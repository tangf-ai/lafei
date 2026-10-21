#!/usr/bin/env node
/**
 * 清理构建产物，但默认保留 Rust 依赖缓存（target/release/deps + build），
 * 这样下次打包仍然是增量编译（十几秒），空间也不会越堆越大。
 *
 *   pnpm clean        清掉每次构建都会重新生成的东西（dist、bundle、旧 dmg 副本、vite 缓存、debug 构建）
 *   pnpm clean:all    连依赖缓存一起清（下次构建约需几分钟）
 */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const full = process.argv.includes("--all");

const artifacts = [
  "dist",
  "src-tauri/gen",
  "node_modules/.vite",
  "src-tauri/target/debug",
  "src-tauri/target/release/bundle",
];

const targets = full ? ["src-tauri/target", "dist", "node_modules/.vite"] : artifacts;

const sizeOf = (path) => {
  try {
    const kb = Number(execFileSync("du", ["-sk", path], { encoding: "utf8" }).split("\t")[0]);
    return kb * 1024;
  } catch {
    return 0;
  }
};

const human = (bytes) => {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

let freed = 0;
const removed = [];
for (const rel of targets) {
  const abs = join(root, rel);
  if (!existsSync(abs)) continue;
  const size = sizeOf(abs);
  rmSync(abs, { recursive: true, force: true });
  freed += size;
  removed.push(`${relative(root, abs)}  ${human(size)}`);
}

const kept = ["src-tauri/target/release/deps", "src-tauri/target/release/build"]
  .map((rel) => join(root, rel))
  .filter(existsSync)
  .reduce((sum, path) => sum + sizeOf(path), 0);

const dmg = execFileSync("sh", ["-c", `ls -1 "${root}"/*.dmg 2>/dev/null | head -1`], {
  encoding: "utf8",
}).trim();

console.log(full ? "已清理全部构建产物" : "已清理构建产物（保留 Rust 依赖缓存）");
if (removed.length === 0) console.log("  没有需要清理的目录");
for (const line of removed) console.log(`  - ${line}`);
console.log(`共释放 ${human(freed)}`);
if (!full) {
  if (kept > 0) console.log(`保留依赖缓存 ${human(kept)}（target/release/deps + build，下次构建可增量）`);
  if (dmg) console.log(`保留发布包 ${relative(root, dmg)}`);
}
