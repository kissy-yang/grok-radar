import CoreFoundation
import CryptoKit
import Darwin
import Foundation

/// Reads the local transcript mirror described by CodeBurn's Grok Bot provider.
/// Reads the roster, its matching transcript slices, and the account's cached weekly usage.
enum GrokLocalSource {
    private static let slicePrefix = "sand.client.slice.account."
    private static let rosterSuffix = ".roster.last-roster"
    private static let weeklyUsageSuffix = ".weekly-usage.cache"
    private static let transcriptMarker = ".transcript.replicas."
    private static let maxFileBytes = 8 * 1024 * 1024
    private static let maxSnapshotBytes = 32 * 1024 * 1024
    private static let maxQuotaBytes = 64 * 1024
    private static let maxBytesPerRole = 48 * 1024
    private static let maxMessagesPerRole = 64
    private static let streamingLifetime = 5 * 60 * 1000.0
    private static let waitingLifetime = 60 * 1000.0
    private static let delegatedWaitingLifetime = 15 * 60 * 1000.0
    private static let followupLifetime = 45 * 1000.0
    private static let unconfirmedLifetime = 15 * 60 * 1000.0
    private static let taskPreviewLimit = 120
    private static let oldestTimestamp = 1_577_836_800_000.0 // 2020-01-01 UTC
    private static let newestTimestamp = 4_102_444_800_000.0 // 2100-01-01 UTC
    static let mirrorDirectory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Grok Bot/sand-client-persistence", isDirectory: true)

    struct Account {
        let key: String
        let botIDsByKey: [String: String]
    }

    enum MessageRole: String {
        case user, assistant
    }

    struct Message {
        let role: MessageRole
        let text: String
        let at: String
    }

    struct Conversation {
        let items: [Message]
        let truncated: Bool
    }

    enum ConversationError: LocalizedError {
        case accountUnavailable, eventUnavailable

        var errorDescription: String? {
            switch self {
            case .accountUnavailable:
                return WorkbenchLanguage.text("当前 Grok Bot 账号或 Bot 不可用。", "The current Grok Bot account or bot is unavailable.")
            case .eventUnavailable:
                return WorkbenchLanguage.text("本机镜像中找不到这条事件的可读记录。", "This event has no readable conversation in the local cache.")
            }
        }
    }

    private struct MessageBudget {
        private var remaining = maxBytesPerRole
        private var count = 0
        private var seen: [Double: Set<String>] = [:]
        private(set) var truncated = false

        mutating func appendText(_ text: String, at timestamp: Double) -> String? {
            guard !truncated, seen[timestamp, default: []].insert(text).inserted else { return nil }
            guard remaining > 0, count < maxMessagesPerRole else {
                truncated = true
                return nil
            }
            let bytes = text.utf8
            if bytes.count > remaining {
                // Clip at a scalar boundary before transferring the conversation to WebKit.
                var end = bytes.index(bytes.startIndex, offsetBy: remaining)
                while (bytes[end] & 0xC0) == 0x80 { end = bytes.index(before: end) }
                truncated = true
                return end > bytes.startIndex ? String(decoding: bytes[..<end], as: UTF8.self) : nil
            }
            remaining -= bytes.count
            count += 1
            return text
        }
    }

    private struct Slice {
        let url: URL
        let account: String
        let bot: String?
    }

    private struct Contents {
        let value: [String: Any]
        let modifiedAt: Date
    }

    private enum Trigger: String {
        case person
        case bot
        case observed
    }

    private struct StreamingState {
        let at: Double
        let sequence: Double
        let streaming: Bool

        func supersedes(_ other: Self) -> Bool {
            if at != other.at { return at > other.at }
            if sequence != other.sequence { return sequence > other.sequence }
            return !streaming && other.streaming
        }
    }

    private struct Round {
        var earliest: Double
        var latest: Double
        var hasUserInput = false
        var hasBotInput = false
        var hasBotOutput = false
        private var latestInputAt: Double?
        private var latestInputText: String?
        private var streamingState: StreamingState?
        private var firstInputAt: Double?
        private(set) var firstReplyAt: Double?
        private(set) var lastReplyAt: Double?
        private var firstSourceAgent: String?
        private var hasAmbiguousBotSource = false
        private var firstHandoff: String?
        private var hasConflictingHandoffs = false

        init(at timestamp: Double) {
            earliest = timestamp
            latest = timestamp
        }

        mutating func observe(_ entry: [String: Any], at timestamp: Double) {
            earliest = min(earliest, timestamp)
            latest = max(latest, timestamp)
            let kind = entry["kind"] as? String
            let role = entry["role"] as? String
            if kind == "message", role == "assistant", let flag = entry["isStreaming"] as? NSNumber,
               CFGetTypeID(flag) == CFBooleanGetTypeID() {
                let state = StreamingState(at: timestamp, sequence: entrySequence(entry["seq"]), streaming: flag.boolValue)
                if streamingState.map(state.supersedes) ?? true { streamingState = state }
            }
            if kind == "send-message" || role == "assistant" {
                hasBotOutput = true
                let message = entry["message"] as? [String: Any]
                let delivered = kind == "send-message" && visibleReplyText(message) != nil
                let visible = delivered || (kind == "send-message"
                    ? hasVisibleText(message?["content"]) || hasVisibleText(message?["text"])
                    : hasVisibleText(entry["content"]))
                if visible { firstReplyAt = min(firstReplyAt ?? timestamp, timestamp) }
                if delivered { lastReplyAt = max(lastReplyAt ?? timestamp, timestamp) }
            } else if role == "user" {
                if let text = entry["content"] as? String, hasVisibleText(text) {
                    firstInputAt = min(firstInputAt ?? timestamp, timestamp)
                    if latestInputAt.map({ timestamp > $0 }) ?? true {
                        latestInputAt = timestamp
                        latestInputText = text
                    } else if timestamp == latestInputAt, latestInputText != text {
                        latestInputText = nil
                    }
                }
                let fromAgent = entry["fromAgent"]
                if let fromAgent, !(fromAgent is NSNull) {
                    hasBotInput = true
                    let sender = (fromAgent as? [String: Any]).flatMap { identifier($0["id"]) }
                    if let sender, firstSourceAgent == nil || firstSourceAgent == sender {
                        firstSourceAgent = sender
                    } else {
                        hasAmbiguousBotSource = true
                    }
                } else {
                    hasUserInput = true
                    if let text = entry["content"] as? String, let marker = handoffID(in: text) {
                        if firstHandoff == nil || firstHandoff == marker {
                            firstHandoff = marker
                        } else {
                            hasConflictingHandoffs = true
                        }
                    }
                }
            }
        }

        func streamingAt(now: Double) -> Double? {
            guard let state = streamingState, state.streaming,
                  (0 ... streamingLifetime).contains(now - state.at) else { return nil }
            return state.at
        }

        func waitingAt(now: Double, isDelegated: Bool) -> Double? {
            let limit = isDelegated ? delegatedWaitingLifetime : waitingLifetime
            guard lastReplyAt == nil, let latestInputAt,
                  (0 ... limit).contains(now - latestInputAt) else { return nil }
            return latestInputAt
        }

        func task(now: Double, isDelegated: Bool) -> String? {
            guard trigger == .person || isDelegated,
                  let latestInputAt, latestInputAt <= now, let latestInputText else { return nil }
            return taskPreview(latestInputText)
        }

        func followupAt(now: Double) -> Double? {
            // The mirror does not identify the final delivery. Only recent visible replies qualify.
            guard let lastReplyAt, lastReplyAt >= (latestInputAt ?? lastReplyAt),
                  (0 ..< followupLifetime).contains(now - lastReplyAt) else { return nil }
            return lastReplyAt
        }

        func unconfirmedAt(now: Double, isDelegated: Bool) -> Double? {
            guard trigger == .person || isDelegated,
                  let latestInputAt, let lastReplyAt, lastReplyAt >= latestInputAt,
                  (followupLifetime ..< unconfirmedLifetime).contains(now - lastReplyAt) else { return nil }
            return lastReplyAt
        }

        var latency: Double? {
            guard let firstInputAt, let firstReplyAt, firstReplyAt >= firstInputAt else { return nil }
            return firstReplyAt - firstInputAt
        }

        var trigger: Trigger {
            if hasUserInput && !hasBotInput { return .person }
            if hasBotInput && !hasUserInput { return .bot }
            return .observed
        }

        var sourceAgent: String? {
            guard trigger == .bot, !hasAmbiguousBotSource else { return nil }
            return firstSourceAgent
        }

        var handoff: String? {
            guard trigger == .person, !hasConflictingHandoffs else { return nil }
            return firstHandoff
        }

        var title: String {
            switch trigger {
            case .person: return "用户发起的回合"
            case .bot: return "Bot 间对话回合"
            case .observed: return "Grok Bot 对话回合"
            }
        }

        var detail: String {
            hasBotOutput ? "本机镜像中有 Bot 输出记录。" : "本机镜像中只有回合记录。"
        }
    }

    static func snapshot() -> [String: Any] {
        snapshot(at: mirrorDirectory)
    }

    static func currentAccount(at directory: URL = mirrorDirectory) -> Account? {
        guard let slices = readIndex(at: directory) else { return nil }
        let rosters = slices.filter { $0.bot == nil }
        var budget = maxSnapshotBytes
        guard rosters.count == 1, let roster = rosters.first,
              let names = readRoster(roster, budget: &budget), !names.isEmpty else { return nil }
        let ids = Dictionary(uniqueKeysWithValues: names.keys.map { bot in
            (eventID(account: roster.account, bot: bot, request: ""), bot)
        })
        return Account(key: eventID(account: roster.account, bot: "", request: ""), botIDsByKey: ids)
    }

    static func visibleConversation(
        accountKey: String, botKey: String, observedId: String, at directory: URL = mirrorDirectory
    ) throws -> Conversation {
        guard let slices = readIndex(at: directory) else { throw ConversationError.accountUnavailable }
        let rosters = slices.filter { $0.bot == nil }
        var budget = maxSnapshotBytes
        guard rosters.count == 1, let roster = rosters.first,
              eventID(account: roster.account, bot: "", request: "") == accountKey,
              let names = readRoster(roster, budget: &budget),
              let bot = names.keys.first(where: { eventID(account: roster.account, bot: $0, request: "") == botKey })
        else { throw ConversationError.accountUnavailable }

        let mirrors = slices.filter { $0.account == roster.account && $0.bot == bot }
        guard mirrors.count == 1, let mirror = mirrors.first,
              let contents = read(mirror.url, budget: &budget),
              let entries = contents.value["entries"] as? [Any],
              let matching = entries.lazy.compactMap({ $0 as? [String: Any] }).first(where: { entry in
                  guard let kind = entry["kind"] as? String, kind == "message" || kind == "send-message",
                        let request = identifier(entry["requestId"]), timestamp(entry["timestampMs"]) != nil
                  else { return false }
                  return eventID(account: roster.account, bot: bot, request: request) == observedId
              }),
              let request = identifier(matching["requestId"])
        else { throw ConversationError.eventUnavailable }

        let visible = entries.enumerated().compactMap { order, value -> (time: Double, order: Int, role: MessageRole, text: String)? in
            guard let entry = value as? [String: Any], identifier(entry["requestId"]) == request,
                  let time = timestamp(entry["timestampMs"]), let kind = entry["kind"] as? String
            else { return nil }
            // send-message is the transcript's record of output delivered to the chat.
            if kind == "send-message", let text = visibleReplyText(entry["message"] as? [String: Any]) {
                return (time, order, .assistant, text)
            }
            if kind == "message", entry["role"] as? String == "user",
               entry["fromAgent"] == nil || entry["fromAgent"] is NSNull,
               let text = entry["content"] as? String, hasVisibleText(text) {
                return (time, order, .user, text)
            }
            return nil
        }.sorted { left, right in
            left.time == right.time ? left.order < right.order : left.time < right.time
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var items: [Message] = []
        // A long prompt must not consume the transfer budget of delivered replies.
        var budgets: [MessageRole: MessageBudget] = [:]
        for entry in visible {
            guard let text = budgets[entry.role, default: MessageBudget()].appendText(entry.text, at: entry.time) else { continue }
            let at = formatter.string(from: Date(timeIntervalSince1970: entry.time / 1000))
            items.append(Message(role: entry.role, text: text, at: at))
        }
        return Conversation(items: items, truncated: budgets.values.contains { $0.truncated })
    }

    private static func hasVisibleText(_ value: Any?) -> Bool {
        guard let text = value as? String else { return false }
        return text.unicodeScalars.contains { !CharacterSet.whitespacesAndNewlines.contains($0) }
    }

    private static func visibleReplyText(_ message: [String: Any]?) -> String? {
        guard let message, message["type"] == nil || message["type"] as? String == "text" else { return nil }
        return [message["content"], message["text"]].lazy.compactMap { $0 as? String }.first { hasVisibleText($0) }
    }

    private static func taskPreview(_ text: String) -> String? {
        // Keep the preview small even if user-perceived characters have many combining scalars.
        let scalarLimit = taskPreviewLimit * 4
        let separators = CharacterSet.whitespacesAndNewlines.union(.controlCharacters)
        let content = handoffID(in: text).map { text.dropFirst(5 + $0.count) } ?? text[...]
        var preview = String.UnicodeScalarView()
        var separatorPending = false
        var clipped = false
        var scalarCount = 0
        for scalar in content.unicodeScalars {
            if separators.contains(scalar) {
                separatorPending = scalarCount > 0
                continue
            }
            let added = separatorPending ? 2 : 1
            guard scalarCount + added <= scalarLimit else {
                clipped = true
                break
            }
            if separatorPending { preview.append(" ") }
            preview.append(scalar)
            separatorPending = false
            scalarCount += added
        }
        let value = String(preview)
        guard !value.isEmpty else { return nil }
        if clipped || value.count > taskPreviewLimit {
            return String(value.prefix(taskPreviewLimit - 1)).trimmingCharacters(in: .whitespaces) + "…"
        }
        return value
    }

    // Routine snapshots extract only the fixed leading token from the input.
    static func handoffID(in text: String) -> String? {
        let start = "[WB#".utf8
        let endIndex = start.count + 32
        let markerLength = endIndex + 1
        let prefix = Array(text.utf8.prefix(markerLength + 2))
        guard prefix.count >= markerLength, prefix.starts(with: start),
              prefix[endIndex] == UInt8(ascii: "]")
        else { return nil }
        let boundary = prefix.dropFirst(markerLength)
        guard boundary.isEmpty || boundary.first == UInt8(ascii: " ") ||
              boundary.starts(with: "\n".utf8) || boundary.starts(with: "\r\n".utf8)
        else { return nil }
        let identifier = prefix[start.count..<endIndex]
        guard identifier.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { return nil }
        return String(decoding: identifier, as: UTF8.self)
    }

    static func snapshot(at directory: URL, now: Date = Date()) -> [String: Any] {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var result: [String: Any] = [
            "status": "waiting",
            "accountKey": NSNull(),
            "checkedAt": formatter.string(from: now),
            "sourceUpdatedAt": NSNull(),
            "latestEventAt": NSNull(),
            "botCount": 0,
            "bots": [[String: String]](),
            "skippedCount": 0,
            "events": [[String: Any]](),
            "activeRuns": [[String: String]](),
            "waitingRuns": [[String: String]](),
            "followupRuns": [[String: String]](),
            "unconfirmedRuns": [[String: String]](),
        ]
        guard let slices = readIndex(at: directory) else {
            result["status"] = "unavailable"
            result["reason"] = "directoryUnavailable"
            return result
        }
        let rosterFiles = slices.filter { $0.bot == nil }
        guard !rosterFiles.isEmpty else {
            result["reason"] = "rosterMissing"
            return result
        }
        // Stale rosters from another account must never be merged into this view.
        guard rosterFiles.count == 1, let roster = rosterFiles.first else {
            result["reason"] = "multipleAccounts"
            return result
        }
        var budget = maxSnapshotBytes
        guard let names = readRoster(roster, budget: &budget) else {
            result["status"] = "unavailable"
            result["reason"] = "rosterUnreadable"
            return result
        }
        result["botCount"] = names.count
        guard !names.isEmpty else {
            result["reason"] = "noBots"
            return result
        }
        let nowMilliseconds = now.timeIntervalSince1970 * 1000
        func formatted(_ milliseconds: Double) -> String {
            formatter.string(from: Date(timeIntervalSince1970: milliseconds / 1000))
        }
        result["weeklyQuota"] = weeklyQuota(at: directory, account: roster.account, now: nowMilliseconds, formatted: formatted)
        let mirrors = slices.filter { item in
            guard let bot = item.bot else { return false }
            return item.account == roster.account && names[bot] != nil
        }

        let agentKeys = Dictionary(uniqueKeysWithValues: names.keys.map { bot in
            (bot, eventID(account: roster.account, bot: bot, request: ""))
        })
        var validMirrors = 0
        var skippedCount = 0
        var latestChange: Date?
        var latestEntry = 0.0
        var events: [[String: Any]] = []
        var activeRuns: [[String: String]] = []
        var waitingRuns: [[String: String]] = []
        var followupRuns: [[String: String]] = []
        var unconfirmedRuns: [[String: String]] = []
        for mirror in mirrors.sorted(by: { ($0.bot ?? "") < ($1.bot ?? "") }) {
            guard let bot = mirror.bot, let name = names[bot],
                  let agentKey = agentKeys[bot],
                  let contents = read(mirror.url, budget: &budget),
                  let entries = contents.value["entries"] as? [Any] else {
                skippedCount += 1
                continue
            }
            validMirrors += 1
            latestChange = max(latestChange ?? contents.modifiedAt, contents.modifiedAt)
            var rounds: [String: Round] = [:]
            for case let entry as [String: Any] in entries {
                guard let kind = entry["kind"] as? String, kind == "message" || kind == "send-message" else { continue }
                guard let request = identifier(entry["requestId"]), let time = timestamp(entry["timestampMs"]) else {
                    skippedCount += 1
                    continue
                }
                rounds[request, default: Round(at: time)].observe(entry, at: time)
            }
            let newestStart = rounds.values.map(\.earliest).max()
            let newestRoundCount = rounds.values.lazy.filter { $0.earliest == newestStart }.count
            let activeBefore = activeRuns.count
            var waiting: [String: String]?
            var followup: [String: String]?
            var unconfirmed: [String: String]?
            for (request, round) in rounds {
                latestEntry = max(latestEntry, round.latest)
                let id = eventID(account: roster.account, bot: bot, request: request)
                let sourceAgentKey = round.sourceAgent.flatMap { agentKeys[$0] }
                let isDelegated = sourceAgentKey != nil && sourceAgentKey != agentKey
                func activityItem(at timestamp: Double) -> [String: String] {
                    var item = ["id": id, "agentKey": agentKey, "at": formatted(timestamp)]
                    item["task"] = round.task(now: nowMilliseconds, isDelegated: isDelegated)
                    return item
                }
                if let activity = round.streamingAt(now: nowMilliseconds) {
                    activeRuns.append(activityItem(at: activity))
                } else if newestRoundCount == 1, round.earliest == newestStart {
                    if let activity = round.waitingAt(now: nowMilliseconds, isDelegated: isDelegated) {
                        waiting = activityItem(at: activity)
                    } else if let activity = round.followupAt(now: nowMilliseconds) {
                        followup = activityItem(at: activity)
                    } else if let activity = round.unconfirmedAt(now: nowMilliseconds, isDelegated: isDelegated) {
                        unconfirmed = activityItem(at: activity)
                    }
                }
                events.append([
                    "id": id,
                    "at": formatted(round.earliest),
                    "source": "local-turn",
                    "title": round.title,
                    "agent": name,
                    "agentKey": agentKey,
                    "trigger": round.trigger.rawValue,
                    "sourceAgentKey": sourceAgentKey as Any? ?? NSNull(),
                    "handoffId": round.handoff as Any? ?? NSNull(),
                    "hasBotOutput": round.hasBotOutput,
                    "replyAt": round.firstReplyAt.map(formatted) as Any? ?? NSNull(),
                    "lastReplyAt": round.lastReplyAt.map(formatted) as Any? ?? NSNull(),
                    "route": NSNull(),
                    "status": NSNull(),
                    "latencyMs": round.latency as Any? ?? NSNull(),
                    "inputTokens": NSNull(),
                    "outputTokens": NSNull(),
                    "cacheReadTokens": NSNull(),
                    "cacheWriteTokens": NSNull(),
                    "actualUsd": NSNull(),
                    "baselineUsd": NSNull(),
                    "model": NSNull(),
                    "detail": round.detail,
                    "turnId": NSNull(),
                    "requestId": NSNull(),
                ])
            }
            if activeRuns.count == activeBefore {
                if let waiting { waitingRuns.append(waiting) }
                if let followup { followupRuns.append(followup) }
                if let unconfirmed { unconfirmedRuns.append(unconfirmed) }
            }
        }

        result["skippedCount"] = skippedCount
        // A verified roster can be available before this account has any transcript replicas.
        guard validMirrors > 0 || mirrors.isEmpty else {
            result["reason"] = "replicasUnreadable"
            return result
        }
        result["status"] = "connected"
        result["accountKey"] = eventID(account: roster.account, bot: "", request: "")
        result["bots"] = agentKeys.compactMap { id, key in
            names[id].map { ["key": key, "name": $0] }
        }.sorted { $0["key", default: ""] < $1["key", default: ""] }
        result["events"] = events.sorted { left, right in
            let lhs = left["at"] as? String ?? ""
            let rhs = right["at"] as? String ?? ""
            if lhs != rhs { return lhs > rhs }
            return (left["id"] as? String ?? "") < (right["id"] as? String ?? "")
        }
        func newestFirst(_ left: [String: String], _ right: [String: String]) -> Bool {
            let lhs = left["at", default: ""]
            let rhs = right["at", default: ""]
            return lhs == rhs ? left["id", default: ""] < right["id", default: ""] : lhs > rhs
        }
        result["activeRuns"] = activeRuns.sorted(by: newestFirst)
        result["waitingRuns"] = waitingRuns.sorted(by: newestFirst)
        result["followupRuns"] = followupRuns.sorted(by: newestFirst)
        result["unconfirmedRuns"] = unconfirmedRuns.sorted(by: newestFirst)
        if let latestChange { result["sourceUpdatedAt"] = formatter.string(from: latestChange) }
        if latestEntry > 0 { result["latestEventAt"] = formatted(latestEntry) }
        return result
    }

    private static func readIndex(at directory: URL) -> [Slice]? {
        guard let properties = try? directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]),
              properties.isDirectory == true, properties.isSymbolicLink != true,
              let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        else { return nil }
        return files.compactMap(slice)
    }

    private static func readRoster(_ roster: Slice, budget: inout Int) -> [String: String]? {
        guard let contents = read(roster.url, budget: &budget),
              let rows = contents.value["rows"] as? [Any] else { return nil }
        var names: [String: String] = [:]
        for case let row as [String: Any] in rows {
            guard let id = identifier(row["id"]) else { continue }
            let name = (row["name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            names[id] = name.isEmpty ? "未命名 Bot" : String(name.prefix(120))
        }
        return names
    }

    private static func weeklyQuota(
        at directory: URL, account: String, now: Double, formatted: (Double) -> String
    ) -> [String: Any]? {
        // Use the exact cache for the unique validated roster; never look for credentials or other billing data.
        let name = encodeBase32(slicePrefix + account + weeklyUsageSuffix) + ".blob"
        var budget = maxQuotaBytes
        guard let cache = read(directory.appendingPathComponent(name), budget: &budget, schemaVersion: 3)?.value,
              cache["kind"] as? String == "present",
              let reading = cache["reading"] as? [String: Any],
              let usage = reading["usage"] as? [String: Any],
              boolean(usage["hasNonZeroIncludedLimit"]) == true,
              boolean(usage["isSandTrial"]) == false,
              let isTeamSeat = boolean(usage["isTeamSeat"]),
              let updated = timestamp(reading["readAtMs"]), updated <= now,
              let expires = timestamp(cache["expiresAtMs"]), expires > now,
              let used = usage["percentUsed"] as? NSNumber, CFGetTypeID(used) != CFBooleanGetTypeID(),
              (0 ... 100).contains(used.doubleValue),
              let selectedTeam = cache["selectedTeamId"], let readTeam = usage["readForTeamId"]
        else { return nil }

        if isTeamSeat {
            guard let selected = identifier(selectedTeam), selected == identifier(readTeam) else { return nil }
        } else if !(selectedTeam is NSNull && readTeam is NSNull) {
            return nil
        }

        var quota: [String: Any] = ["remainingPercent": 100 - used.doubleValue, "updatedAt": formatted(updated)]
        if let candidate = usage["nextResetMs"], !(candidate is NSNull) {
            guard let reset = timestamp(candidate), reset > now else { return nil }
            quota["resetAt"] = formatted(reset)
        }
        return quota
    }

    private static func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    private static func slice(_ file: URL) -> Slice? {
        guard file.pathExtension == "blob",
              let key = decodeBase32(file.deletingPathExtension().lastPathComponent),
              key.hasPrefix(slicePrefix) else { return nil }
        let name = key.dropFirst(slicePrefix.count)
        if name.hasSuffix(rosterSuffix),
           let account = identifier(String(name.dropLast(rosterSuffix.count))) {
            return Slice(url: file, account: account, bot: nil)
        }
        guard let marker = name.range(of: transcriptMarker, options: .backwards),
              let account = identifier(String(name[..<marker.lowerBound])),
              let bot = identifier(String(name[marker.upperBound...])) else { return nil }
        return Slice(url: file, account: account, bot: bot)
    }

    private static func decodeBase32(_ name: String) -> String? {
        guard !name.isEmpty, [0, 2, 4, 5, 7].contains(name.utf8.count % 8) else { return nil }
        var remaining = 0
        var bits = 0
        var bytes = [UInt8]()
        for character in name.utf8 {
            let digit: UInt8
            switch character {
            case 97...122: digit = character - 97
            case 50...55: digit = character - 24
            default: return nil
            }
            remaining = (remaining << 5) | Int(digit)
            bits += 5
            if bits >= 8 {
                bits -= 8
                bytes.append(UInt8((remaining >> bits) & 0xff))
                remaining &= (1 << bits) - 1
            }
        }
        guard remaining == 0 else { return nil }
        return String(bytes: bytes, encoding: .utf8)
    }

    private static func encodeBase32(_ value: String) -> String {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567".utf8)
        var buffer = 0
        var bits = 0
        var result: [UInt8] = []
        for byte in value.utf8 {
            buffer = (buffer << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                bits -= 5
                result.append(alphabet[(buffer >> bits) & 31])
            }
            buffer &= (1 << bits) - 1
        }
        if bits > 0 { result.append(alphabet[(buffer << (5 - bits)) & 31]) }
        return String(decoding: result, as: UTF8.self)
    }

    private static func read(_ url: URL, budget: inout Int, schemaVersion: Int? = nil) -> Contents? {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { return nil }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }

        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_size > 0, info.st_size <= maxFileBytes, info.st_size <= budget else { return nil }
        budget -= Int(info.st_size)
        guard let data = try? handle.read(upToCount: Int(info.st_size) + 1), data.count == Int(info.st_size),
              let envelope = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let value = envelope["value"] as? [String: Any] else { return nil }
        if let schemaVersion {
            guard let version = envelope["schemaVersion"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(),
                  version.doubleValue == Double(schemaVersion) else { return nil }
        }
        let modified = Double(info.st_mtimespec.tv_sec) + Double(info.st_mtimespec.tv_nsec) / 1_000_000_000
        return Contents(value: value, modifiedAt: Date(timeIntervalSince1970: modified))
    }

    private static func identifier(_ value: Any?) -> String? {
        guard let string = value as? String, !string.isEmpty, string.utf8.count <= 512,
              !string.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
        return string
    }

    private static func timestamp(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let milliseconds = number.doubleValue
        guard milliseconds >= oldestTimestamp && milliseconds < newestTimestamp else { return nil }
        return milliseconds
    }

    private static func entrySequence(_ value: Any?) -> Double {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return -1 }
        let sequence = number.doubleValue
        guard sequence.isFinite, sequence >= 0, sequence.rounded(.towardZero) == sequence else { return -1 }
        return sequence
    }

    private static func eventID(account: String, bot: String, request: String) -> String {
        let key = [account, bot, request].joined(separator: "\u{0}")
        let hash = SHA256.hash(data: Data(key.utf8)).prefix(16)
        return "local:" + hash.map { String(format: "%02x", $0) }.joined()
    }
}
