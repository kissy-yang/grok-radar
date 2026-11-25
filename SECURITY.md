# 安全与隐私 / Security and Privacy

## Radar 在 Mac 上读取什么

- 读取当前可唯一识别账号的 Grok Bot 本机名册、会话缓存和每周额度缓存。常规轮询读取事件状态与短任务摘要。打开关联事件的详情时，按需读取可用的用户文本和 Bot 回复。
- 启用 macOS 辅助功能后，Radar 从经过身份检查的官方 Grok Bot 客户端侧栏读取 Bot 状态。关闭权限后，实时读取会停止。
- 工作台录入的事件、交接记录和角色绑定按账号存于 `~/Library/Application Support/local.grokbot.workbench/`。导入的数据保存在 WebKit 或浏览器的 IndexedDB 中。会话详情直接从 Grok Bot 缓存读取。
- Radar 没有独立的上传或遥测服务。由用户发起的交接将草稿交给官方客户端。发送确认及后续服务通信由官方客户端处理。

## 反馈安全问题

如仓库已启用 GitHub 私密漏洞报告，请到 **Security → Advisories → Report a vulnerability** 提交。如果入口暂不可用，可通过仓库维护者资料中公布的私人联系渠道反馈。公开 Issue 适合普通故障和建议。

请提供 Radar 和 macOS 版本、受影响的功能及最小复现步骤。用合成记录说明问题，避免上传会话缓存、账本、账号标识、密钥和未脱敏截图。
