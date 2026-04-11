#!/usr/bin/env node

/**
 * 测试运行器
 * 使用 Node.js 内置的测试框架运行所有测试
 */

import { execSync } from 'child_process';

console.log('🧪 运行测试...\n');

try {
  execSync('node --test test/*.test.js', {
    stdio: 'inherit',
    cwd: new URL('..', import.meta.url).pathname
  });
} catch (err) {
  process.exit(1);
}
