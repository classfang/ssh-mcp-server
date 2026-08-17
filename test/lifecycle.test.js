import { describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const entrypoint = path.join(rootDir, 'build', 'index.js');

function waitForOutput(stream, pattern, timeoutMs = 5000) {
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

async function waitForRunning(child, delayMs = 200) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  assert.strictEqual(child.exitCode, null);
}

function waitForExit(child, timeoutMs = 5000) {
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

function createTempConfig() {
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

  return { tmpDir, configPath };
}

function createPreConnectConfig(port) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-lifecycle-'));
  const configPath = path.join(tmpDir, 'config.json');

  fs.writeFileSync(configPath, JSON.stringify({
    test: {
      host: '127.0.0.1',
      port,
      username: 'test',
      password: 'test',
      connectionTimeoutMs: 10000,
      commandWhitelist: ['^echo'],
    },
  }));

  return { tmpDir, configPath };
}

function spawnServer(configPath) {
  const child = spawn(process.execPath, [entrypoint, '--config-file', configPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let closed = false;
  return {
    child,
    closeInput: () => {
      if (closed) return;
      closed = true;
      child.stdin.end();
    },
  };
}

describe('MCP server lifecycle', () => {
  // Windows has no POSIX signals: child.kill('SIGTERM') maps to
  // TerminateProcess, so the handler under test never runs and the exit is
  // always reported as signalled. The stdin path below covers shutdown there,
  // and is what MCP clients actually use.
  it('exits after SIGTERM even when stdin remains open', { skip: process.platform === 'win32' && 'no POSIX signals on Windows' }, async () => {
    const { tmpDir, configPath } = createTempConfig();
    const { child, closeInput } = spawnServer(configPath);

    try {
      await waitForRunning(child, 1500);

      child.kill('SIGTERM');
      const result = await waitForExit(child);

      assert.strictEqual(result.signal, null);
      assert.strictEqual(result.code, 0);
    } finally {
      try {
        closeInput();
      } catch {}
      child.kill('SIGKILL');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits after stdin is closed', async () => {
    const { tmpDir, configPath } = createTempConfig();
    const { child, closeInput } = spawnServer(configPath);

    try {
      await waitForRunning(child);

      closeInput();
      const result = await waitForExit(child);

      assert.strictEqual(result.signal, null);
      assert.strictEqual(result.code, 0);
    } finally {
      try {
        closeInput();
      } catch {}
      child.kill('SIGKILL');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('accepts initialize requests while pre-connect is still pending', async () => {
    const handshakeServer = net.createServer();
    const sockets = new Set();
    handshakeServer.on('connection', (socket) => {
      sockets.add(socket);
      // Killing the child resets this connection instead of closing it
      // cleanly on some platforms; an unhandled 'error' would fail the test.
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });

    await new Promise((resolve, reject) => {
      handshakeServer.once('error', reject);
      handshakeServer.listen(0, '127.0.0.1', resolve);
    });

    const address = handshakeServer.address();
    assert.ok(address && typeof address !== 'string');
    const { tmpDir, configPath } = createPreConnectConfig(address.port);
    const child = spawn(process.execPath, [entrypoint, '--config-file', configPath, '--pre-connect'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try {
      child.stdin.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 61,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'lifecycle-test', version: '1.0.0' },
        },
      })}\n`);

      const output = await waitForOutput(child.stdout, /"id":61/, 1250);
      assert.match(output, /"result"/);
    } finally {
      child.stdin.end();
      if (child.exitCode === null) {
        const exitPromise = waitForExit(child);
        child.kill('SIGKILL');
        await exitPromise;
      }
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => handshakeServer.close(resolve));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
