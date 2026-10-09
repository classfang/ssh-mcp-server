import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { registerJobTools } from '../build/tools/jobs.js';
import { SSHConnectionManager } from '../build/services/ssh-connection-manager.js';
import { ToolError } from '../build/utils/tool-error.js';

describe('job-* 工具', () => {
  let tools;
  let manager;
  let originals;

  beforeEach(() => {
    manager = SSHConnectionManager.getInstance();
    originals = {
      jobStart: manager.jobStart,
      jobStatus: manager.jobStatus,
      jobKill: manager.jobKill,
      jobList: manager.jobList,
    };
    tools = {};
    registerJobTools({
      registerTool(name, _meta, handler) {
        tools[name] = handler;
      },
    });
  });

  afterEach(() => {
    Object.assign(manager, originals);
  });

  it('注册四个工具', () => {
    assert.deepStrictEqual(Object.keys(tools).sort(), ['job-kill', 'job-list', 'job-start', 'job-status']);
  });

  it('job-start 返回 job_id 与下一步提示', async () => {
    manager.jobStart = async (cmd, dir, name) => {
      assert.deepStrictEqual([cmd, dir, name], ['make', '/srv', 'web']);
      return { jobId: 'job-abcdefgh-0000', message: 'started job-abcdefgh-0000 (pid 7)' };
    };
    const result = await tools['job-start']({ cmdString: 'make', directory: '/srv', connectionName: 'web' });
    assert.match(result.content[0].text, /job_id: job-abcdefgh-0000/);
    assert.match(result.content[0].text, /job-status/);
  });

  it('job-status / job-kill / job-list 把参数传给管理器', async () => {
    manager.jobStatus = async (id, opts, name) => `status ${id} ${JSON.stringify(opts)} ${name}`;
    manager.jobKill = async (id, name) => `kill ${id} ${name}`;
    manager.jobList = async (limit, name) => `list ${limit} ${name}`;

    assert.strictEqual(
      (await tools['job-status']({ jobId: 'j', offset: 5, tailBytes: 6, maxBytes: 7, connectionName: 'c' })).content[0].text,
      'status j {"offset":5,"tailBytes":6,"maxBytes":7} c',
    );
    assert.strictEqual((await tools['job-kill']({ jobId: 'j', connectionName: 'c' })).content[0].text, 'kill j c');
    assert.strictEqual((await tools['job-list']({ connectionName: 'c' })).content[0].text, 'list 20 c');
  });

  it('失败时与其他工具一致，返回 isError 与 code/message/retriable JSON', async () => {
    manager.jobKill = async () => {
      throw new ToolError('COMMAND_TIMEOUT', 'slow', true);
    };
    const result = await tools['job-kill']({ jobId: 'j' });
    assert.strictEqual(result.isError, true);
    assert.deepStrictEqual(JSON.parse(result.content[0].text), {
      code: 'COMMAND_TIMEOUT',
      message: 'slow',
      retriable: true,
    });
  });
});
