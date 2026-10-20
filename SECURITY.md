# Security Policy

## Supported versions

当前维护 `0.2.x`。

## Reporting a vulnerability

请**不要**在公开 issue 中披露安全问题。使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告，并尽量包含：

- 影响版本与操作系统
- 复现步骤
- 可能的后果
- 最小修复建议（如果有）

我会尽快确认并回复。涉及用户数据、文件夹路径、AI Key 或任意文件读写的报告会优先处理。

## Security model

- Lafei 没有账号系统或中转服务器。默认数据在本机 IndexedDB；启用文件夹存储后，内容写入用户选择的目录。
- API Key 保存在本机 `localStorage`，目前**没有**接入系统钥匙串，这是已知限制。请不要在共享设备上保存敏感 Key。
- 文件夹同步按文件的 `updatedAt` 做最后写入优先，并通过 tombstone 传播删除；它不是加密存储，也不是实时协作协议。不要把敏感数据放进不信任的同步盘。
- AI 请求直接发往用户配置的 OpenAI 兼容接口；请只使用你信任的服务商或本地模型。
