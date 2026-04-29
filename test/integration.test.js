import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { CommandLineParser } from '../build/cli/command-line-parser.js';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures');

describe('集成测试', () => {
  let originalArgv;

  before(() => {
    originalArgv = process.argv;

    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }
  });

  after(() => {
    process.argv = originalArgv;
  });

  describe('端到端场景', () => {
    it('应该能够从命令行参数创建完整配置并传递给连接管理器', () => {
      process.argv = [
        'node',
        'test',
        '--host', '192.168.1.100',
        '--port', '22',
        '--username', 'testuser',
        '--password', 'testpass',
        '--whitelist', 'ls,cat,grep',
        '--blacklist', 'rm,shutdown'
      ];

      const result = CommandLineParser.parseArgs();

      assert.strictEqual(result.configs.default.host, '192.168.1.100');
      assert.strictEqual(result.configs.default.port, 22);
      assert.strictEqual(result.configs.default.username, 'testuser');
      assert.deepStrictEqual(result.configs.default.commandWhitelist, ['ls', 'cat', 'grep']);
      assert.deepStrictEqual(result.configs.default.commandBlacklist, ['rm', 'shutdown']);

      // 验证可以用这个配置初始化连接管理器
      const manager = SSHConnectionManager.getInstance();
      manager.setConfig(result.configs);

      const config = manager.getConfig('default');
      assert.strictEqual(config.host, '192.168.1.100');
      assert.strictEqual(config.username, 'testuser');
    });

    it('应该能够从命令行参数生成 shell transport 配置', () => {
      process.argv = [
        'node',
        'test',
        '--host', '192.168.1.110',
        '--port', '22',
        '--username', 'shelluser',
        '--password', 'shellpass',
        '--transport-mode', 'shell',
        '--shell-ready-timeout', '18000'
      ];

      const result = CommandLineParser.parseArgs();
      assert.strictEqual(result.configs.default.transportMode, 'shell');
      assert.strictEqual(result.configs.default.shellReadyTimeoutMs, 18000);

      const manager = SSHConnectionManager.getInstance();
      manager.setConfig(result.configs);

      const config = manager.getConfig('default');
      assert.strictEqual(config.transportMode, 'shell');
      assert.strictEqual(config.shellReadyTimeoutMs, 18000);
    });

    it('应该能够从 SSH config 创建完整配置', () => {
      const tempSshConfig = path.join(fixturesDir, 'integration-ssh-config');
      fs.writeFileSync(tempSshConfig, [
        'Host integration-test',
        '    HostName 192.168.1.200',
        '    Port 2222',
        '    User integrationuser',
        '    IdentityFile ~/.ssh/integration_key',
      ].join('\n'));

      try {
        process.argv = [
          'node',
          'test',
          '--host', 'integration-test',
          '--ssh-config-file', tempSshConfig
        ];

        const result = CommandLineParser.parseArgs();

        assert.strictEqual(result.configs.default.host, '192.168.1.200');
        assert.strictEqual(result.configs.default.port, 2222);
        assert.strictEqual(result.configs.default.username, 'integrationuser');
        assert.ok(result.configs.default.privateKey.includes('integration_key'));

        // 验证可以用这个配置初始化连接管理器
        const manager = SSHConnectionManager.getInstance();
        manager.setConfig(result.configs);

        const config = manager.getConfig('default');
        assert.strictEqual(config.host, '192.168.1.200');
      } finally {
        fs.unlinkSync(tempSshConfig);
      }
    });

    it('应该能够处理多服务器配置', () => {
      const tempConfig = path.join(fixturesDir, 'multi-server-config.json');
      fs.writeFileSync(tempConfig, JSON.stringify({
        server1: {
          host: '192.168.1.1',
          port: 22,
          username: 'user1',
          password: 'pass1',
          commandWhitelist: ['^ls', '^cat']
        },
        server2: {
          host: '192.168.1.2',
          port: 2222,
          username: 'user2',
          privateKey: '~/.ssh/key2',
          commandBlacklist: ['^rm', '^shutdown']
        }
      }));

      try {
        process.argv = ['node', 'test', '--config-file', tempConfig];

        const result = CommandLineParser.parseArgs();
        assert.strictEqual(Object.keys(result.configs).length, 2);

        const manager = SSHConnectionManager.getInstance();
        manager.setConfig(result.configs);

        // 验证配置列表
        const allInfos = manager.getAllServerInfos();
        assert.strictEqual(allInfos.length, 2);

        const server1 = allInfos.find(i => i.name === 'server1');
        assert.ok(server1);
        assert.strictEqual(server1.host, '192.168.1.1');
        assert.strictEqual(server1.connected, false);

        const server2 = allInfos.find(i => i.name === 'server2');
        assert.ok(server2);
        assert.strictEqual(server2.port, 2222);
      } finally {
        fs.unlinkSync(tempConfig);
      }
    });

    it('应该能够从配置文件生成 shell transport 配置', () => {
      const tempConfig = path.join(fixturesDir, 'shell-server-config.json');
      fs.writeFileSync(tempConfig, JSON.stringify({
        shellbox: {
          host: '192.168.1.20',
          port: 22,
          username: 'shelluser',
          password: 'shellpass',
          transportMode: 'shell',
          shellReadyTimeoutMs: 12000
        }
      }));

      try {
        process.argv = ['node', 'test', '--config-file', tempConfig];

        const result = CommandLineParser.parseArgs();
        assert.strictEqual(result.configs.shellbox.transportMode, 'shell');
        assert.strictEqual(result.configs.shellbox.shellReadyTimeoutMs, 12000);

        const manager = SSHConnectionManager.getInstance();
        manager.setConfig(result.configs);

        const config = manager.getConfig('shellbox');
        assert.strictEqual(config.transportMode, 'shell');
        assert.strictEqual(config.shellReadyTimeoutMs, 12000);
      } finally {
        fs.unlinkSync(tempConfig);
      }
    });
  });

  describe('错误处理', () => {
    it('应该正确处理无效的 JSON 配置文件', () => {
      const invalidConfig = path.join(fixturesDir, 'invalid-config.json');
      fs.writeFileSync(invalidConfig, '{ invalid json }');

      try {
        process.argv = ['node', 'test', '--config-file', invalidConfig];
        assert.throws(() => {
          CommandLineParser.parseArgs();
        }, /Invalid JSON/);
      } finally {
        fs.unlinkSync(invalidConfig);
      }
    });

    it('应该正确处理缺少必需字段的配置', () => {
      const incompleteConfig = path.join(fixturesDir, 'incomplete-config.json');
      fs.writeFileSync(incompleteConfig, JSON.stringify({
        server1: {
          host: '192.168.1.1'
          // 缺少 port, username 等必需字段
        }
      }));

      try {
        process.argv = ['node', 'test', '--config-file', incompleteConfig];
        assert.throws(() => {
          CommandLineParser.parseArgs();
        });
      } finally {
        fs.unlinkSync(incompleteConfig);
      }
    });

    it('应该正确处理不存在的配置文件', () => {
      process.argv = ['node', 'test', '--config-file', '/nonexistent/config.json'];
      assert.throws(() => {
        CommandLineParser.parseArgs();
      }, /not found/);
    });

    it('应该正确处理缺少认证参数的情况', () => {
      const emptySshConfig = path.join(fixturesDir, 'empty-ssh-config');
      fs.writeFileSync(emptySshConfig, '');

      try {
        process.argv = [
          'node',
          'test',
          '--host', '1.2.3.4',
          '--port', '22',
          '--username', 'user',
          '--ssh-config-file', emptySshConfig
        ];
        assert.throws(() => {
          CommandLineParser.parseArgs();
        }, /Missing required parameters/);
      } finally {
        fs.unlinkSync(emptySshConfig);
      }
    });

    it('应该正确处理无效的端口号', () => {
      process.argv = ['node', 'test', '--host', '1.2.3.4', '--port', 'abc', '--username', 'user', '--password', 'pass'];
      assert.throws(() => {
        CommandLineParser.parseArgs();
      }, /Port must be a valid number/);
    });
  });
});
