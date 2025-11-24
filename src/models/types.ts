/**
 * SSH connection configuration interface
 */
export interface SSHConfig {
  name?: string; // Connection name, optional, compatible with single connection
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  commandWhitelist?: string[]; // Command whitelist (array of regex strings)
  commandBlacklist?: string[]; // Command blacklist (array of regex strings)
  socksProxy?: string; // SOCKS proxy URL, e.g. 'socks://user:pass@host:port'
}

/**
 * Multiple SSH connection configuration Map
 */
export type SshConnectionConfigMap = Record<string, SSHConfig>;

/**
 * Log levels
 */
export type LogLevel = "info" | "error" | "debug";

/**
 * System status information
 */
export interface ServerStatus {
  reachable: boolean;
  hostname?: string;
  ipAddresses?: string[];
  osName?: string;
  osVersion?: string;
  kernelVersion?: string;
  uptime?: string;
  diskSpace?: {
    free: string;
    total: string;
  };
  drives?: Array<{
    device: string;
    mountPoint: string;
    total: string;
    used: string;
    free: string;
    usagePercent: string;
    filesystem?: string;
  }>;
  memory?: {
    free: string;
    total: string;
  };
  cpu?: {
    name?: string;
    usage?: string;
  };
  gpus?: Array<{
    name: string;
    usage?: string;
    path?: string;
  }>;
  processes?: {
    running: number;
    threads: number;
  };
  services?: {
    running: number;
    installed: number;
  };
  lastUpdated?: string;
}

/**
 * Parsed command line arguments result
 */
export interface ParsedArgs {
  configs: SshConnectionConfigMap;
  preConnect: boolean;
}