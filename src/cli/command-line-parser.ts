import { parseArgs } from "node:util";
import { SSHConfig, SshConnectionConfigMap, ParsedArgs } from "../models/types.js";

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
        ssh: { type: "string", multiple: true },
        // Compatible with single connection legacy parameters
        host: { type: "string", short: "h" },
        port: { type: "string", short: "p" },
        username: { type: "string", short: "u" },
        password: { type: "string", short: "w" },
        privateKey: { type: "string", short: "k" },
        passphrase: { type: "string", short: "P" },
        whitelist: { type: "string", short: "W" },
        blacklist: { type: "string", short: "B" },
        socksProxy: { type: "string", short: "s" },
        "pre-connect": { type: "boolean" },
      },
      allowPositionals: true,
    });

    const sshParams: string[] = Array.isArray(values.ssh)
      ? values.ssh
      : values.ssh
      ? [values.ssh]
      : [];

    const configMap: SshConnectionConfigMap = {};

    // Parse multiple --ssh parameters
    for (const sshStr of sshParams) {
      // Parse format: name=dev,host=1.2.3.4,port=22,user=alice,password=xxx
      const parts = sshStr.split(",");
      const conf: any = {};
      for (const part of parts) {
        const [k, v] = part.split("=");
        if (k && v) {
          conf[k.trim()] = v.trim();
        }
      }
      // Must have name, host, port, user
      if (!conf.name || !conf.host || !conf.port || !conf.user) {
        throw new Error("Each --ssh must include name, host, port, user");
      }
      const port = parseInt(conf.port, 10);
      if (isNaN(port)) {
        throw new Error(
          `Port for connection ${conf.name} must be a valid number`
        );
      }
      configMap[conf.name] = {
        name: conf.name,
        host: conf.host,
        port,
        username: conf.user,
        password: conf.password,
        privateKey: conf.privateKey,
        passphrase: conf.passphrase,
        socksProxy: conf.socksProxy,
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

    // Compatible with single connection legacy parameters
    if (Object.keys(configMap).length === 0) {
      const host = values.host || positionals[0];
      const portStr = values.port || positionals[1];
      const username = values.username || positionals[2];
      const password = values.password || positionals[3];
      const privateKey = values.privateKey;
      const passphrase = values.passphrase;
      const whitelist = values.whitelist;
      const blacklist = values.blacklist;

      if (!host || !portStr || !username || (!password && !privateKey)) {
        throw new Error(
          "Missing required parameters, need to provide host, port, username and password or private key"
        );
      }

      const port = parseInt(portStr, 10);
      if (isNaN(port)) {
        throw new Error("Port must be a valid number");
      }

      configMap["default"] = {
        name: "default",
        host,
        port,
        username,
        password,
        privateKey,
        passphrase,
        socksProxy: values.socksProxy,
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
}
