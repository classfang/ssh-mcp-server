import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { Logger } from "../utils/logger.js";
import { toToolError } from "../utils/tool-error.js";

/**
 * Register execute command tool
 */
export function registerExecuteCommandTool(server: McpServer): void {
  const sshManager = SSHConnectionManager.getInstance();

  server.registerTool(
    "execute-command",
    {
      description:
        "Execute command on connected server and get output result. " +
        "A non-zero exit code is returned as the command's output followed by '[exit code] N' (not as a tool error).",
      inputSchema: {
        cmdString: z.string().describe("Command to execute"),
        directory: z.string().optional().describe("Working directory for command execution"),
        connectionName: z
          .string()
          .optional()
          .describe("SSH connection name (optional, default is 'default')"),
        timeout: z
          .number()
          .optional()
          .describe(
            "Command execution timeout in milliseconds (optional; overrides the connection's commandTimeoutMs or shellCommandTimeoutMs, which defaults to 30000ms)",
          ),
      },
    },
    async ({ cmdString, directory, connectionName, timeout }) => {
      try {
        const result = await sshManager.executeCommand(
          cmdString,
          directory,
          connectionName,
          {
            timeout,
          },
        );
        return {
          content: [{ type: "text", text: result }],
        };
      } catch (error: unknown) {
        const toolError = toToolError(error, "UNKNOWN_ERROR");

        // The command ran and ended with a non-zero status: its output ending in
        // "[exit code] N" is the result, so return it as is instead of wrapping
        // it in an escaped JSON error object. `grep` with no match or `diff` with
        // differences are normal outcomes, not failures of this tool.
        if (toolError.commandRan) {
          return {
            content: [{ type: "text", text: toolError.message }],
          };
        }

        Logger.handleError(toolError, "Failed to execute command");
        return {
          content: [{
            type: "text",
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
    },
  );
}
