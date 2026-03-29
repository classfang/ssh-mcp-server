import { parseArgs } from "node:util";
import { SSHConfig, SshConnectionConfigMap, ParsedArgs } from "../models/types.js";
import fs from "fs";
import path from "path";
import { lookupSshConfig } from "../utils/ssh-config-parser.js";

/**
 * Command line argument parser class
 */
export class CommandLineParser {
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
        socksProxy: { type: "string", short: "s" },
        pty: { type: "boolean" },
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

    // Priority 3: Compatible with single connection legacy parameters
    if (Object.keys(configMap).length === 0) {
      const host = values.host || positionals[0];

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

      const portStr = values.port || positionals[1] || sshConfigEntry?.port?.toString();
      const username = values.username || positionals[2] || sshConfigEntry?.user;
      const password = values.password || positionals[3];
      const privateKey = values.privateKey || sshConfigEntry?.identityFile;
      const passphrase = values.passphrase || process.env.SSH_MCP_PASSPHRASE;
      const whitelist = values.whitelist;
      const blacklist = values.blacklist;
      const pty = values.pty;

      // 实际连接地址：优先使用 SSH config 的 HostName
      const actualHost = sshConfigEntry?.hostName || host;

      if (!actualHost || !portStr || !username || (!password && !privateKey && !values.agent)) {
        throw new Error(
          "Missing required parameters, need to provide host, port, username and password, private key or agent"
        );
      }

      const port = parseInt(portStr, 10);
      if (isNaN(port)) {
        throw new Error("Port must be a valid number");
      }

      configMap["default"] = {
        name: "default",
        host: actualHost,
        port,
        username,
        password,
        privateKey,
        passphrase,
        agent: values.agent,
        socksProxy: values.socksProxy,
        pty: pty !== undefined ? pty : undefined,
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
      };
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
    
    return {
      name: conf.name,
      host: conf.host,
      port,
      username: conf.user,
      password: conf.password,
      privateKey: conf.privateKey,
      passphrase: conf.passphrase || process.env.SSH_MCP_PASSPHRASE,
      agent: conf.agent,
      socksProxy: conf.socksProxy,
      pty: conf.pty !== undefined ? conf.pty === "true" || conf.pty === true : undefined,
      commandWhitelist: conf.whitelist
        ? conf.whitelist
            .split("|")
            .map((s: string) => s.trim())
            .filter(Boolean)
        : undefined,
      commandBlacklist: conf.blacklist
        ? conf.blacklist
            .split("|")
            .map((s: string) => s.trim())
            .filter(Boolean)
        : undefined,
    };
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
      privateKey: config.privateKey,
      passphrase: config.passphrase || process.env.SSH_MCP_PASSPHRASE,
      agent: config.agent,
      socksProxy: config.socksProxy,
      pty: config.pty !== undefined ? Boolean(config.pty) : undefined,
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
    };
  }
}
