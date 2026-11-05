#!/usr/bin/env node
/**
 * lafei-mcp 冒烟测试。
 *
 * 用法：
 *   node scripts/test-mcp.mjs [--data-dir <snapshot-dir>]   真实快照只读验证（不会调用写入工具）
 *   node scripts/test-mcp.mjs --fixture                     自动创建临时快照，验证读取 + 写入队列
 *
 * 先构建：node scripts/build-mcp.mjs
 * （或 cargo build --release --manifest-path mcp/Cargo.toml）
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REQUEST_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,95}\.json$/;
const QUEUED_MESSAGE =
  "Lafei 应用当前未运行或尚未处理请求；请求已排队，Lafei 启动后会自动创建。";

function defaultDataDir() {
  if (platform() === "darwin") {
    return join(homedir(), "Library/Application Support/app.lafei.desktop/agent");
  }
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? homedir(), "app.lafei.desktop", "agent");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "app.lafei.desktop", "agent");
}

function parseArgs(argv) {
  let dataDir = null;
  let fixture = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--data-dir" && argv[index + 1]) {
      dataDir = resolve(argv[index + 1]);
      index += 1;
    } else if (argv[index] === "--fixture") {
      fixture = true;
    } else {
      console.error(`未知参数：${argv[index]}`);
      process.exit(2);
    }
  }
  if (fixture && dataDir) {
    console.error("--fixture 不能和 --data-dir 同时使用");
    process.exit(2);
  }
  if (!fixture && !dataDir) dataDir = defaultDataDir();
  return { dataDir, fixture };
}

function findBinary() {
  const suffix = platform() === "win32" ? ".exe" : "";
  const candidates = [
    process.env.LAFEI_MCP_BIN,
    join(process.cwd(), "mcp/target/release", `lafei-mcp${suffix}`),
    join(process.cwd(), "mcp/target/debug", `lafei-mcp${suffix}`),
  ].filter(Boolean);
  const binary = candidates.find((candidate) => existsSync(candidate));
  if (!binary) {
    console.error("找不到 lafei-mcp，请先运行 node scripts/build-mcp.mjs");
    process.exit(1);
  }
  return binary;
}

/** 写入 fixture 的 manifest，模拟应用导出的快照；写入开关通过 enabled 控制。 */
function writeFixtureManifest(dir, enabled) {
  const manifest = {
    schemaVersion: 2,
    appVersion: "0.20.0-fixture",
    revision: 1,
    generatedAt: 1762345678901,
    counts: { notes: 1, tasks: 1, tags: 1 },
    writer: {
      enabled,
      inbox: "inbox",
      processed: "inbox/done",
      failed: "inbox/failed",
      ops: ["notes.create", "tasks.create"],
      maxPending: 200,
    },
  };
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** 建一份最小可用的临时快照目录（默认写入关闭，写测试时再打开）。 */
function createFixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "lafei-mcp-fixture-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  mkdirSync(join(dir, "inbox/done"), { recursive: true });
  mkdirSync(join(dir, "inbox/failed"), { recursive: true });
  writeFixtureManifest(dir, false);
  writeFileSync(
    join(dir, "notes.index.json"),
    `${JSON.stringify(
      [
        {
          id: "fixture-note-1",
          title: "Alpha 冒烟笔记",
          tags: ["alpha"],
          pinned: false,
          excerpt: "这是 fixture 笔记正文",
          createdAt: 1762345678000,
          updatedAt: 1762345688000,
          file: "notes/fixture-note-1.md",
        },
      ],
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(dir, "notes/fixture-note-1.md"),
    "---\ntitle: Alpha 冒烟笔记\ntags:\n  - alpha\n---\n\n这是 fixture 笔记正文，包含 alpha 关键词。\n"
  );
  writeFileSync(
    join(dir, "tasks.jsonl"),
    `${JSON.stringify({
      id: "fixture-task-1",
      title: "Alpha 冒烟任务",
      done: false,
      dueDate: "2026-12-31",
      priority: "medium",
      tags: ["alpha"],
      createdAt: 1762345678000,
      updatedAt: 1762345688000,
    })}\n`
  );
  writeFileSync(
    join(dir, "tags.json"),
    `${JSON.stringify([{ tag: "alpha", notes: 1, tasks: 1 }], null, 2)}\n`
  );
  writeFileSync(
    join(dir, "AGENTS.md"),
    "# Lafei 智能体说明（冒烟 fixture）\n\n此目录由 scripts/test-mcp.mjs --fixture 临时创建，仅用于测试。\n"
  );
  return dir;
}

function startServer(binary, dataDir) {
  const child = spawn(binary, ["--data-dir", dataDir], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let stderrText = "";
  const pending = new Map();

  child.stderr.on("data", (chunk) => (stderrText += chunk.toString()));
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = pending.get(message.id);
      if (!entry) continue;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(`${entry.method}: ${JSON.stringify(message.error)}`));
      } else {
        entry.resolve(message.result);
      }
    }
  });
  child.on("exit", (code) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`server 已退出（code=${code}），方法 ${entry.method} 未返回`));
    }
    pending.clear();
  });

  let nextId = 1;
  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`timeout: ${method}`));
      }, 10000);
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, method });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  function notify(method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
  return { request, notify, stderr: () => stderrText, close: () => child.kill("SIGTERM") };
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function toolText(result) {
  return result?.content?.[0]?.text ?? "";
}

function toolJson(result) {
  return JSON.parse(toolText(result));
}

function callTool(server, name, args) {
  return server.request("tools/call", { name, arguments: args });
}

function listInboxRequestFiles(inboxDir) {
  return readdirSync(inboxDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && REQUEST_FILE_PATTERN.test(entry.name))
    .map((entry) => entry.name);
}

function listTempFiles(inboxDir) {
  return readdirSync(inboxDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(".tmp-"))
    .map((entry) => entry.name);
}

/** 模拟桌面应用：把请求文件合并 result 后移动到 done/ 或 failed/。 */
function settleRequest(inboxDir, targetDir, requestId, result) {
  const source = join(inboxDir, `${requestId}.json`);
  const request = JSON.parse(readFileSync(source, "utf8"));
  request.result = { appliedAt: Date.now(), ...result };
  writeFileSync(join(targetDir, `${requestId}.json`), `${JSON.stringify(request, null, 2)}\n`);
  rmSync(source);
}

function scheduleSettle(inboxDir, targetDir, requestId, result) {
  setTimeout(() => {
    try {
      settleRequest(inboxDir, targetDir, requestId, result);
    } catch (error) {
      console.error(`模拟应用处理失败：${error.message}`);
    }
  }, 150);
}

async function runReadChecks(server, fixture) {
  const init = await server.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "lafei-smoke-test", version: "0.0.1" },
  });
  server.notify("notifications/initialized");
  assert(typeof init.serverInfo?.name === "string", "initialize 应返回 serverInfo.name");
  assert(
    typeof init.instructions === "string" &&
      init.instructions.includes("read-only") &&
      init.instructions.includes("notes_create"),
    "initialize instructions 应说明默认只读并提到 notes_create / tasks_create"
  );

  const tools = await server.request("tools/list");
  const names = tools.tools.map((tool) => tool.name);
  for (const name of [
    "notes_search",
    "notes_get",
    "tasks_list",
    "tasks_get",
    "tags_list",
    "notes_create",
    "tasks_create",
  ]) {
    assert(names.includes(name), `tools/list 缺少 ${name}`);
  }
  for (const name of ["notes_create", "tasks_create"]) {
    const tool = tools.tools.find((item) => item.name === name);
    assert(tool.annotations?.readOnlyHint === false, `${name}.annotations.readOnlyHint 应为 false`);
    assert(tool.annotations?.destructiveHint === false, `${name}.annotations.destructiveHint 应为 false`);
    assert(tool.inputSchema?.required?.includes("title"), `${name}.inputSchema 应要求 title`);
    assert(tool.inputSchema?.additionalProperties === false, `${name}.inputSchema 应禁止额外参数`);
  }

  const resources = await server.request("resources/list");
  const tags = toolJson(await callTool(server, "tags_list", {}));
  const tasks = toolJson(await callTool(server, "tasks_list", { status: "all", limit: 5 }));
  const search = toolJson(await callTool(server, "notes_search", { query: "alpha" }));

  console.log(`server: ${init.serverInfo.name} ${init.serverInfo.version} (${init.protocolVersion})`);
  console.log(`tools: ${names.join(", ")}`);
  console.log(`resources: ${resources.resources.length}`);
  console.log(`tags: ${tags.tags.length}`);
  console.log(`tasks: ${tasks.total ?? tasks.tasks.length}`);
  console.log(`search(alpha): ${search.count}`);

  if (fixture) {
    assert(search.count >= 1, "fixture 中 notes_search 应能命中 alpha 笔记");
    const note = toolJson(await callTool(server, "notes_get", { id: "fixture-note-1" }));
    assert(note.markdown.includes("alpha"), "notes_get 应返回 fixture 笔记正文");
    assert(tasks.total === 1, `fixture 中 tasks_list 应返回 1 条，实际 ${tasks.total}`);
    assert(tags.tags.length === 1, `fixture tags 应有 1 个，实际 ${tags.tags.length}`);
  }
}

async function runWriteChecks(server, fixtureDir) {
  const inboxDir = join(fixtureDir, "inbox");
  const doneDir = join(inboxDir, "done");
  const failedDir = join(inboxDir, "failed");
  const requestFiles = () => listInboxRequestFiles(inboxDir);
  const assertNoTempLeftovers = () => {
    const leftovers = listTempFiles(inboxDir);
    assert(leftovers.length === 0, `inbox 不应残留临时文件：${leftovers.join(", ")}`);
  };

  // 1. writer 关闭时写入被拒绝，且不写队列
  let result = await callTool(server, "notes_create", { title: "关闭状态笔记" });
  assert(result.isError === true, "writer 关闭时 notes_create 应返回 isError=true");
  assert(
    toolText(result).includes("未开启智能体写入"),
    `错误文案应提示未开启写入，实际：${toolText(result)}`
  );
  assert(requestFiles().length === 0, "writer 关闭时不应写入 inbox");
  console.log("✓ writer 关闭：notes_create 被拒绝且未写队列");

  // 2. 参数校验（发生在写入开关检查之前，因此关闭状态下也能验证）
  const invalidCases = [
    ["notes_create", { title: "   " }, "标题不能为空"],
    ["notes_create", { title: "x".repeat(201) }, "最多 200 个字符"],
    ["tasks_create", { title: "任务", dueDate: "2026-02-30" }, "dueDate"],
    ["tasks_create", { title: "任务", priority: "urgent" }, "priority"],
    ["tasks_create", { title: "任务", noteId: "missing-note" }, "noteId"],
  ];
  for (const [tool, args, expected] of invalidCases) {
    const bad = await callTool(server, tool, args);
    assert(bad.isError === true, `${tool} 非法参数应返回 isError=true：${JSON.stringify(args)}`);
    assert(
      toolText(bad).includes(expected),
      `${tool} 错误文案应包含「${expected}」，实际：${toolText(bad)}`
    );
  }
  assert(requestFiles().length === 0, "参数校验失败时不应写入 inbox");
  console.log("✓ 参数校验：空标题 / 超长标题 / 假日期 / 非法优先级 / 不存在的 noteId 均返回中文错误");

  // 3. 打开写入后 notes_create 排队，检查 inbox 请求文件结构
  writeFixtureManifest(fixtureDir, true);
  const noteArgs = {
    title: "  冒烟笔记  ",
    content: "你好，Lafei",
    tags: ["#alpha", "alpha", " beta "],
    pinned: true,
  };
  result = await callTool(server, "notes_create", noteArgs);
  assert(result.isError === false, `writer 开启后 notes_create 应成功：${toolText(result)}`);
  const noteQueued = toolJson(result);
  assert(noteQueued.status === "queued", `notes_create 应返回 queued，实际：${noteQueued.status}`);
  assert(
    /^req-\d{13}-[0-9a-f]{8}$/.test(noteQueued.requestId),
    `requestId 格式不符：${noteQueued.requestId}`
  );
  assert(noteQueued.message === QUEUED_MESSAGE, `排队提示文案不符：${noteQueued.message}`);

  const noteRequestFile = join(inboxDir, `${noteQueued.requestId}.json`);
  assert(existsSync(noteRequestFile), "inbox 中应有笔记请求文件");
  const noteRequest = JSON.parse(readFileSync(noteRequestFile, "utf8"));
  assert(
    JSON.stringify(Object.keys(noteRequest).sort()) ===
      JSON.stringify(["client", "createdAt", "op", "payload", "requestId", "schemaVersion"]),
    `请求文件字段不符：${Object.keys(noteRequest).join(", ")}`
  );
  assert(noteRequest.schemaVersion === 1, "schemaVersion 应为 1");
  assert(noteRequest.requestId === noteQueued.requestId, "requestId 应与返回一致");
  assert(noteRequest.op === "notes.create", "op 应为 notes.create");
  assert(
    noteRequest.client === "lafei-smoke-test",
    `client 应为 initialize 的 clientInfo.name，实际：${noteRequest.client}`
  );
  assert(
    typeof noteRequest.createdAt === "number" && String(noteRequest.createdAt).length === 13,
    "createdAt 应为 13 位毫秒时间戳"
  );
  assert(noteRequest.payload.title === "冒烟笔记", "title 应 trim");
  assert(noteRequest.payload.content === "你好，Lafei", "content 应原样保留");
  assert(
    JSON.stringify(noteRequest.payload.tags) === JSON.stringify(["alpha", "beta"]),
    `tags 应去 #、trim、去重，实际：${JSON.stringify(noteRequest.payload.tags)}`
  );
  assert(noteRequest.payload.pinned === true, "pinned 应保留 true");
  assertNoTempLeftovers();
  console.log(`✓ writer 开启：notes_create 已排队（${noteQueued.requestId}），inbox JSON 结构正确`);

  // 4. 幂等：模拟应用落库后重复调用，直接返回 done 结果且不再入队
  settleRequest(inboxDir, doneDir, noteQueued.requestId, {
    status: "applied",
    entityKind: "note",
    entityId: "fixture-note-created",
    title: "冒烟笔记",
  });
  const replay = await callTool(server, "notes_create", {
    title: "重复提交",
    requestId: noteQueued.requestId,
  });
  assert(replay.isError === false, `同一 requestId 重放应返回 created：${toolText(replay)}`);
  const replayBody = toolJson(replay);
  assert(replayBody.status === "created", `重放应返回 created，实际：${replayBody.status}`);
  assert(replayBody.kind === "note", "重放 kind 应为 note");
  assert(replayBody.id === "fixture-note-created", `重放 id 不符：${replayBody.id}`);
  assert(!existsSync(noteRequestFile), "重放不应重新写入请求文件");
  assert(requestFiles().length === 0, "重放后 inbox 应无待处理请求");
  console.log("✓ 幂等：同一 requestId 直接复用 done 结果，不重复入队");

  // 5. tasks_create 排队，检查 payload 归一化（dueDate null、priority、tags、noteId）
  const taskArgs = {
    title: "排队任务",
    description: "描述",
    dueDate: null,
    priority: "low",
    tags: ["x"],
    noteId: "fixture-note-1",
  };
  result = await callTool(server, "tasks_create", taskArgs);
  assert(result.isError === false, `tasks_create 应排队成功：${toolText(result)}`);
  const taskQueued = toolJson(result);
  assert(taskQueued.status === "queued", `tasks_create 应返回 queued，实际：${taskQueued.status}`);
  const taskRequestFile = join(inboxDir, `${taskQueued.requestId}.json`);
  const taskRequest = JSON.parse(readFileSync(taskRequestFile, "utf8"));
  assert(taskRequest.op === "tasks.create", "op 应为 tasks.create");
  assert(taskRequest.payload.title === "排队任务", "任务 title 应保留");
  assert(taskRequest.payload.dueDate === null, "dueDate: null 应保留");
  assert(taskRequest.payload.priority === "low", "priority 应保留 low");
  assert(
    JSON.stringify(taskRequest.payload.tags) === JSON.stringify(["x"]),
    "任务 tags 应正确"
  );
  assert(taskRequest.payload.noteId === "fixture-note-1", "已存在的 noteId 应保留");
  assertNoTempLeftovers();
  rmSync(taskRequestFile);
  console.log(`✓ writer 开启：tasks_create 已排队（${taskQueued.requestId}），payload 归一化正确`);

  // 6. 写入后轮询 done：应用在 150ms 后落库，工具应返回 created
  const pollRequestId = "req-fixture-poll-task-0001";
  scheduleSettle(inboxDir, doneDir, pollRequestId, {
    status: "applied",
    entityKind: "task",
    entityId: "fixture-task-created",
    title: "轮询任务",
  });
  result = await callTool(server, "tasks_create", { title: "轮询任务", requestId: pollRequestId });
  assert(result.isError === false, `轮询成功路径应返回 created：${toolText(result)}`);
  const polled = toolJson(result);
  assert(polled.status === "created", `轮询结果 status 应为 created，实际：${polled.status}`);
  assert(polled.kind === "task", "轮询结果 kind 应为 task");
  assert(polled.id === "fixture-task-created", `轮询结果 id 不符：${polled.id}`);
  assert(!existsSync(join(inboxDir, `${pollRequestId}.json`)), "应用处理后请求文件应被移走");
  console.log("✓ 轮询 done：应用落库后返回 status=created");

  // 7. 写入后轮询 failed，并验证同一 requestId 重放保持错误
  const failRequestId = "req-fixture-reject-0001";
  scheduleSettle(inboxDir, failedDir, failRequestId, {
    status: "rejected",
    error: "fixture 拒绝创建",
  });
  result = await callTool(server, "tasks_create", { title: "被拒任务", requestId: failRequestId });
  assert(result.isError === true, "failed 结果应返回 isError=true");
  assert(
    toolText(result).includes("fixture 拒绝创建"),
    `错误应包含应用返回原因：${toolText(result)}`
  );
  const replayReject = await callTool(server, "tasks_create", {
    title: "被拒任务",
    requestId: failRequestId,
  });
  assert(
    replayReject.isError === true && toolText(replayReject).includes("fixture 拒绝创建"),
    "已 failed 的 requestId 重放应保持错误"
  );
  console.log("✓ 轮询 failed：返回应用错误原因，重放保持幂等");
}

const { dataDir: realDataDir, fixture } = parseArgs(process.argv.slice(2));
const binary = findBinary();
let fixtureDir = null;
let dataDir = realDataDir;
if (fixture) {
  fixtureDir = createFixtureDir();
  dataDir = fixtureDir;
  console.log(`fixture: ${fixtureDir}`);
} else if (!existsSync(dataDir)) {
  console.error(`快照目录不存在：${dataDir}\n请先在 Lafei 设置 → 智能体访问中开启并导出。`);
  process.exit(1);
}

const server = startServer(binary, dataDir);
let success = false;
try {
  await runReadChecks(server, fixture);
  if (fixture) await runWriteChecks(server, fixtureDir);
  success = true;
  console.log(fixture ? "fixture 全部通过" : "OK（只读验证通过）");
} catch (error) {
  console.error("FAILED:", error.message);
  const stderrText = server.stderr();
  if (stderrText.trim()) console.error(stderrText.trim().slice(0, 1000));
} finally {
  server.close();
  if (fixtureDir) {
    if (success) {
      rmSync(fixtureDir, { recursive: true, force: true });
    } else {
      console.error(`fixture 目录已保留以便排查：${fixtureDir}`);
    }
  }
}
process.exitCode = success ? 0 : 1;
