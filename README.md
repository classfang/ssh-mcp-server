# 🔐 ssh-mcp-server

![NPM Version](https://img.shields.io/npm/v/%40fangjunjie%2Fssh-mcp-server?label=%40fangjunjie%2Fssh-mcp-server)
![GitHub forks](https://img.shields.io/github/forks/classfang/ssh-mcp-server)
![GitHub Repo stars](https://img.shields.io/github/stars/classfang/ssh-mcp-server)
![GitHub Issues or Pull Requests](https://img.shields.io/github/issues/classfang/ssh-mcp-server)
![GitHub Issues or Pull Requests](https://img.shields.io/github/issues-closed/classfang/ssh-mcp-server)
![GitHub Issues or Pull Requests](https://img.shields.io/github/issues-pr/classfang/ssh-mcp-server)
![GitHub Issues or Pull Requests](https://img.shields.io/github/issues-pr-closed/classfang/ssh-mcp-server)

SSH-based MCP (Model Context Protocol) server that allows remote execution of SSH commands via the MCP protocol.

English Document | [中文文档](README_CN.md)

## 📝 Project Overview

ssh-mcp-server is a bridging tool that enables AI assistants and other applications supporting the MCP protocol to execute remote SSH commands through a standardized interface. This allows AI assistants to safely operate remote servers, execute commands, and retrieve results without directly exposing SSH credentials to AI models.

Welcome to join wechat group:

![wx_1.png](images/wx_1.png)

## ✨ Key Features

- **🔒 Secure Connections**: Supports multiple secure SSH connection methods, including password authentication and private key authentication (with passphrase support)
- **🛡️ Command Security Control**: Precisely control the range of allowed commands through flexible blacklist and whitelist mechanisms to prevent dangerous operations
- **🔄 Standardized Interface**: Complies with MCP protocol specifications for seamless integration with AI assistants supporting the protocol
- **🚇 Dual Transport Modes**: Supports both `exec` and `shell` transport modes for direct SSH hosts and bastion or jump-host scenarios
- **📂 File Transfer**: Supports bidirectional file transfers, uploading local files to servers or downloading files from servers
- **🔑 Credential Isolation**: SSH credentials are managed entirely locally and never exposed to AI models, enhancing security
- **🚀 Ready to Use**: Can be run directly using NPX without global installation, making it convenient and quick to deploy

## 📦 Open Source Repository

GitHub: [https://github.com/classfang/ssh-mcp-server](https://github.com/classfang/ssh-mcp-server)

NPM: [https://www.npmjs.com/package/@fangjunjie/ssh-mcp-server](https://www.npmjs.com/package/@fangjunjie/ssh-mcp-server)

## 🛠️ Tools List

| Tool | Name | Description |
|---------|-----------|----------|
| execute-command | Command Execution Tool | Execute SSH commands on remote servers and get results |
| upload | File Upload Tool | Upload local files to specified locations on remote servers |
| download | File Download Tool | Download files from remote servers to local specified locations |
| list-servers | List Servers Tool | List all available SSH server configurations |

## 📚 Usage

### 🔧 MCP Configuration Examples

> **⚠️ Important**: In MCP configuration files, each command line argument and its value must be separate elements in the `args` array. Do NOT combine them with spaces. For example, use `"--host", "192.168.1.1"` instead of `"--host 192.168.1.1"`.

#### ⚙️ Command Line Options

```text
Options:
  --config-file       JSON configuration file path (recommended for multiple servers)
  --ssh-config-file   SSH config file path (default: ~/.ssh/config)
  --ssh               SSH connection configuration (can be JSON string or legacy format)
  -h, --host          SSH server host address or alias from SSH config
  -p, --port          SSH server port
  -u, --username      SSH username
  -w, --password      SSH password
  -k, --privateKey    SSH private key file path
  -P, --passphrase    Private key passphrase (if any)
  -a, --agent         SSH agent socket path
  -W, --whitelist     Command whitelist, comma-separated regular expressions
  -B, --blacklist     Command blacklist, comma-separated regular expressions
  -s, --socksProxy    SOCKS proxy server address (e.g., socks://user:password@host:port)
  --allowed-local-paths Additional allowed local paths for upload/download, comma-separated
  --allowed-remote-paths Allowed remote (POSIX, absolute) paths for SFTP upload/download, comma-separated
  --transport-mode    SSH transport mode: exec or shell (default: exec)
  --shell-ready-timeout Shell readiness probe timeout in milliseconds (default: 10000)
  --pty               Allocate pseudo-tty for command execution (default: true)
  --pre-connect       Pre-connect to all configured SSH servers on startup

```

#### 🚇 When To Use `transportMode`

`transportMode` defaults to `exec`.

- Use `exec` for regular Linux hosts that support standard SSH command execution.
- Use `shell` for bastion hosts, jump hosts, network devices, or environments where you must enter an interactive shell before commands work reliably.

Behavior differences:

- `exec`: supports `execute-command`, `upload`, and `download`
- `shell`: runs commands through a persistent shell session with an internal command queue, but does not support `upload` or `download` because SFTP is unavailable in this mode

Switch to `shell` when:

- SSH login succeeds but `exec` command execution fails
- The remote side requires shell startup scripts, banners, or environment initialization first
- The target effectively exposes only an interactive shell

Configuration:

- CLI: `--transport-mode shell --shell-ready-timeout 15000`
- JSON config: set `transportMode` to `"shell"` and optionally set `shellReadyTimeoutMs`
- JSON config only: use `shellCommandTimeoutMs` to override the default timeout for shell-backed commands

Example:

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@fangjunjie/ssh-mcp-server",
        "--host", "bastion.example.com",
        "--port", "22",
        "--username", "ops",
        "--password", "pwd123456",
        "--transport-mode", "shell",
        "--shell-ready-timeout", "15000"
      ]
    }
  }
}
```

#### 🔑 Using Password

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@fangjunjie/ssh-mcp-server",
        "--host", "192.168.1.1",
        "--port", "22",
        "--username", "root",
        "--password", "pwd123456"
      ]
    }
  }
}
```

#### 🔐 Using Private Key

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@fangjunjie/ssh-mcp-server",
        "--host", "192.168.1.1",
        "--port", "22",
        "--username", "root",
        "--privateKey", "~/.ssh/id_rsa"
      ]
    }
  }
}
```

#### 🔏 Using Private Key with Passphrase

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@fangjunjie/ssh-mcp-server",
        "--host", "192.168.1.1",
        "--port", "22",
        "--username", "root",
        "--privateKey", "~/.ssh/id_rsa",
        "--passphrase", "pwd123456"
      ]
    }
  }
}
```

#### 📋 Using ~/.ssh/config

You can use host aliases defined in your `~/.ssh/config` file. The server will automatically read connection parameters from the SSH config:

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@fangjunjie/ssh-mcp-server",
        "--host", "myserver"
      ]
    }
  }
}
```

Assuming your `~/.ssh/config` contains:

```
Host myserver
    HostName 192.168.1.1
    Port 22
    User root
    IdentityFile ~/.ssh/id_rsa
```

You can also specify a custom SSH config file path:

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@fangjunjie/ssh-mcp-server",
        "--host", "myserver",
        "--ssh-config-file", "/path/to/custom/ssh_config"
      ]
    }
  }
}
```

**Note**: Command-line parameters take precedence over SSH config values. For example, if you specify `--port 2222`, it will override the port from SSH config.

#### 🌐 Using SOCKS Proxy

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@fangjunjie/ssh-mcp-server",
        "--host", "192.168.1.1",
        "--port", "22",
        "--username", "root",
        "--password", "pwd123456",
        "--socksProxy", "socks://username:password@proxy-host:proxy-port"
      ]
    }
  }
}

```

#### 📝 Using Command Whitelist and Blacklist

Use the `--whitelist` and `--blacklist` parameters to restrict the range of executable commands. Multiple patterns are separated by commas. Each pattern is a regular expression used to match commands.

Example: Using Command Whitelist

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@fangjunjie/ssh-mcp-server",
        "--host", "192.168.1.1",
        "--port", "22",
        "--username", "root",
        "--password", "pwd123456",
        "--whitelist", "^ls( .*)?,^cat .*,^df.*"
      ]
    }
  }
}
```

Example: Using Command Blacklist

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@fangjunjie/ssh-mcp-server",
        "--host", "192.168.1.1",
        "--port", "22",
        "--username", "root",
        "--password", "pwd123456",
        "--blacklist", "^rm .*,^shutdown.*,^reboot.*"
      ]
    }
  }
}
```

> Note: If both whitelist and blacklist are specified, the system will first check whether the command is in the whitelist, and then check whether it is in the blacklist. The command must pass both checks to be executed.

### 🧩 Multi-SSH Connection Example

There are three ways to configure multiple SSH connections:

#### 📄 Method 1: Using Config File (Recommended)

Create a JSON configuration file (e.g., `ssh-config.json`):

**Array Format:**
```json
[
  {
    "name": "dev",
    "host": "1.2.3.4",
    "port": 22,
    "username": "alice",
    "password": "{abc=P100s0}",
    "socksProxy": "socks://127.0.0.1:10808"
  },
  {
    "name": "bastion",
    "host": "9.9.9.9",
    "port": 22,
    "username": "ops",
    "password": "pwd123456",
    "transportMode": "shell",
    "shellReadyTimeoutMs": 15000,
    "shellCommandTimeoutMs": 45000
  },
  {
    "name": "prod",
    "host": "5.6.7.8",
    "port": 22,
    "username": "bob",
    "password": "yyy",
    "socksProxy": "socks://127.0.0.1:10808"
  }
]
```

**Object Format:**
```json
{
  "dev": {
    "host": "1.2.3.4",
    "port": 22,
    "username": "alice",
    "password": "{abc=P100s0}",
    "socksProxy": "socks://127.0.0.1:10808"
  },
  "bastion": {
    "host": "9.9.9.9",
    "port": 22,
    "username": "ops",
    "password": "pwd123456",
    "transportMode": "shell",
    "shellReadyTimeoutMs": 15000,
    "shellCommandTimeoutMs": 45000
  },
  "prod": {
    "host": "5.6.7.8",
    "port": 22,
    "username": "bob",
    "password": "yyy",
    "socksProxy": "socks://127.0.0.1:10808"
  }
}
```

Then use the `--config-file` parameter:

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@fangjunjie/ssh-mcp-server",
        "--config-file", "ssh-config.json"
      ]
    }
  }
}
```

#### 🔧 Method 2: Using JSON Format with --ssh Parameter

You can pass JSON-formatted configuration strings directly:

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@fangjunjie/ssh-mcp-server",
        "--ssh", "{\"name\":\"dev\",\"host\":\"1.2.3.4\",\"port\":22,\"username\":\"alice\",\"password\":\"{abc=P100s0}\",\"socksProxy\":\"socks://127.0.0.1:10808\"}",
        "--ssh", "{\"name\":\"bastion\",\"host\":\"9.9.9.9\",\"port\":22,\"username\":\"ops\",\"password\":\"pwd123456\",\"transportMode\":\"shell\",\"shellReadyTimeoutMs\":15000}",
        "--ssh", "{\"name\":\"prod\",\"host\":\"5.6.7.8\",\"port\":22,\"username\":\"bob\",\"password\":\"yyy\",\"socksProxy\":\"socks://127.0.0.1:10808\"}"
      ]
    }
  }
}
```

#### 📝 Method 3: Legacy Comma-Separated Format (Backward Compatible)

For simple cases without special characters in passwords, you can still use the legacy format:

```bash
npx @fangjunjie/ssh-mcp-server \
  --ssh "name=dev,host=1.2.3.4,port=22,user=alice,password=xxx" \
  --ssh "name=prod,host=5.6.7.8,port=22,user=bob,password=yyy"
```

> **⚠️ Note**: The legacy format may have issues with passwords containing special characters like `=`, `,`, `{`, `}`. Use Method 1 or Method 2 for passwords with special characters.

In MCP tool calls, specify the connection name via the `connectionName` parameter. If omitted, the default connection is used.

Example (execute command on 'prod' connection):

```json
{
  "tool": "execute-command",
  "params": {
    "cmdString": "ls -al",
    "connectionName": "prod"
  }
}
```

Example (execute command with timeout options):

```json
{
  "tool": "execute-command",
  "params": {
    "cmdString": "ping -c 10 127.0.0.1",
    "connectionName": "prod",
    "timeout": 5000
  }
}
```

### ⏱️ Command Execution Timeout

The `execute-command` tool supports timeout options to prevent commands from hanging indefinitely:

- **timeout**: Command execution timeout in milliseconds (optional, default is 30000ms)
- In `shell` mode, you can also set `shellCommandTimeoutMs` per connection in the JSON config file
- Error responses include stable `code`, `message`, and `retriable` fields for easier agent-side handling

This is particularly useful for commands like `ping`, `tail -f`, or other long-running processes that might block execution.

### 🗂️ List All SSH Servers

You can use the MCP tool `list-servers` to get all available SSH server configurations:

Example call:

```json
{
  "tool": "list-servers",
  "params": {}
}
```

Example response:

```json
[
  { "name": "dev", "host": "1.2.3.4", "port": 22, "username": "alice" },
  { "name": "prod", "host": "5.6.7.8", "port": 22, "username": "bob" }
]
```

## 🛡️ Security Considerations

This server provides powerful capabilities to execute commands and transfer files on remote servers. To ensure it is used securely, please consider the following:

- **Command Whitelisting**: It is *strongly recommended* to use the `--whitelist` option to restrict the set of commands that can be executed. Without a whitelist, any command can be executed on the remote server, which can be a significant security risk.
- **Private Key Security**: The server reads the SSH private key into memory. Ensure that the machine running the `ssh-mcp-server` is secure. Do not expose the server to untrusted networks.
- **Denial of Service (DoS)**: The server does not have built-in rate limiting. An attacker could potentially launch a DoS attack by flooding the server with connection requests or large file transfers. It is recommended to run the server behind a firewall or reverse proxy with rate-limiting capabilities.
- **Path Traversal**: The server has built-in protection against path traversal attacks on the local filesystem. However, it is still important to be mindful of the paths used in `upload` and `download` commands.
- **Local Transfer Scope**: By default, local file transfers are restricted to the current working directory. Use `--allowed-local-paths` or `allowedLocalPaths` in config only for explicitly trusted directories.
- **Remote Transfer Scope**: SFTP upload/download accepts only absolute POSIX paths. If `allowedRemotePaths` (or `--allowed-remote-paths`) is not configured, any remote path is accepted and the server prints a startup warning. Configure `allowedRemotePaths` to whitelist a small set of remote directories; this is strongly recommended to prevent prompt-injection-driven reads or writes of files like `~/.ssh/authorized_keys` or `/etc/sshd_config`.

## 🌟 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=classfang/ssh-mcp-server&type=date&legend=top-left)](https://www.star-history.com/#classfang/ssh-mcp-server&type=date&legend=top-left)
