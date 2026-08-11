import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_CONFIG } from '../build/config/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const entrypoint = path.join(rootDir, 'build', 'index.js');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')
);

const expectedHelpOptions = [
  '--config-file <path>',
  '--ssh-config-file <path>',
  '--ssh <config>',
  '-h, --host <host>',
  '-p, --port <port>',
  '-u, --username <name>',
  '-w, --password <password>',
  '-k, --privateKey <path>',
  '-P, --passphrase <passphrase>',
  '-a, --agent <path>',
  '-W, --whitelist <patterns>',
  '-B, --blacklist <patterns>',
  '--proxy <url>',
  '-s, --socksProxy <url>',
  '--allowed-local-paths <paths>',
  '--allowed-remote-paths <paths>',
  '--transport-mode <mode>',
  '--shell-ready-timeout <ms>',
  '--command-template <template>',
  '--pty',
  '--try-keyboard',
  '--pre-connect',
  '--version, -v',
  '--help',
];

function runCli(args) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: rootDir,
    encoding: 'utf8',
  });
}

describe('CLI info flags', () => {
  it('keeps the MCP server version in sync with package metadata', () => {
    assert.strictEqual(SERVER_CONFIG.version, packageJson.version);
  });

  it('prints package version and exits successfully for --version', () => {
    const result = runCli(['--version']);

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), packageJson.version);
    assert.doesNotMatch(result.stderr, /Unknown option/);
  });

  it('prints package version and exits successfully for -v', () => {
    const result = runCli(['-v']);

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), packageJson.version);
    assert.doesNotMatch(result.stderr, /Unknown option/);
  });

  it('prints help and exits successfully for --help', () => {
    const result = runCli(['--help']);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Usage: ssh-mcp-server/);
    for (const option of expectedHelpOptions) {
      assert.ok(
        result.stdout.includes(option),
        `Expected help output to include ${option}`
      );
    }
    assert.doesNotMatch(result.stderr, /Unknown option/);
  });

  it('handles info flags before normal config parsing', () => {
    const missingConfigPath = path.join(rootDir, 'missing-cli-info-config.json');
    const result = runCli(['--config-file', missingConfigPath, '--help']);

    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Usage: ssh-mcp-server/);
    assert.doesNotMatch(result.stderr, /Config file not found/);
    assert.doesNotMatch(result.stderr, /Unknown option/);
  });
});
