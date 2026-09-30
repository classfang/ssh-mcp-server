import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertValidJobId,
  buildJobKillScript,
  buildJobListScript,
  buildJobStartScript,
  buildJobStatusScript,
  generateJobId,
} from '../build/utils/remote-jobs.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('remote jobs', () => {
  let home;
  const run = (script) =>
    execFileSync('/bin/sh', ['-c', script], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
  const status = (id, options = {}) =>
    run(buildJobStatusScript(id, { tailBytes: 4096, maxBytes: 65536, ...options }));

  before(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-jobs-test-'));
  });

  after(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe('job id', () => {
    it('生成的 id 符合校验规则', () => {
      for (let i = 0; i < 20; i++) {
        assertValidJobId(generateJobId());
      }
    });

    it('拒绝能注入 shell 的 id', () => {
      for (const bad of ['', 'job-1', 'x; rm -rf /', 'job-abcdefgh-0000; id', '../etc', 'job-abcdefgh-0000\n']) {
        assert.throws(() => assertValidJobId(bad), /Invalid job id/, JSON.stringify(bad));
        assert.throws(() => buildJobKillScript(bad), /Invalid job id/);
        assert.throws(() => buildJobStatusScript(bad, { tailBytes: 1, maxBytes: 1 }), /Invalid job id/);
      }
    });
  });

  describe('脚本语法', () => {
    it('所有脚本都能通过 sh -n 语法检查（含带引号的命令与工作目录）', () => {
      const id = generateJobId();
      const scripts = [
        buildJobStartScript(id, "echo 'a' \"b\" $c `d`; sleep 1", "/srv/my dir's"),
        buildJobStartScript(id, 'true'),
        buildJobStatusScript(id, { tailBytes: 10, maxBytes: 20 }),
        buildJobStatusScript(id, { offset: 5, tailBytes: 10, maxBytes: 20 }),
        buildJobKillScript(id),
        buildJobListScript(3),
      ];
      for (const script of scripts) {
        execFileSync('/bin/sh', ['-n', '-c', script]);
      }
    });
  });

  describe('脚本不含会杀死交互 shell 的顶层 exit', () => {
    it('start/status/kill/list 脚本均不含 exit 语句（wrapper 内的除外）', () => {
      const id = generateJobId();
      const scripts = [
        buildJobStatusScript(id, { tailBytes: 1, maxBytes: 1 }),
        buildJobKillScript(id),
        buildJobListScript(5),
      ];
      for (const script of scripts) {
        // Quoted text such as "[exit code]" is output, not a statement.
        const code = script.replace(/"[^"]*"/g, '""');
        assert.ok(!/(^|[;{\s])exit(\s|;|$)/m.test(code), script);
      }
    });
  });

  describe('真实执行（本机 /bin/sh，临时 HOME）', () => {
    it('运行、结束、退出码、增量读取', async () => {
      const id = generateJobId();
      const started = run(buildJobStartScript(id, "echo line1; sleep 1; echo err >&2; echo line2; exit 3", os.tmpdir()));
      assert.match(started, new RegExp(`started ${id} \\(pid \\d+\\)`));

      const running = status(id);
      assert.match(running, /\[state\] running/);
      assert.match(running, /line1/);

      await sleep(2200);
      const done = status(id);
      assert.match(done, /\[state\] exited/);
      assert.match(done, /\[exit code\] 3/);
      assert.match(done, /line2/);
      assert.match(done, /err/);

      const next = /next offset (\d+)/.exec(done)[1];
      const idle = status(id, { offset: Number(next) });
      assert.match(idle, new RegExp(`bytes ${next}-${next} of ${next}`));
    });

    it('命令里的引号、$ 和反引号原样执行，不被 wrapper 二次解释', async () => {
      const id = generateJobId();
      run(buildJobStartScript(id, `printf '%s\\n' "it's $HOME" \`echo tick\``));
      await sleep(700);
      const out = status(id);
      assert.match(out, /\[state\] exited/);
      assert.ok(out.includes(`it's ${home}`), out);
      assert.match(out, /tick/);
    });

    it('工作目录不存在时任务以退出码 1 结束并说明原因', async () => {
      const id = generateJobId();
      run(buildJobStartScript(id, 'echo never', '/no/such/dir'));
      await sleep(700);
      const out = status(id);
      assert.match(out, /\[exit code\] 1/);
      assert.match(out, /cannot cd to \/no\/such\/dir/);
      // The status header echoes the command; only the output body must be empty.
      assert.ok(!out.split('---\n')[1].includes('never'));
    });

    it('kill 终止整个进程树且不留孤儿，重复 kill 无害', async () => {
      const marker = `jobs-test-${Date.now()}`;
      const id = generateJobId();
      run(buildJobStartScript(id, `sleep 300 # ${marker}`));
      await sleep(400);
      assert.match(run(buildJobKillScript(id)), /terminated|killed/);
      await sleep(300);
      const ps = execFileSync('/bin/sh', ['-c', `ps -axo args | grep -F "${marker}" | grep -v grep || true`], { encoding: 'utf8' });
      assert.strictEqual(ps.trim(), '');
      assert.match(status(id), /\[state\] killed/);
      assert.match(run(buildJobKillScript(id)), /is not running \(state: killed\)/);
    });

    it('pid 指向无关的存活进程时视为 lost，kill 拒绝发信号', () => {
      const id = generateJobId();
      const dir = path.join(home, '.ssh-mcp-jobs', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      fs.writeFileSync(path.join(dir, 'cmd'), 'fake\n');
      fs.writeFileSync(path.join(dir, 'started'), '0\n');
      fs.writeFileSync(path.join(dir, 'out'), '');
      assert.match(status(id), /\[state\] lost/);
      assert.match(run(buildJobKillScript(id)), /is not running \(state: lost\)/);
    });

    it('不存在的任务给出说明而不是报错，list 列出已有任务', () => {
      assert.match(status('job-abcdefgh-0000'), /not found/);
      const list = run(buildJobListScript(50));
      assert.match(list, /job-/);
    });
  });
});
