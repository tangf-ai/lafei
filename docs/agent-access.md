# 智能体访问（MCP）

Lafei 可以把笔记和任务导出成一份快照，再通过 `lafei-mcp` 提供给 Codex、Pi 或其他支持 MCP 的智能体：默认只读；单独打开写入后，智能体还可以通过 `notes_create` / `tasks_create` 新建笔记和任务。

## 开启

1. 打开 Lafei → 设置 → 智能体访问。
2. 打开「允许外部智能体读取」。首次开启会立即导出一份快照；之后笔记或任务变化约 1 秒内自动更新。
3. 需要智能体新建内容时，再打开「允许外部智能体新建笔记和任务」。第一次开启会二次确认。
4. 在同一个页面可以复制快照目录、Codex 配置和通用 JSON 配置。

读取和写入各有一个开关，默认都关闭；写入依赖读取，关闭读取会同时关闭写入。关闭写入后队列不再处理，已导出的文件仍保留。

## 快照目录

macOS：

```text
~/Library/Application Support/app.lafei.desktop/agent/
```

Windows：

```text
%APPDATA%\app.lafei.desktop\agent\
```

Linux：

```text
$XDG_DATA_HOME/app.lafei.desktop/agent/
```

目录结构：

```text
agent/
  manifest.json      # schemaVersion、revision、数量、写入能力（writer）
  AGENTS.md          # 给智能体的使用说明
  notes.index.json   # 笔记 id、标题、标签、摘要、文件路径
  notes/<safe-id>.md # 带 frontmatter 的 Markdown 正文
  tasks.jsonl        # 每行一个任务 JSON
  tags.json          # 标签与笔记/任务计数
  inbox/             # 写入队列：智能体放进来、Lafei 处理完成后移走
    req-<时间戳>-<随机>.json
    done/<同一文件名>.json     # 已创建，附 result
    failed/<同一文件名>.json   # 被拒绝，附 result.error
```

快照只包含笔记和任务，不包含 AI 对话、API Key 或删除记录；文件只在本机应用数据目录，不会上传。`inbox/` 同理，只在本机磁盘上传递。

## 配置 Codex

把设置页复制的配置写进 `~/.codex/config.toml`：

```toml
[mcp_servers.lafei]
command = "/Applications/Lafei.app/Contents/MacOS/lafei-mcp"
args = ["--data-dir", "/Users/you/Library/Application Support/app.lafei.desktop/agent"]
```

`command` 和 `args` 以设置页显示的路径为准。

## 配置 Pi / 其他 MCP 客户端

使用同样的 stdio 配置，JSON 形式：

```json
{
  "mcpServers": {
    "lafei": {
      "command": "/Applications/Lafei.app/Contents/MacOS/lafei-mcp",
      "args": ["--data-dir", "/Users/you/Library/Application Support/app.lafei.desktop/agent"]
    }
  }
}
```

具体配置文件名取决于客户端，但 MCP server 的启动方式相同。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `notes_search` | 按标题、标签和正文搜索笔记 |
| `notes_get` | 读取一篇笔记的完整 Markdown |
| `notes_create` | 新建一篇笔记（需要打开写入） |
| `tasks_list` | 按状态、标签、截止日期筛选任务 |
| `tasks_get` | 读取一个任务 |
| `tasks_create` | 新建一个任务（需要打开写入） |
| `tags_list` | 标签及笔记/任务计数 |

读取类工具标记为只读；`notes_create` / `tasks_create` 不是只读工具，只在用户打开写入后可用。没打开写入时调用会直接报错，不会写队列。

资源：

```text
lafei://manifest
lafei://AGENTS.md
lafei://notes
lafei://notes/{id}
lafei://tasks
lafei://tags
```

## 写入是怎么发生的

Lafei 的数据在应用自己的本地数据库里，外部进程不能直接改；写入走一条本机文件队列：

1. 智能体调用 `notes_create` / `tasks_create`，`lafei-mcp` 先检查 `manifest.json` 的 `writer.enabled`。
2. 可写时，`lafei-mcp` 把请求原子写入 `inbox/<requestId>.json`，然后最多等 2 秒。
3. Lafei 应用开启写入时每 0.8 秒检查一次队列：校验请求、在本地库里创建笔记/任务、把请求移入 `done/` 或 `failed/`，并写入结果。
4. 智能体拿到 `done/` 的结果后，工具返回 `created` 和新建内容的 id；如果应用没开或没来得及处理，返回 `queued`，请求留在队列里，应用下次启动并开启写入时自动处理。

应用内表现：

- 每批创建都会弹一条提示，写明「外部智能体新建了 N 篇笔记、M 个任务」，并带「撤销」按钮，可一次删除这一批。
- 设置页「由智能体创建」会保留最近 20 条记录（含失败的请求），列表里展示最近 5 条；成功的记录点一下可以直接打开对应的笔记或任务。
- 关闭写入后队列停止处理；重新打开会继续处理积压的请求。队列最多保留 200 条待处理请求，超过后 MCP 会拒绝新请求。

边界：

- 这一版只支持**新建**，不支持修改、删除或完成任务；这些操作仍需要你本人在 Lafei 里做。
- 写入只发生在用户打开写入开关、且 Lafei 应用正在运行时。
- 队列里超过 30 天没处理的请求会被清理；`done/`、`failed/` 的结果保留 7 天。

## 写入数据契约

`manifest.json` 的 `schemaVersion` 是快照协议版本，当前为 `2`。智能体应以 `notes.index.json` 的 `file` 字段定位笔记文件，以 `revision` 判断快照是否变化。

写入能力写在 `manifest.json` 的 `writer` 字段：

```json
"writer": {
  "enabled": true,
  "inbox": "inbox",
  "processed": "inbox/done",
  "failed": "inbox/failed",
  "ops": ["notes.create", "tasks.create"],
  "maxPending": 200
}
```

`writer.enabled` 为 `false` 或没有 `writer` 字段（旧版本快照）时，服务视为不可写。

请求文件示例（`inbox/req-1762345678901-3f9a1c2e.json`）：

```json
{
  "schemaVersion": 1,
  "requestId": "req-1762345678901-3f9a1c2e",
  "op": "notes.create",
  "client": "codex",
  "createdAt": 1762345678901,
  "payload": {
    "title": "周会记录",
    "content": "## 讨论\n\n- 下周发布",
    "tags": ["work"],
    "pinned": false
  }
}
```

`tasks.create` 的 `payload` 支持 `title`（必填）、`description`、`dueDate`（`YYYY-MM-DD` 或 `null`）、`priority`（`high` / `medium` / `low`）、`tags`、`noteId`（关联到已存在的笔记，或 `null`）。

处理完成后，请求文件被移动到 `done/`（或 `failed/`），原字段保留并追加 `result`：

```json
"result": {
  "status": "applied",
  "appliedAt": 1762345679999,
  "entityKind": "note",
  "entityId": "note-id",
  "title": "周会记录"
}
```

失败时 `status` 为 `rejected`，并带 `error` 说明原因。智能体可以用自己传入的 `requestId` 做幂等：同一个 `requestId` 重复调用不会创建重复内容，只会返回已有结果。

## 本地验证

```bash
pnpm mcp:build                       # 构建 mcp/target/release/lafei-mcp
node scripts/test-mcp.mjs            # 读取默认快照目录并做一次握手/工具调用
node scripts/test-mcp.mjs --data-dir /tmp/lafei-agent-fixture
node scripts/test-mcp.mjs --fixture  # 自动建临时快照，测只读与写入队列（不需要打开 Lafei）
```

也可以直接用 MCP Inspector 连接 `mcp/target/release/lafei-mcp`。

## 常见问题

- **设置页显示「服务未就绪」**：当前运行的是开发模式或旧版本，`lafei-mcp` 没有随应用打包；重新构建桌面版即可。
- **MCP 工具提示快照目录不存在**：先在设置 → 智能体访问中开启并导出。
- **应用关闭后还能用吗**：读取可以，读到的是最近一次快照；写入会排队，等 Lafei 下次启动并开启写入后自动创建。
- **智能体能改笔记吗**：这一版可以新建笔记和任务，不能修改、删除或完成任务；每次新建都会在应用里提示，并可撤销。
- **为什么调用返回 `queued`**：Lafei 应用当时没开或还没处理到这条请求；请求已经排队，稍后会自动生效，不需要重复调用。
- **如何彻底禁止写入**：关闭「允许外部智能体新建笔记和任务」即可，MCP 会立即拒绝新的写入请求，队列也停止处理。
