#!/usr/bin/env node

import { SshMcpServer } from "./core/mcp-server.js";
import { SERVER_CONFIG } from "./config/server.js";
import { Logger } from "./utils/logger.js";

const HELP_TEXT = `Usage: ssh-mcp-server [options]

Options:
  --config-file <path>       Load SSH server configs from a JSON file
  --ssh <config>             Add an SSH config as JSON or legacy key=value pairs
  --host <host>              Connect to a single SSH host
  --port <port>              SSH port for single-host mode
  --username <name>          SSH username for single-host mode
  --password <password>      SSH password for single-host mode
  --privateKey <path>        SSH private key path for single-host mode
  --ssh-config-file <path>   Read host aliases from a custom SSH config file
  --version, -v              Print package version
  --help                     Print this help message`;

function hasArg(...names: string[]): boolean {
  return process.argv.slice(2).some((arg) => names.includes(arg));
}

/**
 * Main program entry
 */
async function main(): Promise<void> {
  if (hasArg("--help")) {
    console.log(HELP_TEXT);
    return;
  }

  if (hasArg("--version", "-v")) {
    console.log(SERVER_CONFIG.version);
    return;
  }

  const sshMcpServer = new SshMcpServer();
  await sshMcpServer.run();
}

main().catch((error) => Logger.handleError(error, "【SSH MCP Server Error】", true));
