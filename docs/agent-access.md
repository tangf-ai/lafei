# 智能体访问（MCP）

Lafei 可以把笔记和任务导出成一份**只读快照**，再通过 `lafei-mcp` 提供给 Codex、Pi 或其他支持 MCP 的智能体读取。

## 开启

1. 打开 Lafei → 设置 → 智能体访问。
2. 打开「允许外部智能体读取」。
3. 首次开启会立即导出一份快照；之后笔记或任务变化约 1 秒内自动更新。
4. 在同一个页面可以复制快照目录、Codex 配置和通用 JSON 配置。

默认不开启。关闭后停止更新，已导出的文件仍保留，可在设置页清除。

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
  manifest.json      # schemaVersion、revision、数量
  AGENTS.md          # 给智能体的读取说明
  notes.index.json   # 笔记 id、标题、标签、摘要、文件路径
  notes/<safe-id>.md # 带 frontmatter 的 Markdown 正文
  tasks.jsonl        # 每行一个任务 JSON
  tags.json          # 标签与笔记/任务计数
```

快照是**只读**的，不包含 AI 对话、API Key 或删除记录。文件只在本机应用数据目录，不会上传。

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
| `tasks_list` | 按状态、标签、截止日期筛选任务 |
| `tasks_get` | 读取一个任务 |
| `tags_list` | 标签及笔记/任务计数 |

资源：

```text
lafei://manifest
lafei://AGENTS.md
lafei://notes
lafei://notes/{id}
lafei://tasks
lafei://tags
```

工具都标记为只读；MCP server 没有写入工具。

## 本地验证

```bash
pnpm mcp:build                       # 构建 mcp/target/release/lafei-mcp
node scripts/test-mcp.mjs            # 读取默认快照目录并做一次握手/工具调用
node scripts/test-mcp.mjs --data-dir /tmp/lafei-agent-fixture
```

也可以直接用 MCP Inspector 连接 `mcp/target/release/lafei-mcp`。

## 数据契约

`manifest.json` 里的 `schemaVersion` 是快照协议版本，当前为 `1`。智能体应以 `notes.index.json` 的 `file` 字段定位笔记文件，以 `revision` 判断快照是否变化。

## 常见问题

- **设置页显示「服务未就绪」**：当前运行的是开发模式或旧版本，`lafei-mcp` 没有随应用打包；重新构建桌面版即可。
- **MCP 工具提示快照目录不存在**：先在设置 → 智能体访问中开启并导出。
- **应用关闭后还能用吗**：可以。MCP server 读取的是最近一次快照；需要最新数据时打开 Lafei 或点「立即导出」。
- **智能体能改笔记吗**：不能。这是只读 MVP；写入需要设计队列和确认机制，暂未提供。
