# 测试文档

本项目使用 Node.js 内置的测试框架进行单元测试和集成测试。

## 测试结构

```
test/
├── ssh-config-parser.test.js      # SSH 配置解析器测试
├── command-line-parser.test.js    # 命令行参数解析器测试
├── ssh-connection-manager.test.js # SSH 连接管理器测试
├── integration.test.js            # 集成测试
└── fixtures/                      # 测试数据（自动生成）
```

## 运行测试

### 运行所有测试

```bash
npm test
```

### 监听模式（开发时使用）

```bash
npm run test:watch
```

监听模式会在文件变化时自动重新运行测试。

### 运行单个测试文件

```bash
node --test test/ssh-config-parser.test.js
```

## 测试覆盖范围

### 1. SSH Config Parser 测试

测试 `src/utils/ssh-config-parser.ts` 的功能：

- ✅ 基本 Host 别名解析
- ✅ 多别名 Host 行（`Host a b c`）
- ✅ 通配符匹配（`Host *.example.com`）
- ✅ `Host *` 默认值 fallback
- ✅ `Include` 指令支持
- ✅ 路径展开（`~` 和相对路径）
- ✅ First-match-wins 语义
- ✅ 错误处理（文件不存在等）

### 2. Command Line Parser 测试

测试 `src/cli/command-line-parser.ts` 的功能：

- ✅ JSON 配置文件解析（对象和数组格式）
- ✅ `--ssh` 参数解析（JSON 和旧格式）
- ✅ 单连接模式（命令行参数和位置参数）
- ✅ SSH config 集成
- ✅ 参数优先级（命令行 > SSH config）
- ✅ 命令白名单和黑名单
- ✅ 其他选项（`--pty`, `--pre-connect`, `--proxy`, `--socksProxy`）
- ✅ 错误处理

### 3. SSH Connection Manager 测试

测试 `src/services/ssh-connection-manager.ts` 的功能：

- ✅ 配置管理（初始化、获取配置）
- ✅ 命令验证（白名单、黑名单、正则表达式）
- ✅ 连接状态管理
- ✅ 多服务器支持

### 4. 集成测试

端到端测试完整流程：

- ✅ 从命令行参数到连接管理器的完整流程
- ✅ 从 SSH config 到连接管理器的完整流程
- ✅ 多服务器配置场景
- ✅ 错误处理（无效配置、缺少字段等）

## 编写新测试

### 测试文件命名

测试文件应该以 `.test.js` 结尾，并放在 `test/` 目录下。

### 测试示例

```javascript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';

describe('功能模块名称', () => {
  before(() => {
    // 测试前的准备工作
  });

  after(() => {
    // 测试后的清理工作
  });

  describe('子功能', () => {
    it('应该做某事', () => {
      // 测试代码
      assert.strictEqual(1 + 1, 2);
    });

    it('应该处理错误情况', () => {
      assert.throws(() => {
        throw new Error('测试错误');
      }, /测试错误/);
    });
  });
});
```

## 测试最佳实践

1. **独立性**：每个测试应该独立运行，不依赖其他测试的状态
2. **清理**：使用 `after` 钩子清理测试创建的临时文件和资源
3. **描述性**：测试名称应该清楚地描述测试的内容
4. **覆盖边界情况**：测试正常情况、边界情况和错误情况
5. **使用 fixtures**：将测试数据放在 `test/fixtures/` 目录下

## CI/CD 集成

测试可以轻松集成到 CI/CD 流程中：

```yaml
# GitHub Actions 示例
- name: Run tests
  run: npm test
```

## 调试测试

### 使用 Node.js 调试器

```bash
node --inspect-brk --test test/ssh-config-parser.test.js
```

然后在 Chrome 中打开 `chrome://inspect` 进行调试。

### 查看详细输出

```bash
node --test --test-reporter=tap test/**/*.test.js
```

## 常见问题

### Q: 测试失败但没有详细错误信息？

A: 使用 `--test-reporter=spec` 查看详细输出：

```bash
node --test --test-reporter=spec test/**/*.test.js
```

### Q: 如何跳过某个测试？

A: 使用 `it.skip()`:

```javascript
it.skip('暂时跳过的测试', () => {
  // 测试代码
});
```

### Q: 如何只运行某个测试？

A: 使用 `it.only()`:

```javascript
it.only('只运行这个测试', () => {
  // 测试代码
});
```

## 贡献指南

提交 PR 时，请确保：

1. 所有测试通过：`npm test`
2. 新功能有对应的测试
3. 测试覆盖了正常情况和边界情况
4. 代码编译通过：`npm run build`
