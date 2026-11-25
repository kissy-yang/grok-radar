# 贡献指南 / Contributing

欢迎用中文或英文提 Issue 或 PR。修复前可先搜索相关 Issue。跨模块的改动可以先开一个提案，让维护者和贡献者对齐行为。

## 本机验证

在项目根目录运行。JavaScript 测试需要 Node.js 22，Swift 测试和构建需要 Apple Silicon Mac 上的 Xcode Command Line Tools。

```sh
node --test *.test.mjs
test_dir="$(mktemp -d)"
xcrun --sdk macosx swiftc -parse-as-library -module-cache-path "$test_dir/module-cache" \
  mac/GrokLocalSource.swift mac/WorkbenchConnection.swift mac/GrokLocalSourceTests.swift \
  -o "$test_dir/native-tests"
"$test_dir/native-tests"
bash mac/build.sh "$test_dir/Grok Radar.app"
codesign --verify --deep --strict "$test_dir/Grok Radar.app"
```

Swift 测试用合成缓存和临时账本，运行整套测试不要求登录 Grok Bot 或开启辅助功能。若改动涉及实时状态、唤醒或交接，在有官方客户端的 Mac 上补测对应操作。提交时写清改动前后的行为、已运行的检查和未覆盖的环境。

| 文件 | 主要职责 |
| --- | --- |
| `app.mjs`、`index.html`、`style.css` | 工作台界面 |
| `live-updates.mjs`、`event-store.mjs`、`routing*.mjs` | 运行状态、事件归并和路由 |
| `data.mjs`、`otlp.mjs` | 导入 JSON、CSV 与 OTLP |
| `mac/Workbench.swift`、`mac/GrokDesktopActivity.swift` | WebKit、刷新、系统电源状态与实时读取 |
| `mac/GrokLocalSource.swift`、`mac/WorkbenchConnection.swift` | 本机镜像、交接和账号账本 |

请用合成数据或脱敏后的最小示例报告问题。公开问题和 PR 中请去掉账号、对话、机器路径和凭证。对可能泄露数据的问题，参见[安全报告方式](SECURITY.md)。
