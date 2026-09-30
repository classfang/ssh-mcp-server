import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { registerExecuteCommandTool } from '../build/tools/execute-command.js';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';
import { ToolError } from '../build/utils/tool-error.js';

describe('execute-command 工具返回格式', () => {
  let handler;
  let manager;
  let originalExecute;

  beforeEach(() => {
    manager = SSHConnectionManager.getInstance();
    originalExecute = manager.executeCommand;
    registerExecuteCommandTool({
      registerTool(_name, _meta, fn) {
        handler = fn;
      },
    });
  });

  afterEach(() => {
    manager.executeCommand = originalExecute;
  });

  it('成功时原样返回输出', async () => {
    manager.executeCommand = async () => 'hello';
    const result = await handler({ cmdString: 'echo hello' });
    assert.deepStrictEqual(result, { content: [{ type: 'text', text: 'hello' }] });
  });

  it('非零退出码返回原始输出加 [exit code]，不是工具错误也不包 JSON', async () => {
    manager.executeCommand = async () => {
      throw new ToolError('COMMAND_EXECUTION_ERROR', 'partial\n[exit code] 1', false, true);
    };
    const result = await handler({ cmdString: 'grep nomatch f' });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(result.content[0].text, 'partial\n[exit code] 1');
  });

  it('超时、校验失败等真正的错误仍然是 isError 加 JSON', async () => {
    manager.executeCommand = async () => {
      throw new ToolError('COMMAND_TIMEOUT', '[timeout] Command timed out after 10ms', true);
    };
    const result = await handler({ cmdString: 'sleep 100' });
    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(JSON.parse(result.content[0].text), {
      code: 'COMMAND_TIMEOUT',
      message: '[timeout] Command timed out after 10ms',
      retriable: true,
    });
  });
});
