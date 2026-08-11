import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';

test('does not load SSH dependencies when importing the connection manager', () => {
  const managerUrl = pathToFileURL(
    path.resolve('build/services/ssh-connection-manager.js'),
  ).href;
  const loader = `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'ssh2' || specifier === 'socks') {
        throw new Error('eager SSH dependency: ' + specifier);
      }
      return nextResolve(specifier, context);
    }
  `)}`;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-loader',
      loader,
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(managerUrl)});`,
    ],
    { cwd: path.resolve('.'), encoding: 'utf8', timeout: 10_000 },
  );

  assert.strictEqual(
    result.status,
    0,
    [result.error?.stack, result.stderr, result.stdout].filter(Boolean).join('\n'),
  );
});
