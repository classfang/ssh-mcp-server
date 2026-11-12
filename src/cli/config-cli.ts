import { parseArgs } from "node:util";
import fs from "fs";
import path from "path";
import * as readline from "node:readline/promises";
import {
  decryptJson,
  defaultKeyPath,
  encryptJson,
  generateKeyFile,
  isEncryptedBuffer,
  resolveKeyMaterial,
} from "../utils/config-crypto.js";

/**
 * `ssh-mcp-server config <action>` 子命令:管理加密配置存储。
 *
 * 明文只存在于内存与显式 export 的输出文件中,磁盘上的存储文件始终是密文。
 */

type StoreEntry = Record<string, unknown> & {
  name: string;
  host: string;
  port: number;
  username: string;
};

export function printConfigHelp(): void {
  console.log(`Usage: ssh-mcp-server config <action> [options]

Manage the encrypted connection store (secrets never rest in plaintext on disk).

Actions:
  init    --file <store.enc> [--key <keyfile>]
          Create an empty encrypted store. Generates a key at --key (or
          ~/.ssh-mcp-server.key) if it does not exist yet.
  add     --file <store.enc> --name <name> --host <host> --username <user>
          [--port <22>] [--password <pw>] [--privateKey <path>]
          [--passphrase <phrase>] [--force]
          Add a connection. --force overwrites an existing name. When
          --password is omitted and stdin is a TTY, you are prompted
          (input is echoed - prefer --password for scripted use).
  remove  --file <store.enc> <name>
          Remove a connection by name.
  list    --file <store.enc> [--show-secrets]
          List connections. Secrets are masked unless --show-secrets.
  export  --file <store.enc> --out <plain.json>
          Decrypt to a plaintext JSON file (for migration/backup).
  import  --in <plain.json> --file <store.enc> [--key <keyfile>]
          Replace the store with the contents of a plaintext JSON file
          (accepts array or object format, same as --config-file).

Key resolution (highest priority first):
  1. --key / --config-key <keyfile|literal>
  2. env SSH_MCP_CONFIG_KEY
  3. default key file ~/.ssh-mcp-server.key

Run the server against the store with:
  ssh-mcp-server --config-file <store.enc> [--config-key <keyfile>]`);
}

function fail(message: string): never {
  throw new Error(message);
}

/** 读取加密存储并解密为数组 */
function loadStore(storeFile: string, keyOption?: string): StoreEntry[] {
  if (!fs.existsSync(storeFile)) {
    fail(`Store file not found: ${storeFile}. Run 'ssh-mcp-server config init' first.`);
  }
  const raw = fs.readFileSync(storeFile);
  if (!isEncryptedBuffer(raw)) {
    fail(`Store file is not in encrypted format (missing SSHMCPENC1 header): ${storeFile}`);
  }
  const value = decryptJson<unknown>(raw, resolveKeyMaterial(keyOption));
  if (!Array.isArray(value)) {
    fail(`Decrypted store must contain a JSON array, got: ${typeof value}`);
  }
  return value as StoreEntry[];
}

/** 加密并原子写回存储(临时文件 + rename,避免写一半崩溃留下坏文件) */
function saveStore(storeFile: string, entries: StoreEntry[], keyOption?: string): void {
  const keyMaterial = resolveKeyMaterial(keyOption);
  const encrypted = encryptJson(entries, keyMaterial);
  const tmpFile = path.join(
    path.dirname(storeFile),
    `.${path.basename(storeFile)}.tmp-${process.pid}-${Date.now()}`
  );
  fs.writeFileSync(tmpFile, encrypted, { mode: 0o600 });
  try {
    fs.chmodSync(tmpFile, 0o600);
  } catch {
    // Windows 上 chmod 是近似语义,失败不阻塞
  }
  fs.renameSync(tmpFile, storeFile);
}

/** 确保 --key(或默认路径)的密钥文件存在,不存在则生成;返回密钥文件路径 */
function ensureKeyFile(keyOption?: string): string {
  const target = keyOption && keyOption.trim() && !fs.existsSync(keyOption.trim())
    ? keyOption.trim()
    : keyOption && keyOption.trim() && fs.existsSync(keyOption.trim())
      ? keyOption.trim()
      : defaultKeyPath();
  if (!fs.existsSync(target)) {
    generateKeyFile(target);
    console.log(`[config] generated key file: ${target} (keep it private)`);
  }
  return target;
}

/** 把明文 JSON(数组或对象格式,同 --config-file)归一化为存储数组 */
function normalizePlainConfig(parsed: unknown): StoreEntry[] {
  const entries: StoreEntry[] = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      entries.push(item as StoreEntry);
    }
  } else if (parsed && typeof parsed === "object") {
    for (const [name, item] of Object.entries(parsed as Record<string, unknown>)) {
      entries.push({ ...(item as Record<string, unknown>), name } as StoreEntry);
    }
  } else {
    fail("Plaintext config must contain a JSON array or object of SSH configurations");
  }
  for (const entry of entries) {
    if (!entry.name || !entry.host || !entry.port || !entry.username) {
      fail(`Each entry must include name, host, port, username (offender: ${String(entry.name)})`);
    }
    entry.port = Number(entry.port);
  }
  return entries;
}

function maskValue(value: unknown): string {
  return value === undefined || value === null || value === "" ? "-" : "******";
}

/** config 子命令入口;返回进程退出码 */
export async function runConfigCli(argv: string[]): Promise<number> {
  const action = argv[0];
  if (!action || action === "--help" || action === "-h") {
    printConfigHelp();
    return 0;
  }

  const args = argv.slice(1);

  if (action === "init") {
    const { values } = parseArgs({
      args,
      options: {
        file: { type: "string" },
        key: { type: "string" },
      },
    });
    if (!values.file) {
      fail("init requires --file <store.enc>");
    }
    const storeFile = path.resolve(values.file);
    if (fs.existsSync(storeFile)) {
      fail(`Store file already exists: ${storeFile}`);
    }
    const keyFile = ensureKeyFile(values.key);
    const keyMaterial = resolveKeyMaterial(values.key);
    fs.writeFileSync(storeFile, encryptJson([], keyMaterial), { mode: 0o600 });
    try {
      fs.chmodSync(storeFile, 0o600);
    } catch {
      // Windows 上 chmod 是近似语义,失败不阻塞
    }
    console.log(`[config] created encrypted store: ${storeFile}`);
    console.log(`[config] key file in use: ${keyFile}`);
    console.log(
      "[config] start the server with: " +
        `ssh-mcp-server --config-file "${storeFile}"`
    );
    return 0;
  }

  if (action === "add") {
    const { values } = parseArgs({
      args,
      options: {
        file: { type: "string" },
        key: { type: "string" },
        name: { type: "string" },
        host: { type: "string" },
        port: { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        privateKey: { type: "string" },
        passphrase: { type: "string" },
        force: { type: "boolean" },
      },
    });
    if (!values.file || !values.name || !values.host || !values.username) {
      fail("add requires --file, --name, --host, --username");
    }
    const storeFile = path.resolve(values.file);
    const entries = loadStore(storeFile, values.key);
    const port = values.port ? parseInt(values.port, 10) : 22;
    if (!Number.isFinite(port) || port <= 0) {
      fail(`--port must be a positive number, got: ${String(values.port)}`);
    }
    const index = entries.findIndex((entry) => entry.name === values.name);
    if (index >= 0 && !values.force) {
      fail(`Connection '${values.name}' already exists. Use --force to overwrite.`);
    }
    let password = values.password;
    if (password === undefined && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log("[config] input is echoed on screen - prefer --password for scripted use");
      password = await rl.question(`password for ${values.name}: `);
      rl.close();
      password = password.trim() || undefined;
    }
    const entry: StoreEntry = {
      name: values.name,
      host: values.host,
      port,
      username: values.username,
    };
    if (password !== undefined) {
      entry.password = password;
    }
    if (values.privateKey !== undefined) {
      entry.privateKey = values.privateKey;
    }
    if (values.passphrase !== undefined) {
      entry.passphrase = values.passphrase;
    }
    if (index >= 0) {
      entries[index] = entry;
    } else {
      entries.push(entry);
    }
    saveStore(storeFile, entries, values.key);
    console.log(`[config] ${index >= 0 ? "updated" : "added"} connection: ${values.name} (${entries.length} total)`);
    return 0;
  }

  if (action === "remove") {
    const { values, positionals } = parseArgs({
      args,
      options: {
        file: { type: "string" },
        key: { type: "string" },
      },
      allowPositionals: true,
    });
    const name = positionals[0];
    if (!values.file || !name) {
      fail("remove requires --file <store.enc> <name>");
    }
    const storeFile = path.resolve(values.file);
    const entries = loadStore(storeFile, values.key);
    const index = entries.findIndex((entry) => entry.name === name);
    if (index < 0) {
      fail(`Connection not found: ${name}`);
    }
    entries.splice(index, 1);
    saveStore(storeFile, entries, values.key);
    console.log(`[config] removed connection: ${name} (${entries.length} total)`);
    return 0;
  }

  if (action === "list") {
    const { values } = parseArgs({
      args,
      options: {
        file: { type: "string" },
        key: { type: "string" },
        "show-secrets": { type: "boolean" },
      },
    });
    if (!values.file) {
      fail("list requires --file <store.enc>");
    }
    const entries = loadStore(path.resolve(values.file), values.key);
    if (entries.length === 0) {
      console.log("[config] (empty store)");
      return 0;
    }
    for (const entry of entries) {
      const secrets = values["show-secrets"]
        ? `password=${entry.password === undefined ? "-" : String(entry.password)}`
        : `password=${maskValue(entry.password)}`;
      console.log(
        `${entry.name}  ${entry.host}:${entry.port}  ${entry.username}  ` +
          `${secrets}` +
          `${entry.privateKey ? `  privateKey=${entry.privateKey}` : ""}` +
          `${entry.agent ? `  agent=${entry.agent}` : ""}`
      );
    }
    return 0;
  }

  if (action === "export") {
    const { values } = parseArgs({
      args,
      options: {
        file: { type: "string" },
        key: { type: "string" },
        out: { type: "string" },
      },
    });
    if (!values.file || !values.out) {
      fail("export requires --file <store.enc> --out <plain.json>");
    }
    const entries = loadStore(path.resolve(values.file), values.key);
    const outFile = path.resolve(values.out);
    fs.writeFileSync(outFile, JSON.stringify(entries, null, 2) + "\n");
    console.log(`[config] exported ${entries.length} connection(s) to ${outFile} (PLAINTEXT - handle with care)`);
    return 0;
  }

  if (action === "import") {
    const { values } = parseArgs({
      args,
      options: {
        file: { type: "string" },
        key: { type: "string" },
        in: { type: "string" },
      },
    });
    if (!values.file || !values.in) {
      fail("import requires --in <plain.json> --file <store.enc>");
    }
    const inFile = path.resolve(values.in);
    if (!fs.existsSync(inFile)) {
      fail(`Input file not found: ${inFile}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(inFile, "utf-8"));
    } catch (err) {
      fail(`Invalid JSON in ${inFile}: ${(err as Error).message}`);
    }
    const entries = normalizePlainConfig(parsed);
    const storeFile = path.resolve(values.file);
    if (!fs.existsSync(storeFile)) {
      const keyFile = ensureKeyFile(values.key);
      console.log(`[config] store did not exist, created with key: ${keyFile}`);
    }
    saveStore(storeFile, entries, values.key);
    console.log(`[config] imported ${entries.length} connection(s) into ${storeFile} (store replaced)`);
    return 0;
  }

  fail(`Unknown config action: ${action}. Run 'ssh-mcp-server config' for help.`);
}
