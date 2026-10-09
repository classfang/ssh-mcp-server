import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  normalizeRemotePath,
  isRemotePathWithinRoot,
} from '../build/utils/remote-path.js';

describe('normalizeRemotePath', () => {
  it('归一化 POSIX 绝对路径', () => {
    assert.strictEqual(normalizeRemotePath('/home/user/file.txt'), '/home/user/file.txt');
    assert.strictEqual(normalizeRemotePath('/home/user/../user/file.txt'), '/home/user/file.txt');
    assert.strictEqual(normalizeRemotePath('/'), '/');
  });

  it('去掉 POSIX 路径末尾多余的斜杠', () => {
    assert.strictEqual(normalizeRemotePath('/var/log/'), '/var/log');
  });

  it('归一化 Windows 盘符路径并统一为正斜杠', () => {
    assert.strictEqual(normalizeRemotePath('C:\\Users\\foo\\bar.txt'), 'C:/Users/foo/bar.txt');
    assert.strictEqual(normalizeRemotePath('C:/Users/foo'), 'C:/Users/foo');
    assert.strictEqual(normalizeRemotePath('d:\\data\\file.log'), 'd:/data/file.log');
  });

  it('处理 Windows 混合分隔符与 ..', () => {
    assert.strictEqual(
      normalizeRemotePath('C:\\Users\\foo/../bar/file.txt'),
      'C:/Users/bar/file.txt',
    );
    assert.strictEqual(normalizeRemotePath('C:\\Users\\..\\..\\Windows'), 'C:/Windows');
  });

  it('保留盘符大小写原样', () => {
    assert.strictEqual(normalizeRemotePath('c:\\Users\\Foo'), 'c:/Users/Foo');
  });

  it('去掉 Windows 路径末尾多余的分隔符', () => {
    assert.strictEqual(normalizeRemotePath('C:\\Users\\'), 'C:/Users');
    assert.strictEqual(normalizeRemotePath('C:/'), 'C:/');
  });

  it('拒绝相对路径', () => {
    assert.throws(() => normalizeRemotePath('tmp/a.txt'), /absolute POSIX path or an absolute Windows path/);
    assert.throws(() => normalizeRemotePath('file.txt'), /absolute POSIX path or an absolute Windows path/);
  });

  it('拒绝缺少分隔符的盘符相对路径', () => {
    assert.throws(() => normalizeRemotePath('C:'), /absolute POSIX path or an absolute Windows path/);
    assert.throws(() => normalizeRemotePath('C:foo\\bar'), /absolute POSIX path or an absolute Windows path/);
  });

  it('拒绝无盘符的反斜杠路径', () => {
    assert.throws(() => normalizeRemotePath('\\Users\\foo'), /absolute POSIX path or an absolute Windows path/);
  });

  it('拒绝 UNC 网络路径', () => {
    assert.throws(() => normalizeRemotePath('\\\\server\\share\\file'), /absolute POSIX path or an absolute Windows path/);
  });

  it('拒绝空串与 null byte', () => {
    assert.throws(() => normalizeRemotePath(''), /non-empty/);
    assert.throws(() => normalizeRemotePath('/tmp/\0evil'), /null bytes/);
    assert.throws(() => normalizeRemotePath('C:\\tmp\\\0evil'), /null bytes/);
  });
});

describe('isRemotePathWithinRoot', () => {
  it('POSIX 路径按前缀匹配', () => {
    assert.strictEqual(isRemotePathWithinRoot('/home/user/file.txt', '/home/user'), true);
    assert.strictEqual(isRemotePathWithinRoot('/home/user', '/home/user'), true);
    assert.strictEqual(isRemotePathWithinRoot('/home/user2/file.txt', '/home/user'), false);
    assert.strictEqual(isRemotePathWithinRoot('/home/user', '/home/user/dir'), false);
  });

  it('POSIX 根为 / 时放行所有绝对路径', () => {
    assert.strictEqual(isRemotePathWithinRoot('/anything/at/all', '/'), true);
  });

  it('Windows 路径按前缀匹配', () => {
    assert.strictEqual(isRemotePathWithinRoot('C:/Users/foo/file.txt', 'C:/Users'), true);
    assert.strictEqual(isRemotePathWithinRoot('C:/Users', 'C:/Users'), true);
    assert.strictEqual(isRemotePathWithinRoot('C:/Users2/file.txt', 'C:/Users'), false);
    assert.strictEqual(isRemotePathWithinRoot('D:/Users/file.txt', 'C:/Users'), false);
  });

  it('Windows 匹配大小写不敏感', () => {
    assert.strictEqual(isRemotePathWithinRoot('c:/users/foo/file.txt', 'C:/Users'), true);
    assert.strictEqual(isRemotePathWithinRoot('C:/USERS/FOO', 'c:/users'), true);
  });

  it('Windows 盘符根放行整个盘', () => {
    assert.strictEqual(isRemotePathWithinRoot('C:/Users/foo', 'C:/'), true);
    assert.strictEqual(isRemotePathWithinRoot('D:/Users/foo', 'C:/'), false);
  });

  it('POSIX 与 Windows 路径互不匹配', () => {
    assert.strictEqual(isRemotePathWithinRoot('/home/user/x', 'C:/Users'), false);
    assert.strictEqual(isRemotePathWithinRoot('C:/Users/x', '/home'), false);
  });

  it('对未归一化的输入先做归一化', () => {
    assert.strictEqual(isRemotePathWithinRoot('C:\\Users\\foo\\..\\bar.txt', 'C:/Users'), true);
    assert.strictEqual(isRemotePathWithinRoot('/home/user/./file.txt', '/home/user'), true);
  });
});
