import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const manifest = join(root, "mcp", "Cargo.toml");

console.log("[mcp] building lafei-mcp (release)…");
execFileSync("cargo", ["build", "--release", "--manifest-path", manifest], {
  stdio: "inherit",
});

const rustc = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const triple = /host:\s*(\S+)/.exec(rustc)?.[1];
if (!triple) throw new Error("无法从 rustc -vV 读取目标 triple");

const suffix = process.platform === "win32" ? ".exe" : "";
const source = join(root, "mcp", "target", "release", `lafei-mcp${suffix}`);
const binaryDir = join(root, "src-tauri", "binaries");
const target = join(binaryDir, `lafei-mcp-${triple}${suffix}`);

mkdirSync(binaryDir, { recursive: true });
copyFileSync(source, target);
if (process.platform !== "win32") chmodSync(target, 0o755);
console.log(`[mcp] sidecar ready at ${target}`);
