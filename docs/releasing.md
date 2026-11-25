# 在 GitHub 首发

仓库名可以用 `grok-radar`。项目简介可使用下面这一句。

> A local macOS dashboard for Grok Bot activity, conversations, and weekly quota.

Topics 可添加 `macos`、`swift`、`grok-bot`、`dashboard`、`local-first`。

## 源码首发

1. 确认仓库归属、[MIT 许可与版权署名](../LICENSE)。检查拟提交的文件，保留源码、应用图标、合成示例和公开资料。
2. 如果目录尚未初始化 Git，运行 `git init -b main`。检查暂存范围后提交。在 GitHub 创建公开仓库，再把首个提交推上去。
3. 检查 README 截图、[测试工作流](../.github/workflows/checks.yml) 和 Issue 表单。开启[私密漏洞报告](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)。
4. 用与 `mac/Info.plist` 一致的版本创建 GitHub Release。以[版本记录](../CHANGELOG.md)为发布说明，并注明用户可[从源码构建](../README.md#从源码运行)。

## 分发 Mac 安装包

普通本地构建使用临时签名，适用于从源码运行。需要提供公开的可下载安装包时，先用项目自己的 Developer ID Application 签名、启用 Hardened Runtime，再完成 Apple 公证。构建脚本的 `WORKBENCH_SIGN_IDENTITY` 可选择签名身份，公证与分发验证需要单独完成。[Apple 的签名说明](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac) · [Apple 的公证说明](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

在干净的 Apple Silicon Mac 环境验证首次打开、申请权限、实时刷新、事件详情、休眠恢复和退出。把已验证的 ZIP 和 SHA-256 校验值附到 Release。发布包里只放应用和发布所需资料。
