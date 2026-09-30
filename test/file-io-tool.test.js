import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { registerFileIoTools } from '../build/tools/file-io.js';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';
import { ToolError } from '../build/utils/tool-error.js';

describe('read-file / write-file 工具', () => {
  let tools;
  let manager;
  let originals;

  beforeEach(() => {
    manager = SSHConnectionManager.getInstance();
    originals = { readFile: manager.readFile, writeFile: manager.writeFile };
    tools = {};
    registerFileIoTools({
      registerTool(name, _meta, handler) {
        tools[name] = handler;
      },
    });
  });

  afterEach(() => {
    Object.assign(manager, originals);
  });

  it('注册 read-file 与 write-file', () => {
    assert.deepStrictEqual(Object.keys(tools).sort(), ['read-file', 'write-file']);
  });

  it('read-file 把参数传给管理器并原样返回文本', async () => {
    let received;
    manager.readFile = async (...args) => {
      received = args;
      return 'content';
    };
    const result = await tools['read-file']({ remotePath: '/a', offset: 3, length: 9, connectionName: 'x' });
    assert.deepStrictEqual(received, ['/a', { offset: 3, length: 9 }, 'x']);
    assert.deepStrictEqual(result, { content: [{ type: 'text', text: 'content' }] });
  });

  it('write-file 把参数传给管理器', async () => {
    let received;
    manager.writeFile = async (...args) => {
      received = args;
      return 'Wrote 1 bytes to /a';
    };
    const result = await tools['write-file']({ remotePath: '/a', content: 'x', append: true, mode: 420 });
    assert.deepStrictEqual(received, ['/a', 'x', { append: true, mode: 420 }, undefined]);
    assert.strictEqual(result.content[0].text, 'Wrote 1 bytes to /a');
  });

  it('失败时与其他工具一致，返回 isError 与 code/message/retriable JSON', async () => {
    manager.readFile = async () => {
      throw new ToolError('SFTP_ERROR', 'boom', true);
    };
    const result = await tools['read-file']({ remotePath: '/a' });
    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(JSON.parse(result.content[0].text), {
      code: 'SFTP_ERROR',
      message: 'boom',
      retriable: true,
    });
  });
});
