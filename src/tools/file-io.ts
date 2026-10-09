import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { toToolError } from "../utils/tool-error.js";

const connectionName = z
  .string()
  .optional()
  .describe("SSH connection name (optional, default is 'default')");

function errorResult(error: unknown, context: string) {
  const toolError = toToolError(error, "UNKNOWN_ERROR");
  Logger.handleError(toolError, context);
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify(
        {
          code: toolError.code,
          message: toolError.message,
          retriable: toolError.retriable,
        },
        null,
        2,
      ),
    }],
    isError: true,
  };
}

/**
 * Text file access over SFTP, so content never goes through shell quoting
 * (heredocs, nested quotes) and large files can be paged.
 */
export function registerFileIoTools(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.registerTool(
    "read-file",
    {
      description:
        "Read a text file on the server over SFTP. Returns a byte range, so large files can be paged: " +
        "the header names the next offset. Refuses binary files (use download).",
      inputSchema: {
        remotePath: z.string().describe("Remote file path"),
        offset: z.number().int().nonnegative().optional().describe("Byte offset to start from (default 0)"),
        length: z.number().int().positive().optional().describe("Max bytes to read (default 65536)"),
        connectionName,
      },
    },
    async ({ remotePath, offset, length, connectionName }) => {
      try {
        const result = await sshManager.readFile(remotePath, { offset, length }, connectionName);
        return { content: [{ type: "text", text: result }] };
      } catch (error: unknown) {
        return errorResult(error, "Failed to read file");
      }
    },
  );

  server.registerTool(
    "write-file",
    {
      description:
        "Write text content to a file on the server over SFTP (overwrites, or appends with append=true). " +
        "Prefer this over echo/heredoc through execute-command for multi-line content or content with quotes.",
      inputSchema: {
        remotePath: z.string().describe("Remote file path"),
        content: z.string().describe("Text content to write (UTF-8)"),
        append: z.boolean().optional().describe("Append instead of overwrite (default false)"),
        mode: z
          .number()
          .int()
          .min(0)
          .max(0o7777)
          .optional()
          .describe("File permission bits for a newly created file, as a number, e.g. 420 for 0644 (optional)"),
        connectionName,
      },
    },
    async ({ remotePath, content, append, mode, connectionName }) => {
      try {
        const result = await sshManager.writeFile(remotePath, content, { append, mode }, connectionName);
        return { content: [{ type: "text", text: result }] };
      } catch (error: unknown) {
        return errorResult(error, "Failed to write file");
      }
    },
  );
}
