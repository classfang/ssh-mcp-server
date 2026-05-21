import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface SshConfigEntry {
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

interface HostBlock {
  patterns: string[];
  config: Map<string, string>;
}

/**
 * 查找 SSH 配置文件中指定主机别名的配置
 * @param hostAlias 主机别名
 * @param configFilePath 配置文件路径，默认为 ~/.ssh/config
 * @returns 解析后的配置项，未找到返回 null
 */
export function lookupSshConfig(
  hostAlias: string,
  configFilePath?: string
): SshConfigEntry | null {
  const configPath = configFilePath || path.join(os.homedir(), '.ssh', 'config');

  // 默认路径不存在时静默返回 null
  if (!configFilePath && !fs.existsSync(configPath)) {
    return null;
  }

  // 显式指定路径不存在时抛错
  if (configFilePath && !fs.existsSync(configPath)) {
    throw new Error(`SSH config file not found: ${configPath}`);
  }

  const blocks = parseConfigFile(configPath, new Set());
  return matchHost(hostAlias, blocks);
}

/**
 * 解析 SSH 配置文件
 */
function parseConfigFile(filePath: string, visited: Set<string>): HostBlock[] {
  // 防止循环引用
  const realPath = fs.realpathSync(filePath);
  if (visited.has(realPath)) {
    return [];
  }
  visited.add(realPath);

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const blocks: HostBlock[] = [];
  let currentBlock: HostBlock | null = null;

  for (let line of lines) {
    // 移除注释和前后空白
    const commentIndex = line.indexOf('#');
    if (commentIndex !== -1) {
      line = line.substring(0, commentIndex);
    }
    line = line.trim();

    if (!line) continue;

    // 解析 Include 指令
    if (line.toLowerCase().startsWith('include ')) {
      if (currentBlock) {
        blocks.push(currentBlock);
        currentBlock = null;
      }
      const pattern = line.substring(8).trim();
      const includePaths = expandIncludePath(pattern, path.dirname(filePath));
      for (const includePath of includePaths) {
        if (fs.existsSync(includePath)) {
          blocks.push(...parseConfigFile(includePath, visited));
        }
      }
      continue;
    }

    // 解析 Host 行
    if (line.toLowerCase().startsWith('host ')) {
      if (currentBlock) {
        blocks.push(currentBlock);
      }
      const hostPatterns = line.substring(5).trim().split(/\s+/);
      currentBlock = {
        patterns: hostPatterns,
        config: new Map()
      };
      continue;
    }

    // 解析配置项
    if (!currentBlock) {
      currentBlock = {
        patterns: ['*'],
        config: new Map()
      };
    }

    const spaceIndex = line.search(/\s/);
    if (spaceIndex !== -1) {
      const key = line.substring(0, spaceIndex).toLowerCase();
      const value = line.substring(spaceIndex + 1).trim();

      // 只保存第一次出现的值（SSH first-match-wins）
      if (!currentBlock.config.has(key)) {
        currentBlock.config.set(key, value);
      }
    }
  }

  if (currentBlock) {
    blocks.push(currentBlock);
  }

  return blocks;
}

/**
 * 展开 Include 路径（支持 ~ 和通配符）
 */
function expandIncludePath(pattern: string, baseDir: string): string[] {
  // 展开 ~
  if (pattern.startsWith('~/')) {
    pattern = path.join(os.homedir(), pattern.substring(2));
  } else if (pattern.startsWith('~')) {
    // ~user 形式不支持，直接返回空
    return [];
  } else if (!path.isAbsolute(pattern)) {
    // 相对路径相对于配置文件所在目录
    pattern = path.join(baseDir, pattern);
  }

  // 使用 glob 展开通配符
  try {
    // Node.js 22+ 支持 fs.globSync
    if (typeof fs.globSync === 'function') {
      return fs.globSync(pattern);
    }
  } catch (e) {
    // glob 失败时静默跳过
  }

  // 降级：无通配符时直接返回
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return [pattern];
  }

  return [];
}

/**
 * 匹配主机别名
 */
function matchHost(hostAlias: string, blocks: HostBlock[]): SshConfigEntry | null {
  const result: SshConfigEntry = {};

  for (const block of blocks) {
    const matched = hostBlockMatches(hostAlias, block.patterns);

    if (!matched) continue;

    // first-match-wins：只取第一个匹配到的值
    if (!result.hostName && block.config.has('hostname')) {
      result.hostName = block.config.get('hostname');
    }
    if (!result.user && block.config.has('user')) {
      result.user = block.config.get('user');
    }
    if (!result.port && block.config.has('port')) {
      const portStr = block.config.get('port');
      const portNum = parseInt(portStr!, 10);
      if (!isNaN(portNum)) {
        result.port = portNum;
      }
    }
    if (!result.identityFile && block.config.has('identityfile')) {
      result.identityFile = expandTilde(block.config.get('identityfile')!);
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

function hostBlockMatches(hostAlias: string, patterns: string[]): boolean {
  let positiveMatch = false;

  for (const pattern of patterns) {
    const isNegated = pattern.startsWith('!');
    const patternBody = isNegated ? pattern.slice(1) : pattern;
    if (!patternBody) {
      continue;
    }

    if (hostPatternMatches(hostAlias, patternBody)) {
      if (isNegated) {
        return false;
      }
      positiveMatch = true;
    }
  }

  return positiveMatch;
}

function hostPatternMatches(hostAlias: string, pattern: string): boolean {
  if (pattern === '*') {
    return true;
  }

  const regexSource = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  return new RegExp(`^${regexSource}$`).test(hostAlias);
}

/**
 * 展开路径中的 ~
 */
function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.substring(2));
  }
  if (filePath === '~') {
    return os.homedir();
  }
  return filePath;
}
