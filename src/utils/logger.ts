import { LogLevel } from '../models/types.js';

/**
 * Logger class
 */
export class Logger {
  /**
   * Log a message
   * Note: All logging goes to stderr to avoid interfering with MCP stdio protocol (which uses stdout)
   */
  public static log(message: string, level: LogLevel = "info"): void {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;

    // Always write to stderr to avoid corrupting MCP protocol messages on stdout
    process.stderr.write(formattedMessage + '\n');
  }

  /**
   * Handle error
   */
  public static handleError(
    error: unknown,
    prefix: string = "",
    exit: boolean = false
  ): string {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const fullMessage = prefix ? `${prefix}: ${errorMessage}` : errorMessage;

    Logger.log(fullMessage, "error");

    if (exit) {
      process.exit(1);
    }

    return fullMessage;
  }
} 