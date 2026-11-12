import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  decryptJson,
  encryptJson,
  generateKeyFile,
  isEncryptedBuffer,
} from '../build/utils/config-crypto.js';
import { runConfigCli } from '../build/cli/config-cli.js';
import { CommandLineParser } from '../build/cli/command-line-parser.js';

describe('config-crypto', () => {
  it('口令派生密钥的加解密往返', () => {
    const value = [{ name: 'dev', host: 'h', port: 22, username: 'u', password: 'p' }];
    const enc = encryptJson(value, 'my-passphrase');
    assert.ok(isEncryptedBuffer(enc));
    assert.strictEqual(decryptJson(enc, 'my-passphrase')[0].name, 'dev');
  });

  it('64 位十六进制原始密钥的加解密往返', () => {
    const hex = 'ab'.repeat(32);
    const enc = encryptJson({ a: 1 }, hex);
    assert.deepStrictEqual(decryptJson(enc, hex), { a: 1 });
  });

  it('错误密钥解密失败并给出可读错误', () => {
    const enc = encryptJson({ a: 1 }, 'right-pass');
    assert.throws(() => decryptJson(enc, 'wrong-pass'), /wrong key or corrupted/i);
  });

  it('密文被篡改后解密失败', () => {
    const enc = encryptJson({ a: 1 }, 'pass');
    enc[enc.length - 1] ^= 0xff;
    assert.throws(() => decryptJson(enc, 'pass'), /wrong key or corrupted/i);
  });

  it('明文 JSON 不被误判为加密格式', () => {
    assert.ok(!isEncryptedBuffer(Buffer.from(JSON.stringify([{ a: 1 }]))));
  });

  it('generateKeyFile 产出 64 位十六进制密钥', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-key-'));
    const keyFile = path.join(dir, 'k.key');
    const hex = generateKeyFile(keyFile);
    assert.match(hex, /^[0-9a-f]{64}$/);
    assert.match(fs.readFileSync(keyFile, 'utf-8').trim(), /^[0-9a-f]{64}$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('config CLI', () => {
  let dir;
  let storeFile;
  let keyFile;
  const savedEnv = { ...process.env };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-cli-'));
    storeFile = path.join(dir, 'store.enc');
    keyFile = path.join(dir, 'k.key');
    delete process.env.SSH_MCP_CONFIG_KEY;
  });

  after(() => {
    process.env.SSH_MCP_CONFIG_KEY = savedEnv.SSH_MCP_CONFIG_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const keyArgs = () => ['--key', keyFile];

  it('init 创建空加密存储', async () => {
    await runConfigCli(['init', '--file', storeFile, ...keyArgs()]);
    assert.ok(fs.existsSync(storeFile));
    assert.ok(isEncryptedBuffer(fs.readFileSync(storeFile)));
    assert.deepStrictEqual(decryptJson(fs.readFileSync(storeFile), fs.readFileSync(keyFile, 'utf-8').trim()), []);
  });

  it('add 写入连接且密文不含明文密码', async () => {
    await runConfigCli([
      'add', '--file', storeFile, ...keyArgs(),
      '--name', 'dev', '--host', '192.0.2.1', '--username', 'u', '--password', 'secret-pw',
    ]);
    const raw = fs.readFileSync(storeFile);
    assert.ok(!raw.includes('secret-pw'));
    const entries = decryptJson(raw, fs.readFileSync(keyFile, 'utf-8').trim());
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].password, 'secret-pw');
    assert.strictEqual(entries[0].port, 22);
  });

  it('add 同名默认拒绝,--force 覆盖', async () => {
    await assert.rejects(
      runConfigCli(['add', '--file', storeFile, ...keyArgs(), '--name', 'dev', '--host', 'h', '--username', 'u']),
      /already exists/i
    );
    await runConfigCli([
      'add', '--file', storeFile, ...keyArgs(),
      '--name', 'dev', '--host', '192.0.2.2', '--port', '2222', '--username', 'u2', '--password', 'pw2', '--force',
    ]);
    const entries = decryptJson(fs.readFileSync(storeFile), fs.readFileSync(keyFile, 'utf-8').trim());
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].host, '192.0.2.2');
    assert.strictEqual(entries[0].port, 2222);
  });

  it('remove 删除连接', async () => {
    await runConfigCli(['remove', '--file', storeFile, ...keyArgs(), 'dev']);
    const entries = decryptJson(fs.readFileSync(storeFile), fs.readFileSync(keyFile, 'utf-8').trim());
    assert.strictEqual(entries.length, 0);
  });

  it('export/import 往返且支持对象格式明文', async () => {
    const plain = path.join(dir, 'plain.json');
    const plainConfig = {
      work: { host: '10.0.0.5', port: 2222, username: 'root', password: 'x' },
    };
    fs.writeFileSync(plain, JSON.stringify(plainConfig));
    await runConfigCli(['import', '--in', plain, '--file', storeFile, ...keyArgs()]);
    const out = path.join(dir, 'out.json');
    await runConfigCli(['export', '--file', storeFile, ...keyArgs(), '--out', out]);
    const roundtrip = JSON.parse(fs.readFileSync(out, 'utf-8'));
    assert.strictEqual(roundtrip.length, 1);
    assert.strictEqual(roundtrip[0].name, 'work');
    assert.strictEqual(roundtrip[0].password, 'x');
  });
});

describe('--config-file 加密加载', () => {
  const originalArgv = process.argv;
  const savedEnv = { ...process.env };
  let dir;

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-load-'));
    delete process.env.SSH_MCP_CONFIG_KEY;
  });

  after(() => {
    process.argv = originalArgv;
    process.env.SSH_MCP_CONFIG_KEY = savedEnv.SSH_MCP_CONFIG_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('加密存储可作为 --config-file 被加载', () => {
    const storeFile = path.join(dir, 'store.enc');
    fs.writeFileSync(storeFile, encryptJson([
      { name: 'enc-host', host: '192.0.2.9', port: 22, username: 'u', password: 'pw' },
    ], 'cli-test-pass'));
    process.argv = ['node', 'ssh-mcp-server', '--config-file', storeFile, '--config-key', 'cli-test-pass'];
    const parsed = CommandLineParser.parseArgs();
    assert.ok(parsed.configs['enc-host']);
    assert.strictEqual(parsed.configs['enc-host'].host, '192.0.2.9');
    assert.strictEqual(parsed.configs['enc-host'].password, 'pw');
  });
});
