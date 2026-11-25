import AppKit
import ApplicationServices
import Security

/// Reads status labels from the official client's accessibility sidebar.
enum GrokDesktopActivity {
    private static let bundleID = "com.anysphere.sand"
    private static let installedPath = "/Applications/Grok Bot.app"
    private static let nodeLimit = 350
    private static let depthLimit = 24
    private static let scanBudget: TimeInterval = 0.7
    private static let accessibility = AccessibilityRegistration()
    private static let offlineLabels: Set<String> = [
        "你已离线", "You're offline", "You’re offline",
        "Grok Bot 连接时遇到问题", "Grok Bot is having trouble connecting",
    ]
    private static let requirement: SecRequirement? = {
        let identity = #"anchor apple generic and identifier "com.anysphere.sand" and certificate leaf[subject.OU] = "DCNK4UB866""#
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(identity as CFString, SecCSFlags(), &requirement) == errSecSuccess else { return nil }
        return requirement
    }()

    static func requestPermission() -> Bool {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    static func read(bots: [[String: String]]) -> [String: Any] {
        guard AXIsProcessTrusted() else { return result(access: "permission") }
        let roster = uniqueRoster(bots)
        guard roster.count >= 2, let application = officialApplication() else { return result(access: "unavailable") }

        let root = AXUIElementCreateApplication(application.processIdentifier)
        _ = AXUIElementSetMessagingTimeout(root, 0.04)
        accessibility.enable(root, application: application)
        guard let windows = attribute(root, kAXWindowsAttribute) as? [AXUIElement], windows.count == 1,
              let window = windows.first, attribute(window, kAXMinimizedAttribute) as? Bool != true,
              let descriptions = sidebarDescriptions(in: window) else { return result(access: "unavailable") }

        var labelsByName: [String: [String]] = [:]
        for description in descriptions {
            guard let matched = match(description, names: roster.keys) else { continue }
            labelsByName[matched.name, default: []].append(matched.state)
        }
        var states: [String: String] = [:]
        for (name, labels) in labelsByName where labels.count == 1 {
            if let key = roster[name] { states[key] = labels[0] }
        }
        let minimumMatches = min(3, roster.count)
        guard states.count >= minimumMatches, states.count == descriptions.count,
              states.count * 2 >= roster.count else { return result(access: "unavailable") }
        return result(access: "ready", states: states)
    }

    private static func result(access: String, states: [String: String] = [:]) -> [String: Any] {
        ["access": access, "states": states]
    }

    private static func uniqueRoster(_ bots: [[String: String]]) -> [String: String] {
        let entries = bots.compactMap { bot -> (name: String, key: String)? in
            guard let key = bot["key"], WorkbenchHandoff.isOpaqueKey(key), let name = bot["name"], !name.isEmpty else { return nil }
            return (name, key)
        }
        return Dictionary(grouping: entries, by: \.name).compactMapValues { matches in
            matches.count == 1 ? matches.first?.key : nil
        }
    }

    private static func officialApplication() -> NSRunningApplication? {
        let applications = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
        guard applications.count == 1, let application = applications.first,
              application.bundleURL?.resolvingSymlinksInPath().standardizedFileURL.path == installedPath,
              NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)?.resolvingSymlinksInPath().standardizedFileURL.path == installedPath,
              let requirement else { return nil }
        var code: SecCode?
        let attributes = [kSecGuestAttributePid as String: application.processIdentifier] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code) == errSecSuccess,
              let code, SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess else { return nil }
        return application
    }

    private static func sidebarDescriptions(in window: AXUIElement) -> [String]? {
        let start = ProcessInfo.processInfo.systemUptime
        var pending = [(element: window, depth: 0, web: false)]
        var descriptions: [String] = []
        var examined = 0
        while !pending.isEmpty {
            guard examined < nodeLimit, ProcessInfo.processInfo.systemUptime - start < scanBudget else { return nil }
            let node = pending.removeLast()
            examined += 1
            if node.depth > depthLimit { continue }
            let role = attribute(node.element, kAXRoleAttribute) as? String
            let web = node.web || role == "AXWebArea"
            let classes = web ? attribute(node.element, "AXDOMClassList") as? [String] ?? [] : []
            if web && role == "AXButton" && classes.contains("sand-agent-item") {
                if let description = attribute(node.element, kAXDescriptionAttribute) as? String, description.utf8.count <= 512 {
                    descriptions.append(description)
                }
                continue
            }
            if classes.contains("sand-sent-while-offline-notice") && !classes.contains("sand-sent-while-offline-notice--cleared") {
                return nil
            }
            if web && isStatusElement(node.element, role: role) && isOfflineBanner(node.element) { return nil }
            // Only walk structural controls. Transcript articles and message boxes are not status sources.
            if classes.contains(where: { $0 == "sand-message" || $0 == "sand-activity-slot" }) ||
               role == "AXStaticText" || role == "AXTextArea" || role == "AXTextField" || role == "AXImage" {
                continue
            }
            guard let children = attribute(node.element, kAXChildrenAttribute) as? [AXUIElement] else { continue }
            guard children.count <= nodeLimit - pending.count else { return nil }
            pending.append(contentsOf: children.reversed().map { (element: $0, depth: node.depth + 1, web: web) })
        }
        return descriptions
    }

    private static func isStatusElement(_ element: AXUIElement, role: String?) -> Bool {
        if role == "AXAlert" || role == "AXStatus" { return true }
        guard role == "AXGroup", let subrole = attribute(element, kAXSubroleAttribute) as? String else { return false }
        return subrole == "AXApplicationAlert" || subrole == "AXApplicationStatus"
    }

    private static func isOfflineBanner(_ element: AXUIElement) -> Bool {
        func hasOfflineLabel(_ item: AXUIElement) -> Bool {
            [kAXDescriptionAttribute, kAXTitleAttribute, kAXValueAttribute].contains { key in
                guard let label = attribute(item, key) as? String else { return false }
                return offlineLabels.contains(label)
            }
        }
        if hasOfflineLabel(element) { return true }
        let children = (attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(4)
        return children.contains { attribute($0, kAXRoleAttribute) as? String == "AXStaticText" && hasOfflineLabel($0) }
    }

    private static func match(_ description: String, names: Dictionary<String, String>.Keys) -> (name: String, state: String)? {
        let informational: Set<String> = ["主 Bot", "Main Bot", "未读动态", "Unread activity"]
        let working: Set<String> = ["工作中", "Working"]
        let waiting: Set<String> = ["需要关注", "Needs attention"]
        var matched: (name: String, state: String)?
        for name in names {
            let state: String
            if description == name {
                state = "idle"
            } else {
                let prefix = name + ", "
                guard description.hasPrefix(prefix) else { continue }
                let tokens = String(description.dropFirst(prefix.count)).components(separatedBy: ", ")
                guard tokens.allSatisfy({ informational.contains($0) || working.contains($0) || waiting.contains($0) }) else { continue }
                state = tokens.contains(where: working.contains) ? "working" : tokens.contains(where: waiting.contains) ? "waiting" : "idle"
            }
            if matched != nil { return nil }
            matched = (name, state)
        }
        return matched
    }

    private static func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
    }

    private final class AccessibilityRegistration {
        private let lock = NSLock()
        private var process: (pid: pid_t, launch: Date?)?

        func enable(_ element: AXUIElement, application: NSRunningApplication) {
            lock.lock()
            defer { lock.unlock() }
            let pid = application.processIdentifier
            let launch = application.launchDate
            if let process, process.pid == pid, process.launch == launch { return }
            process = (pid, launch)
            // Electron exposes its normal sidebar accessibility tree after this accessibility-only registration.
            _ = AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        }
    }
}
