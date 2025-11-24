import { Client, ClientChannel } from "ssh2";
import { SocksClient } from "socks";
import { SSHConfig, SshConnectionConfigMap, ServerStatus } from "../models/types.js";
import { Logger } from "../utils/logger.js";
import { collectSystemStatus } from "../utils/status-collector.js";
import fs from "fs";
import path from "path";
import { SFTPWrapper } from "ssh2";

/**
 * SSH Connection Manager class
 */
export class SSHConnectionManager {
  private static instance: SSHConnectionManager;
  private clients: Map<string, Client> = new Map();
  private configs: SshConnectionConfigMap = {};
  private connected: Map<string, boolean> = new Map();
  private statusCache: Map<string, ServerStatus> = new Map();
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
    defaultName?: string
  ): void {
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
    for (const name of names) {
      await this.connect(name);
    }
  }

  /**
   * Connect to SSH with specified name
   */
  public async connect(name?: string): Promise<void> {
    const key = name || this.defaultName;
    if (this.connected.get(key) && this.clients.get(key)) {
      return;
    }
    const config = this.getConfig(key);
    const client = new Client();
    await new Promise<void>(async (resolve, reject) => {
      client.on("ready", () => {
        this.connected.set(key, true);
        Logger.log(
          `Successfully connected to SSH server [${key}] ${config.host}:${config.port}`
        );
        
        // Collect system status after connection (non-blocking)
        collectSystemStatus(client, key)
          .then((status) => {
            this.statusCache.set(key, status);
            Logger.log(
              `System status collected for [${key}]`,
              "info"
            );
          })
          .catch((error) => {
            Logger.log(
              `Failed to collect system status for [${key}]: ${(error as Error).message}`,
              "error"
            );
            // Set basic status even if collection fails
            this.statusCache.set(key, {
              reachable: true,
              lastUpdated: new Date().toISOString(),
            });
          });
        
        resolve();
      });
      client.on("error", (err: Error) => {
        this.connected.set(key, false);
        reject(new Error(`SSH connection [${key}] failed: ${err.message}`));
      });
      client.on("close", () => {
        this.connected.set(key, false);
        Logger.log(`SSH connection [${key}] closed`, "info");
      });
      const sshConfig: any = {
        host: config.host,
        port: config.port,
        username: config.username,
      };
      // Add SOCKS proxy configuration if provided
      if (config.socksProxy) {
        try {
          // Parse SOCKS proxy URL
          const proxyUrl = new URL(config.socksProxy);
          const proxyHost = proxyUrl.hostname;
          const proxyPort = parseInt(proxyUrl.port, 10);

          Logger.log(
            `Using SOCKS proxy for [${key}]: ${config.socksProxy}`,
            "info"
          );

          // Create SOCKS connection
          const { socket } = await SocksClient.createConnection({
            proxy: {
              host: proxyHost,
              port: proxyPort,
              type: 5,
            },
            command: "connect",
            destination: {
              host: config.host,
              port: config.port,
            },
          });

          // Set the socket as the sock for SSH connection
          sshConfig.sock = socket;
          Logger.log(
            `SSH config object with SOCKS proxy: ${JSON.stringify(
              sshConfig,
              (k, v) => (k === "sock" ? "[Socket object]" : v)
            )}`,
            "info"
          );
        } catch (err) {
          return reject(
            new Error(
              `Failed to create SOCKS proxy connection for [${key}]: ${
                (err as Error).message
              }`
            )
          );
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
            "info"
          );
        } catch (err) {
          return reject(
            new Error(
              `Failed to read private key file for [${key}]: ${
                (err as Error).message
              }`
            )
          );
        }
      } else if (config.password) {
        sshConfig.password = config.password;
        Logger.log(`Using password authentication for [${key}]`, "info");
      } else {
        return reject(
          new Error(
            `No valid authentication method provided for [${key}] (password or private key)`
          )
        );
      }
      client.connect(sshConfig);
    });
    this.clients.set(key, client);
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
   * Ensure SSH client is connected
   * @private
   */
  private async ensureConnected(name?: string): Promise<Client> {
    const key = name || this.defaultName;
    if (!this.connected.get(key) || !this.clients.get(key)) {
      await this.connect(key);
    }
    const client = this.clients.get(key);
    if (!client) {
      throw new Error(`SSH client for '${key}' not initialized`);
    }
    return client;
  }

  private validateCommand(
    command: string,
    name?: string
  ): { isAllowed: boolean; reason?: string } {
    const config = this.getConfig(name);
    // Check whitelist (if whitelist is configured, command must match one of the patterns to be allowed)
    if (config.commandWhitelist && config.commandWhitelist.length > 0) {
      const matchesWhitelist = config.commandWhitelist.some((pattern) => {
        const regex = new RegExp(pattern);
        return regex.test(command);
      });
      if (!matchesWhitelist) {
        return {
          isAllowed: false,
          reason: "Command not in whitelist, execution forbidden",
        };
      }
    }
    // Check blacklist (if command matches any pattern in blacklist, execution is forbidden)
    if (config.commandBlacklist && config.commandBlacklist.length > 0) {
      const matchesBlacklist = config.commandBlacklist.some((pattern) => {
        const regex = new RegExp(pattern);
        return regex.test(command);
      });
      if (matchesBlacklist) {
        return {
          isAllowed: false,
          reason: "Command matches blacklist, execution forbidden",
        };
      }
    }
    // Validation passed
    return {
      isAllowed: true,
    };
  }

  /**
   * Execute SSH command
   */
  public async executeCommand(
    cmdString: string,
    name?: string,
    options: { timeout?: number } = {}
  ): Promise<string> {
    // Validate command input and security
    const validationResult = this.validateCommand(cmdString, name);
    if (!validationResult.isAllowed) {
      throw new Error(`Command validation failed: ${validationResult.reason}`);
    }

    // Ensure SSH connection is established
    const client = await this.ensureConnected(name);

    // Configure execution options with defaults
    const timeout = options.timeout || 30000; // Default 30 seconds timeout

    return new Promise<string>((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;

      // Cleanup function to clear timeout and prevent memory leaks
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      };

      // Execute command via SSH exec
      client.exec(
        cmdString,
        (err: Error | undefined, stream: ClientChannel) => {
          // Handle immediate execution errors
          if (err) {
            cleanup();
            reject(new Error(`Command execution error: ${err.message}`));
            return;
          }

          // Initialize data buffers for stdout and stderr
          let data = "";
          let errorData = "";

          // Set up event listeners for command output streams
          stream.on("data", (chunk: Buffer) => (data += chunk.toString())); // Collect stdout data
          stream.stderr.on(
            "data",
            (chunk: Buffer) => (errorData += chunk.toString()) // Collect stderr data
          );

          // Handle command completion and exit code
          stream.on("close", (code: number) => {
            cleanup();
            resolve(data);
          });

          // Handle stream errors during execution
          stream.on("error", (err: Error) => {
            cleanup();
            reject(new Error(`Stream error: ${err.message}`));
          });

          // Set timeout for command execution
          timeoutId = setTimeout(() => {
            try {
              // Try to gracefully close the stream first
              stream.close();
            } catch (e) {
              // Ignore errors when closing streams during timeout
            }
          }, timeout);
        }
      );
    });
  }

  /**
   * Upload file
   */
  private validateLocalPath(localPath: string): string {
    const resolvedPath = path.resolve(localPath);
    const workingDir = process.cwd();
    if (!resolvedPath.startsWith(workingDir)) {
      throw new Error(
        `Path traversal detected. Local path must be within the working directory.`
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
    name?: string
  ): Promise<string> {
    const validatedLocalPath = this.validateLocalPath(localPath);
    const client = await this.ensureConnected(name);

    return new Promise<string>((resolve, reject) => {
      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) {
          return reject(new Error(`SFTP connection failed: ${err.message}`));
        }

        const readStream = fs.createReadStream(validatedLocalPath);
        const writeStream = sftp.createWriteStream(remotePath);

        const cleanup = () => {
          sftp.end();
        };

        writeStream.on("close", () => {
          cleanup();
          resolve("File uploaded successfully");
        });

        writeStream.on("error", (err: Error) => {
          cleanup();
          reject(new Error(`File upload failed: ${err.message}`));
        });

        readStream.on("error", (err: Error) => {
          cleanup();
          reject(new Error(`Failed to read local file: ${err.message}`));
        });

        readStream.pipe(writeStream);
      });
    });
  }

  /**
   * Download file
   */
  public async download(
    remotePath: string,
    localPath: string,
    name?: string
  ): Promise<string> {
    const validatedLocalPath = this.validateLocalPath(localPath);
    const client = await this.ensureConnected(name);

    return new Promise<string>((resolve, reject) => {
      client.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
        if (err) {
          return reject(new Error(`SFTP connection failed: ${err.message}`));
        }

        const readStream = sftp.createReadStream(remotePath);
        const writeStream = fs.createWriteStream(validatedLocalPath);

        const cleanup = () => {
          sftp.end();
        };

        writeStream.on("finish", () => {
          cleanup();
          resolve("File downloaded successfully");
        });

        writeStream.on("error", (err: Error) => {
          cleanup();
          reject(new Error(`Failed to save file: ${err.message}`));
        });

        readStream.on("error", (err: Error) => {
          cleanup();
          reject(new Error(`File download failed: ${err.message}`));
        });

        readStream.pipe(writeStream);
      });
    });
  }

  /**
   * Disconnect SSH connection
   */
  public disconnect(): void {
    if (this.clients.size > 0) {
      for (const client of this.clients.values()) {
        client.end();
      }
      this.clients.clear();
    }
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
}
