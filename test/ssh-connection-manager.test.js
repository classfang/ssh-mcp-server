import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';
import { ToolError } from '../build/utils/tool-error.js';

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
      assert.match(seenScript, /cd -- "\/tmp\/work dir" && \{ printf "hello\\nwarning\\n"; \}/);
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
          assert.strictEqual(command, 'cd -- "/tmp" && pwd');
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
  });
});
