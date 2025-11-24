import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";

/**
 * Register list-servers tool
 */
export function registerListServersTool(server: McpServer): void {
  server.tool(
    "list-servers",
    "List all available SSH server configurations",
    {},
    async () => {
      const sshManager = SSHConnectionManager.getInstance();
      const servers = sshManager.getAllServerInfos();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(servers)
          }
        ]
      };
    }
  );
} 