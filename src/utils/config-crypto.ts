import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * 加密配置存储的加解密模块。
 *
 * 密文文件格式(二进制、自描述,magic header 便于 --config-file 自动识别):
 *   MAGIC(10 字节 "SSHMCPENC1") | salt(16) | nonce(12) | authTag(16) | ciphertext
 *
 * 算法:AES-256-GCM。
 * 密钥来源(--config-key 优先级从高到低):
 *   1. --config-key 参数:既可以是密钥文件路径,也可以是字面量密钥材料
 *   2. 环境变量 SSH_MCP_CONFIG_KEY
 *   3. 默认密钥文件 ~/.ssh-mcp-server.key
 * 密钥材料语义:恰好 64 位十六进制字符串按原始 32 字节密钥使用;
 * 其余任意非空字符串按口令处理,经 scrypt(salt, N=16384) 派生 32 字节密钥。
 */

const MAGIC = Buffer.from("SSHMCPENC1", "ascii");
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const RAW_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

/** 默认密钥文件路径:~/.ssh-mcp-server.key */
export function defaultKeyPath(): string {
  return path.join(os.homedir(), ".ssh-mcp-server.key");
}

/** 判断一个文件内容是否为加密配置格式(按 magic header 识别) */
export function isEncryptedBuffer(buf: Buffer): boolean {
  return buf.length > MAGIC.length + SALT_BYTES + NONCE_BYTES + AUTH_TAG_BYTES &&
    buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** 由密钥材料与盐值派生 32 字节 AES 密钥 */
function deriveKey(keyMaterial: string, salt: Buffer): Buffer {
  const material = keyMaterial.trim();
  if (!material) {
    throw new Error("Key material is empty");
  }
  if (RAW_KEY_PATTERN.test(material)) {
    return Buffer.from(material, "hex");
  }
  return crypto.scryptSync(material, salt, 32, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

/** 加密任意可 JSON 序列化的对象,返回完整密文文件内容 */
export function encryptJson(value: unknown, keyMaterial: string): Buffer {
  const salt = crypto.randomBytes(SALT_BYTES);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const key = deriveKey(keyMaterial, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const plaintext = Buffer.from(JSON.stringify(value), "utf-8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, salt, nonce, authTag, ciphertext]);
}

/** 解密 encryptJson 产出的密文;密钥错误或内容被篡改时抛出明确错误 */
export function decryptJson<T = unknown>(buf: Buffer, keyMaterial: string): T {
  if (!isEncryptedBuffer(buf)) {
    throw new Error("Not an encrypted config file (missing SSHMCPENC1 header)");
  }
  let offset = MAGIC.length;
  const salt = buf.subarray(offset, offset + SALT_BYTES);
  offset += SALT_BYTES;
  const nonce = buf.subarray(offset, offset + NONCE_BYTES);
  offset += NONCE_BYTES;
  const authTag = buf.subarray(offset, offset + AUTH_TAG_BYTES);
  offset += AUTH_TAG_BYTES;
  const ciphertext = buf.subarray(offset);
  try {
    const key = deriveKey(keyMaterial, salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf-8")) as T;
  } catch (err) {
    if (err instanceof Error && /auth|final|decrypt/i.test(err.message)) {
      throw new Error(
        "Decryption failed: wrong key or corrupted file. " +
          "Check --config-key / SSH_MCP_CONFIG_KEY / ~/.ssh-mcp-server.key."
      );
    }
    throw err;
  }
}

/**
 * 解析密钥材料,按 --config-key 参数(文件路径或字面量) >
 * 环境变量 SSH_MCP_CONFIG_KEY > 默认密钥文件 ~/.ssh-mcp-server.key 的顺序取值。
 */
export function resolveKeyMaterial(cliKey?: string): string {
  if (cliKey && cliKey.trim()) {
    const trimmed = cliKey.trim();
    if (fs.existsSync(trimmed) && fs.statSync(trimmed).isFile()) {
      const fromFile = fs.readFileSync(trimmed, "utf-8").trim();
      if (fromFile) {
        return fromFile;
      }
      throw new Error(`Key file is empty: ${trimmed}`);
    }
    return trimmed;
  }
  const fromEnv = (process.env.SSH_MCP_CONFIG_KEY || "").trim();
  if (fromEnv) {
    return fromEnv;
  }
  const defaultPath = defaultKeyPath();
  if (fs.existsSync(defaultPath)) {
    const fromFile = fs.readFileSync(defaultPath, "utf-8").trim();
    if (fromFile) {
      return fromFile;
    }
  }
  throw new Error(
    "No key material found. Provide --config-key <keyfile|literal>, " +
      "set SSH_MCP_CONFIG_KEY, or create the default key file via " +
      `'ssh-mcp-server config init' (${defaultPath}).`
  );
}

/** 生成 64 位十六进制原始密钥并写入文件(权限 0600),返回十六进制字符串 */
export function generateKeyFile(filePath: string): string {
  const hex = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(filePath, hex + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows 上 chmod 是近似语义,失败不阻塞
  }
  return hex;
}
