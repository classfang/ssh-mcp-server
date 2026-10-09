import { randomBytes } from "node:crypto";
import { shellQuote } from "./shell.js";

/**
 * Background jobs live entirely on the remote host under
 * `~/.ssh-mcp-jobs/<id>/`, so they survive an MCP restart or a dropped SSH
 * connection. Layout of one job directory:
 *
 *   cmd      the command text, run with bash (or sh)
 *   dir      optional working directory
 *   out      stdout + stderr of the command
 *   pid      pid of the wrapper shell (also the process group id under setsid)
 *   started  epoch seconds
 *   exit     exit status, written atomically when the command ends
 *   killed   marker written by job-kill
 *
 * The scripts below are plain POSIX sh, contain no `exit` (in shell transport
 * mode they are pasted into a live interactive shell) and no heredocs.
 */

export const JOB_ROOT = "$HOME/.ssh-mcp-jobs";
export const JOB_RETENTION_DAYS = 7;
const JOB_ID_PATTERN = /^job-[a-z0-9]{6,12}-[0-9a-f]{4}$/;

export function generateJobId(): string {
  return `job-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
}

/** The id ends up inside shell scripts, so it is validated, never escaped. */
export function assertValidJobId(jobId: string): void {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error(`Invalid job id: ${JSON.stringify(jobId)}`);
  }
}

// Sets `state` (running|exited|killed|lost) and `code`. A live pid only counts
// if its command line names this job: pids get reused, and job-kill must never
// signal an unrelated process. /proc is read first because busybox `ps` has no
// `-p`; `ps -p` covers hosts without /proc (macOS, BSD).
const JOB_STATE_FN = [
  'job_is_ours() { if [ -r "/proc/$pid/cmdline" ]; then tr "\\0" " " < "/proc/$pid/cmdline" | grep -q "$ID"; else ps -o args= -p "$pid" 2>/dev/null | grep -q "$ID"; fi; };',
  'job_state() { J="$1"; ID="$2"; code=""; pid=$(cat "$J/pid" 2>/dev/null);',
  'if [ -f "$J/exit" ]; then state=exited; code=$(cat "$J/exit");',
  'elif [ -f "$J/killed" ]; then state=killed;',
  'elif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && job_is_ours; then state=running;',
  "else state=lost; fi; }",
].join(" ");

// Runs inside `nohup [setsid] sh -c`; $1 = job dir, $2 = working dir or empty.
const JOB_WRAPPER = [
  'echo $$ > "$1/pid"',
  'if [ -n "$2" ]; then cd -- "$2" || { echo "cannot cd to $2"; echo 1 > "$1/exit"; exit 1; }; fi',
  'if command -v bash >/dev/null 2>&1; then bash "$1/cmd"; else sh "$1/cmd"; fi',
  'echo $? > "$1/exit.tmp" && mv "$1/exit.tmp" "$1/exit"',
].join("; ");

function jobDir(jobId: string): string {
  assertValidJobId(jobId);
  return `"${JOB_ROOT}/${jobId}"`;
}

export function buildJobStartScript(
  jobId: string,
  command: string,
  directory?: string,
): string {
  const dir = jobDir(jobId);
  return [
    `J=${dir}`,
    'mkdir -p "$J" || echo "cannot create $J"',
    // 只按结束标记的时间清理任务，保留仍在运行或刚结束的旧任务。
    `find "${JOB_ROOT}" -mindepth 2 -maxdepth 2 -type f \\( -name exit -o -name killed \\) -mtime +${JOB_RETENTION_DAYS} -exec sh -c ${shellQuote('for marker do job=${marker%/*}; case "${job##*/}" in job-*) rm -rf -- "$job";; esac; done')} sh {} + 2>/dev/null`,
    `printf '%s\\n' ${shellQuote(command)} > "$J/cmd"`,
    'date +%s > "$J/started"',
    'S=""; command -v setsid >/dev/null 2>&1 && S=setsid',
    `nohup $S sh -c ${shellQuote(JOB_WRAPPER)} _ "$J" ${shellQuote(directory ?? "")} > "$J/out" 2>&1 < /dev/null &`,
    'i=0; while [ ! -s "$J/pid" ] && [ "$i" -lt 30 ]; do sleep 0.1 2>/dev/null || sleep 1; i=$((i+1)); done',
    `if [ -s "$J/pid" ]; then echo "started ${jobId} (pid $(cat "$J/pid"))"; else echo "job ${jobId} did not report a pid"; fi`,
    "",
  ].join("\n");
}

export function buildJobStatusScript(
  jobId: string,
  options: { offset?: number; tailBytes: number; maxBytes: number },
): string {
  const dir = jobDir(jobId);
  const offset =
    options.offset === undefined
      ? "if [ \"$size\" -gt " + options.tailBytes + " ]; then start=$((size-" + options.tailBytes + ")); else start=0; fi"
      : `start=${Math.max(0, Math.floor(options.offset))}; if [ "$start" -gt "$size" ]; then start=$size; fi`;
  return [
    JOB_STATE_FN,
    `J=${dir}; ID=${jobId}`,
    'if [ ! -d "$J" ]; then echo "[job] $ID not found (never started, or pruned after ' +
      JOB_RETENTION_DAYS +
      ' days)";',
    "else",
    '  job_state "$J" "$ID"',
    '  now=$(date +%s); st=$(cat "$J/started" 2>/dev/null || echo "$now")',
    '  size=$(wc -c < "$J/out" 2>/dev/null | tr -d " "); size=${size:-0}',
    `  ${offset}`,
    `  len=$((size-start)); if [ "$len" -gt ${options.maxBytes} ]; then len=${options.maxBytes}; fi; end=$((start+len))`,
    '  echo "[job] $ID"',
    '  echo "[state] $state"',
    '  if [ -n "$code" ]; then echo "[exit code] $code"; fi',
    '  echo "[elapsed] $((now-st))s"',
    '  echo "[command] $(head -c 200 "$J/cmd" 2>/dev/null | head -n 1)"',
    '  echo "[output] bytes $start-$end of $size (next offset $end)"',
    '  echo "---"',
    // `head -c 0` is an error on BSD/macOS, so skip the read when nothing is new.
    '  if [ "$len" -gt 0 ]; then tail -c +$((start+1)) "$J/out" 2>/dev/null | head -c "$len"; fi',
    "fi",
    "",
  ].join("\n");
}

// Under setsid the whole job is one process group and `kill -- -pid` gets it.
// Without setsid (some BSD/macOS hosts) the wrapper only has children, so walk
// the tree depth-first: children first, because a killed parent reparents them
// to init and pgrep -P could no longer find them.
const KILL_TREE_FN =
  'kill_tree() { for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c" "$2"; done; kill -s "$2" "$1" 2>/dev/null; }';

export function buildJobKillScript(jobId: string): string {
  const dir = jobDir(jobId);
  return [
    JOB_STATE_FN,
    KILL_TREE_FN,
    `J=${dir}; ID=${jobId}`,
    'if [ ! -d "$J" ]; then echo "[job] $ID not found";',
    "else",
    '  job_state "$J" "$ID"',
    '  if [ "$state" != running ]; then echo "[job] $ID is not running (state: $state${code:+, exit code $code})";',
    "  else",
    '    kill -s TERM -- "-$pid" 2>/dev/null; kill_tree "$pid" TERM',
    '    i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 5 ]; do sleep 1; i=$((i+1)); done',
    '    if kill -0 "$pid" 2>/dev/null; then kill -s KILL -- "-$pid" 2>/dev/null; kill_tree "$pid" KILL; echo "[job] $ID killed (SIGKILL after 5s)";',
    '    else echo "[job] $ID terminated (SIGTERM)"; fi',
    '    touch "$J/killed"',
    "  fi",
    "fi",
    "",
  ].join("\n");
}

export function buildJobListScript(limit: number): string {
  return [
    JOB_STATE_FN,
    `R="${JOB_ROOT}"`,
    'if [ ! -d "$R" ]; then echo "(no jobs)";',
    "else",
    '  n=0; for ID in $(ls -1t "$R" 2>/dev/null); do',
    '    case "$ID" in job-*) ;; *) continue;; esac',
    `    n=$((n+1)); if [ "$n" -gt ${Math.max(1, Math.floor(limit))} ]; then break; fi`,
    '    J="$R/$ID"; job_state "$J" "$ID"',
    '    echo "$ID  $state${code:+ (exit $code)}  $(head -c 100 "$J/cmd" 2>/dev/null | head -n 1)"',
    "  done",
    '  if [ "$n" -eq 0 ]; then echo "(no jobs)"; fi',
    "fi",
    "",
  ].join("\n");
}
