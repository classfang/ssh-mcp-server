import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { lookupSshConfig } from '../build/utils/ssh-config-parser.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures');

describe('SSH Config Parser', () => {
  let testConfigPath;
  let testConfigWithIncludePath;
  let includedConfigPath;
  let originalHome;

  before(() => {
    originalHome = process.env.HOME;
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }

    testConfigPath = path.join(fixturesDir, 'ssh-config-basic');
    testConfigWithIncludePath = path.join(fixturesDir, 'ssh-config-include');
    includedConfigPath = path.join(fixturesDir, 'ssh-config-included');

    // 基本测试配置
    fs.writeFileSync(testConfigPath, [
      '# 多别名测试',
      'Host dev staging',
      '    HostName 192.168.1.100',
      '    Port 2222',
      '    User devuser',
      '    IdentityFile ~/.ssh/dev_key',
      '',
      '# 单别名测试',
      'Host prod',
      '    HostName 10.0.0.50',
      '    User produser',
      '    IdentityFile ~/.ssh/prod_key',
      '',
      '# 通配符测试',
      'Host *.example.com',
      '    User wildcarduser',
      '    Port 2200',
      '',
      '# 全局默认值',
      'Host *',
      '    Port 22',
      '    User defaultuser',
    ].join('\n'));

    // 被包含的配置文件
    fs.writeFileSync(includedConfigPath, [
      'Host included-host',
      '    HostName 172.16.0.1',
      '    Port 3333',
      '    User includeduser',
    ].join('\n'));

    // 带 Include 的配置文件
    fs.writeFileSync(testConfigWithIncludePath, [
      `Include ${includedConfigPath}`,
      '',
      'Host main-host',
      '    HostName 192.168.1.1',
      '    User mainuser',
      '',
      'Host *',
      '    Port 22',
    ].join('\n'));
  });

  after(() => {
    process.env.HOME = originalHome;
    try {
      fs.unlinkSync(testConfigPath);
      fs.unlinkSync(testConfigWithIncludePath);
      fs.unlinkSync(includedConfigPath);
    } catch (err) {
      // 忽略清理错误
    }
  });

  describe('基本功能', () => {
    it('应该正确解析单个 Host 别名', () => {
      const config = lookupSshConfig('prod', testConfigPath);
      assert.ok(config, '应该返回非 null 的配置');
      assert.strictEqual(config.hostName, '10.0.0.50');
      assert.strictEqual(config.user, 'produser');
      assert.strictEqual(config.identityFile, path.join(os.homedir(), '.ssh', 'prod_key'));
      assert.strictEqual(config.port, 22); // 从 Host * fallback
    });

    it('应该正确解析多别名 Host 行 - dev', () => {
      const config = lookupSshConfig('dev', testConfigPath);
      assert.ok(config, '应该返回非 null 的配置');
      assert.strictEqual(config.hostName, '192.168.1.100');
      assert.strictEqual(config.port, 2222);
      assert.strictEqual(config.user, 'devuser');
    });

    it('应该正确解析多别名 Host 行 - staging', () => {
      const config = lookupSshConfig('staging', testConfigPath);
      assert.ok(config, '应该返回非 null 的配置');
      assert.strictEqual(config.hostName, '192.168.1.100');
      assert.strictEqual(config.port, 2222);
      assert.strictEqual(config.user, 'devuser');
    });

    it('应该支持通配符匹配', () => {
      const config = lookupSshConfig('server.example.com', testConfigPath);
      assert.ok(config, '应该返回非 null 的配置');
      assert.strictEqual(config.user, 'wildcarduser');
      assert.strictEqual(config.port, 2200);
    });

    it('应该使用 Host * 作为默认值', () => {
      const config = lookupSshConfig('unknown-host', testConfigPath);
      assert.ok(config, '应该返回非 null 的配置');
      assert.strictEqual(config.user, 'defaultuser');
      assert.strictEqual(config.port, 22);
      assert.strictEqual(config.hostName, undefined);
    });
  });

  describe('Include 指令', () => {
    it('应该正确处理 Include 指令', () => {
      const config = lookupSshConfig('included-host', testConfigWithIncludePath);
      assert.ok(config, '应该返回非 null 的配置');
      assert.strictEqual(config.hostName, '172.16.0.1');
      assert.strictEqual(config.port, 3333);
      assert.strictEqual(config.user, 'includeduser');
    });

    it('应该在 Include 后继续解析主配置文件', () => {
      const config = lookupSshConfig('main-host', testConfigWithIncludePath);
      assert.ok(config, '应该返回非 null 的配置');
      assert.strictEqual(config.hostName, '192.168.1.1');
      assert.strictEqual(config.user, 'mainuser');
      assert.strictEqual(config.port, 22);
    });

    it('应该静默跳过不存在的 Include 文件', () => {
      const tempConfig = path.join(fixturesDir, 'temp-include-config');
      fs.writeFileSync(tempConfig, [
        'Include /nonexistent/path/config',
        '',
        'Host test',
        '    HostName 1.2.3.4',
      ].join('\n'));

      const config = lookupSshConfig('test', tempConfig);
      assert.ok(config, '应该返回非 null 的配置');
      assert.strictEqual(config.hostName, '1.2.3.4');

      fs.unlinkSync(tempConfig);
    });
  });

  describe('边界情况', () => {
    it('默认配置文件不存在时应返回 null', () => {
      const fakeHome = fs.mkdtempSync(path.join(fixturesDir, 'fake-home-'));
      process.env.HOME = fakeHome;

      try {
        const config = lookupSshConfig('any-host');
        assert.strictEqual(config, null);
      } finally {
        process.env.HOME = originalHome;
        fs.rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    it('显式指定的配置文件不存在时应抛出错误', () => {
      assert.throws(() => {
        lookupSshConfig('any-host', '/nonexistent/config');
      }, /not found/);
    });

    it('未找到匹配的 Host 时应返回 null', () => {
      const tempConfig = path.join(fixturesDir, 'empty-config');
      fs.writeFileSync(tempConfig, '# Empty config\n');

      const config = lookupSshConfig('any-host', tempConfig);
      assert.strictEqual(config, null);

      fs.unlinkSync(tempConfig);
    });

    it('应该正确展开 ~ 路径', () => {
      const config = lookupSshConfig('dev', testConfigPath);
      assert.ok(config);
      assert.ok(config.identityFile.startsWith(os.homedir()));
      assert.ok(!config.identityFile.includes('~'));
    });

    it('应该正确处理注释行', () => {
      const tempConfig = path.join(fixturesDir, 'comment-config');
      fs.writeFileSync(tempConfig, [
        '# 这是注释',
        'Host test',
        '    HostName 1.2.3.4 # 行内注释',
        '    Port 2222',
      ].join('\n'));

      const config = lookupSshConfig('test', tempConfig);
      assert.ok(config);
      assert.strictEqual(config.hostName, '1.2.3.4');
      assert.strictEqual(config.port, 2222);

      fs.unlinkSync(tempConfig);
    });

    it('应该正确处理空白行和缩进', () => {
      const tempConfig = path.join(fixturesDir, 'whitespace-config');
      fs.writeFileSync(tempConfig, [
        '',
        '  Host test  ',
        '    HostName   1.2.3.4  ',
        '',
        '    Port   2222  ',
        '',
      ].join('\n'));

      const config = lookupSshConfig('test', tempConfig);
      assert.ok(config);
      assert.strictEqual(config.hostName, '1.2.3.4');
      assert.strictEqual(config.port, 2222);

      fs.unlinkSync(tempConfig);
    });
  });

  describe('First-match-wins 语义', () => {
    it('应该使用第一个匹配的值', () => {
      const tempConfig = path.join(fixturesDir, 'priority-config');
      fs.writeFileSync(tempConfig, [
        'Host test',
        '    Port 2222',
        '    User firstuser',
        '',
        'Host test',
        '    Port 3333',
        '    User seconduser',
        '',
        'Host *',
        '    Port 22',
      ].join('\n'));

      const config = lookupSshConfig('test', tempConfig);
      assert.ok(config);
      assert.strictEqual(config.port, 2222);
      assert.strictEqual(config.user, 'firstuser');

      fs.unlinkSync(tempConfig);
    });

    it('特定 Host 的值应优先于 Host *', () => {
      const tempConfig = path.join(fixturesDir, 'specific-priority-config');
      fs.writeFileSync(tempConfig, [
        'Host specific',
        '    Port 2222',
        '',
        'Host *',
        '    Port 22',
        '    User globaluser',
      ].join('\n'));

      const config = lookupSshConfig('specific', tempConfig);
      assert.ok(config);
      assert.strictEqual(config.port, 2222); // 来自 Host specific
      assert.strictEqual(config.user, 'globaluser'); // 来自 Host *

      fs.unlinkSync(tempConfig);
    });
  });
});
