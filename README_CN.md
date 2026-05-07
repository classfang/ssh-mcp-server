# 🔐 ssh-mcp-server

基于 SSH 的 MCP (Model Context Protocol) 服务器，允许通过 MCP 协议远程执行 SSH 命令。

[English Document](README.md) | 中文文档

## 📝 项目介绍

ssh-mcp-server 是一个桥接工具，可以让 AI 助手等支持 MCP 协议的应用通过标准化接口执行远程 SSH 命令。这使得 AI 助手能够安全地操作远程服务器，执行命令并获取结果，而无需直接暴露 SSH 凭据给 AI 模型。

欢迎加入微信交流群「Agent・Skill・MCP 技术交流社」：

![wx_1.png](images/wx_1.png)

> 微信扫码，回复“加群”即可。

## ✨ 功能亮点

- **🔒 安全连接**：支持多种安全的 SSH 连接方式，包括密码认证和私钥认证（支持带密码的私钥）
- **🛡️ 命令安全控制**：通过灵活的黑白名单机制，精确控制允许执行的命令范围，防止危险操作
- **🔄 标准化接口**：符合 MCP 协议规范，与支持该协议的 AI 助手无缝集成
- **🚇 双传输模式**：同时支持 `exec` 和 `shell` 两种 transport，兼容直连主机与堡垒机或跳板机场景
- **📂 文件传输**：支持双向文件传输功能，可上传本地文件到服务器或从服务器下载文件
- **🔑 凭据隔离**：SSH 凭据完全在本地管理，不会暴露给 AI 模型，增强安全性
- **🚀 即用即走**：使用 NPX 可直接运行，无需全局安装，方便快捷

## 📦 开源仓库

GitHub：[https://github.com/classfang/ssh-mcp-server](https://github.com/classfang/ssh-mcp-server)

NPM: [https://www.npmjs.com/package/@fangjunjie/ssh-mcp-server](https://www.npmjs.com/package/@fangjunjie/ssh-mcp-server)

## 🛠️ 工具列表

| 工具 | 名称 | 描述 |
|---------|-----------|----------|
| execute-command | 命令执行工具 | 在远程服务器上执行 SSH 命令并获取执行结果 |
| upload | 文件上传工具 | 将本地文件上传到远程服务器指定位置 |
| download | 文件下载工具 | 从远程服务器下载文件到本地指定位置 |
| list-servers | 服务器列表工具 | 列出所有可用SSH服务器配置 |

## 📚 使用方法

### 🔧 MCP 配置示例

> **⚠️ 重要提示**: 在 MCP 配置文件中，每个命令行参数和其值必须是 `args` 数组中的独立元素。不要用空格将它们连接在一起。例如，使用 `"--host", "192.168.1.1"` 而不是 `"--host 192.168.1.1"`。

#### ⚙️ 命令行选项

```text
选项:
  --config-file       JSON 配置文件路径（推荐用于多服务器配置）
  --ssh-config-file   SSH 配置文件路径（默认: ~/.ssh/config）
  --ssh               SSH 连接配置（可以是 JSON 字符串或旧格式）
  -h, --host          SSH 服务器主机地址或 SSH 配置中的别名
  -p, --port          SSH 服务器端口
  -u, --username      SSH 用户名
  -w, --password      SSH 密码
  -k, --privateKey    SSH 私钥文件路径
  -P, --passphrase    私钥密码（如果有的话）
  -a, --agent         SSH agent socket 路径
  -W, --whitelist     命令白名单，以逗号分隔的正则表达式
  -B, --blacklist     命令黑名单,以逗号分隔的正则表达式
  -s, --socksProxy    SOCKS 代理地址 (e.g., socks://user:password@host:port)
  --allowed-local-paths upload/download 允许访问的额外本地路径，逗号分隔
  --allowed-remote-paths SFTP upload/download 允许访问的远端路径（POSIX 绝对路径），逗号分隔
  --transport-mode    SSH transport 模式: exec 或 shell（默认: exec）
  --shell-ready-timeout shell 就绪探测超时，单位毫秒（默认: 10000）
  --pty               为命令执行分配伪终端 (默认: true)
  --pre-connect       启动时预连接所有配置的 SSH 服务器
```

#### 🚇 `transportMode` 什么时候用

`transportMode` 默认是 `exec`。

- `exec` 适用于普通 Linux 服务器，远端支持标准 SSH `exec` 执行命令时优先使用这个模式。
- `shell` 适用于必须先进入交互式 shell 的场景，比如堡垒机、跳板机、网络设备，或者远端 `exec` 能连上但执行命令不稳定或不可用的环境。

两者差异：

- `exec`：支持 `execute-command`、`upload`、`download`
- `shell`：命令通过持久 shell 会话串行执行，内部带命令队列；但不支持 `upload` 和 `download`，因为该模式下禁用了 SFTP

出现下面这些情况时，应该考虑切到 `shell`：

- SSH 登录成功，但 `exec` 执行命令失败
- 远端必须等登录 banner、profile、环境初始化完成后才能正常执行命令
- 连接目标本质上是堡垒机或只暴露交互式 shell 的设备

怎么配置：

- 单连接命令行参数：`--transport-mode shell --shell-ready-timeout 15000`
- JSON 配置文件：设置 `transportMode` 为 `"shell"`，可选再配 `shellReadyTimeoutMs`
- `shell` 模式命令超时只支持配置文件字段：`shellCommandTimeoutMs`

示例：

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

#### 🔑 使用密码

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

#### 🔐 使用私钥

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

#### 🔏 使用带密码私钥

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

#### 📋 使用 ~/.ssh/config

你可以使用 `~/.ssh/config` 文件中定义的主机别名。服务器会自动从 SSH 配置中读取连接参数：

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

假设你的 `~/.ssh/config` 包含：

```
Host myserver
    HostName 192.168.1.1
    Port 22
    User root
    IdentityFile ~/.ssh/id_rsa
```

你也可以指定自定义的 SSH 配置文件路径：

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

**注意**：命令行参数优先级高于 SSH 配置值。例如，如果你指定了 `--port 2222`，它会覆盖 SSH 配置中的端口。

#### 🌐 使用 SOCKS 代理

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

#### 📝 使用命令白名单和黑名单

使用 `--whitelist` 和 `--blacklist` 参数可以限制可执行的命令范围，多个模式之间用逗号分隔。每个模式都是一个正则表达式，用于匹配命令。

示例：使用命令白名单

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

示例：使用命令黑名单

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

> 注意：如果同时指定了白名单和黑名单，系统会先检查命令是否在白名单中，然后再检查是否在黑名单中。命令必须同时通过两项检查才能被执行。

### 🧩 多SSH连接用法示例

有三种方式可以配置多个 SSH 连接：

#### 📄 方式一：使用配置文件（推荐）

创建 JSON 配置文件（例如 `ssh-config.json`）：

**数组格式：**

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

**对象格式：**

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

然后使用 `--config-file` 参数：

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

#### 🔧 方式二：使用 JSON 格式的 --ssh 参数

可以直接传递 JSON 格式的配置字符串：

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

#### 📝 方式三：旧格式逗号分隔（向后兼容）

对于密码中不包含特殊字符的简单情况，仍可使用旧格式：

```bash
npx @fangjunjie/ssh-mcp-server \
  --ssh "name=dev,host=1.2.3.4,port=22,user=alice,password=xxx" \
  --ssh "name=prod,host=5.6.7.8,port=22,user=bob,password=yyy"
```

> **⚠️ 注意**：旧格式在处理包含特殊字符（如 `=`、`,`、`{`、`}`）的密码时可能会有问题。如果密码包含特殊字符，请使用方式一或方式二。

在MCP工具调用时，通过 `connectionName` 参数指定目标连接名称，未指定时使用默认连接。

示例（在prod连接上执行命令）：

```json
{
  "tool": "execute-command",
  "params": {
    "cmdString": "ls -al",
    "connectionName": "prod"
  }
}
```

示例（带超时选项的命令执行）：

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

### ⏱️ 命令执行超时

`execute-command` 工具支持超时选项，防止命令无限期挂起：

- **timeout**: 命令执行超时时间（毫秒，可选，默认为30000ms）
- 在 `shell` 模式下，还可以在 JSON 配置文件里为单个连接设置 `shellCommandTimeoutMs`
- 错误响应现在包含稳定的 `code`、`message`、`retriable` 字段，便于上层 Agent 处理

这对于像 `ping`、`tail -f` 或其他可能阻塞执行的长时间运行进程特别有用。

### 🗂️ 列出所有SSH服务器

可以通过MCP工具 `list-servers` 获取所有可用的SSH服务器配置：

调用示例：

```json
{
  "tool": "list-servers",
  "params": {}
}
```

返回示例：

```json
[
  { "name": "dev", "host": "1.2.3.4", "port": 22, "username": "alice" },
  { "name": "prod", "host": "5.6.7.8", "port": 22, "username": "bob" }
]
```

## 🛡️ 安全注意事项

该服务器提供了在远程服务器上执行命令和传输文件的强大功能。为确保安全使用，请注意以下几点：

- **命令白名单**：*强烈建议* 使用 `--whitelist` 选项来限制可执行的命令集合。如果没有白名单，任何命令都可以在远程服务器上执行，这可能带来重大的安全风险。
- **私钥安全**：服务器会将 SSH 私钥读入内存。请确保运行 `ssh-mcp-server` 的机器是安全的。不要将服务器暴露给不受信任的网络。
- **拒绝服务攻击 (DoS)**：服务器没有内置的速率限制。攻击者可能通过向服务器发送大量连接请求或大文件传输来发起 DoS 攻击。建议在具有速率限制功能的防火墙或反向代理后面运行服务器。
- **路径遍历**：服务器内置了对本地文件系统路径遍历攻击的保护。但是，仍然需要注意在 `upload` 和 `download` 命令中使用的路径。
- **本地传输范围**：默认仅允许访问当前工作目录。只有在明确可信时，才建议通过 `--allowed-local-paths` 或配置文件中的 `allowedLocalPaths` 放宽范围。
- **远端传输范围**：SFTP upload/download 仅接受绝对 POSIX 路径。未配置 `allowedRemotePaths`（或 `--allowed-remote-paths`）时，任意远端路径都允许，但启动时会打印警告。强烈建议显式配置 `allowedRemotePaths` 白名单，避免模型被 prompt 注入后读写 `~/.ssh/authorized_keys`、`/etc/sshd_config` 之类敏感文件。

## 🎮 演示

### 🖥️ Cursor 接入

![demo_1.png](images/demo_1.png)

![demo_2.png](images/demo_2.png)

## 🌟 Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=classfang/ssh-mcp-server&type=date&legend=top-left)](https://www.star-history.com/#classfang/ssh-mcp-server&type=date&legend=top-left)
