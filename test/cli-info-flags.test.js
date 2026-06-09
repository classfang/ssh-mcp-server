import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const entrypoint = path.join(rootDir, 'build', 'index.js');

function runCli(args) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: rootDir,
    encoding: 'utf8',
  });
}

describe('CLI info flags', () => {
  it('prints package version and exits successfully for --version', () => {
    const result = runCli(['--version']);

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), '1.8.3');
    assert.doesNotMatch(result.stderr, /Unknown option/);
  });

  it('prints help and exits successfully for --help', () => {
    const result = runCli(['--help']);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Usage: ssh-mcp-server/);
    assert.match(result.stdout, /--config-file/);
    assert.match(result.stdout, /--ssh/);
    assert.match(result.stdout, /--version/);
    assert.doesNotMatch(result.stderr, /Unknown option/);
  });
});
