import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
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
      manager.setConfig({
        dev: createPasswordConfig({
          name: 'dev',
          allowedLocalPaths: ['/tmp'],
        }),
      });

      assert.throws(() => manager.validateLocalPath('/etc/passwd'), ToolError);
      assert.strictEqual(manager.validateLocalPath('/tmp/test.txt'), '/tmp/test.txt');
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

    it('本地路径校验应拒绝通过符号链接逃出允许目录', () => {
      const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-allowed-'));
      const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-mcp-outside-'));
      const outsideFile = path.join(outsideRoot, 'secret.txt');
      const symlinkPath = path.join(allowedRoot, 'link');

      try {
        fs.writeFileSync(outsideFile, 'secret');
        fs.symlinkSync(outsideRoot, symlinkPath, 'dir');

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
          commandWhitelist: ['^echo$'],
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
      assert.ok(seenCalls.every((call) => call.options === undefined));
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
});
