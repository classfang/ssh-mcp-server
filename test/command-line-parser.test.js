import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { CommandLineParser } from '../build/cli/command-line-parser.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Command Line Parser', () => {
  let originalArgv;
  let testConfigPath;
  let testSshConfigPath;

  before(() => {
    originalArgv = process.argv;

    // 创建测试配置文件
    const fixturesDir = path.join(__dirname, 'fixtures');
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }

    testConfigPath = path.join(fixturesDir, 'test-config.json');
    testSshConfigPath = path.join(fixturesDir, 'test-ssh-config');

    // 创建 JSON 配置文件
    fs.writeFileSync(testConfigPath, JSON.stringify({
      dev: {
        host: '192.168.1.100',
        port: 22,
        username: 'devuser',
        password: 'devpass'
      },
      prod: {
        host: '10.0.0.50',
        port: 22,
        username: 'produser',
        privateKey: '~/.ssh/prod_key'
      }
    }));

    // 创建 SSH 配置文件
    fs.writeFileSync(testSshConfigPath, `
Host testhost
    HostName 172.16.0.1
    Port 2222
    User testuser
    IdentityFile ~/.ssh/test_key
`);
  });

  after(() => {
    process.argv = originalArgv;

    // 清理测试文件
    try {
      fs.unlinkSync(testConfigPath);
      fs.unlinkSync(testSshConfigPath);
      fs.rmdirSync(path.join(__dirname, 'fixtures'));
    } catch (err) {
      // 忽略清理错误
    }
  });

  describe('配置文件解析', () => {
    it('应该正确解析 JSON 配置文件（对象格式）', () => {
      process.argv = ['node', 'test', '--config-file', testConfigPath];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(Object.keys(result.configs).length, 2);
      assert.strictEqual(result.configs.dev.host, '192.168.1.100');
      assert.strictEqual(result.configs.dev.username, 'devuser');
      assert.strictEqual(result.configs.prod.privateKey, '~/.ssh/prod_key');
    });

    it('应该正确解析 JSON 配置文件（数组格式）', () => {
      const arrayConfigPath = path.join(__dirname, 'fixtures', 'array-config.json');
      fs.writeFileSync(arrayConfigPath, JSON.stringify([
        {
          name: 'server1',
          host: '1.2.3.4',
          port: 22,
          username: 'user1',
          password: 'pass1'
        },
        {
          name: 'server2',
          host: '5.6.7.8',
          port: 2222,
          username: 'user2',
          privateKey: '~/.ssh/key2'
        }
      ]));

      process.argv = ['node', 'test', '--config-file', arrayConfigPath];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(Object.keys(result.configs).length, 2);
      assert.strictEqual(result.configs.server1.host, '1.2.3.4');
      assert.strictEqual(result.configs.server2.port, 2222);

      fs.unlinkSync(arrayConfigPath);
    });

    it('配置文件不存在时应抛出错误', () => {
      process.argv = ['node', 'test', '--config-file', '/nonexistent/config.json'];
      assert.throws(() => {
        CommandLineParser.parseArgs();
      }, /not found/);
    });
  });

  describe('--ssh 参数解析', () => {
    it('应该正确解析 JSON 格式的 --ssh 参数', () => {
      const sshJson = JSON.stringify({
        name: 'test',
        host: '1.2.3.4',
        port: 22,
        username: 'testuser',
        password: 'testpass',
        transportMode: 'shell',
        shellReadyTimeoutMs: 15000
      });

      process.argv = ['node', 'test', '--ssh', sshJson];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(result.configs.test.host, '1.2.3.4');
      assert.strictEqual(result.configs.test.username, 'testuser');
      assert.strictEqual(result.configs.test.transportMode, 'shell');
      assert.strictEqual(result.configs.test.shellReadyTimeoutMs, 15000);
    });

    it('应该正确解析旧格式的 --ssh 参数', () => {
      process.argv = ['node', 'test', '--ssh', 'name=legacy,host=1.2.3.4,port=22,user=legacyuser,password=legacypass'];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(result.configs.legacy.host, '1.2.3.4');
      assert.strictEqual(result.configs.legacy.username, 'legacyuser');
    });

    it('应该支持多个 --ssh 参数', () => {
      const ssh1 = JSON.stringify({ name: 'server1', host: '1.1.1.1', port: 22, username: 'user1', password: 'pass1' });
      const ssh2 = JSON.stringify({ name: 'server2', host: '2.2.2.2', port: 22, username: 'user2', password: 'pass2' });

      process.argv = ['node', 'test', '--ssh', ssh1, '--ssh', ssh2];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(Object.keys(result.configs).length, 2);
      assert.strictEqual(result.configs.server1.host, '1.1.1.1');
      assert.strictEqual(result.configs.server2.host, '2.2.2.2');
    });
  });

  describe('单连接模式（旧格式）', () => {
    it('应该正确解析命令行参数', () => {
      process.argv = ['node', 'test', '--host', '1.2.3.4', '--port', '22', '--username', 'testuser', '--password', 'testpass'];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(result.configs.default.host, '1.2.3.4');
      assert.strictEqual(result.configs.default.port, 22);
      assert.strictEqual(result.configs.default.username, 'testuser');
      assert.strictEqual(result.configs.default.password, 'testpass');
    });

    it('应该正确解析位置参数', () => {
      process.argv = ['node', 'test', '1.2.3.4', '22', 'testuser', 'testpass'];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(result.configs.default.host, '1.2.3.4');
      assert.strictEqual(result.configs.default.port, 22);
      assert.strictEqual(result.configs.default.username, 'testuser');
      assert.strictEqual(result.configs.default.password, 'testpass');
    });

    it('应该支持私钥认证', () => {
      process.argv = ['node', 'test', '--host', '1.2.3.4', '--port', '22', '--username', 'testuser', '--privateKey', '~/.ssh/id_rsa'];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(result.configs.default.privateKey, '~/.ssh/id_rsa');
      assert.strictEqual(result.configs.default.password, undefined);
    });

    it('缺少必需参数时应抛出错误', () => {
      process.argv = ['node', 'test', '--host', '1.2.3.4'];
      assert.throws(() => {
        CommandLineParser.parseArgs();
      }, /Missing required parameters/);
    });
  });

  describe('SSH Config 集成', () => {
    it('应该从 SSH config 读取连接参数', () => {
      process.argv = ['node', 'test', '--host', 'testhost', '--ssh-config-file', testSshConfigPath];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(result.configs.default.host, '172.16.0.1');
      assert.strictEqual(result.configs.default.port, 2222);
      assert.strictEqual(result.configs.default.username, 'testuser');
      assert.ok(result.configs.default.privateKey.includes('.ssh/test_key'));
    });

    it('命令行参数应覆盖 SSH config 值', () => {
      process.argv = ['node', 'test', '--host', 'testhost', '--port', '3333', '--ssh-config-file', testSshConfigPath];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(result.configs.default.port, 3333); // 覆盖
      assert.strictEqual(result.configs.default.host, '172.16.0.1'); // 从 SSH config
      assert.strictEqual(result.configs.default.username, 'testuser'); // 从 SSH config
    });

    it('应该支持 SSH config 别名 + 密码认证', () => {
      process.argv = ['node', 'test', '--host', 'testhost', '--password', 'mypass', '--ssh-config-file', testSshConfigPath];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(result.configs.default.password, 'mypass');
      assert.strictEqual(result.configs.default.host, '172.16.0.1');
    });
  });

  describe('命令白名单和黑名单', () => {
    it('应该正确解析命令白名单', () => {
      process.argv = ['node', 'test', '--host', '1.2.3.4', '--port', '22', '--username', 'user', '--password', 'pass', '--whitelist', 'ls,cat,grep'];
      const result = CommandLineParser.parseArgs();

      assert.deepStrictEqual(result.configs.default.commandWhitelist, ['ls', 'cat', 'grep']);
    });

    it('应该正确解析命令黑名单', () => {
      process.argv = ['node', 'test', '--host', '1.2.3.4', '--port', '22', '--username', 'user', '--password', 'pass', '--blacklist', 'rm,shutdown,reboot'];
      const result = CommandLineParser.parseArgs();

      assert.deepStrictEqual(result.configs.default.commandBlacklist, ['rm', 'shutdown', 'reboot']);
    });
  });

  describe('其他选项', () => {
    it('默认 transportMode 应为 exec', () => {
      process.argv = ['node', 'test', '--host', '1.2.3.4', '--port', '22', '--username', 'user', '--password', 'pass'];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(result.configs.default.transportMode, 'exec');
      assert.strictEqual(result.configs.default.shellReadyTimeoutMs, 10000);
    });

    it('应该正确解析 shell transport 相关选项', () => {
      process.argv = [
        'node',
        'test',
        '--host', '1.2.3.4',
        '--port', '22',
        '--username', 'user',
        '--password', 'pass',
        '--transport-mode', 'shell',
        '--shell-ready-timeout', '15000'
      ];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(result.configs.default.transportMode, 'shell');
      assert.strictEqual(result.configs.default.shellReadyTimeoutMs, 15000);
    });

    it('应该正确解析 --pty 选项', () => {
      process.argv = ['node', 'test', '--host', '1.2.3.4', '--port', '22', '--username', 'user', '--password', 'pass', '--pty'];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(result.configs.default.pty, true);
    });

    it('应该正确解析配置文件中的字符串 false pty', () => {
      const ptyConfigPath = path.join(__dirname, 'fixtures', 'pty-config.json');
      fs.writeFileSync(ptyConfigPath, JSON.stringify({
        dev: {
          host: '192.168.1.100',
          port: 22,
          username: 'devuser',
          password: 'devpass',
          pty: 'false'
        }
      }));

      process.argv = ['node', 'test', '--config-file', ptyConfigPath];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(result.configs.dev.pty, false);

      fs.unlinkSync(ptyConfigPath);
    });

    it('应该正确解析 --pre-connect 选项', () => {
      process.argv = ['node', 'test', '--host', '1.2.3.4', '--port', '22', '--username', 'user', '--password', 'pass', '--pre-connect'];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(result.preConnect, true);
    });

    it('应该正确解析 SOCKS 代理', () => {
      process.argv = ['node', 'test', '--host', '1.2.3.4', '--port', '22', '--username', 'user', '--password', 'pass', '--socksProxy', 'socks://proxy:1080'];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(result.configs.default.socksProxy, 'socks://proxy:1080');
    });

    it('应该正确解析 allowed local paths', () => {
      process.argv = ['node', 'test', '--host', '1.2.3.4', '--port', '22', '--username', 'user', '--password', 'pass', '--allowed-local-paths', './tmp,../ssh-mcp-server/test'];
      const result = CommandLineParser.parseArgs();

      assert.ok(Array.isArray(result.configs.default.allowedLocalPaths));
      assert.strictEqual(result.configs.default.allowedLocalPaths.length, 2);
      assert.ok(result.configs.default.allowedLocalPaths.every((entry) => entry.startsWith('/')));
    });
  });

  describe('优先级测试', () => {
    it('配置文件应优先于 --ssh 参数', () => {
      const sshJson = JSON.stringify({ name: 'test', host: '1.1.1.1', port: 22, username: 'user1', password: 'pass1' });
      process.argv = ['node', 'test', '--config-file', testConfigPath, '--ssh', sshJson];
      const result = CommandLineParser.parseArgs();

      // 应该只有配置文件中的服务器
      assert.strictEqual(Object.keys(result.configs).length, 2);
      assert.ok(result.configs.dev);
      assert.ok(result.configs.prod);
      assert.ok(!result.configs.test);
    });

    it('--ssh 参数应优先于单连接模式', () => {
      const sshJson = JSON.stringify({ name: 'test', host: '1.1.1.1', port: 22, username: 'user1', password: 'pass1' });
      process.argv = ['node', 'test', '--ssh', sshJson, '--host', '2.2.2.2', '--port', '22', '--username', 'user2', '--password', 'pass2'];
      const result = CommandLineParser.parseArgs();

      assert.strictEqual(Object.keys(result.configs).length, 1);
      assert.strictEqual(result.configs.test.host, '1.1.1.1');
    });
  });
});
