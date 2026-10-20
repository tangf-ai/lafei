# Contributing

谢谢你愿意改进 Lafei。这个项目还在早期，欢迎 issue、讨论和 Pull Request。

## 开始之前

- 小修复可以直接提 PR。
- 较大的功能或行为改变，请先开 issue 说明场景和方案，避免做完才发现方向不一致。
- 安全问题请不要公开开 issue，按 [SECURITY.md](SECURITY.md) 的方式私密报告。

## 本地开发

环境要求：Node.js 22+、pnpm 11+。桌面构建还需要 Rust stable；macOS 需要 Xcode Command Line Tools。

```bash
pnpm install
pnpm dev            # Web 预览，http://127.0.0.1:1420
pnpm check          # TypeScript 类型检查
pnpm build          # 生产构建
pnpm desktop:dev    # Tauri 桌面开发窗口
```

Rust 检查：

```bash
cd src-tauri
cargo fmt --all -- --check
cargo test
```

不配置真实 AI Key 也可以开发 AI 流程：

```bash
pnpm mock:ai
```

然后在设置里选择「自定义 / 本地」，Base URL 填 `http://127.0.0.1:4319/v1`，模型填 `mock`。

## 代码约定

- TypeScript strict；提交前至少通过 `pnpm check` 和 `pnpm build`。
- Rust 使用 `cargo fmt` 格式化。
- 组件保持现有视觉语言：暖纸色、衬线标题、克制的动效；移动端要实际在窄屏检查，而不是只看桌面。
- 涉及数据层或文件夹同步的改动，请说明合并、删除、冲突和失败场景。
- 不要把 `dist/`、`src-tauri/target/`、DMG/安装包、`.env` 或 API Key 提交进仓库。
- 截图放到 `docs/screenshots/`，并同步更新 README 中的引用。

## Commit 与 PR

建议使用 Conventional Commits：

```text
feat: add ...
fix: ...
docs: ...
refactor: ...
chore: ...
```

PR 请说明：

1. 解决的问题和用户场景。
2. 关键实现取舍。
3. 已执行的验证命令；涉及 UI 时附前后截图。

提交即表示你同意以 [MIT License](LICENSE) 授权你的贡献。
