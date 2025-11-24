#!/usr/bin/env node

import { execSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, "..");
const buildFile = join(rootDir, "build", "index.js");

// Run TypeScript compiler
console.log("Building TypeScript...");
execSync("tsc", { stdio: "inherit", cwd: rootDir });

// Make executable on Unix-like systems (Linux, macOS, etc.)
if (process.platform !== "win32") {
  try {
    chmodSync(buildFile, 0o755);
    console.log("Made build/index.js executable");
  } catch (error) {
    console.warn(
      "Warning: Could not set executable permissions:",
      error.message
    );
  }
} else {
  console.log("Skipping chmod on Windows");
}

console.log("Build complete!");
