import path from "path";

// Windows drive-absolute path: drive letter followed by a separator
// ("C:\..." or "C:/..."). Drive-relative ("C:foo") and UNC paths are not
// accepted, so this pattern is the only Windows form we normalize.
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;

function isWindowsRemotePath(remotePath: string): boolean {
  return WINDOWS_ABSOLUTE_PATH_PATTERN.test(remotePath);
}

// Trimming trailing separators keeps prefix matching uniform; only "/" and
// drive roots ("C:/") keep theirs, since they are the whole path there.
function trimTrailingSeparators(normalizedPath: string): string {
  while (
    normalizedPath.length > 1 &&
    normalizedPath.endsWith("/") &&
    !/^[A-Za-z]:\/$/.test(normalizedPath)
  ) {
    normalizedPath = normalizedPath.slice(0, -1);
  }
  return normalizedPath;
}

/**
 * Validate and normalize a remote path for SFTP upload/download.
 *
 * Both POSIX absolute paths and Windows drive-absolute paths are accepted.
 * Windows paths are normalized with win32 semantics and canonicalized to
 * forward slashes (e.g. "C:\\Users\\foo" becomes "C:/Users/foo"), which
 * Win32-OpenSSH's sftp-server accepts.
 *
 * Throws an Error for anything else (relative paths, "C:" drive-relative
 * paths, root-relative backslash paths, UNC paths, null bytes).
 */
export function normalizeRemotePath(remotePath: string): string {
  if (typeof remotePath !== "string" || remotePath.length === 0) {
    throw new Error("Remote path must be a non-empty string.");
  }
  if (remotePath.includes("\0")) {
    throw new Error("Remote path must not contain null bytes.");
  }

  let normalizedPath: string;
  if (isWindowsRemotePath(remotePath)) {
    normalizedPath = path.win32.normalize(remotePath).replace(/\\/g, "/");
  } else if (path.posix.isAbsolute(remotePath)) {
    normalizedPath = path.posix.normalize(remotePath);
  } else {
    throw new Error(
      `Remote path must be an absolute POSIX path or an absolute Windows path (e.g. C:/Users/foo), got: ${remotePath}`,
    );
  }

  return trimTrailingSeparators(normalizedPath);
}

/**
 * Style-aware prefix check between two (not necessarily normalized) remote
 * paths. Windows-style comparisons are case-insensitive, matching Windows
 * path semantics; POSIX comparisons stay case-sensitive. A POSIX path never
 * matches a Windows root and vice versa.
 */
export function isRemotePathWithinRoot(
  candidate: string,
  root: string,
): boolean {
  const normalizedCandidate = normalizeRemotePath(candidate);
  const normalizedRoot = normalizeRemotePath(root);
  const caseInsensitive =
    isWindowsRemotePath(normalizedCandidate) ||
    isWindowsRemotePath(normalizedRoot);
  const comparableCandidate = caseInsensitive
    ? normalizedCandidate.toLowerCase()
    : normalizedCandidate;
  const comparableRoot = caseInsensitive
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;

  return (
    comparableCandidate === comparableRoot ||
    comparableCandidate.startsWith(
      comparableRoot.endsWith("/") ? comparableRoot : `${comparableRoot}/`,
    )
  );
}
