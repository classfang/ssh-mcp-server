import { parseArgs } from "node:util";
import { SSHConfig, SshConnectionConfigMap, ParsedArgs } from "../models/types.js";
import fs from "fs";
import path from "path";
import os from "os";
import { lookupSshConfig } from "../utils/ssh-config-parser.js";

/**
 * Command line argument parser class
 */
export class CommandLineParser {
  private static readonly DEFAULT_TRANSPORT_MODE: SSHConfig["transportMode"] = "exec";
  private static readonly DEFAULT_SHELL_READY_TIMEOUT_MS = 10000;

  private static parseBoolean(value: unknown): boolean | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }
    return Boolean(value);
  }

  private static parseTransportMode(
    value: unknown,
  ): SSHConfig["transportMode"] | undefined {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }

    if (value === "exec" || value === "shell") {
      return value;
    }

    throw new Error(
      `transportMode must be either 'exec' or 'shell', got: ${String(value)}`,
    );
  }

  private static parseTimeout(
    value: unknown,
    fieldName: string,
  ): number | undefined {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }

    const parsed =
      typeof value === "number" ? value : parseInt(String(value), 10);

    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${fieldName} must be a positive number, got: ${String(value)}`);
    }

    return parsed;
  }

  private static parseMaxOutputBytes(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }

    const parsed = typeof value === "number" ? value : Number(String(value));

    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(
        `maxOutputBytes must be a non-negative integer, got: ${String(value)}`,
      );
    }

    return parsed;
  }

  /**
   * Parse command line arguments
   */
  public static parseArgs(): ParsedArgs {
    const { values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: {
        "config-file": { type: "string" },
        "ssh-config-file": { type: "string" },
        ssh: { type: "string", multiple: true },
        // Compatible with single connection legacy parameters
        host: { type: "string", short: "h" },
        port: { type: "string", short: "p" },
        username: { type: "string", short: "u" },
        password: { type: "string", short: "w" },
        privateKey: { type: "string", short: "k" },
        passphrase: { type: "string", short: "P" },
        agent: { type: "string", short: "a" },
        whitelist: { type: "string", short: "W" },
        blacklist: { type: "string", short: "B" },
        proxy: { type: "string" },
        socksProxy: { type: "string", short: "s" },
        "allowed-local-paths": { type: "string" },
        "allowed-remote-paths": { type: "string" },
        "transport-mode": { type: "string" },
        "shell-ready-timeout": { type: "string" },
        "command-template": { type: "string" },
        pty: { type: "string" },
        "try-keyboard": { type: "boolean" },
        "pre-connect": { type: "boolean" },
      },
      allowPositionals: true,
    });

    const configMap: SshConnectionConfigMap = {};

    // Priority 1: Load from config file if specified
    if (values["config-file"]) {
      const configFilePath = path.resolve(values["config-file"]);
      if (!fs.existsSync(configFilePath)) {
        throw new Error(`Config file not found: ${configFilePath}`);
      }
      try {
        const configContent = fs.readFileSync(configFilePath, "utf-8");
        const fileConfig = JSON.parse(configContent);
        
        // Support both array format and object format
        if (Array.isArray(fileConfig)) {
          // Array format: [{name: "dev", host: "...", ...}, ...]
          for (const config of fileConfig) {
            if (!config.name || !config.host || !config.port || !config.username) {
              throw new Error("Each config in array must include name, host, port, username");
            }
            configMap[config.name] = this.normalizeConfig(config);
          }
        } else if (typeof fileConfig === "object" && fileConfig !== null) {
          // Object format: {"dev": {host: "...", ...}, "prod": {...}}
          for (const [name, config] of Object.entries(fileConfig)) {
            const normalizedConfig = this.normalizeConfig(config as any);
            normalizedConfig.name = name;
            configMap[name] = normalizedConfig;
          }
        } else {
          throw new Error("Config file must contain an array or object of SSH configurations");
        }
      } catch (err) {
        if (err instanceof SyntaxError) {
          throw new Error(`Invalid JSON in config file: ${(err as Error).message}`);
        }
        throw err;
      }
    }

    // Priority 2: Parse --ssh parameters (only if no config file was loaded)
    if (Object.keys(configMap).length === 0) {
      const sshParams: string[] = Array.isArray(values.ssh)
        ? values.ssh
        : values.ssh
        ? [values.ssh]
        : [];

      for (const sshStr of sshParams) {
        let conf: SSHConfig;
        
        // Try to parse as JSON first
        if (sshStr.trim().startsWith("{")) {
          try {
            const jsonConfig = JSON.parse(sshStr);
            conf = this.normalizeConfig(jsonConfig);
            if (!conf.name) {
              throw new Error("JSON config must include 'name' field");
            }
          } catch (err) {
            throw new Error(`Invalid JSON format in --ssh parameter: ${(err as Error).message}`);
          }
        } else {
          // Fallback to legacy comma-separated format for backward compatibility
          conf = this.parseLegacySshFormat(sshStr);
        }
        
        if (!conf.name || !conf.host || !conf.port || !conf.username) {
          throw new Error("Each --ssh must include name, host, port, username");
        }
        configMap[conf.name] = conf;
      }
    }

    // Priority 3: Compatible with single connection legacy parameters.
    // --host 支持逗号分隔多值：单值保持既有单主机行为不变（连接名"default"）；多值进入多连接模式，每个值作为独立连接，连接名为该值本身。每个值独立套用既有合并规则：命中 SSH config 别名则合并其 HostName/Port/User/IdentityFile，CLI 参数逐字段覆盖。
    if (Object.keys(configMap).length === 0) {
      const hostRaw = values.host || positionals[0];

      // 拆分逗号分隔的多值（单值不含逗号时 hosts 长度为 1，走原路径）
      const hosts: string[] = hostRaw
        ? hostRaw
            .split(",")
            .map((h) => h.trim())
            .filter(Boolean)
        : [];
      if (hostRaw && hosts.length === 0) {
        throw new Error(
          `Invalid --host value: ${hostRaw}. Host list cannot be empty.`
        );
      }

      if (hosts.length > 1) {
        // ===== 多值：多连接模式 =====
        // 认证模式开关：CLI 认证参数（--password/--privateKey/--agent）一旦出现即整体声明"全部主机共享该认证"，SSH config 的 IdentityFile 不参与；否则每个别名独立从 SSH config 解析认证（IdentityFile > 默认身份文件 > SSH agent）。
        const hasCliAuth =
          values.password !== undefined ||
          values.privateKey !== undefined ||
          values.agent !== undefined;

        const passphrase = values.passphrase || process.env.SSH_MCP_PASSPHRASE;
        const whitelistPatterns = values.whitelist
          ? values.whitelist
              .split(",")
              .map((pattern: string) => pattern.trim())
              .filter(Boolean)
          : undefined;
        const blacklistPatterns = values.blacklist
          ? values.blacklist
              .split(",")
              .map((pattern: string) => pattern.trim())
              .filter(Boolean)
          : undefined;
        const allowedLocalPaths = values["allowed-local-paths"]
          ? values["allowed-local-paths"]
              .split(",")
              .map((allowedPath: string) => allowedPath.trim())
              .filter(Boolean)
          : undefined;
        const allowedRemotePaths = values["allowed-remote-paths"]
          ? values["allowed-remote-paths"]
              .split(",")
              .map((allowedPath: string) => allowedPath.trim())
              .filter(Boolean)
          : undefined;
        const sharedPolicy = {
          password: values.password || positionals[3],
          privateKey: values.privateKey,
          agent: values.agent,
          passphrase,
          proxy: values.proxy,
          socksProxy: values.socksProxy,
          pty: this.parseBoolean(values.pty),
          tryKeyboard:
            values["try-keyboard"] !== undefined
              ? values["try-keyboard"]
              : undefined,
          transportMode: values["transport-mode"],
          shellReadyTimeoutMs: values["shell-ready-timeout"],
          commandTemplate: values["command-template"],
          commandWhitelist: whitelistPatterns,
          commandBlacklist: blacklistPatterns,
          allowedLocalPaths,
          allowedRemotePaths,
        };

        const noAuth: string[] = [];
        const defaultAgent = findDefaultAgent();
        const defaultIdentity = findDefaultIdentityFile();

        for (const hostAlias of hosts) {
          // 每个值独立尝试 SSH config 合并（非认证字段始终合并；认证字段仅在无 CLI 认证参数时参与）
          let sshConfigEntry = null;
          try {
            sshConfigEntry = lookupSshConfig(
              hostAlias,
              values["ssh-config-file"],
            );
          } catch (err) {
            throw err;
          }

          const actualHost = sshConfigEntry?.hostName || hostAlias;
          const portStr =
            values.port || positionals[1] || sshConfigEntry?.port?.toString() || "22";
          const port = parseInt(portStr, 10);
          if (isNaN(port)) {
            throw new Error("Port must be a valid number");
          }
          const username =
            values.username || positionals[2] || sshConfigEntry?.user;

          let effectivePrivateKey: string | undefined;
          let resolvedAgent: string | undefined;
          if (hasCliAuth) {
            // 共享模式：CLI 认证参数覆盖一切，不读 config 的 IdentityFile
            effectivePrivateKey = values.privateKey;
            resolvedAgent = values.agent;
          } else {
            // 独立模式：config IdentityFile > 默认身份文件（仅别名命中时） > SSH agent
            effectivePrivateKey =
              sshConfigEntry?.identityFile ||
              (sshConfigEntry ? defaultIdentity : undefined);
            resolvedAgent = !effectivePrivateKey ? defaultAgent : undefined;
          }

          if (!actualHost || !username || (!sharedPolicy.password && !effectivePrivateKey && !resolvedAgent)) {
            noAuth.push(hostAlias);
            continue;
          }

          configMap[hostAlias] = this.normalizeConfig({
            name: hostAlias,
            host: actualHost,
            port,
            username,
            ...sharedPolicy,
            privateKey: effectivePrivateKey,
            agent: resolvedAgent,
          });
        }

        if (noAuth.length > 0) {
          throw new Error(
            `Missing required parameters for host(s): ${noAuth.join(", ")}. ` +
              `Each host needs a username and an authentication source ` +
              `(CLI --password/--privateKey/--agent, SSH config IdentityFile, ` +
              `default identity files, or a running SSH agent).`
          );
        }
      } else {
        // ===== 单值：既有单主机行为，完全不变 =====
        const host = hostRaw;

        // 尝试从 SSH config 读取配置
        let sshConfigEntry = null;
        if (host) {
          try {
            sshConfigEntry = lookupSshConfig(host, values["ssh-config-file"]);
          } catch (err) {
            // 显式指定配置文件但读取失败时抛错
            throw err;
          }
        }

        const portStr = values.port || positionals[1] || sshConfigEntry?.port?.toString() || "22";
        const username = values.username || positionals[2] || sshConfigEntry?.user;
        const password = values.password || positionals[3];
        // 私钥来源：命令行参数 > SSH config 的 IdentityFile
        const privateKey =
          values.privateKey || sshConfigEntry?.identityFile;
        const passphrase = values.passphrase || process.env.SSH_MCP_PASSPHRASE;
        const resolvedAgent = values.agent !== undefined
          ? values.agent
          : !password && !privateKey
          ? findDefaultAgent()
          : undefined;

        // OpenSSH 风格回退：SSH config 命中了主机别名，但没有提供任何认证信息（无 IdentityFile / password / agent）时，模仿 ssh 客户端自动尝试 ~/.ssh 下的默认身份文件（id_rsa、id_ecdsa、id_ed25519 等）
        const defaultPrivateKey =
          !privateKey && !password && !resolvedAgent && sshConfigEntry
            ? findDefaultIdentityFile()
            : undefined;
        const effectivePrivateKey = privateKey || defaultPrivateKey;
        const whitelist = values.whitelist;
        const blacklist = values.blacklist;
        const allowedLocalPaths = values["allowed-local-paths"];
        const allowedRemotePaths = values["allowed-remote-paths"];
        const commandTemplate = values["command-template"];
        const pty = this.parseBoolean(values.pty);
        const tryKeyboard = values["try-keyboard"];

        // 实际连接地址：优先使用 SSH config 的 HostName
        const actualHost = sshConfigEntry?.hostName || host;

        if (!actualHost || !portStr || !username || (!password && !effectivePrivateKey && !resolvedAgent)) {
          throw new Error(
            "Missing required parameters, need to provide host, port, username and password, private key or agent"
          );
        }

        const port = parseInt(portStr, 10);
        if (isNaN(port)) {
          throw new Error("Port must be a valid number");
        }

        configMap["default"] = this.normalizeConfig({
          name: "default",
          host: actualHost,
          port,
          username,
          password,
          privateKey: effectivePrivateKey,
          passphrase,
          agent: resolvedAgent,
          proxy: values.proxy,
          socksProxy: values.socksProxy,
          pty,
          tryKeyboard: tryKeyboard !== undefined ? tryKeyboard : undefined,
          transportMode: values["transport-mode"],
          shellReadyTimeoutMs: values["shell-ready-timeout"],
          commandTemplate,
          commandWhitelist: whitelist
            ? whitelist
                .split(",")
                .map((pattern) => pattern.trim())
                .filter(Boolean)
            : undefined,
          commandBlacklist: blacklist
            ? blacklist
                .split(",")
                .map((pattern) => pattern.trim())
                .filter(Boolean)
            : undefined,
          allowedLocalPaths: allowedLocalPaths
            ? allowedLocalPaths
                .split(",")
                .map((allowedPath) => allowedPath.trim())
                .filter(Boolean)
            : undefined,
          allowedRemotePaths: allowedRemotePaths
            ? allowedRemotePaths
                .split(",")
                .map((allowedPath) => allowedPath.trim())
                .filter(Boolean)
            : undefined,
        });
      }
    }

    return {
      configs: configMap,
      preConnect: values["pre-connect"] === true,
    };
  }

  /**
   * Parse legacy comma-separated format: name=dev,host=1.2.3.4,port=22,user=alice,password=xxx
   * @private
   */
  private static parseLegacySshFormat(sshStr: string): SSHConfig {
    const conf: any = {};
    const parts = sshStr.split(",");
    
    for (const part of parts) {
      // Only split on the first '=' to handle values containing '='
      const equalIndex = part.indexOf("=");
      if (equalIndex > 0) {
        const k = part.substring(0, equalIndex).trim();
        const v = part.substring(equalIndex + 1).trim();
        if (k && v) {
          conf[k] = v;
        }
      }
    }
    
    const port = parseInt(conf.port, 10);
    if (isNaN(port)) {
      throw new Error(
        `Port for connection ${conf.name || "unknown"} must be a valid number`
      );
    }
    
    return this.normalizeConfig(conf);
  }

  /**
   * Normalize SSH config object to ensure proper types and structure
   * @private
   */
  private static normalizeConfig(config: any): SSHConfig {
    const port = typeof config.port === "number"
      ? config.port
      : parseInt(config.port, 10);

    if (isNaN(port)) {
      throw new Error(`Port must be a valid number, got: ${config.port}`);
    }

    return {
      name: config.name,
      host: config.host,
      port,
      username: config.username || config.user,
      password: config.password,
      privateKey: config.privateKey
        ? this.normalizeLocalPath(String(config.privateKey))
        : undefined,
      passphrase: config.passphrase || process.env.SSH_MCP_PASSPHRASE,
      agent: config.agent,
      algorithms: config.algorithms,
      proxy: config.proxy,
      socksProxy: config.socksProxy,
      pty: this.parseBoolean(config.pty),
      tryKeyboard: this.parseBoolean(config.tryKeyboard),
      transportMode:
        this.parseTransportMode(config.transportMode) ||
        this.DEFAULT_TRANSPORT_MODE,
      shellReadyTimeoutMs:
        this.parseTimeout(
          config.shellReadyTimeoutMs,
          "shellReadyTimeoutMs",
        ) || this.DEFAULT_SHELL_READY_TIMEOUT_MS,
      shellCommandTimeoutMs: this.parseTimeout(
        config.shellCommandTimeoutMs,
        "shellCommandTimeoutMs",
      ),
      commandTimeoutMs: this.parseTimeout(
        config.commandTimeoutMs,
        "commandTimeoutMs",
      ),
      connectionTimeoutMs: this.parseTimeout(
        config.connectionTimeoutMs,
        "connectionTimeoutMs",
      ),
      sftpTimeoutMs: this.parseTimeout(config.sftpTimeoutMs, "sftpTimeoutMs"),
      maxOutputBytes: this.parseMaxOutputBytes(config.maxOutputBytes),
      keepaliveIntervalMs: this.parseTimeout(
        config.keepaliveIntervalMs,
        "keepaliveIntervalMs",
      ),
      keepaliveCountMax: this.parseTimeout(
        config.keepaliveCountMax,
        "keepaliveCountMax",
      ),
      commandWhitelist: Array.isArray(config.commandWhitelist)
        ? config.commandWhitelist
        : config.whitelist
        ? typeof config.whitelist === "string"
          ? config.whitelist.split("|").map((s: string) => s.trim()).filter(Boolean)
          : config.whitelist
        : undefined,
      commandBlacklist: Array.isArray(config.commandBlacklist)
        ? config.commandBlacklist
        : config.blacklist
        ? typeof config.blacklist === "string"
          ? config.blacklist.split("|").map((s: string) => s.trim()).filter(Boolean)
          : config.blacklist
        : undefined,
      allowedLocalPaths: Array.isArray(config.allowedLocalPaths)
        ? config.allowedLocalPaths
            .map((allowedPath: unknown) =>
              this.normalizeLocalPath(String(allowedPath)),
            )
            .filter(Boolean)
        : typeof config.allowedLocalPaths === "string"
          ? config.allowedLocalPaths
              .split("|")
              .map((allowedPath: string) =>
                this.normalizeLocalPath(allowedPath.trim()),
              )
              .filter(Boolean)
          : undefined,
      allowedRemotePaths: Array.isArray(config.allowedRemotePaths)
        ? config.allowedRemotePaths
            .map((allowedPath: unknown) =>
              this.normalizeRemotePath(String(allowedPath)),
            )
        : typeof config.allowedRemotePaths === "string"
          ? config.allowedRemotePaths
              .split("|")
              .map((allowedPath: string) =>
                this.normalizeRemotePath(allowedPath.trim()),
              )
              .filter(Boolean)
          : undefined,
      commandTemplate: this.parseCommandTemplate(config.commandTemplate),
    };
  }

  private static parseCommandTemplate(
    value: unknown,
  ): string | undefined {
    if (value === undefined || value === null || value === "") {
      return undefined;
    }

    const template = String(value);
    if (!template.includes("<command>") && !template.includes("<quotedCommand>")) {
      throw new Error(
        `commandTemplate must contain '<command>' or '<quotedCommand>' placeholder, got: ${template}`,
      );
    }

    return template;
  }

  private static normalizeLocalPath(localPath: string): string {
    return path.resolve(this.expandHomePath(localPath));
  }

  private static expandHomePath(localPath: string): string {
    if (localPath === "~") {
      return os.homedir();
    }
    if (localPath.startsWith("~/")) {
      return path.join(os.homedir(), localPath.slice(2));
    }
    return localPath;
  }

  private static normalizeRemotePath(remotePath: string): string {
    if (!remotePath) {
      return "";
    }
    if (!path.posix.isAbsolute(remotePath)) {
      throw new Error(
        `allowedRemotePaths entries must be absolute POSIX paths, got: ${remotePath}`,
      );
    }
    const normalized = path.posix.normalize(remotePath);
    if (normalized.length > 1 && normalized.endsWith("/")) {
      return normalized.slice(0, -1);
    }
    return normalized;
  }
}

/**
 * 模仿 OpenSSH 的行为：当用户未显式指定私钥、密码或 agent 时，按惯例依次尝试 ~/.ssh 下的默认身份文件（id_rsa、id_ecdsa、id_ed25519、id_xmss、id_dsa），返回第一个存在的公钥对应的私钥路径，否则返回undefined。
 */
function findDefaultIdentityFile(): string | undefined {
  const sshDir = path.join(os.homedir(), ".ssh");
  const defaultNames = ["id_rsa", "id_ecdsa", "id_ed25519", "id_xmss", "id_dsa"];
  for (const name of defaultNames) {
    const candidate = path.join(sshDir, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * 在未显式指定认证方式时寻找默认的 SSH agent：
 * - 各平台都优先使用 SSH_AUTH_SOCK 环境变量
 * - Windows 上额外检查 OpenSSH Authentication Agent 的命名管道
 */
function findDefaultAgent(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) {
    return process.env.SSH_AUTH_SOCK;
  }
  if (process.platform === "win32" && fs.existsSync("\\\\.\\pipe\\openssh-ssh-agent")) {
    return "\\\\.\\pipe\\openssh-ssh-agent";
  }
  return undefined;
}
