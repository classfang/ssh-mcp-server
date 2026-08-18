import { describe, it } from 'node:test';
import assert from 'node:assert';
import { collectSystemStatus } from '../build/utils/status-collector.js';

const PROBE_PATTERN = /printf '\\n(__MCP_FIELD_\w+_)(\w+)\\n'/g;

/** Field names in the order the script probes them, plus the shared marker. */
function readProbes(script) {
  const probes = [...script.matchAll(PROBE_PATTERN)];
  return {
    marker: probes[0]?.[1],
    fields: probes.map((probe) => probe[2]),
  };
}

/**
 * Stand-in for the remote shell: emits the marker line for every probe the
 * script declares, followed by whatever `values` supplies for it.
 */
function fakeRemote(values, { lineEnding = '\n' } = {}) {
  return (script) => {
    const { marker, fields } = readProbes(script);
    const output = fields
      .map((field) => `${marker}${field}${lineEnding}${values[field] ?? ''}`)
      .join(lineEnding);
    return Promise.resolve(lineEnding + output);
  };
}

describe('status collector', () => {
  it('所有探针合并为一条单行命令', async () => {
    const scripts = [];
    await collectSystemStatus((script) => {
      scripts.push(script);
      return Promise.resolve('');
    }, 'dev');

    assert.strictEqual(scripts.length, 1);
    // 多行脚本会被 commandTemplate 的引号包裹破坏
    assert.ok(!scripts[0].includes('\n'));
    // 每个探针都被隔离，单个失败不影响其余，且整体以成功退出
    assert.ok(scripts[0].endsWith('; true'));

    const { fields } = readProbes(scripts[0]);
    assert.ok(fields.includes('hostname'));
    assert.ok(fields.includes('servicesInstalled'));
    assert.strictEqual(new Set(fields).size, fields.length);
  });

  it('按 marker 还原各字段', async () => {
    const status = await collectSystemStatus(
      fakeRemote({
        hostname: 'web-01',
        osName: 'Linux',
        kernelVersion: '6.1.0',
        memory: 'free:2.1G total:7.7G',
        processes: '181',
        threads: '901',
      }),
      'dev',
    );

    assert.strictEqual(status.reachable, true);
    assert.strictEqual(status.hostname, 'web-01');
    assert.strictEqual(status.osName, 'Linux');
    assert.strictEqual(status.kernelVersion, '6.1.0');
    assert.deepStrictEqual(status.memory, { free: '2.1G', total: '7.7G' });
    // 解析时会各减去一行表头
    assert.deepStrictEqual(status.processes, { running: 180, threads: 900 });
  });

  // 多行字段是 CRLF 归一化真正起作用的地方：逐行拆分的值不会再单独 trim，
  // 残留的 \r 会直接进入结果。
  it('pty 的 CRLF 输出同样能解析', async () => {
    const status = await collectSystemStatus(
      fakeRemote(
        {
          hostname: 'web-02',
          ipAddresses: '10.0.0.7\r\n192.168.1.5',
          drives: '/dev/sda1|50G|20G|30G|40%|/',
        },
        { lineEnding: '\r\n' },
      ),
      'dev',
    );

    assert.strictEqual(status.hostname, 'web-02');
    assert.deepStrictEqual(status.ipAddresses, ['10.0.0.7', '192.168.1.5']);
    assert.deepStrictEqual(status.drives, [
      {
        device: '/dev/sda1',
        total: '50G',
        used: '20G',
        free: '30G',
        usagePercent: '40%',
        mountPoint: '/',
      },
    ]);
  });

  it('空探针不影响其它字段', async () => {
    const status = await collectSystemStatus(
      fakeRemote({ hostname: 'web-03', ipAddresses: '', osName: 'Linux' }),
      'dev',
    );

    assert.strictEqual(status.hostname, 'web-03');
    assert.strictEqual(status.osName, 'Linux');
    assert.strictEqual(status.ipAddresses, undefined);
  });

  // 命令白名单会拒绝这条探针脚本；那种情况下字段留空即可，
  // 不能把主机报成不可达。
  it('命令被拒绝时字段留空但仍视为可达', async () => {
    const status = await collectSystemStatus(
      () => Promise.reject(new Error('Command validation failed')),
      'dev',
    );

    assert.strictEqual(status.reachable, true);
    assert.strictEqual(status.hostname, undefined);
    assert.ok(status.lastUpdated);
  });

  it('先逐条授权探针，再只批量执行允许的命令', async () => {
    const scripts = [];
    const recordingRemote = fakeRemote({ hostname: 'allowed-host' });
    const status = await collectSystemStatus(
      (script) => {
        scripts.push(script);
        return recordingRemote(script);
      },
      'dev',
      (command) => command === 'hostname',
    );

    assert.strictEqual(status.hostname, 'allowed-host');
    assert.strictEqual(scripts.length, 1);
    assert.match(scripts[0], /hostname/);
    assert.ok(!scripts[0].includes('uname -s'));
    assert.ok(!scripts[0].includes('cat /etc/os-release'));
  });

  it('没有获准探针时不执行远端脚本', async () => {
    let calls = 0;
    const status = await collectSystemStatus(
      async () => {
        calls += 1;
        return '';
      },
      'dev',
      () => false,
    );

    assert.strictEqual(calls, 0);
    assert.strictEqual(status.reachable, true);
    assert.strictEqual(status.hostname, undefined);
  });
});
