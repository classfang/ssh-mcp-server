import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SocksClient } from 'socks';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';
import { ToolError } from '../build/utils/tool-error.js';
import { Logger } from '../build/utils/logger.js';

class FakeExecStream extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
  }

  close() {
    this.emit('close');
  }
}

class FakeProxySocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.unshifted = [];
  }

  destroy() {
    this.destroyed = true;
  }

  unshift(data) {
    this.unshifted.push(data);
  }
}

function createConnectRequest(options, { statusCode = 200, head = Buffer.alloc(0) } = {}) {
  const request = new EventEmitter();
  const socket = new FakeProxySocket();
  request.options = options;
  request.socket = socket;
  request.timeoutMs = undefined;
  request.timeoutCalls = [];
  request.setTimeout = (timeoutMs, callback) => {
    request.timeoutMs = timeoutMs;
    request.timeoutCalls.push(timeoutMs);
    request.timeoutCallback = callback;
    return request;
  };
  request.destroy = (error) => {
    if (error) {
      request.emit('error', error);
    }
  };
  request.end = () => {
    queueMicrotask(() => {
      request.emit('connect', { statusCode }, socket, head);
    });
  };
  return request;
}

class FakeShellChannel extends EventEmitter {
  constructor() {
    super();
    this.stderr = new EventEmitter();
    this.writes = [];
  }

  write(data) {
    this.writes.push(data);
    this.emit('write', data);
    return true;
  }

  close() {
    this.emit('close');
  }
}

class FakeSftp extends EventEmitter {
  end() {
    this.emit('end');
  }
}

function fakeStats(size, { isFile = true } = {}) {
  return { size, isFile: () => isFile, isDirectory: () => !isFile };
}

/**
 * SFTP double that records which transfer path the manager picked
 * (fastGet/fastPut vs the sequential stream) and serves remote content.
 */
class FakeTransferSftp extends EventEmitter {
  constructor(handlers = {}) {
    super();
    this.handlers = handlers;
    this.statCalls = [];
    this.fastGetCalls = [];
    this.fastPutCalls = [];
    this.readStreamCalls = [];
    this.writeStreamCalls = [];
    this.uploadedChunks = [];
  }

  end() {
    this.emit('end');
  }

  stat(remotePath, callback) {
    this.statCalls.push(remotePath);
    const size = this.handlers.statSizes.length > 1
      ? this.handlers.statSizes.shift()
      : this.handlers.statSizes[0];
    setImmediate(() => callback(undefined, fakeStats(size, this.handlers)));
  }

  fastGet(remotePath, localPath, options, callback) {
    this.fastGetCalls.push({ remotePath, localPath, options });
    const content = this.handlers.remoteContent.subarray(
      0,
      this.handlers.fastGetBytes ?? this.handlers.remoteContent.length,
    );
    fs.writeFileSync(localPath, content);
    setImmediate(() => callback());
  }

  fastPut(localPath, remotePath, options, callback) {
    this.fastPutCalls.push({ localPath, remotePath, options });
    setImmediate(() => callback());
  }

  createReadStream(remotePath, options = {}) {
    this.readStreamCalls.push({ remotePath, options });
    return Readable.from([
      this.handlers.remoteContent.subarray(options.start ?? 0),
    ]);
  }

  createWriteStream(remotePath, options = {}) {
    this.writeStreamCalls.push({ remotePath, options });
    const chunks = this.uploadedChunks;
    return new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
  }
}

class FakeClient extends EventEmitter {
  constructor(handlers = {}) {
    super();
    this.handlers = handlers;
    this.connectCalls = [];
    this.execCalls = [];
    this.shellCalls = [];
    this.endCalls = 0;
  }

  connect(config) {
    this.connectCalls.push(config);
    this.handlers.onConnect?.(config, this);
  }

  exec(command, optionsOrCallback, maybeCallback) {
    const hasOptions = typeof optionsOrCallback !== 'function';
    const options = hasOptions ? optionsOrCallback : undefined;
    const callback = hasOptions ? maybeCallback : optionsOrCallback;
    this.execCalls.push({ command, options });
    this.handlers.onExec?.({ command, options, callback }, this);
  }

  shell(options, callback) {
    this.shellCalls.push(options);
    this.handlers.onShell?.({ options, callback }, this);
  }

  sftp(callback) {
    this.handlers.onSftp?.(callback, this);
  }

  end() {
    this.endCalls += 1;
    this.emit('close');
  }

  destroy() {
    this.endCalls += 1;
    this.emit('close');
  }
}

function createPasswordConfig(overrides = {}) {
  return {
    name: 'shell',
    host: '192.168.1.100',
    port: 22,
    username: 'devuser',
    password: 'devpass',
    ...overrides,
  };
}

function extractMarkerId(payload, prefix) {
  const match = payload.match(new RegExp(`${prefix}(.+?)__`));
  return match?.[1];
}

function shellQuoteForTest(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function emitShellCommandResult(channel, commandId, output, exitCode) {
  channel.emit(
    'data',
    Buffer.from(
      `noise\r\n__MCP_BEGIN__${commandId}__\r\n${output}\n__MCP_END__${commandId}__RC__${exitCode}__\r\n$ `,
    ),
  );
}

describe('SSH Connection Manager', () => {
  let manager;
  let originalCreateClient;
  let originalScheduleStatusCollection;

  before(() => {
    manager = SSHConnectionManager.getInstance();
    originalCreateClient = manager.createClient;
    originalScheduleStatusCollection = manager.scheduleStatusCollection;
  });

  afterEach(() => {
    manager.disconnect();
    manager.createClient = originalCreateClient;
    manager.scheduleStatusCollection = originalScheduleStatusCollection;
  });

  describe('配置管理', () => {
    it('应该正确初始化并设置配置', () => {
      const configs = {
        dev: createPasswordConfig({ name: 'dev' }),
      };

      manager.setConfig(configs);
      const config = manager.getConfig('dev');
      assert.strictEqual(config.host, '192.168.1.100');
      assert.strictEqual(config.username, 'devuser');
    });

    it('应该能够获取所有服务器信息', () => {
      const configs = {
        dev: createPasswordConfig({ name: 'dev' }),
        prod: createPasswordConfig({
          name: 'prod',
          host: '10.0.0.50',
          username: 'produser',
          password: 'prodpass',
        }),
      };

      manager.setConfig(configs);
      const allInfos = manager.getAllServerInfos();

      assert.strictEqual(allInfos.length, 2);
      assert.ok(allInfos.find((c) => c.name === 'dev'));
      assert.ok(allInfos.find((c) => c.name === 'prod'));
    });

    it('应该能够通过名称获取配置', () => {
      manager.setConfig({
        dev: createPasswordConfig({ name: 'dev' }),
      });

      const config = manager.getConfig('dev');
      assert.strictEqual(config.name, 'dev');
      assert.strictEqual(config.host, '192.168.1.100');
    });

    it('获取不存在的配置应抛出错误', () => {
      manager.setConfig({});
      assert.throws(() => {
        manager.getConfig('nonexistent');
      }, /not set/);
    });

    it('无效的命令正则应在配置阶段抛出错误', () => {
      assert.throws(() => {
        manager.setConfig({
          dev: createPasswordConfig({
            name: 'dev',
            commandWhitelist: ['[invalid'],
          }),
        });
      }, /Invalid whitelist pattern/);
    });
  });

  describe('服务器信息', () => {
    it('初始状态应该是未连接', () => {
      manager.setConfig({
        dev: createPasswordConfig({ name: 'dev' }),
      });

      const infos = manager.getAllServerInfos();
      const devInfo = infos.find((info) => info.name === 'dev');

      assert.ok(devInfo);
      assert.strictEqual(devInfo.connected, false);
    });

    it('服务器信息应包含正确的连接参数', () => {
      manager.setConfig({
        dev: createPasswordConfig({
          name: 'dev',
          port: 2222,
        }),
      });

      const infos = manager.getAllServerInfos();
      const devInfo = infos.find((info) => info.name === 'dev');

      assert.strictEqual(devInfo.host, '192.168.1.100');
      assert.strictEqual(devInfo.port, 2222);
      assert.strictEqual(devInfo.username, 'devuser');
    });

    it('应允许配置的本地路径用于传输', () => {
      const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-allowed-'));

      try {
        manager.setConfig({
          dev: createPasswordConfig({
            name: 'dev',
            allowedLocalPaths: [allowedRoot],
          }),
        });

        const insidePath = path.join(allowedRoot, 'test.txt');
        assert.strictEqual(manager.validateLocalPath(insidePath, 'dev'), insidePath);
        assert.throws(
          () => manager.validateLocalPath(path.resolve(path.sep, 'etc', 'passwd'), 'dev'),
          ToolError,
        );
      } finally {
        fs.rmSync(allowedRoot, { recursive: true, force: true });
      }
    });

    it('本地允许路径应按连接隔离', () => {
      const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-first-'));
      const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-second-'));

      try {
        manager.setConfig({
          first: createPasswordConfig({
            name: 'first',
            allowedLocalPaths: [firstRoot],
          }),
          second: createPasswordConfig({
            name: 'second',
            allowedLocalPaths: [secondRoot],
          }),
        });

        const firstPath = path.join(firstRoot, 'file.txt');
        assert.strictEqual(manager.validateLocalPath(firstPath, 'first'), firstPath);
        assert.throws(
          () => manager.validateLocalPath(firstPath, 'second'),
          (err) => err instanceof ToolError && err.code === 'LOCAL_PATH_NOT_ALLOWED',
        );
      } finally {
        fs.rmSync(firstRoot, { recursive: true, force: true });
        fs.rmSync(secondRoot, { recursive: true, force: true });
      }
    });

    // 调用方看不到 MCP server 的工作目录，只说“必须在工作目录内”等于没给出可纠正的信息。
    it('本地路径被拒时应指出解析结果和允许的根路径', () => {
      const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-allowed-'));

      try {
        manager.setConfig({
          dev: createPasswordConfig({
            name: 'dev',
            allowedLocalPaths: [allowedRoot],
          }),
        });

        assert.throws(
          () => manager.validateLocalPath(path.resolve(path.sep, 'etc', 'passwd'), 'dev'),
          (error) => {
            assert.strictEqual(error.code, 'LOCAL_PATH_NOT_ALLOWED');
            assert.match(error.message, /Allowed local paths for this connection:/);
            assert.ok(error.message.includes(fs.realpathSync.native(allowedRoot)));
            assert.ok(error.message.includes(fs.realpathSync.native(process.cwd())));
            assert.match(error.message, /resolved to:/);
            return true;
          },
        );
      } finally {
        fs.rmSync(allowedRoot, { recursive: true, force: true });
      }
    });

    it('本地路径校验应拒绝通过符号链接逃出允许目录', (t) => {
      const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-allowed-'));
      const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-outside-'));
      const outsideFile = path.join(outsideRoot, 'secret.txt');
      const symlinkPath = path.join(allowedRoot, 'link');

      try {
        fs.writeFileSync(outsideFile, 'secret');
        try {
          fs.symlinkSync(outsideRoot, symlinkPath, 'dir');
        } catch (error) {
          // Windows only allows this for administrators or with developer
          // mode enabled; the assertion below is meaningless without a symlink.
          if (error.code !== 'EPERM' && error.code !== 'EACCES') {
            throw error;
          }
          t.skip('creating symlinks requires elevated privileges here');
          return;
        }

        manager.setConfig({
          dev: createPasswordConfig({
            name: 'dev',
            allowedLocalPaths: [allowedRoot],
          }),
        });

        assert.throws(
          () => manager.validateLocalPath(path.join(symlinkPath, 'secret.txt'), 'dev'),
          (err) => err instanceof ToolError && err.code === 'LOCAL_PATH_NOT_ALLOWED',
        );
      } finally {
        fs.rmSync(allowedRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
      }
    });

    it('未配置 allowedRemotePaths 时 validateRemotePath 放行绝对路径', () => {
      manager.setConfig({
        dev: createPasswordConfig({ name: 'dev' }),
      });

      assert.strictEqual(manager.validateRemotePath('/tmp/a.txt', 'dev'), '/tmp/a.txt');
    });

    it('validateRemotePath 拒绝相对路径', () => {
      manager.setConfig({
        dev: createPasswordConfig({ name: 'dev' }),
      });

      assert.throws(
        () => manager.validateRemotePath('tmp/a.txt', 'dev'),
        (err) => err instanceof ToolError && err.code === 'REMOTE_PATH_NOT_ALLOWED',
      );
    });

    it('validateRemotePath 拒绝空串与 null byte', () => {
      manager.setConfig({
        dev: createPasswordConfig({ name: 'dev' }),
      });

      assert.throws(
        () => manager.validateRemotePath('', 'dev'),
        (err) => err instanceof ToolError && err.code === 'REMOTE_PATH_NOT_ALLOWED',
      );
      assert.throws(
        () => manager.validateRemotePath('/tmp/\0evil', 'dev'),
        (err) => err instanceof ToolError && err.code === 'REMOTE_PATH_NOT_ALLOWED',
      );
    });

    it('配置 allowedRemotePaths 后只允许前缀匹配的路径', () => {
      manager.setConfig({
        dev: createPasswordConfig({
          name: 'dev',
          allowedRemotePaths: ['/home/ops/inbox', '/var/log'],
        }),
      });

      assert.strictEqual(
        manager.validateRemotePath('/home/ops/inbox/file', 'dev'),
        '/home/ops/inbox/file',
      );
      assert.strictEqual(
        manager.validateRemotePath('/var/log', 'dev'),
        '/var/log',
      );
      assert.throws(
        () => manager.validateRemotePath('/etc/passwd', 'dev'),
        (err) => err instanceof ToolError && err.code === 'REMOTE_PATH_NOT_ALLOWED',
      );
      // prefix-string trap: /home/ops/inbox-other must NOT match /home/ops/inbox
      assert.throws(
        () => manager.validateRemotePath('/home/ops/inbox-other/f', 'dev'),
        (err) => err instanceof ToolError && err.code === 'REMOTE_PATH_NOT_ALLOWED',
      );
    });

    it('远端路径被拒时应指出解析结果和允许的根路径', () => {
      manager.setConfig({
        dev: createPasswordConfig({
          name: 'dev',
          allowedRemotePaths: ['/home/ops/inbox', '/var/log'],
        }),
      });

      assert.throws(
        () => manager.validateRemotePath('/home/ops/inbox/../../../etc/passwd', 'dev'),
        (error) => {
          assert.strictEqual(error.code, 'REMOTE_PATH_NOT_ALLOWED');
          // The normalized path is what the check ran against, not the input.
          assert.match(error.message, /Resolved to: \/etc\/passwd\./);
          assert.match(
            error.message,
            /Allowed remote paths for this connection: \/home\/ops\/inbox, \/var\/log\./,
          );
          return true;
        },
      );
    });

    it('validateRemotePath 归一化 .. 并据此做边界判断', () => {
      manager.setConfig({
        dev: createPasswordConfig({
          name: 'dev',
          allowedRemotePaths: ['/home/ops/inbox'],
        }),
      });

      assert.throws(
        () => manager.validateRemotePath('/home/ops/inbox/../../../etc/passwd', 'dev'),
        (err) => err instanceof ToolError && err.code === 'REMOTE_PATH_NOT_ALLOWED',
      );
    });
  });

  describe('默认连接名称', () => {
    it('应该使用第一个配置作为默认名称', () => {
      manager.setConfig({
        first: createPasswordConfig({ name: 'first', host: '1.1.1.1', username: 'user1', password: 'pass1' }),
        second: createPasswordConfig({ name: 'second', host: '2.2.2.2', username: 'user2', password: 'pass2' }),
      });

      const config = manager.getConfig();
      assert.strictEqual(config.host, '1.1.1.1');
    });

    it('应该支持指定默认连接名称', () => {
      manager.setConfig(
        {
          first: createPasswordConfig({ name: 'first', host: '1.1.1.1', username: 'user1', password: 'pass1' }),
          second: createPasswordConfig({ name: 'second', host: '2.2.2.2', username: 'user2', password: 'pass2' }),
        },
        'second',
      );

      const config = manager.getConfig();
      assert.strictEqual(config.host, '2.2.2.2');
    });
  });

  describe('安全边界', () => {
    it('状态采集命令不应绕过命令白名单', async () => {
      const originalRunCommandInternal = manager.runCommandInternal;
      const seenCalls = [];

      manager.setConfig({
        dev: createPasswordConfig({
          name: 'dev',
          commandWhitelist: ['^hostname$'],
        }),
      });

      manager.runCommandInternal = async (command, directory, name, options) => {
        seenCalls.push({ command, options });
        const validationResult = manager.validateCommand(command, name);
        if (!validationResult.isAllowed) {
          throw new ToolError(
            'COMMAND_VALIDATION_FAILED',
            validationResult.reason,
            false,
          );
        }
        return 'ok';
      };

      try {
        await manager.collectStatusForConnection('dev');
      } finally {
        manager.runCommandInternal = originalRunCommandInternal;
      }

      assert.ok(seenCalls.length > 0);
      assert.ok(
        seenCalls.every(
          (call) => call.options?.prevalidatedInternalCommand === true,
        ),
      );
      assert.ok(seenCalls.every((call) => call.command.includes('hostname')));
      assert.ok(seenCalls.every((call) => !call.command.includes('uname -s')));
      assert.strictEqual(manager.statusCache.get('dev').reachable, true);
    });

    it('SOCKS 代理应传递认证信息并脱敏日志', async () => {
      const originalCreateConnection = SocksClient.createConnection;
      const originalLog = Logger.log;
      const logs = [];
      let socksOptions;

      SocksClient.createConnection = async (options) => {
        socksOptions = options;
        return { socket: { mocked: true } };
      };
      Logger.log = (message, level) => {
        logs.push({ message, level });
      };

      try {
        const sshConfig = await manager.buildClientConfig(
          'proxy',
          createPasswordConfig({
            name: 'proxy',
            socksProxy: 'socks://proxy-user:proxy-pass@proxy.local:1080',
          }),
        );

        assert.strictEqual(socksOptions.proxy.userId, 'proxy-user');
        assert.strictEqual(socksOptions.proxy.password, 'proxy-pass');
        assert.strictEqual(socksOptions.proxy.host, 'proxy.local');
        assert.strictEqual(socksOptions.proxy.port, 1080);
        assert.deepStrictEqual(sshConfig.sock, { mocked: true });
        assert.ok(logs.some((entry) => entry.message.includes('proxy.local')));
        assert.ok(logs.every((entry) => !entry.message.includes('proxy-user')));
        assert.ok(logs.every((entry) => !entry.message.includes('proxy-pass')));
      } finally {
        SocksClient.createConnection = originalCreateConnection;
        Logger.log = originalLog;
      }
    });

    it('HTTP 代理应通过 CONNECT 建立隧道并传递 Basic 认证', async () => {
      const originalRequest = http.request;
      const originalLog = Logger.log;
      const logs = [];
      let proxyRequest;

      http.request = (options) => {
        proxyRequest = createConnectRequest(options, {
          head: Buffer.from('SSH-2.0-test'),
        });
        return proxyRequest;
      };
      Logger.log = (message, level) => {
        logs.push({ message, level });
      };

      try {
        const sshConfig = await manager.buildClientConfig(
          'http-proxy',
          createPasswordConfig({
            name: 'http-proxy',
            host: 'ssh.internal',
            proxy: 'http://proxy-user:proxy-pass@proxy.local:8080',
          }),
        );

        assert.strictEqual(proxyRequest.options.method, 'CONNECT');
        assert.strictEqual(proxyRequest.options.hostname, 'proxy.local');
        assert.strictEqual(proxyRequest.options.port, 8080);
        assert.strictEqual(proxyRequest.options.path, 'ssh.internal:22');
        assert.strictEqual(proxyRequest.options.headers.Host, 'ssh.internal:22');
        assert.strictEqual(
          proxyRequest.options.headers['Proxy-Authorization'],
          `Basic ${Buffer.from('proxy-user:proxy-pass').toString('base64')}`,
        );
        assert.ok(proxyRequest.timeoutCalls.includes(30000));
        assert.strictEqual(sshConfig.sock, proxyRequest.socket);
        assert.deepStrictEqual(proxyRequest.socket.unshifted, [
          Buffer.from('SSH-2.0-test'),
        ]);
        assert.ok(logs.some((entry) => entry.message.includes('proxy.local')));
        assert.ok(logs.every((entry) => !entry.message.includes('proxy-user')));
        assert.ok(logs.every((entry) => !entry.message.includes('proxy-pass')));
      } finally {
        http.request = originalRequest;
        Logger.log = originalLog;
      }
    });

    it('HTTPS 代理应使用 TLS 代理连接和默认端口 443', async () => {
      const originalRequest = https.request;
      let proxyRequest;

      https.request = (options) => {
        proxyRequest = createConnectRequest(options);
        return proxyRequest;
      };

      try {
        const sshConfig = await manager.buildClientConfig(
          'https-proxy',
          createPasswordConfig({
            name: 'https-proxy',
            proxy: 'https://proxy.local',
          }),
        );

        assert.strictEqual(proxyRequest.options.hostname, 'proxy.local');
        assert.strictEqual(proxyRequest.options.port, 443);
        assert.strictEqual(sshConfig.sock, proxyRequest.socket);
      } finally {
        https.request = originalRequest;
      }
    });

    it('HTTP 代理 CONNECT 非 200 响应应关闭 socket 并返回连接错误', async () => {
      const originalRequest = http.request;
      let proxyRequest;

      http.request = (options) => {
        proxyRequest = createConnectRequest(options, { statusCode: 407 });
        return proxyRequest;
      };

      try {
        await assert.rejects(
          manager.buildClientConfig(
            'rejected-proxy',
            createPasswordConfig({
              name: 'rejected-proxy',
              proxy: 'http://proxy.local:8080',
            }),
          ),
          (error) =>
            error instanceof ToolError &&
            error.message.includes('HTTP proxy CONNECT failed with status 407'),
        );
        assert.strictEqual(proxyRequest.socket.destroyed, true);
      } finally {
        http.request = originalRequest;
      }
    });

    it('不支持的代理协议应返回明确错误', async () => {
      await assert.rejects(
        manager.buildClientConfig(
          'invalid-proxy',
          createPasswordConfig({
            name: 'invalid-proxy',
            proxy: 'ftp://proxy.local:21',
          }),
        ),
        (error) =>
          error instanceof ToolError &&
          error.message.includes("Unsupported proxy protocol 'ftp:'"),
      );
    });

    it('旧 socksProxy 配置应拒绝 HTTP 和 HTTPS URL', async () => {
      await assert.rejects(
        manager.buildClientConfig(
          'legacy-http-proxy',
          createPasswordConfig({
            name: 'legacy-http-proxy',
            socksProxy: 'http://proxy.local:8080',
          }),
        ),
        (error) =>
          error instanceof ToolError &&
          error.message.includes("'socksProxy' option only supports"),
      );
    });

    it('proxy 和 socksProxy 同时配置时应拒绝连接', async () => {
      await assert.rejects(
        manager.buildClientConfig(
          'conflicting-proxy',
          createPasswordConfig({
            name: 'conflicting-proxy',
            proxy: 'http://proxy.local:8080',
            socksProxy: 'socks://proxy.local:1080',
          }),
        ),
        (error) =>
          error instanceof ToolError &&
          error.message.includes("cannot use both 'proxy' and 'socksProxy'"),
      );
    });

    it('connectAll 应尝试所有连接后再汇总失败', async () => {
      const originalConnect = manager.connect;
      const attempted = [];

      manager.setConfig({
        good: createPasswordConfig({ name: 'good' }),
        bad: createPasswordConfig({ name: 'bad' }),
      });

      manager.connect = async (name) => {
        attempted.push(name);
        if (name === 'bad') {
          throw new Error('boom');
        }
      };

      try {
        await assert.rejects(
          () => manager.connectAll(),
          (error) => error instanceof ToolError && error.code === 'SSH_CONNECTION_FAILED',
        );
        assert.deepStrictEqual(attempted.sort(), ['bad', 'good']);
      } finally {
        manager.connect = originalConnect;
      }
    });

    it('连接配置默认启用超时和 keepalive', async () => {
      const sshConfig = await manager.buildClientConfig(
        'dev',
        createPasswordConfig({ name: 'dev' }),
      );

      assert.strictEqual(sshConfig.readyTimeout, 30000);
      assert.strictEqual(sshConfig.timeout, 30000);
      assert.strictEqual(sshConfig.keepaliveInterval, 10000);
      assert.strictEqual(sshConfig.keepaliveCountMax, 3);
    });

    it('连接配置允许覆盖超时和 keepalive', async () => {
      const sshConfig = await manager.buildClientConfig(
        'dev',
        createPasswordConfig({
          name: 'dev',
          connectionTimeoutMs: 1234,
          keepaliveIntervalMs: 5678,
          keepaliveCountMax: 2,
        }),
      );

      assert.strictEqual(sshConfig.readyTimeout, 1234);
      assert.strictEqual(sshConfig.timeout, 1234);
      assert.strictEqual(sshConfig.keepaliveInterval, 5678);
      assert.strictEqual(sshConfig.keepaliveCountMax, 2);
    });

    it('连接配置应将自定义 SSH algorithms 透传给 ssh2', async () => {
      const algorithms = {
        serverHostKey: { append: ['ssh-rsa'] },
        hmac: ['hmac-sha1', 'hmac-md5'],
      };
      const sshConfig = await manager.buildClientConfig(
        'legacy',
        createPasswordConfig({ name: 'legacy', algorithms }),
      );

      assert.deepStrictEqual(sshConfig.algorithms, algorithms);
    });

    it('tryKeyboard authHandler 应在认证方法耗尽时返回 false', async () => {
      const sshConfig = await manager.buildClientConfig(
        'dev',
        createPasswordConfig({
          name: 'dev',
          tryKeyboard: true,
        }),
      );

      const attempts = [];
      sshConfig.authHandler(null, null, (nextAuth) => attempts.push(nextAuth));
      sshConfig.authHandler(['password', 'keyboard-interactive'], false, (nextAuth) => attempts.push(nextAuth));
      sshConfig.authHandler(['password', 'keyboard-interactive'], false, (nextAuth) => attempts.push(nextAuth));

      assert.deepStrictEqual(attempts, ['password', 'keyboard-interactive', false]);
    });

    it('tryKeyboard authHandler 应区分 agent 与 publickey', async () => {
      const sshConfig = await manager.buildClientConfig(
        'agent',
        createPasswordConfig({
          name: 'agent',
          password: undefined,
          agent: '/tmp/ssh-agent.sock',
          tryKeyboard: true,
        }),
      );

      const attempts = [];
      sshConfig.authHandler(null, null, (nextAuth) => attempts.push(nextAuth));

      assert.deepStrictEqual(attempts, ['agent']);
      assert.strictEqual(sshConfig.agent, '/tmp/ssh-agent.sock');
    });

    it('tryKeyboard authHandler 应在 publickey 仍可用时继续尝试 agent', async () => {
      const sshConfig = await manager.buildClientConfig(
        'mixed',
        createPasswordConfig({
          name: 'mixed',
          password: undefined,
          privateKey: path.join(process.cwd(), 'node_modules/ssh2/test/fixtures/id_rsa'),
          agent: '/tmp/ssh-agent.sock',
          tryKeyboard: true,
        }),
      );

      const attempts = [];
      sshConfig.authHandler(null, null, (nextAuth) => attempts.push(nextAuth));
      sshConfig.authHandler(['publickey', 'keyboard-interactive'], false, (nextAuth) => attempts.push(nextAuth));

      assert.deepStrictEqual(attempts, ['publickey', 'agent']);
    });

    it('keyboard prompt 有验证码时应优先响应非密码提示', async () => {
      const originalOtp = process.env.SSH_MCP_2FA_CODE;
      process.env.SSH_MCP_2FA_CODE = '654321';

      try {
        const sshConfig = await manager.buildClientConfig(
          'dev',
          createPasswordConfig({
            name: 'dev',
            tryKeyboard: true,
          }),
        );

        let responses;
        sshConfig.keyboard('', '', '', [{ prompt: 'Verification code: ', echo: false }], (answers) => {
          responses = answers;
        });

        assert.deepStrictEqual(responses, ['654321']);
      } finally {
        if (originalOtp === undefined) {
          delete process.env.SSH_MCP_2FA_CODE;
        } else {
          process.env.SSH_MCP_2FA_CODE = originalOtp;
        }
      }
    });

    it('keyboard prompt 无验证码时应将单个 non-echo 提示回退为密码', async () => {
      const originalOtp = process.env.SSH_MCP_2FA_CODE;
      delete process.env.SSH_MCP_2FA_CODE;

      try {
        const sshConfig = await manager.buildClientConfig(
          'dev',
          createPasswordConfig({
            name: 'dev',
            tryKeyboard: true,
          }),
        );

        let responses;
        sshConfig.keyboard('', '', '', [{ prompt: 'Access: ', echo: false }], (answers) => {
          responses = answers;
        });

        assert.deepStrictEqual(responses, ['devpass']);
      } finally {
        if (originalOtp !== undefined) {
          process.env.SSH_MCP_2FA_CODE = originalOtp;
        }
      }
    });
  });

  describe('Shell transport', () => {
    it('shell 模式连接初始化会进入 ready 流程', async () => {
      const channel = new FakeShellChannel();
      channel.on('write', (payload) => {
        const readyId = extractMarkerId(payload, '__MCP_READY__');
        if (readyId) {
          setImmediate(() => {
            channel.emit('data', Buffer.from(`banner\r\n__MCP_READY__${readyId}__\r\n$ `));
          });
        }
      });

      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onShell: ({ callback }) => callback(undefined, channel),
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        shell: createPasswordConfig({
          transportMode: 'shell',
          shellReadyTimeoutMs: 500,
        }),
      });

      await manager.connect('shell');

      assert.strictEqual(client.shellCalls.length, 1);
      assert.strictEqual(manager.shellReady.get('shell'), true);
      assert.strictEqual(manager.getAllServerInfos()[0].connected, true);
      assert.ok(channel.writes.some((payload) => payload.includes('__MCP_READY__')));
    });

    it('shell 模式命令按队列串行执行', async () => {
      const channel = new FakeShellChannel();
      const commandIds = [];

      channel.on('write', (payload) => {
        const readyId = extractMarkerId(payload, '__MCP_READY__');
        if (readyId) {
          setImmediate(() => {
            channel.emit('data', Buffer.from(`__MCP_READY__${readyId}__\n`));
          });
          return;
        }

        const commandId = extractMarkerId(payload, '__MCP_BEGIN__');
        if (commandId) {
          commandIds.push(commandId);
        }
      });

      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onShell: ({ callback }) => callback(undefined, channel),
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        shell: createPasswordConfig({
          transportMode: 'shell',
        }),
      });

      await manager.connect('shell');

      const firstPromise = manager.executeCommand('echo first', undefined, 'shell');
      const secondPromise = manager.executeCommand('echo second', undefined, 'shell');

      await delay(0);
      assert.strictEqual(commandIds.length, 1);

      emitShellCommandResult(channel, commandIds[0], 'first', 0);
      assert.strictEqual(await firstPromise, 'first');

      await delay(0);
      assert.strictEqual(commandIds.length, 2);

      emitShellCommandResult(channel, commandIds[1], 'second', 0);
      assert.strictEqual(await secondPromise, 'second');
    });

    it('shell 模式能正确提取 marker 间的输出', async () => {
      const channel = new FakeShellChannel();
      let seenScript = '';

      channel.on('write', (payload) => {
        seenScript = payload;

        const readyId = extractMarkerId(payload, '__MCP_READY__');
        if (readyId) {
          setImmediate(() => {
            channel.emit('data', Buffer.from(`__MCP_READY__${readyId}__\n`));
          });
          return;
        }

        const commandId = extractMarkerId(payload, '__MCP_BEGIN__');
        if (commandId) {
          setImmediate(() => {
            channel.emit(
              'data',
              Buffer.from(
                `prompt\r\n__MCP_BEGIN__${commandId}__\r\nhello\nwarning\n__MCP_END__${commandId}__RC__0__\r\n$ `,
              ),
            );
          });
        }
      });

      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onShell: ({ callback }) => callback(undefined, channel),
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        shell: createPasswordConfig({
          transportMode: 'shell',
        }),
      });

      const result = await manager.executeCommand(
        'printf "hello\\nwarning\\n"',
        '/tmp/work dir',
        'shell',
      );

      assert.strictEqual(result, 'hello\nwarning');
      assert.match(seenScript, /cd -- '\/tmp\/work dir' && \{ printf "hello\\nwarning\\n"; \}/);
    });

    it('shell 模式会清理 ANSI 和终端标题噪音', async () => {
      const channel = new FakeShellChannel();

      channel.on('write', (payload) => {
        const readyId = extractMarkerId(payload, '__MCP_READY__');
        if (readyId) {
          setImmediate(() => {
            channel.emit('data', Buffer.from(`__MCP_READY__${readyId}__\n`));
          });
          return;
        }

        const commandId = extractMarkerId(payload, '__MCP_BEGIN__');
        if (commandId) {
          setImmediate(() => {
            channel.emit(
              'data',
              Buffer.from(
                `__MCP_BEGIN__${commandId}__\r\n\u001b]0;host:~\u0007hello\r\n\u001b[?1034hworld\r\n__MCP_END__${commandId}__RC__0__\r\n\u001b]0;host:~\u0007`,
              ),
            );
          });
        }
      });

      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onShell: ({ callback }) => callback(undefined, channel),
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        shell: createPasswordConfig({
          transportMode: 'shell',
        }),
      });

      const result = await manager.executeCommand('echo hello', undefined, 'shell');
      assert.strictEqual(result, 'hello\nworld');
    });

    it('shell 模式会剥离开头残留的 BEGIN marker', async () => {
      const channel = new FakeShellChannel();

      channel.on('write', (payload) => {
        const readyId = extractMarkerId(payload, '__MCP_READY__');
        if (readyId) {
          setImmediate(() => {
            channel.emit('data', Buffer.from(`__MCP_READY__${readyId}__\n`));
          });
          return;
        }

        const commandId = extractMarkerId(payload, '__MCP_BEGIN__');
        if (commandId) {
          setImmediate(() => {
            channel.emit(
              'data',
              Buffer.from(
                `__MCP_BEGIN__${commandId}__\r\nhello\r\n__MCP_END__${commandId}__RC__0__\r\n`,
              ),
            );
          });
        }
      });

      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onShell: ({ callback }) => callback(undefined, channel),
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        shell: createPasswordConfig({
          transportMode: 'shell',
        }),
      });

      const result = await manager.executeCommand('echo hello', undefined, 'shell');
      assert.strictEqual(result, 'hello');
    });

    it('shell 模式能正确识别非零退出码', async () => {
      const channel = new FakeShellChannel();

      channel.on('write', (payload) => {
        const readyId = extractMarkerId(payload, '__MCP_READY__');
        if (readyId) {
          setImmediate(() => {
            channel.emit('data', Buffer.from(`__MCP_READY__${readyId}__\n`));
          });
          return;
        }

        const commandId = extractMarkerId(payload, '__MCP_BEGIN__');
        if (commandId) {
          setImmediate(() => emitShellCommandResult(channel, commandId, 'failed', 7));
        }
      });

      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onShell: ({ callback }) => callback(undefined, channel),
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        shell: createPasswordConfig({
          transportMode: 'shell',
        }),
      });

      await assert.rejects(
        () => manager.executeCommand('false', undefined, 'shell'),
        (error) => {
          assert.ok(error instanceof ToolError);
          assert.strictEqual(error.code, 'COMMAND_EXECUTION_ERROR');
          assert.match(error.message, /failed/);
          assert.match(error.message, /\[exit code\] 7/);
          return true;
        },
      );
    });

    it('shell 模式超时会返回固定错误', async () => {
      const channel = new FakeShellChannel();

      channel.on('write', (payload) => {
        const readyId = extractMarkerId(payload, '__MCP_READY__');
        if (readyId) {
          setImmediate(() => {
            channel.emit('data', Buffer.from(`__MCP_READY__${readyId}__\n`));
          });
        }
      });

      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onShell: ({ callback }) => callback(undefined, channel),
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        shell: createPasswordConfig({
          transportMode: 'shell',
        }),
      });

      await manager.connect('shell');

      await assert.rejects(
        () => manager.executeCommand('sleep 10', undefined, 'shell', { timeout: 20 }),
        (error) => {
          assert.ok(error instanceof ToolError);
          assert.strictEqual(error.code, 'COMMAND_TIMEOUT');
          assert.match(error.message, /timed out after 20ms/);
          return true;
        },
      );

      await delay(0);
      assert.strictEqual(manager.getAllServerInfos()[0].connected, false);
    });

    it('shell 模式下 upload/download 返回 UNSUPPORTED_IN_SHELL_MODE', async () => {
      manager.setConfig({
        shell: createPasswordConfig({
          transportMode: 'shell',
        }),
      });

      await assert.rejects(
        () => manager.upload('/tmp/a.txt', '/remote/a.txt', 'shell'),
        (error) => {
          assert.ok(error instanceof ToolError);
          assert.strictEqual(error.code, 'UNSUPPORTED_IN_SHELL_MODE');
          return true;
        },
      );

      await assert.rejects(
        () => manager.download('/remote/a.txt', '/tmp/a.txt', 'shell'),
        (error) => {
          assert.ok(error instanceof ToolError);
          assert.strictEqual(error.code, 'UNSUPPORTED_IN_SHELL_MODE');
          return true;
        },
      );
    });
  });

  describe('Exec transport regression', () => {
    it('exec 模式原有行为不变', async () => {
      const stream = new FakeExecStream();
      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onExec: ({ command, options, callback }) => {
          assert.strictEqual(command, "cd -- '/tmp' && pwd");
          assert.deepStrictEqual(options, { pty: true });
          callback(undefined, stream);
          setImmediate(() => {
            stream.emit('data', Buffer.from('/tmp\n'));
            stream.emit('exit', 0);
            stream.emit('close', 0);
          });
        },
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        exec: createPasswordConfig({
          name: 'exec',
          transportMode: 'exec',
        }),
      });

      const result = await manager.executeCommand('pwd', '/tmp', 'exec');
      assert.strictEqual(result, '/tmp');
      assert.strictEqual(client.shellCalls.length, 0);
      assert.strictEqual(client.execCalls.length, 1);
    });

    it('命令成功时保留 stderr 而不是丢弃', async () => {
      const stream = new FakeExecStream();
      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onExec: ({ callback }) => {
          callback(undefined, stream);
          setImmediate(() => {
            stream.emit('data', Buffer.from('out-line\n'));
            stream.stderr.emit('data', Buffer.from('warn-line\n'));
            stream.emit('exit', 0);
            stream.emit('close', 0);
          });
        },
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        exec: createPasswordConfig({
          name: 'exec',
          transportMode: 'exec',
          pty: false,
        }),
      });

      const result = await manager.executeCommand('cmd', undefined, 'exec');
      assert.strictEqual(result, 'out-line\n[stderr]\nwarn-line');
    });

    it('命令成功且无 stderr 时输出保持原样', async () => {
      const stream = new FakeExecStream();
      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onExec: ({ callback }) => {
          callback(undefined, stream);
          setImmediate(() => {
            stream.emit('data', Buffer.from('only-stdout\n'));
            stream.emit('exit', 0);
            stream.emit('close', 0);
          });
        },
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        exec: createPasswordConfig({ name: 'exec', transportMode: 'exec' }),
      });

      const result = await manager.executeCommand('cmd', undefined, 'exec');
      assert.strictEqual(result, 'only-stdout');
    });

    it('输出超过 maxOutputBytes 时截断并中止命令', async () => {
      const stream = new FakeExecStream();
      let closeCalls = 0;
      stream.close = function close() {
        closeCalls += 1;
        this.emit('close');
      };

      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onExec: ({ callback }) => {
          callback(undefined, stream);
          setImmediate(() => {
            stream.emit('data', Buffer.from('abcdefghij'));
          });
        },
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        exec: createPasswordConfig({
          name: 'exec',
          transportMode: 'exec',
          maxOutputBytes: 8,
        }),
      });

      await assert.rejects(
        () => manager.executeCommand('cmd', undefined, 'exec'),
        (error) => {
          assert.ok(error instanceof ToolError);
          assert.strictEqual(error.code, 'OUTPUT_LIMIT_EXCEEDED');
          assert.strictEqual(error.retriable, false);
          assert.strictEqual(
            error.message,
            'abcdefgh\n[truncated] Output exceeded maxOutputBytes=8; the command was aborted.',
          );
          return true;
        },
      );
      assert.strictEqual(closeCalls, 1);
    });

    it('maxOutputBytes 为 0 时不限制输出', async () => {
      const stream = new FakeExecStream();
      const payload = 'x'.repeat(4096);
      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onExec: ({ callback }) => {
          callback(undefined, stream);
          setImmediate(() => {
            stream.emit('data', Buffer.from(payload));
            stream.emit('exit', 0);
            stream.emit('close', 0);
          });
        },
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        exec: createPasswordConfig({
          name: 'exec',
          transportMode: 'exec',
          maxOutputBytes: 0,
        }),
      });

      const result = await manager.executeCommand('cmd', undefined, 'exec');
      assert.strictEqual(result, payload);
    });

    it('exec channel 打不开时会按命令超时失效连接', async () => {
      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onExec: () => {
          // Simulate a half-open SSH transport where openChannel never calls back.
        },
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        exec: createPasswordConfig({
          name: 'exec',
          transportMode: 'exec',
        }),
      });

      await assert.rejects(
        () => manager.executeCommand('pwd', undefined, 'exec', { timeout: 20 }),
        (error) => {
          assert.ok(error instanceof ToolError);
          assert.strictEqual(error.code, 'COMMAND_TIMEOUT');
          assert.match(error.message, /Command channel did not open/);
          return true;
        },
      );

      assert.strictEqual(manager.getAllServerInfos()[0].connected, false);
      assert.strictEqual(client.endCalls, 1);
    });

    it('exec 模式使用配置的 commandTimeoutMs 作为默认超时', async () => {
      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onExec: () => {
          // Never calls back, so the command can only end on a timeout.
        },
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        exec: createPasswordConfig({
          name: 'exec',
          transportMode: 'exec',
          commandTimeoutMs: 20,
        }),
      });

      const startedAt = Date.now();
      await assert.rejects(
        // 不传 timeout：默认值必须来自配置，而不是写死的 30000
        () => manager.executeCommand('pwd', undefined, 'exec'),
        (error) => {
          assert.strictEqual(error.code, 'COMMAND_TIMEOUT');
          assert.match(error.message, /within 20ms/);
          return true;
        },
      );
      assert.ok(Date.now() - startedAt < 5000);
    });

    it('调用参数里的 timeout 仍然覆盖 commandTimeoutMs', async () => {
      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onExec: () => {},
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        exec: createPasswordConfig({
          name: 'exec',
          transportMode: 'exec',
          commandTimeoutMs: 900000,
        }),
      });

      await assert.rejects(
        () => manager.executeCommand('pwd', undefined, 'exec', { timeout: 20 }),
        (error) => {
          assert.match(error.message, /within 20ms/);
          return true;
        },
      );
    });

    it('SFTP open 卡住时会按 sftpTimeoutMs 失效连接', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-test-'));
      const localFile = path.join(tempDir, 'upload.txt');
      fs.writeFileSync(localFile, 'data');

      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onSftp: () => {
          // Simulate a half-open SSH transport where SFTP never calls back.
        },
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        exec: createPasswordConfig({
          name: 'exec',
          transportMode: 'exec',
          allowedLocalPaths: [tempDir],
          sftpTimeoutMs: 20,
        }),
      });

      await assert.rejects(
        () => manager.upload(localFile, '/tmp/upload.txt', 'exec'),
        (error) => {
          assert.ok(error instanceof ToolError);
          assert.strictEqual(error.code, 'OPERATION_TIMEOUT');
          assert.match(error.message, /SFTP open timed out/);
          return true;
        },
      );

      assert.strictEqual(manager.getAllServerInfos()[0].connected, false);
      assert.strictEqual(client.endCalls, 1);
    });

    it('SFTP upload 传输超时时保留 OPERATION_TIMEOUT 错误码', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-test-'));
      const localFile = path.join(tempDir, 'upload.txt');
      fs.writeFileSync(localFile, 'data');

      const hangingWriteStream = new Writable({
        write(_chunk, _encoding, _callback) {
          // Simulate a half-open transfer where the remote write never completes.
        },
      });
      const sftp = new FakeSftp();
      sftp.createWriteStream = () => hangingWriteStream;

      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onSftp: (callback) => callback(undefined, sftp),
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        exec: createPasswordConfig({
          name: 'exec',
          transportMode: 'exec',
          allowedLocalPaths: [tempDir],
          sftpTimeoutMs: 20,
        }),
      });

      await assert.rejects(
        () => manager.upload(localFile, '/tmp/upload.txt', 'exec'),
        (error) => {
          assert.ok(error instanceof ToolError);
          assert.strictEqual(error.code, 'OPERATION_TIMEOUT');
          assert.match(error.message, /SFTP upload timed out/);
          return true;
        },
      );

      assert.strictEqual(manager.getAllServerInfos()[0].connected, false);
      assert.strictEqual(client.endCalls, 1);
    });

    it('exec 模式应用 commandTemplate 包裹命令', async () => {
      const stream = new FakeExecStream();
      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onExec: ({ command, options, callback }) => {
          assert.strictEqual(
            command,
            `su root -c ${shellQuoteForTest("cd -- '/app' && ls")}`,
          );
          callback(undefined, stream);
          setImmediate(() => {
            stream.emit('data', Buffer.from('file.txt\n'));
            stream.emit('exit', 0);
            stream.emit('close', 0);
          });
        },
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        tmpl: createPasswordConfig({
          name: 'tmpl',
          transportMode: 'exec',
          commandTemplate: "su root -c '<command>'",
        }),
      });

      const result = await manager.executeCommand('ls', '/app', 'tmpl');
      assert.strictEqual(result, 'file.txt');
    });

    it('commandTemplate 会安全包裹含单引号的工作目录', async () => {
      const stream = new FakeExecStream();
      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onExec: ({ command, callback }) => {
          assert.strictEqual(
            command,
            `su root -c ${shellQuoteForTest("cd -- '/tmp/it'\\''s' && ls")}`,
          );
          callback(undefined, stream);
          setImmediate(() => {
            stream.emit('data', Buffer.from('done\n'));
            stream.emit('exit', 0);
            stream.emit('close', 0);
          });
        },
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        tmplQuote: createPasswordConfig({
          name: 'tmplQuote',
          transportMode: 'exec',
          commandTemplate: "su root -c '<command>'",
        }),
      });

      const result = await manager.executeCommand('ls', "/tmp/it's", 'tmplQuote');
      assert.strictEqual(result, 'done');
    });

    it('exec 模式无 directory 时 commandTemplate 仅包裹原始命令', async () => {
      const stream = new FakeExecStream();
      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onExec: ({ command, options, callback }) => {
          assert.strictEqual(command, "su root -c 'whoami'");
          callback(undefined, stream);
          setImmediate(() => {
            stream.emit('data', Buffer.from('root\n'));
            stream.emit('exit', 0);
            stream.emit('close', 0);
          });
        },
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        tmpl2: createPasswordConfig({
          name: 'tmpl2',
          transportMode: 'exec',
          commandTemplate: "su root -c '<command>'",
        }),
      });

      const result = await manager.executeCommand('whoami', undefined, 'tmpl2');
      assert.strictEqual(result, 'root');
    });

    it('commandTemplate 不解释 $& 等 replace 特殊序列', async () => {
      const stream = new FakeExecStream();
      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onExec: ({ command, callback }) => {
          assert.strictEqual(command, "su root -c 'echo $& test'");
          callback(undefined, stream);
          setImmediate(() => {
            stream.emit('data', Buffer.from('ok\n'));
            stream.emit('exit', 0);
            stream.emit('close', 0);
          });
        },
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        tmpl3: createPasswordConfig({
          name: 'tmpl3',
          transportMode: 'exec',
          commandTemplate: "su root -c '<command>'",
        }),
      });

      const result = await manager.executeCommand('echo $& test', undefined, 'tmpl3');
      assert.strictEqual(result, 'ok');
    });

    it('directory 中的命令替换字符不会被 shell 展开', async () => {
      const stream = new FakeExecStream();
      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onExec: ({ command, callback }) => {
          assert.strictEqual(
            command,
            "cd -- '$(rm -rf /tmp/x)' && ls",
          );
          callback(undefined, stream);
          setImmediate(() => {
            stream.emit('data', Buffer.from('done\n'));
            stream.emit('exit', 0);
            stream.emit('close', 0);
          });
        },
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        inj: createPasswordConfig({
          name: 'inj',
          transportMode: 'exec',
        }),
      });

      const result = await manager.executeCommand('ls', '$(rm -rf /tmp/x)', 'inj');
      assert.strictEqual(result, 'done');
    });

    it('directory 中的单引号会被正确转义', async () => {
      const stream = new FakeExecStream();
      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onExec: ({ command, callback }) => {
          assert.strictEqual(
            command,
            "cd -- '/tmp/it'\\''s' && ls",
          );
          callback(undefined, stream);
          setImmediate(() => {
            stream.emit('data', Buffer.from('done\n'));
            stream.emit('exit', 0);
            stream.emit('close', 0);
          });
        },
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        quote: createPasswordConfig({
          name: 'quote',
          transportMode: 'exec',
        }),
      });

      const result = await manager.executeCommand('ls', "/tmp/it's", 'quote');
      assert.strictEqual(result, 'done');
    });
  });

  describe('输出解码与上限', () => {
    // Emit `payload` in fixed-size byte slices so multi-byte characters and
    // markers are split across chunk boundaries.
    function emitInByteSlices(emit, payload, sliceSize) {
      const bytes = Buffer.from(payload, 'utf8');
      for (let i = 0; i < bytes.length; i += sliceSize) {
        emit(bytes.subarray(i, i + sliceSize));
      }
    }

    async function connectShell(channel, overrides = {}) {
      channel.on('write', (payload) => {
        const readyId = extractMarkerId(payload, '__MCP_READY__');
        if (readyId) {
          setImmediate(() => {
            channel.emit('data', Buffer.from(`__MCP_READY__${readyId}__\n`));
          });
        }
      });

      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onShell: ({ callback }) => callback(undefined, channel),
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        shell: createPasswordConfig({ transportMode: 'shell', ...overrides }),
      });

      await manager.connect('shell');
      return client;
    }

    it('exec 模式跨块的多字节字符不会损坏', async () => {
      const text = '中文输出测试内容';
      const stream = new FakeExecStream();
      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onExec: ({ callback }) => {
          callback(undefined, stream);
          setImmediate(() => {
            emitInByteSlices(
              (slice) => stream.emit('data', slice),
              text,
              5,
            );
            stream.emit('exit', 0);
            stream.emit('close', 0);
          });
        },
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        exec: createPasswordConfig({ name: 'exec', transportMode: 'exec' }),
      });

      assert.strictEqual(
        await manager.executeCommand('cat zh.txt', undefined, 'exec'),
        text,
      );
    });

    it('shell 模式跨块的多字节字符与 marker 都能正确还原', async () => {
      const text = '中文输出测试内容';
      const channel = new FakeShellChannel();
      let commandId;
      channel.on('write', (payload) => {
        commandId = extractMarkerId(payload, '__MCP_BEGIN__') ?? commandId;
      });

      await connectShell(channel);
      const pending = manager.executeCommand('cat zh.txt', undefined, 'shell');
      await delay(0);

      // 5 字节一片：既切断多字节字符，也切断 marker 本身
      emitInByteSlices(
        (slice) => channel.emit('data', slice),
        `__MCP_BEGIN__${commandId}__\r\n${text}\n__MCP_END__${commandId}__RC__0__\r\n`,
        5,
      );

      assert.strictEqual(await pending, text);
    });

    it('shell 模式 marker 逐字节到达仍能识别', async () => {
      const channel = new FakeShellChannel();
      let commandId;
      channel.on('write', (payload) => {
        commandId = extractMarkerId(payload, '__MCP_BEGIN__') ?? commandId;
      });

      await connectShell(channel);
      const pending = manager.executeCommand('echo hi', undefined, 'shell');
      await delay(0);

      emitInByteSlices(
        (slice) => channel.emit('data', slice),
        `__MCP_BEGIN__${commandId}__\r\nhi\n__MCP_END__${commandId}__RC__0__\r\n`,
        1,
      );

      assert.strictEqual(await pending, 'hi');
    });

    it('shell 模式退出码晚于 marker 前缀到达仍能识别', async () => {
      const channel = new FakeShellChannel();
      let commandId;
      channel.on('write', (payload) => {
        commandId = extractMarkerId(payload, '__MCP_BEGIN__') ?? commandId;
      });

      await connectShell(channel);
      const pending = manager.executeCommand('false', undefined, 'shell');
      await delay(0);

      channel.emit(
        'data',
        Buffer.from(`__MCP_BEGIN__${commandId}__\r\noops\n__MCP_END__${commandId}__RC__`),
      );
      await delay(0);
      channel.emit('data', Buffer.from('3__\r\n'));

      await assert.rejects(pending, (error) => {
        assert.strictEqual(error.code, 'COMMAND_EXECUTION_ERROR');
        assert.match(error.message, /\[exit code\] 3/);
        return true;
      });
    });

    it('shell 模式超出 maxOutputBytes 会中止命令并失效连接', async () => {
      const channel = new FakeShellChannel();
      let commandId;
      channel.on('write', (payload) => {
        commandId = extractMarkerId(payload, '__MCP_BEGIN__') ?? commandId;
      });

      const client = await connectShell(channel, { maxOutputBytes: 1024 });
      const pending = manager.executeCommand('yes', undefined, 'shell');
      await delay(0);

      channel.emit('data', Buffer.from(`__MCP_BEGIN__${commandId}__\r\n`));
      channel.emit('data', Buffer.alloc(4096, 0x78));

      await assert.rejects(pending, (error) => {
        assert.ok(error instanceof ToolError);
        assert.strictEqual(error.code, 'OUTPUT_LIMIT_EXCEEDED');
        assert.match(error.message, /maxOutputBytes=1024/);
        return true;
      });

      assert.strictEqual(manager.getAllServerInfos()[0].connected, false);
      assert.strictEqual(client.endCalls, 1);
    });

    it('shell 模式只统计 marker 之间的命令输出字节', async () => {
      const channel = new FakeShellChannel();
      let commandId;
      channel.on('write', (payload) => {
        commandId = extractMarkerId(payload, '__MCP_BEGIN__') ?? commandId;
      });

      await connectShell(channel, { maxOutputBytes: 1 });
      const pending = manager.executeCommand('printf x', undefined, 'shell');
      await delay(0);

      // BEGIN/END markers and the wrapper's CRLF are protocol framing. Only
      // the single "x" byte should count against the one-byte limit.
      emitInByteSlices(
        (slice) => channel.emit('data', slice),
        `__MCP_BEGIN__${commandId}__\r\nx\r\n__MCP_END__${commandId}__RC__0__\r\n`,
        3,
      );

      assert.strictEqual(await pending, 'x');
    });
  });

  describe('SFTP 并发传输', () => {
    const FAST_MIN_BYTES = 256 * 1024;

    function setupTransfer(sftp) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-xfer-'));
      const client = new FakeClient({
        onConnect: () => setImmediate(() => client.emit('ready')),
        onSftp: (callback) => callback(undefined, sftp),
      });

      manager.createClient = () => client;
      manager.scheduleStatusCollection = () => {};
      manager.setConfig({
        exec: createPasswordConfig({
          name: 'exec',
          transportMode: 'exec',
          allowedLocalPaths: [tempDir],
        }),
      });

      return tempDir;
    }

    it('小文件上传仍走顺序流，不触发 fastPut', async () => {
      const sftp = new FakeTransferSftp({ statSizes: [0] });
      const tempDir = setupTransfer(sftp);
      const localFile = path.join(tempDir, 'small.bin');
      fs.writeFileSync(localFile, Buffer.alloc(1024, 7));

      await manager.upload(localFile, '/remote/small.bin', 'exec');

      assert.strictEqual(sftp.fastPutCalls.length, 0);
      assert.strictEqual(sftp.writeStreamCalls.length, 1);
      assert.strictEqual(
        Buffer.concat(sftp.uploadedChunks).length,
        1024,
      );
    });

    it('大文件上传使用 fastPut 并发传输', async () => {
      const sftp = new FakeTransferSftp({ statSizes: [FAST_MIN_BYTES] });
      const tempDir = setupTransfer(sftp);
      const localFile = path.join(tempDir, 'big.bin');
      fs.writeFileSync(localFile, Buffer.alloc(FAST_MIN_BYTES, 7));

      await manager.upload(localFile, '/remote/big.bin', 'exec');

      assert.strictEqual(sftp.fastPutCalls.length, 1);
      assert.strictEqual(sftp.writeStreamCalls.length, 0);
      assert.strictEqual(sftp.fastPutCalls[0].options.concurrency, 64);
      assert.strictEqual(sftp.fastPutCalls[0].options.chunkSize, 32 * 1024);
    });

    // fastGet plans its chunks from the reported size and treats 0 as "nothing
    // to transfer" while still reporting success, so /proc-style pseudo files
    // must never reach it.
    it('远端 size 为 0 的伪文件走顺序流并拿到真实内容', async () => {
      const content = Buffer.from('processor\t: 0\nmodel name\t: fake\n');
      const sftp = new FakeTransferSftp({
        statSizes: [0],
        remoteContent: content,
      });
      const tempDir = setupTransfer(sftp);
      const localFile = path.join(tempDir, 'cpuinfo');

      await manager.download('/proc/cpuinfo', localFile, 'exec');

      assert.strictEqual(sftp.fastGetCalls.length, 0);
      assert.deepStrictEqual(fs.readFileSync(localFile), content);
    });

    it('远端目录不会走 fastGet', async () => {
      const sftp = new FakeTransferSftp({
        statSizes: [FAST_MIN_BYTES],
        isFile: false,
        remoteContent: Buffer.alloc(0),
      });
      const tempDir = setupTransfer(sftp);

      await manager.download('/remote/dir', path.join(tempDir, 'dir'), 'exec');

      assert.strictEqual(sftp.fastGetCalls.length, 0);
      assert.strictEqual(sftp.readStreamCalls.length, 1);
    });

    it('大文件下载使用 fastGet 并发传输', async () => {
      const content = Buffer.alloc(FAST_MIN_BYTES, 3);
      const sftp = new FakeTransferSftp({
        statSizes: [FAST_MIN_BYTES],
        remoteContent: content,
      });
      const tempDir = setupTransfer(sftp);
      const localFile = path.join(tempDir, 'big.bin');

      await manager.download('/remote/big.bin', localFile, 'exec');

      assert.strictEqual(sftp.fastGetCalls.length, 1);
      assert.strictEqual(sftp.readStreamCalls.length, 0);
      assert.deepStrictEqual(fs.readFileSync(localFile), content);
    });

    it('下载期间远端文件增长时补齐尾部', async () => {
      const head = Buffer.alloc(FAST_MIN_BYTES, 1);
      const tail = Buffer.from('appended-while-downloading');
      const content = Buffer.concat([head, tail]);
      const sftp = new FakeTransferSftp({
        // 第一次 stat 决定走 fastGet，第二次 stat 时文件已变长。
        statSizes: [head.length, content.length],
        remoteContent: content,
        fastGetBytes: head.length,
      });
      const tempDir = setupTransfer(sftp);
      const localFile = path.join(tempDir, 'growing.log');

      await manager.download('/remote/growing.log', localFile, 'exec');

      assert.strictEqual(sftp.fastGetCalls.length, 1);
      assert.deepStrictEqual(sftp.readStreamCalls[0].options.start, head.length);
      assert.deepStrictEqual(fs.readFileSync(localFile), content);
    });
  });
});
