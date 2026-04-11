import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const entrypoint = path.join(rootDir, 'build', 'index.js');

function waitForOutput(stream, pattern, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${pattern}. Output:\n${output}`));
    }, timeoutMs);

    const onData = (chunk) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        cleanup();
        resolve(output);
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      stream.off('data', onData);
    };

    stream.on('data', onData);
  });
}

function waitForExit(child, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Process did not exit before timeout'));
    }, timeoutMs);

    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

describe('MCP server lifecycle', () => {
  it('exits after SIGTERM even when stdin remains open', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-lifecycle-'));
    const configPath = path.join(tmpDir, 'config.json');

    fs.writeFileSync(configPath, JSON.stringify({
      test: {
        host: '127.0.0.1',
        port: 22,
        username: 'test',
        password: 'test',
        commandWhitelist: ['^echo'],
      },
    }));

    const child = spawn(process.execPath, [entrypoint, '--config-file', configPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      await waitForOutput(child.stderr, /MCP server connection established/);

      child.kill('SIGTERM');
      const result = await waitForExit(child);

      assert.strictEqual(result.signal, null);
      assert.strictEqual(result.code, 0);
    } finally {
      child.kill('SIGKILL');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
