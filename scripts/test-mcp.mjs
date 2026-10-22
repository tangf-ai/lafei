#!/usr/bin/env node
/**
 * Smoke test for the lafei-mcp stdio server.
 * Usage: node scripts/test-mcp.mjs [--data-dir <snapshot-dir>]
 * Build first: node scripts/build-mcp.mjs
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

function defaultDataDir() {
  if (platform() === "darwin") {
    return join(homedir(), "Library/Application Support/app.lafei.desktop/agent");
  }
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? homedir(), "app.lafei.desktop", "agent");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "app.lafei.desktop", "agent");
}

const args = process.argv.slice(2);
let dataDir = defaultDataDir();
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--data-dir" && args[index + 1]) {
    dataDir = resolve(args[index + 1]);
    index += 1;
  }
}

const candidates = [
  process.env.LAFEI_MCP_BIN,
  join(process.cwd(), "mcp/target/release", platform() === "win32" ? "lafei-mcp.exe" : "lafei-mcp"),
  join(process.cwd(), "mcp/target/debug", platform() === "win32" ? "lafei-mcp.exe" : "lafei-mcp"),
].filter(Boolean);
const binary = candidates.find((candidate) => existsSync(candidate));
if (!binary) {
  console.error("找不到 lafei-mcp，请先运行 node scripts/build-mcp.mjs");
  process.exit(1);
}
if (!existsSync(dataDir)) {
  console.error(`快照目录不存在：${dataDir}\n请先在 Lafei 设置 → 智能体访问中开启并导出。`);
  process.exit(1);
}

const child = spawn(binary, ["--data-dir", dataDir], { stdio: ["pipe", "pipe", "pipe"] });
let buffer = "";
let stderr = "";
const pending = new Map();
child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id != null && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

let nextId = 1;
function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 8000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const notify = (method, params = {}) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "lafei-smoke-test", version: "0.0.1" },
  });
  notify("notifications/initialized");
  const tools = await request("tools/list");
  const resources = await request("resources/list");
  const tags = await request("tools/call", { name: "tags_list", arguments: {} });
  const tasks = await request("tools/call", { name: "tasks_list", arguments: { status: "all", limit: 5 } });
  console.log(`server: ${init.serverInfo.name} ${init.serverInfo.version} (${init.protocolVersion})`);
  console.log(`tools: ${tools.tools.map((tool) => tool.name).join(", ")}`);
  console.log(`resources: ${resources.resources.length}`);
  console.log(`tags: ${JSON.parse(tags.content[0].text).tags.length}`);
  const taskResult = JSON.parse(tasks.content[0].text);
  console.log(`tasks: ${taskResult.total ?? taskResult.tasks.length}`);
  if (stderr.trim()) console.log(`stderr: ${stderr.trim().slice(0, 300)}`);
  console.log("OK");
} catch (error) {
  console.error("FAILED:", error.message);
  if (stderr.trim()) console.error(stderr.trim().slice(0, 1000));
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
}
