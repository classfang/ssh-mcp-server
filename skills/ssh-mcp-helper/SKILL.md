---
name: ssh-mcp-helper
description: Use when 用户希望安装、配置或新增 ssh-mcp-server 的 MCP 连接（如「帮我装一下 ssh-mcp-server」「给 Cursor/Claude Code 配置 SSH MCP」「在已有 MCP 里加一台远程主机」「ssh-mcp-server 的 mcp.json 怎么写」）。技能通过逐步问答收集主机、认证、传输模式、命令限制等参数，并把生成的 mcpServers JSON 片段写入对应客户端的配置文件。
---

# ssh-mcp-helper

## 概述

帮助用户通过交互式问答完成 `@fangjunjie/ssh-mcp-server` 的安装预检与 MCP 客户端配置。技能本身**不代替用户输入凭据**，而是逐项确认认证方式、连接参数与安全策略，最终产出可直接写入 MCP 客户端配置文件的 `mcpServers` JSON 片段。

**核心准则：** 所有可枚举的选项（MCP 客户端类型、认证方式、传输模式、是/否开关）必须使用 AskUserQuestion 让用户选择；只有不可枚举的输入（host、用户名、私钥路径、密码、自定义白名单正则等）才允许自由文本提问。

## 何时使用

- 用户明确要安装/配置/新增 ssh-mcp-server
- 用户提到为 Cursor / Claude Code / Cline / Continue 等客户端添加 SSH MCP
- 用户希望在已有 `mcpServers` 中追加一台 SSH 主机
- 用户问「ssh-mcp-server 的 mcp.json 怎么写」

## 何时不使用

- 用户要修改 ssh-mcp-server 源码 → 直接编辑代码，不进入向导
- 用户只是想跑某条 SSH 命令 → 直接调用已存在的 ssh-mcp-server 工具
- 用户在问 SSH 协议本身的概念 → 解释即可，无需走流程

## 工作流程

```dot
digraph ssh_mcp_helper {
    "0. 前置环境检查" [shape=box];
    "1. 选择 MCP 客户端" [shape=box];
    "2. 单台 vs 多台" [shape=diamond];
    "3. 选择认证方式" [shape=box];
    "4. 询问连接参数" [shape=box];
    "5. 询问高级选项" [shape=box];
    "6. 生成 JSON 片段" [shape=box];
    "7. 合并写入配置" [shape=box];
    "8. 提示重启与验证" [shape=doublecircle];

    "0. 前置环境检查" -> "1. 选择 MCP 客户端";
    "1. 选择 MCP 客户端" -> "2. 单台 vs 多台";
    "2. 单台 vs 多台" -> "3. 选择认证方式" [label="单台"];
    "2. 单台 vs 多台" -> "3. 选择认证方式" [label="多台 → 写 ssh-config.json"];
    "3. 选择认证方式" -> "4. 询问连接参数";
    "4. 询问连接参数" -> "5. 询问高级选项";
    "5. 询问高级选项" -> "6. 生成 JSON 片段";
    "6. 生成 JSON 片段" -> "7. 合并写入配置";
    "7. 合并写入配置" -> "8. 提示重启与验证";
}
```

### Step 0：前置环境检查
- 运行 `node -v` 与 `npx --version` 确认本机有 Node.js（推荐 v18+）
- 缺失则先提示用户安装 Node.js，再继续后续步骤

### Step 1：选择 MCP 客户端（AskUserQuestion 多选一）

| 客户端 | 默认配置位置 |
|---|---|
| Claude Code（全局） | `~/.claude.json` 的 `mcpServers` 字段 |
| Claude Code（项目级） | 项目根 `.mcp.json` |
| Cursor | `~/.cursor/mcp.json` |
| Cline / Continue / 其他 | 让用户提供具体路径 |

### Step 2：单台 vs 多台（AskUserQuestion 三选一）
- **单台**：直接使用命令行参数（`--host` 等）
- **多台（明文 JSON）**：生成 `ssh-config.json` 并使用 `--config-file`
- **多台（加密存储）**：使用 `config` 子命令维护加密存储 `store.enc`，磁盘上不落明文凭据（含密码时**优先推荐**）

#### 多台·加密存储流程
1. 初始化（一次性）：`ssh-mcp-server config init --file <store.enc>`，密钥文件默认生成在 `~/.ssh-mcp-server.key`
2. 逐台添加：`ssh-mcp-server config add --file <store.enc> --name <名称> --host <主机> --username <用户> [--password ...]`（省略 `--password` 时交互输入；`--force` 覆盖同名）；已有明文 JSON 可用 `config import --in <plain.json> --file <store.enc>` 一次性迁移
3. 检查：`ssh-mcp-server config list --file <store.enc>`（默认脱敏，`--show-secrets` 显示明文）
4. 启动参数与明文完全一致（`--config-file <store.enc>`），密钥来源按优先级：`--config-key <keyfile|literal>` > 环境变量 `SSH_MCP_CONFIG_KEY` > `~/.ssh-mcp-server.key`

### Step 3：选择认证方式（AskUserQuestion 多选一）
- `password` — 账号 + 密码
- `privateKey` — 账号 + 私钥；再用 AskUserQuestion 确认是否带 passphrase
- `ssh-config` — 复用 `~/.ssh/config` 中的 Host 别名（只需 `--host <alias>`，可选 `--ssh-config-file`）
- `ssh-agent` — 使用 `--agent` 指向 socket
- `2fa` — 密码 + 私钥 + 键盘交互，追加 `--try-keyboard`

### Step 4：连接参数（自由文本）
- host / port / username（port=22 可省略）
- 按 Step 3 的结果追问密码、私钥路径、passphrase、agent socket 等

### Step 5：高级选项（每项独立用 AskUserQuestion 询问是/否）
1. SOCKS 代理：是 → 追问 `--socksProxy` 字符串
2. 命令白名单：是 → 追问逗号分隔正则（**生产环境强烈建议开启**）
3. 命令黑名单：是 → 追问逗号分隔正则
4. 命令模板：是 → 追问含 `<command>` 占位符的模板
5. 传输模式：默认 `exec`；若用户标记目标为堡垒机/跳板机，改 `shell` 并追问 `--shell-ready-timeout`
6. 路径白名单：是 → 追问 `--allowed-local-paths` / `--allowed-remote-paths`
7. 启动时预连接：是 → 追加 `--pre-connect`
8. MCP 接入方式：默认 `stdio`（客户端拉起进程）。若选 HTTP：
   - 启动命令追加 `--mcp-transport http`，并建议设置 `SSH_MCP_HTTP_TOKEN`（或 `--http-token`）
   - 客户端配置使用 `url` 与可选的 `headers.Authorization`，形式为 `Bearer <token>`
   - 提醒用户先单独启动 ssh-mcp-server 进程，再让客户端连接该 URL
   - 默认只监听 `127.0.0.1:3000`，路径 `/mcp`；监听非本机地址时启动日志会警告，应同时配置令牌

### Step 6：生成 JSON 片段
装配规则：
- stdio：`command` 固定为 `"npx"`，`args` 第一项 `"-y"`，第二项 `"@fangjunjie/ssh-mcp-server"`
- http：客户端片段使用 `url`；有令牌时加上 `headers.Authorization`。另外单独给出启动进程的命令，令牌放在环境变量 `SSH_MCP_HTTP_TOKEN` 中
- **每个命令行参数与值必须是 args 数组中独立的两个元素**，绝不能写成 `"--host 192.168.1.1"`
- 多连接场景：把每个连接写入 `ssh-config.json`（数组或对象格式皆可）。stdio 的客户端配置里放 `--config-file <绝对路径>`；http 则把该参数放进单独的启动命令
- 加密存储场景：客户端配置里放 `--config-file <store.enc 绝对路径>`，密钥用 `--config-key <密钥文件绝对路径>` 或在 mcpServers 片段的 `env` 字段里设 `SSH_MCP_CONFIG_KEY`（**不要**把密钥字面量写进命令行——会留在 shell 历史与进程列表里）

### Step 7：合并写入配置
- 先用 Read 读取目标 JSON 配置文件
- 合并到既存 `mcpServers` 下；若存在同名 key，**先 AskUserQuestion 让用户选择覆盖 / 改名 / 取消**
- 写入前把最终片段展示给用户确认
- 写入后输出该配置文件的绝对路径

### Step 8：收尾
- 提示用户重启对应 MCP 客户端使配置生效
- 给出验证方式：调用 `list-servers`，或对该连接执行 `execute-command "whoami"`

## 速查表

| 场景 | 关键参数 |
|---|---|
| 账号密码 | `--host --port --username --password` |
| 私钥（可带 passphrase） | `--host --port --username --privateKey [--passphrase]` |
| 复用 ssh config 别名 | `--host <alias>` (+可选 `--ssh-config-file`) |
| SOCKS 代理 | `--socksProxy socks://user:pwd@host:port` |
| 堡垒机 / 跳板机 | `--transport-mode shell --shell-ready-timeout 15000` |
| 多连接 | `--config-file /abs/path/ssh-config.json` |
| 多连接（加密存储） | `config init/add` 维护 `store.enc`，启动 `--config-file <store.enc> --config-key <keyfile>`（或环境变量 `SSH_MCP_CONFIG_KEY`） |
| 2FA / MFA | `--try-keyboard`（搭配密码 + 私钥） |
| 命令白名单 | `--whitelist "^ls(?: [A-Za-z0-9_./-]+)*$,^cat [A-Za-z0-9_./-]+$"` |
| 命令黑名单 | `--blacklist "^rm .*,^shutdown.*"` |
| 命令模板 | `--command-template "su root -c '<command>'"` |
| 路径白名单 | `--allowed-local-paths` / `--allowed-remote-paths` |
| HTTP 接入 | `--mcp-transport http`，客户端改用 `url`；令牌用 `SSH_MCP_HTTP_TOKEN` |

## 常见坑

- ❌ 把 `"--host 192.168.1.1"` 当作一个 args 元素 → ✅ 拆成两个元素 `"--host", "192.168.1.1"`
- ❌ 密码含 `{ } = ,` 等字符却用旧式 `--ssh "name=...,password=..."` → ✅ 改用 `--config-file` 或 JSON 形式 `--ssh`
- ❌ `shell` 模式下还想用 `upload`/`download` → 该模式禁用 SFTP，需切回 `exec`
- ❌ 直接覆盖用户既有 `mcpServers` 中的同名 key → 必须先读后合并，覆盖前显式确认
- ❌ 直连生产环境却未配置 `--whitelist` / `--blacklist` → 必须主动提醒安全风险
- ❌ 把私钥内容粘进配置 → 配置里应填**私钥文件路径**，凭据留在本地
- ❌ 连接带密码却仍写明文 `ssh-config.json` → ✅ 优先用加密存储（`config init/add/import`），磁盘不落明文凭据
- ❌ 密钥字面量直接放 `--config-key` 命令行 → ✅ 用密钥文件路径或 `SSH_MCP_CONFIG_KEY` 环境变量，避免进 shell 历史与进程列表
- ❌ 用本地 tarball 当 npx 包规格时漏掉 `file:` 前缀 → ✅ 写成 `npx -y file:D:/path/pkg.tgz`，否则不会被当作包解析

## 输出示例

最简单的账号密码场景产出：

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
        "--whitelist", "^ls(?: [A-Za-z0-9_./-]+)*$,^cat [A-Za-z0-9_./-]+$"
      ]
    }
  }
}
```

HTTP 接入时，进程单独启动，客户端只保存 URL：

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer replace-with-a-long-random-token"
      }
    }
  }
}
```

对应启动命令在参数中加上 `--mcp-transport http`，令牌通过 `SSH_MCP_HTTP_TOKEN` 传入。

多连接场景产出 `ssh-config.json` + 简化的客户端配置：

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": ["-y", "@fangjunjie/ssh-mcp-server", "--config-file", "/abs/path/ssh-config.json"]
    }
  }
}
```

加密存储场景（凭据不落盘）+ 密钥走环境变量：

```json
{
  "mcpServers": {
    "ssh-mcp-server": {
      "command": "npx",
      "args": ["-y", "@fangjunjie/ssh-mcp-server", "--config-file", "/abs/path/store.enc"],
      "env": {
        "SSH_MCP_CONFIG_KEY": "/abs/path/.ssh-mcp-server.key 的内容或口令"
      }
    }
  }
}
```
