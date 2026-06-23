import { Client, ClientChannel, SFTPWrapper } from "ssh2";
import { SocksClient } from "socks";
import {
  SSHConfig,
  SshConnectionConfigMap,
  ServerStatus,
} from "../models/types.js";
import { Logger } from "../utils/logger.js";
import { collectSystemStatus } from "../utils/status-collector.js";
import { ToolError } from "../utils/tool-error.js";
import fs from "fs";
import path from "path";
import { pipeline } from "node:stream/promises";

type RunCommandOptions = {
  timeout?: number;
};

type LocalPathPurpose = "read" | "write";

type ShellCommandMatch = {
  output: string;
  exitCode: number;
  remainder: string;
};

type SshAuthMethod =
  | "none"
  | "password"
  | "publickey"
  | "agent"
  | "keyboard-interactive"
  | "hostbased";

const ANSI_OSC_PATTERN = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

const COMMAND_TEMPLATE_PLACEHOLDER = "<command>";
const QUOTED_COMMAND_TEMPLATE_PLACEHOLDER = "<quotedCommand>";
const DEFAULT_CONNECTION_TIMEOUT_MS = 30000;
const DEFAULT_KEEPALIVE_INTERVAL_MS = 10000;
const DEFAULT_KEEPALIVE_COUNT_MAX = 3;
const DEFAULT_SFTP_TIMEOUT_MS = 300000;

function applyCommandTemplate(template: string, command: string): string {
  const quotedCommand = shellQuote(command);
  return template
    .split(QUOTED_COMMAND_TEMPLATE_PLACEHOLDER)
    .join(quotedCommand)
    .split(`'${COMMAND_TEMPLATE_PLACEHOLDER}'`)
    .join(quotedCommand)
    .split(`"${COMMAND_TEMPLATE_PLACEHOLDER}"`)
    .join(quotedCommand)
    .split(COMMAND_TEMPLATE_PLACEHOLDER)
    .join(command);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relativePath = path.relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== "" &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath))
  );
}

function redactProxyUrl(proxyUrl: URL): string {
  const redactedUrl = new URL(proxyUrl.toString());
  if (redactedUrl.username) {
    redactedUrl.username = "***";
  }
  if (redactedUrl.password) {
    redactedUrl.password = "***";
  }
  return redactedUrl.toString();
}

function isPasswordPrompt(prompt: string): boolean {
  const promptText = prompt.toLowerCase();
  return promptText.includes("password") || promptText.includes("密码");
}

function isAuthMethodAllowedByServer(
  method: SshAuthMethod,
  methodsLeft: string[] | null,
): boolean {
  if (methodsLeft === null) {
    return true;
  }

  // ssh-agent uses the SSH publickey protocol method.
  if (method === "agent") {
    return methodsLeft.includes("publickey");
  }

  return methodsLeft.includes(method);
}

/**
 * SSH Connection Manager class
 */
export class SSHConnectionManager {
  private static instance: SSHConnectionManager;
  private clients: Map<string, Client> = new Map();
  private configs: SshConnectionConfigMap = {};
  private connected: Map<string, boolean> = new Map();
  private statusCache: Map<string, ServerStatus> = new Map();
  private pendingConnections: Map<string, Promise<void>> = new Map();
  private pendingStatusCollections: Map<string, NodeJS.Timeout> = new Map();
  private commandWhitelistRegexes: Map<string, RegExp[]> = new Map();
  private commandBlacklistRegexes: Map<string, RegExp[]> = new Map();
  private shellStreams: Map<string, ClientChannel> = new Map();
  private shellReady: Map<string, boolean> = new Map();
  private shellQueues: Map<string, Promise<unknown>> = new Map();
  private shellBuffers: Map<string, string> = new Map();
  private defaultName: string = "default";

  private constructor() {}

  /**
   * Get singleton instance
   */
  public static getInstance(): SSHConnectionManager {
    if (!SSHConnectionManager.instance) {
      SSHConnectionManager.instance = new SSHConnectionManager();
    }
    return SSHConnectionManager.instance;
  }

  /**
   * Batch set SSH configurations
   */
  public setConfig(
    configs: SshConnectionConfigMap,
    defaultName?: string,
  ): void {
    this.disconnect();

    this.commandWhitelistRegexes.clear();
    this.commandBlacklistRegexes.clear();

    for (const [name, config] of Object.entries(configs)) {
      this.commandWhitelistRegexes.set(
        name,
        this.compilePatterns(config.commandWhitelist, name, "whitelist"),
      );
      this.commandBlacklistRegexes.set(
        name,
        this.compilePatterns(config.commandBlacklist, name, "blacklist"),
      );
    }

    this.configs = configs;
    if (defaultName && configs[defaultName]) {
      this.defaultName = defaultName;
    } else if (Object.keys(configs).length > 0) {
      this.defaultName = Object.keys(configs)[0];
    }
  }

  /**
   * Get specified connection configuration
   */
  public getConfig(name?: string): SSHConfig {
    const key = name || this.defaultName;
    if (!this.configs[key]) {
      throw new Error(`SSH configuration for '${key}' not set`);
    }
    return this.configs[key];
  }

  /**
   * Batch connect all configured SSH connections
   */
  public async connectAll(): Promise<void> {
    const names = Object.keys(this.configs);
    const results = await Promise.allSettled(
      names.map((name) => this.connect(name)),
    );
    const failures = results
      .map((result, index) => ({ result, name: names[index] }))
      .filter(
        (entry): entry is {
          result: PromiseRejectedResult;
          name: string;
        } => entry.result.status === "rejected",
      );

    if (failures.length > 0) {
      throw new ToolError(
        "SSH_CONNECTION_FAILED",
        failures
          .map(
            ({ name, result }) =>
              `[${name}] ${
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason)
              }`,
          )
          .join("; "),
        true,
      );
    }
  }

  /**
   * Connect to SSH with specified name
   */
  public async connect(name?: string): Promise<void> {
    const key = name || this.defaultName;
    if (this.hasUsableConnection(key)) {
      return;
    }

    const existingConnection = this.pendingConnections.get(key);
    if (existingConnection) {
      await existingConnection;
      return;
    }

    const config = this.getConfig(key);
    const client = this.createClient();
    const connectionPromise = new Promise<void>(async (resolve, reject) => {
      let settled = false;
      const timeoutMs = this.getConnectionTimeoutMs(config);
      const timeoutId = setTimeout(() => {
        rejectOnce(
          new ToolError(
            "SSH_CONNECTION_TIMEOUT",
            `SSH connection [${key}] timed out after ${timeoutMs}ms`,
            true,
          ),
        );
        this.invalidateConnection(key);
        try {
          client.destroy();
        } catch {
          // Ignore cleanup errors during connection timeout.
        }
      }, timeoutMs);

      const clearConnectionTimeout = () => clearTimeout(timeoutId);

      const resolveOnce = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearConnectionTimeout();
        resolve();
      };

      const rejectOnce = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearConnectionTimeout();
        reject(error);
      };

      client.on("ready", async () => {
        Logger.log(
          `Successfully connected to SSH server [${key}] ${config.host}:${config.port}`,
        );

        try {
          if (this.getTransportMode(config) === "shell") {
            await this.initializeShellSession(client, key, config);
          }

          this.clients.set(key, client);
          this.connected.set(key, true);
          this.scheduleStatusCollection(key);
          resolveOnce();
        } catch (error) {
          this.connected.set(key, false);
          this.cleanupShellState(key, true);
          try {
            client.end();
          } catch {
            // Ignore cleanup errors during failed initialization.
          }
          rejectOnce(
            error instanceof ToolError
              ? error
              : new ToolError(
                  "SSH_CONNECTION_FAILED",
                  `SSH connection [${key}] failed: ${(error as Error).message}`,
                  true,
                ),
          );
        }
      });

      client.on("error", (err: Error) => {
        this.connected.set(key, false);
        if (this.clients.get(key) === client || this.shellStreams.has(key)) {
          this.invalidateConnection(key);
        }
        rejectOnce(
          new ToolError(
            "SSH_CONNECTION_FAILED",
            `SSH connection [${key}] failed: ${err.message}`,
            true,
          ),
        );
      });

      client.on("close", () => {
        this.clearConnectionState(key);
        Logger.log(`SSH connection [${key}] closed`, "info");
      });

      try {
        const sshConfig = await this.buildClientConfig(key, config);
        client.connect(sshConfig);
      } catch (error) {
        rejectOnce(error);
      }
    });

    this.pendingConnections.set(key, connectionPromise);

    try {
      await connectionPromise;
    } finally {
      this.pendingConnections.delete(key);
    }
  }

  /**
   * Get SSH Client with specified name
   */
  public getClient(name?: string): Client {
    const key = name || this.defaultName;
    const client = this.clients.get(key);
    if (!client) {
      throw new Error(`SSH client for '${key}' not connected`);
    }
    return client;
  }

  /**
   * Execute SSH command
   */
  public async executeCommand(
    cmdString: string,
    directory?: string,
    name?: string,
    options: { timeout?: number } = {},
  ): Promise<string> {
    return this.runCommandInternal(cmdString, directory, name, options);
  }

  /**
   * Upload file
   */
  private validateLocalPath(
    localPath: string,
    name?: string,
    purpose: LocalPathPurpose = "read",
  ): string {
    if (typeof localPath !== "string" || localPath.length === 0) {
      throw new ToolError(
        "LOCAL_PATH_NOT_ALLOWED",
        "Local path must be a non-empty string.",
        false,
      );
    }
    if (localPath.includes("\0")) {
      throw new ToolError(
        "LOCAL_PATH_NOT_ALLOWED",
        "Local path must not contain null bytes.",
        false,
      );
    }

    const resolvedPath = path.resolve(localPath);
    const allowedRoots = this.getAllowedLocalRoots(name);
    const parentPath = path.dirname(resolvedPath);
    const existingPath = this.tryRealpath(resolvedPath);
    const parentRealPath = this.tryRealpath(parentPath);

    let pathToCheck = existingPath;
    if (!pathToCheck && parentRealPath) {
      pathToCheck = path.join(parentRealPath, path.basename(resolvedPath));
    }
    if (!pathToCheck) {
      pathToCheck = resolvedPath;
    }

    if (purpose === "write" && !parentRealPath) {
      throw new ToolError(
        "LOCAL_PATH_NOT_ALLOWED",
        "Local path parent directory must exist and be within an allowed local path.",
        false,
      );
    }

    const isAllowed = allowedRoots.some((allowedRoot) =>
      isPathWithinRoot(pathToCheck, allowedRoot),
    );

    if (!isAllowed) {
      throw new ToolError(
        "LOCAL_PATH_NOT_ALLOWED",
        "Path traversal detected. Local path must be within the working directory or configured allowed local paths for this connection.",
        false,
      );
    }
    return resolvedPath;
  }

  private getAllowedLocalRoots(name?: string): string[] {
    const config = this.getConfig(name);
    return [process.cwd(), ...(config.allowedLocalPaths || [])]
      .filter((allowedPath) => allowedPath.trim().length > 0)
      .map((allowedPath) => {
        const resolvedRoot = path.resolve(allowedPath);
        return this.tryRealpath(resolvedRoot) || resolvedRoot;
      });
  }

  private tryRealpath(localPath: string): string | undefined {
    try {
      return fs.realpathSync.native(localPath);
    } catch {
      return undefined;
    }
  }

  private validateRemotePath(remotePath: string, name?: string): string {
    if (typeof remotePath !== "string" || remotePath.length === 0) {
      throw new ToolError(
        "REMOTE_PATH_NOT_ALLOWED",
        "Remote path must be a non-empty string.",
        false,
      );
    }
    if (remotePath.includes("\0")) {
      throw new ToolError(
        "REMOTE_PATH_NOT_ALLOWED",
        "Remote path must not contain null bytes.",
        false,
      );
    }
    if (!path.posix.isAbsolute(remotePath)) {
      throw new ToolError(
        "REMOTE_PATH_NOT_ALLOWED",
        `Remote path must be an absolute POSIX path, got: ${remotePath}`,
        false,
      );
    }

    const resolvedPath = path.posix.normalize(remotePath);
    const config = this.getConfig(name);
    const allowedRoots = config.allowedRemotePaths || [];

    if (allowedRoots.length === 0) {
      return resolvedPath;
    }

    const isAllowed = allowedRoots.some(
      (allowedRoot) =>
        resolvedPath === allowedRoot ||
        resolvedPath.startsWith(
          allowedRoot.endsWith("/") ? allowedRoot : `${allowedRoot}/`,
        ),
    );

    if (!isAllowed) {
      throw new ToolError(
        "REMOTE_PATH_NOT_ALLOWED",
        "Remote path is not within the configured allowedRemotePaths.",
        false,
      );
    }
    return resolvedPath;
  }

  /**
   * Upload file
   */
  public async upload(
    localPath: string,
    remotePath: string,
    name?: string,
  ): Promise<string> {
    const config = this.getConfig(name);
    const key = name || this.defaultName;
    if (this.getTransportMode(config) === "shell") {
      throw new ToolError(
        "UNSUPPORTED_IN_SHELL_MODE",
        "Current bastion shell mode does not support SFTP upload/download.",
        false,
      );
    }

    const validatedLocalPath = this.validateLocalPath(localPath, name, "read");
    const validatedRemotePath = this.validateRemotePath(remotePath, name);
    const client = await this.ensureConnected(name);
    const sftpTimeoutMs = this.getSftpTimeoutMs(config);
    const sftp = await this.withTimeout(
      this.openSftp(client),
      sftpTimeoutMs,
      () => this.invalidateConnection(key),
      `SFTP open timed out after ${sftpTimeoutMs}ms`,
    );

    try {
      await this.withTimeout(
        pipeline(
          fs.createReadStream(validatedLocalPath),
          sftp.createWriteStream(validatedRemotePath),
        ),
        sftpTimeoutMs,
        () => this.invalidateConnection(key),
        `SFTP upload timed out after ${sftpTimeoutMs}ms`,
      );
      return "File uploaded successfully";
    } catch (error) {
      if (error instanceof ToolError && error.code === "OPERATION_TIMEOUT") {
        throw error;
      }
      if (this.errorPathMatches(error, validatedLocalPath)) {
        throw new ToolError(
          "LOCAL_FILE_READ_FAILED",
          `Failed to read local file: ${(error as Error).message}`,
          false,
        );
      }
      throw new ToolError(
        "SFTP_ERROR",
        `File upload failed: ${(error as Error).message}`,
        true,
      );
    } finally {
      this.closeSftp(sftp);
    }
  }

  /**
   * Download file
   */
  public async download(
    remotePath: string,
    localPath: string,
    name?: string,
  ): Promise<string> {
    const config = this.getConfig(name);
    const key = name || this.defaultName;
    if (this.getTransportMode(config) === "shell") {
      throw new ToolError(
        "UNSUPPORTED_IN_SHELL_MODE",
        "Current bastion shell mode does not support SFTP upload/download.",
        false,
      );
    }

    const validatedLocalPath = this.validateLocalPath(localPath, name, "write");
    const validatedRemotePath = this.validateRemotePath(remotePath, name);
    const client = await this.ensureConnected(name);
    const sftpTimeoutMs = this.getSftpTimeoutMs(config);
    const sftp = await this.withTimeout(
      this.openSftp(client),
      sftpTimeoutMs,
      () => this.invalidateConnection(key),
      `SFTP open timed out after ${sftpTimeoutMs}ms`,
    );
    const tempLocalPath = `${validatedLocalPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`;

    try {
      await this.withTimeout(
        pipeline(
          sftp.createReadStream(validatedRemotePath),
          fs.createWriteStream(tempLocalPath, { flags: "wx" }),
        ),
        sftpTimeoutMs,
        () => this.invalidateConnection(key),
        `SFTP download timed out after ${sftpTimeoutMs}ms`,
      );
      await fs.promises.rename(tempLocalPath, validatedLocalPath);
      return "File downloaded successfully";
    } catch (error) {
      await this.unlinkIfExists(tempLocalPath);
      if (error instanceof ToolError && error.code === "OPERATION_TIMEOUT") {
        throw error;
      }
      if (
        this.errorPathMatches(error, tempLocalPath) ||
        this.errorPathMatches(error, validatedLocalPath)
      ) {
        throw new ToolError(
          "LOCAL_FILE_WRITE_FAILED",
          `Failed to save file: ${(error as Error).message}`,
          false,
        );
      }
      throw new ToolError(
        "SFTP_ERROR",
        `File download failed: ${(error as Error).message}`,
        true,
      );
    } finally {
      this.closeSftp(sftp);
    }
  }

  private openSftp(client: Client): Promise<SFTPWrapper> {
    return new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) {
          reject(
            new ToolError(
              "SFTP_ERROR",
              `SFTP connection failed: ${err.message}`,
              true,
            ),
          );
          return;
        }

        resolve(sftp);
      });
    });
  }

  private closeSftp(sftp: SFTPWrapper): void {
    try {
      sftp.end();
    } catch {
      // Ignore cleanup errors after transfer completion.
    }
  }

  private withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: () => void,
    message: string,
  ): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    return new Promise<T>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        try {
          onTimeout();
        } catch {
          // Ignore cleanup errors while rejecting a timed out operation.
        }
        reject(new ToolError("OPERATION_TIMEOUT", message, true));
      }, timeoutMs);

      promise.then(
        (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      );
    });
  }

  private errorPathMatches(error: unknown, localPath: string): boolean {
    const errorPath = (error as NodeJS.ErrnoException).path;
    return typeof errorPath === "string" && path.resolve(errorPath) === localPath;
  }

  private async unlinkIfExists(localPath: string): Promise<void> {
    try {
      await fs.promises.unlink(localPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        Logger.log(
          `Failed to remove partial local file ${localPath}: ${(error as Error).message}`,
          "error",
        );
      }
    }
  }

  /**
   * Disconnect SSH connection
   */
  public disconnect(): void {
    for (const timeoutId of this.pendingStatusCollections.values()) {
      clearTimeout(timeoutId);
    }
    this.pendingStatusCollections.clear();

    for (const [key] of this.clients) {
      this.cleanupShellState(key, true);
    }

    if (this.clients.size > 0) {
      for (const client of this.clients.values()) {
        client.end();
      }
      this.clients.clear();
    }

    this.connected.clear();
    this.statusCache.clear();
    this.pendingConnections.clear();
    this.commandWhitelistRegexes.clear();
    this.commandBlacklistRegexes.clear();
    this.shellStreams.clear();
    this.shellReady.clear();
    this.shellQueues.clear();
    this.shellBuffers.clear();
  }

  /**
   * Get basic information of all configured servers
   */
  public getAllServerInfos(): Array<{
    name: string;
    host: string;
    port: number;
    username: string;
    connected: boolean;
    status?: ServerStatus;
  }> {
    return Object.keys(this.configs).map((key) => {
      const config = this.configs[key];
      const status = this.statusCache.get(key);
      return {
        name: key,
        host: config.host,
        port: config.port,
        username: config.username,
        connected: this.connected.get(key) === true,
        status: status,
      };
    });
  }

  private createClient(): Client {
    return new Client();
  }

  private async ensureConnected(name?: string): Promise<Client> {
    const key = name || this.defaultName;
    if (!this.hasUsableConnection(key)) {
      await this.connect(key);
    }

    const client = this.clients.get(key);
    if (!client) {
      throw new Error(`SSH client for '${key}' not initialized`);
    }
    return client;
  }

  private hasUsableConnection(key: string): boolean {
    const client = this.clients.get(key);
    if (!client || this.connected.get(key) !== true) {
      return false;
    }

    const config = this.getConfig(key);
    if (this.getTransportMode(config) === "shell") {
      return (
        this.shellReady.get(key) === true && this.shellStreams.has(key)
      );
    }

    return true;
  }

  private getTransportMode(config: SSHConfig): "exec" | "shell" {
    return config.transportMode || "exec";
  }

  private getShellReadyTimeoutMs(config: SSHConfig): number {
    return config.shellReadyTimeoutMs || 10000;
  }

  private getShellCommandTimeoutMs(config: SSHConfig): number {
    return config.shellCommandTimeoutMs || 30000;
  }

  private getConnectionTimeoutMs(config: SSHConfig): number {
    return config.connectionTimeoutMs || DEFAULT_CONNECTION_TIMEOUT_MS;
  }

  private getSftpTimeoutMs(config: SSHConfig): number {
    return config.sftpTimeoutMs || DEFAULT_SFTP_TIMEOUT_MS;
  }

  private async buildClientConfig(
    key: string,
    config: SSHConfig,
  ): Promise<Record<string, unknown>> {
    const sshConfig: Record<string, unknown> = {
      host: config.host,
      port: config.port,
      username: config.username,
      readyTimeout: this.getConnectionTimeoutMs(config),
      timeout: this.getConnectionTimeoutMs(config),
      keepaliveInterval:
        config.keepaliveIntervalMs || DEFAULT_KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax:
        config.keepaliveCountMax || DEFAULT_KEEPALIVE_COUNT_MAX,
    };

    if (config.socksProxy) {
      try {
        const proxyUrl = new URL(config.socksProxy);
        const proxyHost = proxyUrl.hostname;
        const proxyPort = Number.parseInt(proxyUrl.port, 10);

        if (!proxyHost || !Number.isInteger(proxyPort) || proxyPort <= 0) {
          throw new Error(
            "SOCKS proxy URL must include a valid host and positive port",
          );
        }

        const proxy: {
          host: string;
          port: number;
          type: 5;
          userId?: string;
          password?: string;
        } = {
          host: proxyHost,
          port: proxyPort,
          type: 5,
        };

        if (proxyUrl.username) {
          proxy.userId = decodeURIComponent(proxyUrl.username);
        }
        if (proxyUrl.password) {
          proxy.password = decodeURIComponent(proxyUrl.password);
        }

        Logger.log(
          `Using SOCKS proxy for [${key}]: ${redactProxyUrl(proxyUrl)}`,
          "info",
        );

        const { socket } = await SocksClient.createConnection({
          proxy,
          command: "connect",
          destination: {
            host: config.host,
            port: config.port,
          },
        });

        sshConfig.sock = socket;
        Logger.log(
          `SSH config object with SOCKS proxy: ${JSON.stringify(
            sshConfig,
            (field, value) => (field === "sock" ? "[Socket object]" : value),
          )}`,
          "info",
        );
      } catch (error) {
        throw new ToolError(
          "SSH_CONNECTION_FAILED",
          `Failed to create SOCKS proxy connection for [${key}]: ${
            (error as Error).message
          }`,
          true,
        );
      }
    }

    // Enable keyboard-interactive authentication for 2FA/MFA
    if (config.tryKeyboard) {
      sshConfig.tryKeyboard = true;

      // Build ordered preference of methods this connection supports.
      const authMethods: SshAuthMethod[] = [];
      if (config.privateKey) {
        authMethods.push("publickey");
      }
      if (config.agent) {
        authMethods.push("agent");
      }
      if (config.password) {
        authMethods.push("password");
      }
      authMethods.push("keyboard-interactive");

      const triedMethods: SshAuthMethod[] = [];
      const maxAuthAttempts = authMethods.length;

      sshConfig.authHandler = (
        methodsLeft: string[] | null,
        partialSuccess: boolean | null,
        callback: (nextAuth: SshAuthMethod | false) => void,
      ) => {
        // Prevent infinite retry loops.
        if (triedMethods.length >= maxAuthAttempts) {
          Logger.log(
            `[${key}] Authentication failed after trying [${triedMethods.join(", ")}]`,
            "error",
          );
          return callback(false);
        }

        // Pick the next preferred method that hasn't been attempted yet
        // (and is still allowed by the server if methodsLeft is provided).
        const candidates =
          methodsLeft !== null
            ? authMethods.filter((m) =>
                isAuthMethodAllowedByServer(m, methodsLeft),
              )
            : authMethods;

        const nextMethod = candidates.find(
          (m) => !triedMethods.includes(m),
        );

        if (!nextMethod) {
          Logger.log(
            `[${key}] All supported auth methods exhausted`,
            "error",
          );
          return callback(false);
        }

        triedMethods.push(nextMethod);
        Logger.log(
          `[${key}] Trying auth method: ${nextMethod} (${triedMethods.length}/${maxAuthAttempts})`,
          "info",
        );
        return callback(nextMethod);
      };

      // Handle keyboard-interactive prompts (for 2FA codes)
      sshConfig.keyboard = (
        name: string,
        instructions: string,
        instructionsLang: string,
        prompts: Array<{ prompt: string; echo: boolean }>,
        finish: (responses: string[]) => void,
      ) => {
        Logger.log(
          `[${key}] Keyboard-interactive authentication requested`,
          "info",
        );
        Logger.log(`[${key}] Name: ${name}`, "debug");
        Logger.log(`[${key}] Instructions: ${instructions}`, "debug");
        Logger.log(`[${key}] Prompts: ${JSON.stringify(prompts)}`, "debug");

        const otpCode = process.env.SSH_MCP_2FA_CODE;
        const responses: string[] = [];
        for (const prompt of prompts) {
          if (config.password && isPasswordPrompt(prompt.prompt)) {
            // For password prompts, use the configured password
            responses.push(config.password);
            Logger.log(
              `[${key}] Responding to password prompt: ${prompt.prompt}`,
              "debug",
            );
          } else if (otpCode) {
            // For 2FA/verification code prompts, use SSH_MCP_2FA_CODE if provided
            responses.push(otpCode);
            Logger.log(
              `[${key}] Responding to non-password prompt with SSH_MCP_2FA_CODE: ${prompt.prompt}`,
              "info",
            );
          } else if (config.password && prompts.length === 1 && !prompt.echo) {
            // Single non-echoing prompt without "password" label:
            // treat as password prompt (common on embedded devices)
            responses.push(config.password);
            Logger.log(
              `[${key}] Responding to single non-echo prompt (assumed password): ${prompt.prompt}`,
              "debug",
            );
          } else {
            // No code available — empty response will fail the auth attempt;
            // set SSH_MCP_2FA_CODE before connecting to enable 2FA/MFA.
            responses.push("");
            Logger.log(
              `[${key}] Empty response for prompt (set SSH_MCP_2FA_CODE to satisfy 2FA): ${prompt.prompt}`,
              "info",
            );
          }
        }

        finish(responses);
      };
    }

    if (config.agent) {
      sshConfig.agent = config.agent;
      Logger.log(
        `Using SSH agent authentication for [${key}]: ${config.agent}`,
        "info",
      );
      if (!config.tryKeyboard) {
        return sshConfig;
      }
    }

    if (config.privateKey) {
      try {
        sshConfig.privateKey = fs.readFileSync(config.privateKey, "utf8");
        if (config.passphrase) {
          sshConfig.passphrase = config.passphrase;
        }
        Logger.log(
          `Using SSH private key authentication for [${key}]`,
          "info",
        );
        if (!config.tryKeyboard) {
          return sshConfig;
        }
      } catch (error) {
        throw new ToolError(
          "LOCAL_FILE_READ_FAILED",
          `Failed to read private key file for [${key}]: ${
            (error as Error).message
          }`,
          false,
        );
      }
    }

    if (config.password) {
      sshConfig.password = config.password;
      Logger.log(`Using password authentication for [${key}]`, "info");
      if (!config.tryKeyboard) {
        return sshConfig;
      }
    }

    if (!config.agent && !config.privateKey && !config.password && !config.tryKeyboard) {
      throw new ToolError(
        "SSH_AUTHENTICATION_MISSING",
        `No valid authentication method provided for [${key}] (agent, password, private key, or tryKeyboard)`,
        false,
      );
    }

    return sshConfig;
  }

  private scheduleStatusCollection(key: string): void {
    const existingStatusCollection = this.pendingStatusCollections.get(key);
    if (existingStatusCollection) {
      clearTimeout(existingStatusCollection);
    }

    const timeoutId = setTimeout(() => {
      this.pendingStatusCollections.delete(key);
      void this.collectStatusForConnection(key);
    }, 1000);

    this.pendingStatusCollections.set(key, timeoutId);
  }

  private async collectStatusForConnection(key: string): Promise<void> {
    try {
      const status = await collectSystemStatus(
        (command, connectionName) =>
          this.runCommandInternal(command, undefined, connectionName),
        key,
      );
      this.statusCache.set(key, status);
      Logger.log(`System status collected for [${key}]`, "info");
    } catch (error) {
      Logger.log(
        `Failed to collect system status for [${key}]: ${(error as Error).message}`,
        "error",
      );
      this.statusCache.set(key, {
        reachable: true,
        lastUpdated: new Date().toISOString(),
      });
    }
  }

  private compilePatterns(
    patterns: string[] | undefined,
    connectionName: string,
    kind: "whitelist" | "blacklist",
  ): RegExp[] {
    if (!patterns || patterns.length === 0) {
      return [];
    }

    return patterns.map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch (error) {
        throw new Error(
          `Invalid ${kind} pattern for '${connectionName}': ${pattern} (${(error as Error).message})`,
        );
      }
    });
  }

  private validateCommand(
    command: string,
    name?: string,
  ): { isAllowed: boolean; reason?: string } {
    const key = name || this.defaultName;
    const whitelistRegexes = this.commandWhitelistRegexes.get(key) || [];
    if (whitelistRegexes.length > 0) {
      const matchesWhitelist = whitelistRegexes.some((regex) =>
        regex.test(command),
      );
      if (!matchesWhitelist) {
        return {
          isAllowed: false,
          reason: "Command not in whitelist, execution forbidden",
        };
      }
    }

    const blacklistRegexes = this.commandBlacklistRegexes.get(key) || [];
    if (blacklistRegexes.length > 0) {
      const matchesBlacklist = blacklistRegexes.some((regex) =>
        regex.test(command),
      );
      if (matchesBlacklist) {
        return {
          isAllowed: false,
          reason: "Command matches blacklist, execution forbidden",
        };
      }
    }

    return {
      isAllowed: true,
    };
  }

  private formatCommandFailure(
    stdout: string,
    stderr: string,
    exitCode?: number,
    exitSignal?: string,
  ): string {
    const outputSections: string[] = [];

    if (stdout) {
      outputSections.push(stdout);
    }

    if (stderr) {
      outputSections.push(`[stderr]\n${stderr}`);
    }

    if (exitCode !== undefined) {
      outputSections.push(`[exit code] ${exitCode}`);
    }

    if (exitSignal) {
      outputSections.push(`[signal] ${exitSignal}`);
    }

    return outputSections.join("\n");
  }

  private async runCommandInternal(
    cmdString: string,
    directory?: string,
    name?: string,
    options: RunCommandOptions = {},
  ): Promise<string> {
    const validationResult = this.validateCommand(cmdString, name);
    if (!validationResult.isAllowed) {
      throw new ToolError(
        "COMMAND_VALIDATION_FAILED",
        `Command validation failed: ${validationResult.reason}`,
        false,
      );
    }

    const key = name || this.defaultName;
    const config = this.getConfig(name);
    const transportMode = this.getTransportMode(config);
    const timeout =
      options.timeout ??
      (transportMode === "shell"
        ? this.getShellCommandTimeoutMs(config)
        : 30000);
    const connectionTimeoutMs = this.getConnectionTimeoutMs(config);
    const client = await this.withTimeout(
      this.ensureConnected(name),
      connectionTimeoutMs,
      () => this.invalidateConnection(key),
      `SSH connection [${key}] timed out after ${connectionTimeoutMs}ms`,
    );

    if (transportMode === "shell") {
      return this.runShellCommand(cmdString, directory, name, timeout);
    }

    return this.runExecCommand(
      client,
      config,
      cmdString,
      directory,
      timeout,
      key,
    );
  }

  private runExecCommand(
    client: Client,
    config: SSHConfig,
    cmdString: string,
    directory: string | undefined,
    timeout: number,
    key: string,
  ): Promise<string> {
    let commandToRun = directory
      ? `cd -- ${shellQuote(directory)} && ${cmdString}`
      : cmdString;

    if (config.commandTemplate) {
      commandToRun = applyCommandTemplate(config.commandTemplate, commandToRun);
    }

    return new Promise<string>((resolve, reject) => {
      let openTimeoutId: NodeJS.Timeout | undefined;
      let commandTimeoutId: NodeJS.Timeout | undefined;
      let settled = false;

      const cleanup = () => {
        if (openTimeoutId) {
          clearTimeout(openTimeoutId);
        }
        if (commandTimeoutId) {
          clearTimeout(commandTimeoutId);
        }
      };

      client.exec(
        commandToRun,
        { pty: config.pty !== undefined ? config.pty : true },
        (err: Error | undefined, stream: ClientChannel) => {
          if (openTimeoutId) {
            clearTimeout(openTimeoutId);
            openTimeoutId = undefined;
          }

          if (settled) {
            try {
              stream?.close();
            } catch {
              // Ignore late stream cleanup errors after timeout.
            }
            return;
          }

          if (err) {
            cleanup();
            settled = true;
            reject(
              new ToolError(
                "COMMAND_EXECUTION_ERROR",
                `Command execution error: ${err.message}`,
                true,
              ),
            );
            return;
          }

          let data = "";
          let errorData = "";
          let exitCode: number | undefined;
          let exitSignal: string | undefined;

          stream.on("data", (chunk: Buffer) => (data += chunk.toString()));
          stream.stderr.on(
            "data",
            (chunk: Buffer) => (errorData += chunk.toString()),
          );

          stream.on(
            "exit",
            (code: number | undefined, signal: string | undefined) => {
              exitCode = code;
              exitSignal = signal;
            },
          );

          stream.on("close", (code?: number, signal?: string) => {
            cleanup();
            if (settled) {
              return;
            }
            settled = true;

            if (exitCode === undefined) {
              exitCode = code;
            }

            if (!exitSignal && signal) {
              exitSignal = signal;
            }

            const stdout = data.trimEnd();
            const stderr = errorData.trimEnd();
            const hasNonZeroExitCode =
              exitCode !== undefined && exitCode !== 0;
            const hasExitSignal =
              exitSignal !== undefined && exitSignal !== "";

            if (hasNonZeroExitCode || hasExitSignal) {
              reject(
                new ToolError(
                  "COMMAND_EXECUTION_ERROR",
                  this.formatCommandFailure(
                    stdout,
                    stderr,
                    exitCode,
                    exitSignal,
                  ) ||
                    (hasExitSignal
                      ? `Command terminated by signal ${exitSignal}${
                          exitCode !== undefined ? ` (exit code ${exitCode})` : ""
                        }`
                      : `Command failed with exit code ${exitCode}`),
                  false,
                ),
              );
              return;
            }

            resolve(stdout);
          });

          stream.on("error", (streamError: Error) => {
            cleanup();
            settled = true;
            reject(
              new ToolError(
                "COMMAND_EXECUTION_ERROR",
                `Stream error: ${streamError.message}`,
                true,
              ),
            );
          });

          commandTimeoutId = setTimeout(() => {
            try {
              stream.close();
            } catch {
              // Ignore stream close errors during timeout handling.
            }

            if (!settled) {
              settled = true;
              const stdout = data.trimEnd();
              const stderr = errorData.trimEnd();
              reject(
                new ToolError(
                  "COMMAND_TIMEOUT",
                  [
                    this.formatCommandFailure(stdout, stderr),
                    `[timeout] Command timed out after ${timeout}ms`,
                  ]
                    .filter(Boolean)
                    .join("\n"),
                  true,
                ),
              );
            }
          }, timeout);
        },
      );

      openTimeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.invalidateConnection(key);
          reject(
            new ToolError(
              "COMMAND_TIMEOUT",
              `[timeout] Command channel did not open within ${timeout}ms`,
              true,
            ),
          );
        }
      }, timeout);
    });
  }

  private async initializeShellSession(
    client: Client,
    key: string,
    config: SSHConfig,
  ): Promise<void> {
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell(
        { term: "xterm" },
        (err: Error | undefined, channel: ClientChannel) => {
          if (err) {
            reject(
              new ToolError(
                "SSH_CONNECTION_FAILED",
                `Failed to initialize shell transport for [${key}]: ${err.message}`,
                true,
              ),
            );
            return;
          }
          resolve(channel);
        },
      );
    });

    this.shellStreams.set(key, stream);
    this.shellReady.set(key, false);
    this.shellQueues.set(key, Promise.resolve());
    this.shellBuffers.set(key, "");

    const readyId = this.generateMarkerId("ready");
    const readyMarker = `__MCP_READY__${readyId}__`;

    try {
      await this.waitForShellReady(
        key,
        stream,
        readyMarker,
        this.getShellReadyTimeoutMs(config),
      );
      this.configureShellSession(stream);
      this.shellReady.set(key, true);
      this.attachShellLifecycleListeners(key, stream);
    } catch (error) {
      this.cleanupShellState(key, true);
      throw new ToolError(
        "SSH_CONNECTION_FAILED",
        `Shell transport initialization failed for [${key}]: ${
          (error as Error).message
        }`,
        true,
      );
    }
  }

  private waitForShellReady(
    key: string,
    stream: ClientChannel,
    readyMarker: string,
    timeout: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeoutId: NodeJS.Timeout;
      let probeIntervalId: NodeJS.Timeout;
      const payload = `printf '${readyMarker}\\n'\n`;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (probeIntervalId) {
          clearInterval(probeIntervalId);
        }
        stream.off("data", onData);
        stream.off("close", onClose);
        stream.off("error", onError);
      };

      const resolveIfReady = () => {
        const buffer = this.shellBuffers.get(key) || "";
        const markerIndex = buffer.indexOf(readyMarker);
        if (markerIndex === -1) {
          return;
        }

        const lineEndIndex = buffer.indexOf("\n", markerIndex);
        if (lineEndIndex === -1) {
          return;
        }

        if (!settled) {
          settled = true;
          this.shellBuffers.set(key, buffer.slice(lineEndIndex + 1));
          cleanup();
          resolve();
        }
      };

      const onData = (chunk: Buffer) => {
        this.appendShellBuffer(key, chunk.toString());
        resolveIfReady();
      };

      const onClose = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error("Shell channel closed before ready probe completed"));
      };

      const onError = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      stream.on("data", onData);
      stream.on("close", onClose);
      stream.on("error", onError);

      timeoutId = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(
          new Error(`Timed out waiting for shell ready marker after ${timeout}ms`),
        );
      }, timeout);

      stream.write(payload);
      probeIntervalId = setInterval(() => {
        if (!settled) {
          stream.write(payload);
        }
      }, 1000);
      resolveIfReady();
    });
  }

  private attachShellLifecycleListeners(
    key: string,
    stream: ClientChannel,
  ): void {
    const handleUnavailable = (reason: string) => {
      if (this.shellStreams.get(key) !== stream) {
        return;
      }

      Logger.log(`Shell channel [${key}] unavailable: ${reason}`, "error");
      this.invalidateConnection(key);
    };

    stream.on("close", () => handleUnavailable("closed"));
    stream.on("error", (error: Error) =>
      handleUnavailable(`error: ${error.message}`),
    );
  }

  private configureShellSession(stream: ClientChannel): void {
    stream.write("export PS1=''\n");
    stream.write("stty -echo >/dev/null 2>&1 || true\n");
  }

  private runShellCommand(
    cmdString: string,
    directory: string | undefined,
    name: string | undefined,
    timeout: number,
  ): Promise<string> {
    const key = name || this.defaultName;
    return this.enqueueShellCommand(key, () =>
      this.executeShellCommand(key, cmdString, directory, timeout),
    );
  }

  private enqueueShellCommand<T>(
    key: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.shellQueues.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.shellQueues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  private executeShellCommand(
    key: string,
    cmdString: string,
    directory: string | undefined,
    timeout: number,
  ): Promise<string> {
    const stream = this.shellStreams.get(key);
    if (!stream || this.shellReady.get(key) !== true) {
      throw new ToolError(
        "SSH_CONNECTION_FAILED",
        `Shell transport for [${key}] is not ready`,
        true,
      );
    }

    const commandId = this.generateMarkerId("command");
    const config = this.getConfig(key);
    const script = this.buildShellCommandScript(commandId, cmdString, directory, config.commandTemplate);

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let timeoutId: NodeJS.Timeout;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        stream.off("data", onData);
        stream.off("close", onClose);
        stream.off("error", onError);
      };

      const finish = (error?: ToolError, output?: string) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();

        if (error) {
          reject(error);
          return;
        }

        resolve(output || "");
      };

      const resolveIfComplete = () => {
        const buffer = this.shellBuffers.get(key) || "";
        const matched = this.extractShellCommandResult(buffer, commandId);
        if (!matched) {
          return;
        }

        this.shellBuffers.set(key, matched.remainder);
        const output = this.stripLeadingBeginMarker(
          this.cleanShellOutput(matched.output),
          commandId,
        ).trimEnd();

        if (matched.exitCode !== 0) {
          finish(
            new ToolError(
              "COMMAND_EXECUTION_ERROR",
              this.formatCommandFailure(output, "", matched.exitCode) ||
                `Command failed with exit code ${matched.exitCode}`,
              false,
            ),
          );
          return;
        }

        finish(undefined, output);
      };

      const onData = (chunk: Buffer) => {
        this.appendShellBuffer(key, chunk.toString());
        resolveIfComplete();
      };

      const onClose = () => {
        finish(
          new ToolError(
            "COMMAND_EXECUTION_ERROR",
            "Shell channel closed during command execution",
            true,
          ),
        );
      };

      const onError = (error: Error) => {
        finish(
          new ToolError(
            "COMMAND_EXECUTION_ERROR",
            `Shell channel error during command execution: ${error.message}`,
            true,
          ),
        );
      };

      stream.on("data", onData);
      stream.on("close", onClose);
      stream.on("error", onError);

      timeoutId = setTimeout(() => {
        this.invalidateConnection(key);
        finish(
          new ToolError(
            "COMMAND_TIMEOUT",
            `[timeout] Command timed out after ${timeout}ms`,
            true,
          ),
        );
      }, timeout);

      stream.write(script);
      resolveIfComplete();
    });
  }

  private buildShellCommandScript(
    commandId: string,
    cmdString: string,
    directory?: string,
    commandTemplate?: string,
  ): string {
    const beginMarker = `__MCP_BEGIN__${commandId}__`;
    const endMarker = `__MCP_END__${commandId}__RC__`;
    let commandBody = directory
      ? `cd -- ${shellQuote(directory)} && { ${cmdString}; }`
      : `{ ${cmdString}; }`;

    if (commandTemplate) {
      commandBody = applyCommandTemplate(commandTemplate, commandBody);
    }

    return [
      `printf '${beginMarker}\\n'`,
      commandBody,
      "__mcp_rc=$?",
      `printf '\\n${endMarker}%s__\\n' "$__mcp_rc"`,
      "",
    ].join("\n");
  }

  private extractShellCommandResult(
    buffer: string,
    commandId: string,
  ): ShellCommandMatch | null {
    const beginMarker = `__MCP_BEGIN__${commandId}__`;
    const beginIndex = buffer.indexOf(beginMarker);
    if (beginIndex === -1) {
      return null;
    }

    const beginLineEndIndex = buffer.indexOf("\n", beginIndex);
    if (beginLineEndIndex === -1) {
      return null;
    }

    const outputStartIndex = beginLineEndIndex + 1;
    const tail = buffer.slice(outputStartIndex);
    const endRegex = new RegExp(
      `__MCP_END__${this.escapeRegExp(commandId)}__RC__(-?\\d+)__(?:\\r)?\\n`,
    );
    const matched = endRegex.exec(tail);
    if (!matched) {
      return null;
    }

    const endIndex = outputStartIndex + matched.index;
    const consumedEndIndex = endIndex + matched[0].length;

    return {
      output: buffer.slice(outputStartIndex, endIndex),
      exitCode: Number.parseInt(matched[1], 10),
      remainder: buffer.slice(consumedEndIndex),
    };
  }

  private appendShellBuffer(key: string, chunk: string): void {
    const current = this.shellBuffers.get(key) || "";
    this.shellBuffers.set(key, current + chunk);
  }

  private cleanShellOutput(output: string): string {
    return output
      .replace(ANSI_OSC_PATTERN, "")
      .replace(ANSI_CSI_PATTERN, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
  }

  private stripLeadingBeginMarker(output: string, commandId: string): string {
    const beginPrefix = `__MCP_BEGIN__${commandId}__`;
    if (!output.startsWith(beginPrefix)) {
      return output;
    }

    const newlineIndex = output.indexOf("\n");
    if (newlineIndex === -1) {
      return "";
    }

    return output.slice(newlineIndex + 1);
  }

  private generateMarkerId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  }

  private escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private cleanupShellState(key: string, closeStream: boolean = false): void {
    const stream = this.shellStreams.get(key);
    if (closeStream && stream) {
      try {
        stream.close();
      } catch {
        // Ignore shell close errors during cleanup.
      }
    }

    this.shellStreams.delete(key);
    this.shellReady.delete(key);
    this.shellQueues.delete(key);
    this.shellBuffers.delete(key);
  }

  private clearConnectionState(key: string): void {
    const pendingStatusCollection = this.pendingStatusCollections.get(key);
    if (pendingStatusCollection) {
      clearTimeout(pendingStatusCollection);
      this.pendingStatusCollections.delete(key);
    }

    this.cleanupShellState(key);
    this.connected.set(key, false);
    this.clients.delete(key);
    this.pendingConnections.delete(key);
  }

  private invalidateConnection(key: string): void {
    const client = this.clients.get(key);
    this.clearConnectionState(key);
    if (client) {
      try {
        client.end();
      } catch {
        // Ignore client close errors during invalidation.
      }
    }
  }
}
