import AppKit
import CoreGraphics
import UniformTypeIdentifiers
import WebKit

@MainActor
private final class WorkbenchAssets: NSObject, WKURLSchemeHandler {
    static let scheme = "grok-workbench"
    static let home = URL(string: "\(scheme)://local/index.html")!

    private static let types = [
        "/index.html": "text/html",
        "/style.css": "text/css",
        "/mascot.css": "text/css",
        "/app.mjs": "text/javascript",
        "/weekly-quota.mjs": "text/javascript",
        "/data.mjs": "text/javascript",
        "/event-store.mjs": "text/javascript",
        "/i18n.mjs": "text/javascript",
        "/live-updates.mjs": "text/javascript",
        "/otlp.mjs": "text/javascript",
        "/routing.mjs": "text/javascript",
        "/routing-controls.mjs": "text/javascript",
    ]

    private let directory: URL

    init(directory: URL) {
        self.directory = directory
    }

    static func resourcePath(for url: URL) -> String? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == scheme, parts.host == home.host,
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.query == nil, types[parts.percentEncodedPath] != nil else {
            return nil
        }
        return parts.percentEncodedPath
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard task.request.httpMethod == "GET",
              let url = task.request.url,
              let path = Self.resourcePath(for: url),
              let type = Self.types[path],
              let data = try? Data(contentsOf: directory.appendingPathComponent(String(path.dropFirst()))),
              let response = HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": "\(type); charset=utf-8",
                    "Content-Length": String(data.count),
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                    "Access-Control-Allow-Origin": "*",
                    "Content-Security-Policy": """
                        default-src 'none'; script-src grok-workbench:; style-src grok-workbench: 'unsafe-inline';                         img-src grok-workbench: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
                        """,
                ]
              ) else {
            task.didFailWithError(URLError(.resourceUnavailable))
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        // Bundled resources are returned synchronously on the main actor.
    }
}

// Invalidate queued reads before they enter the file or accessibility readers.
private final class MonitoringGeneration: @unchecked Sendable {
    private let lock = NSLock()
    private var generation = 0

    var current: Int { lock.withLock { generation } }

    func invalidate() {
        lock.withLock { generation += 1 }
    }
}

@MainActor
private final class WorkbenchApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply {
    private static let appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Grok Radar"
    private static let canvasBackground = NSColor(srgbRed: 247.0 / 255, green: 249.0 / 255, blue: 252.0 / 255, alpha: 1)
    private static let grokBotBundleID = "com.anysphere.sand"
    private static let bridgeHandlers = ["workbenchLedger", "workbenchHandoff", "workbenchConversation", "workbenchRefresh",
                                         "workbenchOpenUsage", "workbenchRunAccess", "workbenchSetLanguage"]
    private static let refreshTimeout: TimeInterval = 10
    private static let maxQueuedRefreshReplies = 8
    private static let mirrorInterval: TimeInterval = 0.65
    private static let desktopInterval: TimeInterval = 0.3

    private typealias BridgeReply = (Any?, String?) -> Void

    private struct RefreshPass {
        let sequence: Int
        let replies: [BridgeReply]
    }

    private let verify = CommandLine.arguments.contains("--verify-render")
    private let reader = DispatchQueue(label: "GrokBotWorkbench.mirror", qos: .utility)
    private let desktopReader = DispatchQueue(label: "GrokBotWorkbench.desktopActivity", qos: .userInitiated)
    private let connection = DispatchQueue(label: "GrokBotWorkbench.connection", qos: .userInitiated)
    private let monitorGeneration = MonitoringGeneration()
    private var reservedHandoffs = Set<String>()
    private var window: NSWindow!
    private var webView: WKWebView!
    private var mirrorTimer: Timer?
    private var desktopTimer: Timer?
    private var powerObservers: [NSObjectProtocol] = []
    private var systemSleeping = false
    private var screensSleeping = false
    private var terminating = false
    private var canMonitor: Bool { !systemSleeping && !screensSleeping && !terminating }
    private var manualDesktopRead: DispatchWorkItem?
    private var readingDesktop = false
    private var desktopAccount: String?
    private var desktopBots: [[String: String]] = []
    private var desktopScope = 0
    private var documentLoaded = false
    private var refreshSequence = 0
    private var readingSnapshot = false
    private var currentRefresh: RefreshPass?
    private var queuedRefreshReplies: [BridgeReply] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let resources = Bundle.main.resourceURL else {
            exit(1)
        }

        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(
            WorkbenchAssets(directory: resources.appendingPathComponent("Workbench", isDirectory: true)),
            forURLScheme: WorkbenchAssets.scheme
        )
        installBridgeScript(in: configuration.userContentController)
        for name in Self.bridgeHandlers {
            configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: name)
        }
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.underPageBackgroundColor = Self.canvasBackground
        webView.allowsLinkPreview = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        let available = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1298, height: 918)
        let size = NSSize(width: min(1250, available.width - 48), height: min(870, available.height - 48))
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = Self.appName
        window.appearance = NSAppearance(named: .aqua)
        window.backgroundColor = Self.canvasBackground
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.minSize = NSSize(width: 530, height: 530)
        let content = NSView()
        window.contentView = content
        let contentTop = (window.contentLayoutGuide as? NSLayoutGuide)?.topAnchor ?? content.topAnchor
        webView.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: contentTop),
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        window.isReleasedWhenClosed = false
        window.center()

        if verify {
            DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
                fputs("Workbench verification timed out.\n", stderr)
                exit(1)
            }
        } else {
            installMenus()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }

        if !verify {
            screensSleeping = CGDisplayIsAsleep(CGMainDisplayID()) != 0
            observePower()
        }
        startMonitoring()
        webView.load(URLRequest(url: WorkbenchAssets.home))
    }

    private func startMonitoring() {
        guard canMonitor, mirrorTimer == nil else { return }
        let timer = Timer(timeInterval: Self.mirrorInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        timer.tolerance = 0.04
        RunLoop.main.add(timer, forMode: .common)
        mirrorTimer = timer
        if !verify {
            let timer = Timer(timeInterval: Self.desktopInterval, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.refreshDesktop() }
            }
            timer.tolerance = 0.02
            RunLoop.main.add(timer, forMode: .common)
            desktopTimer = timer
        }
        refresh()
    }

    private func stopMonitoring() {
        mirrorTimer?.invalidate()
        mirrorTimer = nil
        desktopTimer?.invalidate()
        desktopTimer = nil
        cancelRefreshes(message: WorkbenchLanguage.text("实时监听已暂停。", "Live monitoring is paused."))
    }

    private func observePower() {
        let workspace = NSWorkspace.shared
        let names = [NSWorkspace.willSleepNotification, NSWorkspace.didWakeNotification,
                     NSWorkspace.screensDidSleepNotification, NSWorkspace.screensDidWakeNotification]
        powerObservers = names.map { name in
            workspace.notificationCenter.addObserver(forName: name, object: workspace, queue: .main) { [weak self] note in
                MainActor.assumeIsolated { self?.powerDidChange(note.name) }
            }
        }
    }

    private func powerDidChange(_ name: Notification.Name) {
        let wasMonitoring = canMonitor
        switch name {
        case NSWorkspace.willSleepNotification:
            systemSleeping = true
        case NSWorkspace.didWakeNotification:
            systemSleeping = false
            screensSleeping = CGDisplayIsAsleep(CGMainDisplayID()) != 0
        case NSWorkspace.screensDidSleepNotification:
            screensSleeping = true
        case NSWorkspace.screensDidWakeNotification:
            screensSleeping = false
        default:
            return
        }
        guard wasMonitoring != canMonitor else { return }
        if canMonitor {
            startMonitoring()
        } else {
            stopMonitoring()
            if documentLoaded {
                webView.callAsyncJavaScript(
                    "window.grokWorkbenchPauseMonitoring?.(scope);",
                    arguments: ["scope": desktopScope], in: nil, in: .page
                )
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationDidBecomeActive(_ notification: Notification) {
        refreshDesktop()
        refresh()
    }

    func applicationWillTerminate(_ notification: Notification) {
        terminating = true
        stopMonitoring()
        let center = NSWorkspace.shared.notificationCenter
        powerObservers.forEach { center.removeObserver($0) }
        powerObservers.removeAll()
        for name in Self.bridgeHandlers {
            webView?.configuration.userContentController.removeScriptMessageHandler(forName: name, contentWorld: .page)
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        let path = action.request.url.flatMap(WorkbenchAssets.resourcePath)
        decisionHandler(action.targetFrame?.isMainFrame == true && path == "/index.html" ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        documentLoaded = false
        cancelRefreshes()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        documentLoaded = true
        refresh()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        documentLoaded = false
        cancelRefreshes()
        webView.reload()
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        guard !verify, frame.isMainFrame, webView.url.flatMap(WorkbenchAssets.resourcePath) == "/index.html" else {
            completionHandler(nil)
            return
        }
        let panel = NSOpenPanel()
        panel.title = WorkbenchLanguage.text("导入记录", "Import Records")
        panel.prompt = WorkbenchLanguage.text("导入", "Import")
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.commaSeparatedText, .json]
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard message.webView === webView, message.frameInfo.isMainFrame,
              message.frameInfo.request.url.flatMap(WorkbenchAssets.resourcePath) == "/index.html",
              let body = message.body as? [String: Any]
        else {
            replyHandler(["ok": false, "error": WorkbenchLanguage.text("工作台来源无效。", "Invalid workbench page.")], nil)
            return
        }

        switch message.name {
        case "workbenchLedger":
            processLedger(body, replyHandler: replyHandler)
        case "workbenchHandoff":
            guard !verify, let handoff = WorkbenchHandoff(body) else {
                let error = WorkbenchLanguage.text("交接参数无效或当前处于验收模式。",
                                                  "The handoff is invalid or verification mode is active.")
                replyHandler(["ok": false, "error": error], nil)
                return
            }
            launchHandoff(handoff, replyHandler: replyHandler)
        case "workbenchConversation":
            processConversation(body, replyHandler: replyHandler)
        case "workbenchRefresh":
            requestRefresh(body, replyHandler: replyHandler)
        case "workbenchOpenUsage":
            openUsage(body, replyHandler: replyHandler)
        case "workbenchRunAccess":
            guard !verify, documentLoaded, body.isEmpty else {
                replyHandler(["ok": false], nil)
                return
            }
            replyHandler(["ok": true, "enabled": GrokDesktopActivity.requestPermission()], nil)
            refreshDesktop()
        case "workbenchSetLanguage":
            guard !verify, body.count == 1, let value = body["language"] as? String,
                  let language = WorkbenchLanguage(rawValue: value) else {
                replyHandler(["ok": false, "error": WorkbenchLanguage.text(
                    "无法设置工作台语言。", "Could not set the workbench language."
                )], nil)
                return
            }
            language.save()
            installBridgeScript(in: userContentController)
            installMenus()
            replyHandler(["ok": true], nil)
        default:
            replyHandler(["ok": false, "error": WorkbenchLanguage.text("未知工作台操作。", "Unknown workbench operation.")], nil)
        }
    }

    private func installBridgeScript(in controller: WKUserContentController) {
        let language = WorkbenchLanguage.current.rawValue
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(
            source: "window.grokWorkbenchNative = true; window.grokWorkbenchLanguage = '\(language)';",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
    }

    private func processConversation(_ body: [String: Any], replyHandler: @escaping (Any?, String?) -> Void) {
        guard !verify,
              let key = body["accountKey"] as? String, WorkbenchHandoff.isOpaqueKey(key),
              let bot = body["botKey"] as? String, WorkbenchHandoff.isOpaqueKey(bot),
              let event = body["observedId"] as? String, WorkbenchHandoff.isOpaqueKey(event)
        else {
            replyHandler(["ok": false, "error": WorkbenchLanguage.text("对话查询参数无效。", "Invalid conversation request.")], nil)
            return
        }
        reader.async {
            let response: [String: Any]
            do {
                let result = try GrokLocalSource.visibleConversation(accountKey: key, botKey: bot, observedId: event)
                response = [
                    "ok": true,
                    "messages": result.items.map { ["role": $0.role.rawValue, "text": $0.text, "at": $0.at] },
                    "truncated": result.truncated,
                ]
            } catch let error as GrokLocalSource.ConversationError {
                response = ["ok": false, "error": error.localizedDescription]
            } catch {
                response = ["ok": false, "error": WorkbenchLanguage.text("无法读取对话。", "Could not read the conversation.")]
            }
            DispatchQueue.main.async { replyHandler(response, nil) }
        }
    }

    private func processLedger(_ body: [String: Any], replyHandler: @escaping (Any?, String?) -> Void) {
        guard let op = body["op"] as? String, op == "load" || (op == "save" && !verify),
              let key = body["accountKey"] as? String, WorkbenchHandoff.isOpaqueKey(key)
        else {
            replyHandler(["ok": false, "error": WorkbenchLanguage.text("事件日志请求无效。", "Invalid event log request.")], nil)
            return
        }
        let data = body["data"] as? String
        connection.async {
            let response: [String: Any]
            do {
                guard GrokLocalSource.currentAccount()?.key == key else {
                    throw WorkbenchLedger.StorageError.invalidAccount
                }
                let ledger = WorkbenchLedger()
                if op == "load" {
                    let stored = try ledger.load(accountKey: key)
                    response = ["ok": true, "data": stored as Any? ?? NSNull()]
                } else {
                    guard let data else { throw WorkbenchLedger.StorageError.invalidData }
                    try ledger.save(data, accountKey: key)
                    response = ["ok": true]
                }
            } catch let error as WorkbenchLedger.StorageError {
                response = ["ok": false, "error": error.localizedDescription]
            } catch {
                response = ["ok": false, "error": WorkbenchLanguage.text("无法读取或保存本机事件日志。", "Could not read or save the local event log.")]
            }
            DispatchQueue.main.async { replyHandler(response, nil) }
        }
    }

    private func launchHandoff(_ handoff: WorkbenchHandoff, replyHandler: @escaping (Any?, String?) -> Void) {
        let reservation = "\(handoff.accountKey):\(handoff.eventID)"
        guard reservedHandoffs.insert(reservation).inserted else {
            let error = WorkbenchLanguage.text("该事件已尝试交接，请在 Grok Bot 中确认。",
                                              "A handoff was already attempted. Check this event in Grok Bot.")
            replyHandler(["ok": false, "uncertain": true, "error": error], nil)
            return
        }
        connection.async { [weak self] in
            let url = GrokLocalSource.currentAccount().flatMap(handoff.url(for:))
            DispatchQueue.main.async {
                guard let self, self.documentLoaded, let url, self.registeredGrokBot(for: url) != nil
                else {
                    self?.reservedHandoffs.remove(reservation)
                    let error = WorkbenchLanguage.text("找不到当前账号的目标 Bot，或系统未将 Grok Bot 注册为链接处理程序。",
                                                      "The target bot is missing from this account, or macOS has no registered Grok Bot link handler.")
                    replyHandler(["ok": false, "error": error], nil)
                    return
                }
                // Standard registered URL dispatch, as when opening a grokbot link from macOS.
                let open = Process()
                open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                open.arguments = [url.absoluteString]
                open.standardInput = FileHandle.nullDevice
                open.standardOutput = FileHandle.nullDevice
                open.standardError = FileHandle.nullDevice
                open.terminationHandler = { result in
                    let succeeded = result.terminationReason == .exit && result.terminationStatus == 0
                    let error = WorkbenchLanguage.text("系统无法确认交接结果，请在 Grok Bot 中检查该事件。",
                                                      "macOS could not confirm the handoff. Check this event in Grok Bot.")
                    let response: [String: Any] = succeeded ? ["ok": true] : ["ok": false, "uncertain": true, "error": error]
                    DispatchQueue.main.async { replyHandler(response, nil) }
                }
                do {
                    try open.run()
                } catch {
                    self.reservedHandoffs.remove(reservation)
                    let message = WorkbenchLanguage.text("系统无法启动 Grok Bot 链接交接。",
                                                        "macOS could not open the Grok Bot handoff link.")
                    replyHandler(["ok": false, "error": message], nil)
                }
            }
        }
    }

    private func installedGrokBot() -> URL? {
        let standard = URL(fileURLWithPath: "/Applications/Grok Bot.app", isDirectory: true)
        if Bundle(url: standard)?.bundleIdentifier == Self.grokBotBundleID { return standard }
        guard let application = NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.grokBotBundleID),
              Bundle(url: application)?.bundleIdentifier == Self.grokBotBundleID
        else { return nil }
        return application
    }

    private func registeredGrokBot(for url: URL) -> URL? {
        guard let application = installedGrokBot(),
              let handler = NSWorkspace.shared.urlForApplication(toOpen: url),
              Bundle(url: handler)?.bundleIdentifier == Self.grokBotBundleID,
              handler.resolvingSymlinksInPath().standardizedFileURL.path ==
                application.resolvingSymlinksInPath().standardizedFileURL.path
        else { return nil }
        return application
    }

    private func openUsage(_ body: [String: Any], replyHandler: @escaping BridgeReply) {
        let error = WorkbenchLanguage.text("无法打开用量页面。请在 Grok Bot 中打开「设置 → 用量与账单」。",
                                          "Could not open the usage page. In Grok Bot, open Settings → Usage and Billing.")
        let failure: [String: Any] = ["ok": false, "error": error]
        guard !verify, documentLoaded, body.isEmpty,
              let url = URL(string: "grokbot://app/v1/settings?id=usage-and-billing"),
              let application = registeredGrokBot(for: url)
        else {
            replyHandler(failure, nil)
            return
        }
        NSWorkspace.shared.open([url], withApplicationAt: application, configuration: NSWorkspace.OpenConfiguration()) { app, error in
            DispatchQueue.main.async {
                let opened = error == nil && app?.bundleIdentifier == Self.grokBotBundleID
                replyHandler(opened ? ["ok": true] : failure, nil)
            }
        }
    }

    private func requestRefresh(_ body: [String: Any], replyHandler: @escaping BridgeReply) {
        guard canMonitor, documentLoaded, body.isEmpty else {
            replyHandler(["ok": false, "error": WorkbenchLanguage.text("工作台暂时无法刷新。", "The workbench cannot refresh right now.")], nil)
            return
        }
        guard queuedRefreshReplies.count < Self.maxQueuedRefreshReplies, !readingSnapshot || currentRefresh != nil else {
            replyHandler(["ok": false, "error": WorkbenchLanguage.text("仍在读取 Grok Bot 数据，请稍后刷新。", "Grok Bot data is still loading. Refresh again in a moment.")], nil)
            return
        }
        queuedRefreshReplies.append(replyHandler)
        refresh()
    }

    private func refresh() {
        guard canMonitor, documentLoaded, !readingSnapshot, currentRefresh == nil else { return }
        refreshSequence += 1
        let sequence = refreshSequence
        let manual = !queuedRefreshReplies.isEmpty
        currentRefresh = RefreshPass(sequence: sequence, replies: queuedRefreshReplies)
        queuedRefreshReplies.removeAll()
        readingSnapshot = true

        DispatchQueue.main.asyncAfter(deadline: .now() + Self.refreshTimeout) { [weak self] in
            guard let self, self.currentRefresh?.sequence == sequence else { return }
            self.finishRefresh(sequence, response: ["ok": false, "error": WorkbenchLanguage.text("刷新超时，请稍后重试。", "The refresh timed out. Try again in a moment.")])
        }
        let generation = monitorGeneration.current
        reader.async { [weak self, monitorGeneration] in
            let snapshot = monitorGeneration.current == generation ? GrokLocalSource.snapshot() : nil
            let payload = snapshot.flatMap(Self.json)
            DispatchQueue.main.async {
                guard let self else { return }
                self.readingSnapshot = false
                guard self.currentRefresh?.sequence == sequence else {
                    self.refresh()
                    return
                }
                guard let payload, let snapshot else {
                    self.finishRefresh(sequence, response: ["ok": false, "error": WorkbenchLanguage.text("无法读取 Grok Bot 状态。", "Could not read Grok Bot status.")])
                    return
                }
                self.publishSnapshot(payload, snapshot: snapshot, sequence: sequence, manual: manual)
            }
        }
    }

    private nonisolated static func json(_ object: [String: Any]) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private nonisolated static func desktopSample(bots: [[String: String]]) -> String? {
        var sample = GrokDesktopActivity.read(bots: bots)
        sample["sampledAt"] = ProcessInfo.processInfo.systemUptime
        return json(sample)
    }

    private func setDesktopRoster(account: String?, bots: [[String: String]]) {
        guard desktopAccount != account || desktopBots != bots else { return }
        desktopAccount = account
        desktopBots = bots
        desktopScope += 1
    }

    private func publishSnapshot(_ payload: String, snapshot: [String: Any], sequence: Int, manual: Bool) {
        let account = snapshot["status"] as? String == "connected" ? snapshot["accountKey"] as? String : nil
        let bots = account == nil ? [] : snapshot["bots"] as? [[String: String]] ?? []
        setDesktopRoster(account: account, bots: bots)
        let scope = desktopScope
        guard manual, !verify, account != nil else {
            push(payload, sequence: sequence, scope: scope)
            return
        }
        // A manual refresh waits for a fresh read, even when a periodic read is in flight.
        let read = DispatchWorkItem { [weak self] in
            let sample = Self.desktopSample(bots: bots)
            DispatchQueue.main.async {
                guard let self, self.canMonitor, self.currentRefresh?.sequence == sequence, self.desktopScope == scope else { return }
                self.manualDesktopRead = nil
                self.push(payload, sequence: sequence, scope: scope, sample: sample)
            }
        }
        manualDesktopRead = read
        desktopReader.async(execute: read)
    }

    private func refreshDesktop() {
        guard canMonitor, !verify, documentLoaded, desktopAccount != nil,
              !readingDesktop, manualDesktopRead == nil else { return }
        let bots = desktopBots
        let scope = desktopScope
        let generation = monitorGeneration.current
        readingDesktop = true
        desktopReader.async { [weak self, monitorGeneration] in
            let sample = monitorGeneration.current == generation ? Self.desktopSample(bots: bots) : nil
            DispatchQueue.main.async {
                guard let self else { return }
                guard self.canMonitor, self.documentLoaded, self.desktopScope == scope, let sample else {
                    self.readingDesktop = false
                    return
                }
                self.webView.callAsyncJavaScript(
                    "window.grokWorkbenchDesktopUpdate?.(scope, JSON.parse(sample));",
                    arguments: ["scope": scope, "sample": sample], in: nil, in: .page
                ) { [weak self] _ in
                    self?.readingDesktop = false
                }
            }
        }
    }

    private func cancelRefreshes(message: String = WorkbenchLanguage.text("页面已更新，请重新刷新。", "The page changed. Refresh again.")) {
        monitorGeneration.invalidate()
        desktopAccount = nil
        desktopBots = []
        desktopScope += 1
        manualDesktopRead?.cancel()
        manualDesktopRead = nil
        let replies = (currentRefresh?.replies ?? []) + queuedRefreshReplies
        currentRefresh = nil
        queuedRefreshReplies.removeAll()
        for reply in replies { reply(["ok": false, "error": message], nil) }
    }

    private func finishRefresh(_ sequence: Int, response: [String: Any]) {
        guard let pass = currentRefresh, pass.sequence == sequence else { return }
        manualDesktopRead?.cancel()
        manualDesktopRead = nil
        currentRefresh = nil
        let replies = readingSnapshot ? pass.replies + queuedRefreshReplies : pass.replies
        if readingSnapshot { queuedRefreshReplies.removeAll() }
        for reply in replies { reply(response, nil) }
        if !queuedRefreshReplies.isEmpty { refresh() }
    }

    private func push(_ payload: String, sequence: Int, scope: Int, sample: String? = nil) {
        webView.callAsyncJavaScript(
            """
            if (typeof window.grokWorkbenchUpdate !== 'function' ||
                sequence <= (window.grokWorkbenchSnapshotSequence ?? 0)) return null;
            const state = JSON.parse(snapshot);
            state.desktopScope = scope;
            if (sample) state.desktopActivity = JSON.parse(sample);
            window.grokWorkbenchUpdate(state);
            window.grokWorkbenchSnapshotSequence = sequence;
            if (!diagnostic) {
                const activeBots = new Set([state.activeRuns, state.waitingRuns, state.followupRuns]
                    .flatMap(runs => Array.isArray(runs) ? runs.map(run => run.agentKey) : []).filter(Boolean));
                return {ok: true, status: state.status, checkedAt: state.checkedAt,
                    botCount: state.botCount, activeCount: activeBots.size};
            }
            const counter = document.getElementById('results-count')?.textContent ?? '';
            return {
                nativeMode: window.grokWorkbenchNative === true,
                status: state.status,
                suppliedEvents: state.events.length,
                renderedCount: Number(counter.trim().replace(/[^0-9]/g, '')),
                hasRendered: /[0-9]/.test(counter)
            };
            """,
            arguments: ["snapshot": payload, "diagnostic": verify, "sequence": sequence, "scope": scope, "sample": sample ?? ""],
            in: nil,
            in: .page
        ) { [weak self] result in
            guard let self, self.currentRefresh?.sequence == sequence else { return }
            guard case let .success(output) = result, let summary = output as? [String: Any] else {
                self.finishRefresh(sequence, response: ["ok": false, "error": WorkbenchLanguage.text("刷新结果未能载入，请重试。", "Could not load the refresh result. Try again.")])
                return
            }
            self.finishRefresh(sequence, response: summary)
            guard self.verify, summary["nativeMode"] as? Bool == true, summary["hasRendered"] as? Bool == true,
                  let data = try? JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys]),
                  let json = String(data: data, encoding: .utf8) else { return }
            print(json)
            exit(0)
        }
    }

    private func installMenus() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: Self.appName)
        appMenu.addItem(withTitle: WorkbenchLanguage.text("退出 \(Self.appName)", "Quit \(Self.appName)"),
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)

        let editTitle = WorkbenchLanguage.text("编辑", "Edit")
        let editItem = NSMenuItem(title: editTitle, action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: editTitle)
        editMenu.addItem(withTitle: WorkbenchLanguage.text("剪切", "Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: WorkbenchLanguage.text("复制", "Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: WorkbenchLanguage.text("粘贴", "Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: WorkbenchLanguage.text("全选", "Select All"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        menu.addItem(editItem)
        NSApp.mainMenu = menu
    }
}

@main
@MainActor
private enum Launcher {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(CommandLine.arguments.contains("--verify-render") ? .accessory : .regular)
        let delegate = WorkbenchApp()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}
