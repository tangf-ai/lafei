# Changelog

所有值得记录的变更都会写在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-20

### Added

- 桌面端「文件夹存储」：选择任意目录，把笔记、任务、AI 对话写为普通文件
- iCloud Drive 友好：目录交给 iCloud 同步，支持多台 Mac 共享同一份数据
- 新设备接入已有目录时，可选择「合并两边」或「以文件夹为准」
- 每次编辑自动落盘；启动、聚焦和每 30 秒检查 manifest 变化，支持手动「立即同步」
- 删除 tombstone、按 `updatedAt` 的冲突合并
- 文件夹路径持久化、同步状态、错误重试与目录结构说明
- 完整备份增加 tombstone；导入/清空数据时同步更新文件夹
- Rust 文件夹读写命令与单元测试
- 原生 macOS 文件夹选择器、原子写入、文件管理器定位

### Changed

- 版本升级至 `0.2.0`
- 设置页数据区重新组织：文件夹存储位于备份与迁移之前

## [0.1.0] - 2026-10-20

### Added

- 初始版本：Markdown 笔记、双向链接、标签、全文搜索
- 任务、截止日期、优先级、关联笔记、今日视图
- 内置 AI：笔记总结/提取待办/续写/起标题、带笔记检索的 AI 助手
- Tauri 2 桌面端 + 响应式 PWA
- JSON / Markdown 备份与恢复、深色模式、命令面板
