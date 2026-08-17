import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";

type ServerInfo = ReturnType<SSHConnectionManager["getAllServerInfos"]>[number];

export function formatServerList(servers: ServerInfo[]): string {
  if (servers.length === 0) {
    return "No SSH servers configured.";
  }

  const summary = servers.map((server) => {
    const parts = [
      `[${server.connected ? "connected" : "disconnected"}] ${server.name}`,
      `${server.username}@${server.host}:${server.port}`,
    ];

    if (server.status?.hostname) {
      parts.push(`hostname=${server.status.hostname}`);
    }

    if (server.status?.osName) {
      parts.push(`os=${server.status.osName}`);
    }

    if (server.status?.lastUpdated) {
      parts.push(`updated=${server.status.lastUpdated}`);
    }

    return parts.join(" | ");
  });

  return [
    "Configured SSH servers:",
    ...summary,
    "",
    "Raw JSON:",
    // Not indented: the pretty printed form is roughly 40% larger for the same
    // data, and this output is fed to a model rather than read as a document.
    JSON.stringify(servers),
  ].join("\n");
}

/**
 * Register list-servers tool
 */
export function registerListServersTool(server: McpServer): void {
  server.registerTool(
    "list-servers",
    {
      description: "List all available SSH server configurations",
    },
    async () => {
      const sshManager = SSHConnectionManager.getInstance();
      const servers = sshManager.getAllServerInfos();
      return {
        content: [
          {
            type: "text",
            text: formatServerList(servers),
          },
        ],
      };
    },
  );
}
