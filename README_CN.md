# 🔐 ssh-mcp-server

基于 SSH 的 MCP (Model Context Protocol) 服务器，允许通过 MCP 协议远程执行 SSH 命令。

[English Document](README.md) | 中文文档

## 📝 项目介绍

ssh-mcp-server 是一个桥接工具，可以让 AI 助手等支持 MCP 协议的应用通过标准化接口执行远程 SSH 命令。这使得 AI 助手能够安全地操作远程服务器，执行命令并获取结果，而无需直接暴露 SSH 凭据给 AI 模型。

微信MCP技术交流群：

![wx_1.png](images/wx_1.png)

## ✨ 功能亮点

- **🔒 安全连接**：支持多种安全的 SSH 连接方式，包括密码认证和私钥认证（支持带密码的私钥）
- **🛡️ 命令安全控制**：通过灵活的黑白名单机制，精确控制允许执行的命令范围，防止危险操作
- **🔄 标准化接口**：符合 MCP 协议规范，与支持该协议的 AI 助手无缝集成
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
  --ssh               SSH 连接配置（可以是 JSON 字符串或旧格式）
  --ssh-config-file   SSH 配置文件路径（默认：~/.ssh/config）
  -h, --host          SSH 服务器主机地址（支持 ~/.ssh/config 中的主机别名）
  -p, --port          SSH 服务器端口
  -u, --username      SSH 用户名
  -w, --password      SSH 密码
  -k, --privateKey    SSH 私钥文件路径
  -P, --passphrase    私钥密码（如果有的话）
  -W, --whitelist     命令白名单，以逗号分隔的正则表达式
  -B, --blacklist     命令黑名单，以逗号分隔的正则表达式
  -s, --socksProxy    SOCKS 代理地址 (e.g., socks://user:password@host:port)
  --pre-connect       启动时预连接所有配置的 SSH 服务器
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

#### 🔑 使用 ~/.ssh/config

如果你已经在 `~/.ssh/config` 中配置了主机，可以直接使用主机别名——端口、用户名和私钥路径会自动从 SSH 配置文件中读取：

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@fangjunjie/ssh-mcp-server",
        "--host", "my-server"
      ]
    }
  }
}
```

命令行参数优先于 SSH 配置文件中的值。你也可以指定自定义的 SSH 配置文件路径：

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": [
        "-y",
        "@fangjunjie/ssh-mcp-server",
        "--host", "my-server",
        "--ssh-config-file", "/path/to/custom/ssh_config"
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

## 🎮 演示

### 🖥️ Cursor 接入

![demo_1.png](images/demo_1.png)

![demo_2.png](images/demo_2.png)

## 🌟 Star 历史

[![Star History Chart](https://api.star-history.com/svg?repos=classfang/ssh-mcp-server&type=date&legend=top-left)](https://www.star-history.com/#classfang/ssh-mcp-server&type=date&legend=top-left)
