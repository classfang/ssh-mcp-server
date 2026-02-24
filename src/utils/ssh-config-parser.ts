import fs from "fs";
import path from "path";
import os from "os";
import { SSHConfig } from "../models/types.js";

interface SshConfigEntry {
  host: string;
  hostname?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  proxyCommand?: string;
}

/**
 * Parse ~/.ssh/config file and extract host entries
 */
export function parseSshConfigFile(filePath?: string): SshConfigEntry[] {
  const configPath = filePath || path.join(os.homedir(), ".ssh", "config");
  if (!fs.existsSync(configPath)) {
    return [];
  }

  const content = fs.readFileSync(configPath, "utf-8");
  return parseSshConfig(content);
}

/**
 * Parse SSH config content string
 */
function parseSshConfig(content: string): SshConfigEntry[] {
  const entries: SshConfigEntry[] = [];
  let current: SshConfigEntry | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith("#")) {
      continue;
    }

    // Split on first whitespace or '='
    const match = line.match(/^(\S+)\s*[=\s]\s*(.+)$/);
    if (!match) continue;

    const key = match[1].toLowerCase();
    const value = match[2].trim();

    if (key === "host") {
      // Skip wildcard patterns like Host *
      if (value.includes("*") || value.includes("?")) {
        current = null;
        continue;
      }
      current = { host: value };
      entries.push(current);
    } else if (current) {
      switch (key) {
        case "hostname":
          current.hostname = value;
          break;
        case "user":
          current.user = value;
          break;
        case "port":
          current.port = parseInt(value, 10);
          break;
        case "identityfile":
          current.identityFile = resolveHome(value);
          break;
        case "proxycommand":
          current.proxyCommand = value;
          break;
      }
    }
  }

  return entries;
}

/**
 * Resolve ~ to home directory in a path
 */
function resolveHome(p: string): string {
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Look up a host in ~/.ssh/config and return an SSHConfig object
 */
export function lookupSshConfig(
  hostAlias: string,
  configFilePath?: string,
): SSHConfig | null {
  const entries = parseSshConfigFile(configFilePath);
  const entry = entries.find(
    (e) => e.host.toLowerCase() === hostAlias.toLowerCase(),
  );
  if (!entry) {
    return null;
  }

  return {
    name: entry.host,
    host: entry.hostname || entry.host,
    port: entry.port || 22,
    username: entry.user || "",
    privateKey: entry.identityFile,
  };
}
