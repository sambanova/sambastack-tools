#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const VENV_DIR = path.join(ROOT, ".venv");
const VENV_PY = path.join(VENV_DIR, "bin", "python");
const VENV_PIP = path.join(VENV_DIR, "bin", "pip");
const REQ_FILE = path.join(__dirname, "requirements.txt");

if (existsSync(VENV_PY)) {
  process.exit(0);
}

const pythonBin = process.env.PYTHON_BIN || "python3";

console.log(`[sambaeval] Creating Python venv at ${path.relative(ROOT, VENV_DIR)} ...`);
const venv = spawnSync(pythonBin, ["-m", "venv", VENV_DIR], {
  cwd: ROOT,
  stdio: "inherit",
});
if (venv.error || venv.status !== 0) {
  console.error(
    `[sambaeval] Failed to create venv. Ensure ${pythonBin} is installed and on PATH.`,
  );
  process.exit(venv.status ?? 1);
}

console.log("[sambaeval] Installing Python requirements ...");
const pip = spawnSync(VENV_PIP, ["install", "-q", "-r", REQ_FILE], {
  cwd: ROOT,
  stdio: "inherit",
});
if (pip.error || pip.status !== 0) {
  console.error("[sambaeval] Failed to install Python requirements.");
  process.exit(pip.status ?? 1);
}

console.log("[sambaeval] Python environment ready.");
