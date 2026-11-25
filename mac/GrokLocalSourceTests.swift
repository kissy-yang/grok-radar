import Foundation

@main
struct GrokLocalSourceTests {
    private static let now = Date(timeIntervalSince1970: 1_790_206_400)
    private static let baseTime = 1_790_206_400_000

    static func main() throws {
        if CommandLine.arguments.contains("--current-summary") {
            let snapshot = GrokLocalSource.snapshot()
            let events = snapshot["events"] as? [[String: Any]] ?? []
            let triggers = Dictionary(grouping: events) { $0["trigger"] as? String ?? "missing" }.mapValues(\.count)
            let summary = [
                "status": snapshot["status"] ?? NSNull(),
                "botCount": snapshot["botCount"] ?? NSNull(),
                "skippedCount": snapshot["skippedCount"] ?? NSNull(),
                "eventCount": events.count,
                "activeRuns": (snapshot["activeRuns"] as? [[String: String]])?.count ?? 0,
                "waitingRuns": (snapshot["waitingRuns"] as? [[String: String]])?.count ?? 0,
                "followupRuns": (snapshot["followupRuns"] as? [[String: String]])?.count ?? 0,
                "unconfirmedRuns": (snapshot["unconfirmedRuns"] as? [[String: String]])?.count ?? 0,
                "weeklyQuota": snapshot["weeklyQuota"] ?? NSNull(),
                "triggers": triggers,
                "linkedBotSources": events.filter { $0["sourceAgentKey"] is String }.count,
                "sourceUpdatedAt": snapshot["sourceUpdatedAt"] ?? NSNull(),
                "latestEventAt": snapshot["latestEventAt"] ?? NSNull(),
            ] as [String: Any]
            let json = try JSONSerialization.data(withJSONObject: summary, options: [.sortedKeys])
            print(String(decoding: json, as: UTF8.self))
            return
        }
        try unavailableAndEmpty()
        try groupsOnlyRosterMatches()
        try identifiesOnlyUnambiguousBotSources()
        try observesOnlyUnambiguousUserHandoffs()
        try describesCurrentBotActivity()
        try keepsVerifiedDelegationPendingAndPreviewsOnlyScopedInput()
        try followsDeliveredRepliesAcrossQuietGaps()
        try retainsUnconfirmedReplyWithoutAssumingCompletion()
        try readsOnlyCurrentValidWeeklyQuota()
        try ignoresInvalidOrSupersededFollowups()
        try ignoresStaleAmbiguousOrInvalidBotActivity()
        try acceptsOnlyExactInitialHandoffMarkers()
        try timesOnlyTextualRepliesWithKnownInput()
        try tracksLatestDeliveredReplyWithinOneRequest()
        try detectsBotsBeforeTheirTranscriptAppears()
        try readsVisibleConversationOnlyForSelectedEvent()
        try rejectsMismatchedConversationScope()
        try capsConversationPerRoleAtValidUnicodeBoundary()
        try waitsOnMoreThanOneAccount()
        try ignoresUnusableMirrors()
        try opensOnlyAccountRosterTargets()
        try storesPrivateAccountLedgers()
        print("GrokLocalSource and WorkbenchConnection: 22 test cases passed")
    }

    private static func unavailableAndEmpty() throws {
        try withDirectory { directory in
            let missing = GrokLocalSource.snapshot(at: directory.appendingPathComponent("absent"), now: now)
            try check(missing["status"] as? String == "unavailable", "Missing folder")
            let empty = GrokLocalSource.snapshot(at: directory, now: now)
            try check(empty["status"] as? String == "waiting", "Empty folder")
            try check(empty["reason"] as? String == "rosterMissing", "Empty folder reason")
            try check(empty["checkedAt"] as? String != nil && empty["sourceUpdatedAt"] is NSNull, "Timestamps")
            try check(empty["accountKey"] is NSNull, "Disconnected snapshot exposes no account key")
            try check(runs("activeRuns", missing).isEmpty && runs("waitingRuns", empty).isEmpty, "Empty and unavailable snapshots expose no activity")
            try check(runs("followupRuns", missing).isEmpty && runs("followupRuns", empty).isEmpty, "Disconnected snapshots expose no follow-up activity")
            try check(runs("unconfirmedRuns", missing).isEmpty && runs("unconfirmedRuns", empty).isEmpty,
                      "Disconnected snapshots expose no unconfirmed activity")
        }
    }

    private static func describesCurrentBotActivity() throws {
        try withDirectory { directory in
            let account = "activity-account"
            let bot = "activity-bot"
            let request = "activity-request"
            let file = mirror(account, bot)
            let input = entry(request, "message", timestamp: baseTime - 3000, extras: ["role": "user", "content": "PRIVATE-INPUT"])
            let streaming = entry(request, "message", timestamp: baseTime - 2000, extras: [
                "role": "assistant", "isStreaming": true, "seq": 5, "content": "PRIVATE-STREAMING",
            ])
            let interim = entry(request, "send-message", timestamp: baseTime - 1000, extras: ["message": ["content": "PRIVATE-INTERIM"]])
            let finished = entry(request, "message", timestamp: baseTime - 2000, extras: ["role": "assistant", "isStreaming": false, "seq": 6])
            try writeSlice(roster(account), ["rows": [["id": bot, "name": "Bot A"]]], to: directory)
            try writeSlice(file, ["entries": [input]], to: directory)
            let waiting = GrokLocalSource.snapshot(at: directory, now: now)
            let event = eventsOf(waiting).first
            let pending = runs("waitingRuns", waiting)
            try check(pending.count == 1 && pending[0]["id"] == event?["id"] as? String && pending[0]["agentKey"] == event?["agentKey"] as? String, "Fresh observed input uses the original opaque event and Bot keys")
            try check(pending[0]["at"] == event?["at"] as? String && runs("activeRuns", waiting).isEmpty, "Input alone is waiting rather than streaming")

            let draft = entry(request, "message", timestamp: baseTime - 2250, extras: ["role": "assistant", "content": "PRIVATE-DRAFT"])
            try writeSlice(file, ["entries": [input, draft]], to: directory)
            let drafting = GrokLocalSource.snapshot(at: directory, now: now)
            try check(runs("waitingRuns", drafting) == pending && runs("followupRuns", drafting).isEmpty,
                      "Internal output before the first delivered reply does not stop the wait")

            try writeSlice(file, ["entries": [input, streaming]], to: directory)
            let running = GrokLocalSource.snapshot(at: directory, now: now)
            try check(runs("activeRuns", running).first?["id"] == pending[0]["id"] && runs("waitingRuns", running).isEmpty, "Explicit streaming replaces waiting on the same event")
            try writeSlice(file, ["entries": [interim, streaming, input]], to: directory)
            let replying = GrokLocalSource.snapshot(at: directory, now: now)
            try check(runs("activeRuns", replying) == runs("activeRuns", running), "An interim visible answer does not end explicit streaming")
            try check(runs("followupRuns", replying).isEmpty, "Explicit streaming suppresses inferred follow-up for the same Bot")
            try check(runs("activeRuns", replying).first.map { Set($0.keys) } == Set(["id", "agentKey", "at", "task"]) &&
                      runs("activeRuns", replying).first?["task"] == "PRIVATE-INPUT", "Activity may preview only the matching incoming text")
            let serialized = try JSONSerialization.data(withJSONObject: replying)
            try check(![account, bot, request, "PRIVATE-STREAMING", "PRIVATE-INTERIM"].contains(where: String(decoding: serialized, as: UTF8.self).contains), "Activity polling excludes internal output, replies and original IDs")
            let history = try JSONSerialization.data(withJSONObject: eventsOf(replying))
            try check(!String(decoding: history, as: UTF8.self).contains("PRIVATE-"), "History polling excludes all message text")

            try writeSlice(file, ["entries": [finished, input, streaming]], to: directory)
            let complete = GrokLocalSource.snapshot(at: directory, now: now)
            try check(runs("activeRuns", complete).isEmpty && runs("waitingRuns", complete) == pending,
                      "An explicit later sequence ends streaming while the first public reply is still unobserved")
            try writeSlice(file, ["entries": [input, interim]], to: directory)
            let delivered = GrokLocalSource.snapshot(at: directory, now: now)
            try check(runs("waitingRuns", delivered).isEmpty, "Visible delivery ends an inferred wait")
        }
    }

    private static func keepsVerifiedDelegationPendingAndPreviewsOnlyScopedInput() throws {
        try withDirectory { directory in
            let account = "delegation-account"
            let sender = "verified-sender-opaque-source"
            let receiver = "receiver-opaque-source"
            let receiverFile = mirror(account, receiver)
            let personFile = mirror(account, "person-bot")
            let unknownFile = mirror(account, "unknown-bot")
            let ambiguousFile = mirror(account, "ambiguous-bot")
            let competingFile = mirror(account, "competing-bot")
            let bots = [["id": sender, "name": "Sender"], ["id": receiver, "name": "Receiver"],
                        ["id": "person-bot", "name": "Personal"], ["id": "unknown-bot", "name": "Unknown"],
                        ["id": "ambiguous-bot", "name": "Ambiguous"], ["id": "competing-bot", "name": "Competing"]]
            func input(_ request: String, offset: Int, text: String, from: String? = nil) -> [String: Any] {
                var fields: [String: Any] = ["role": "user", "content": text, "isStreaming": false]
                if let from { fields["fromAgent"] = ["id": from] }
                return entry(request, "message", timestamp: baseTime + offset, extras: fields)
            }
            let older = input("delegated-request", offset: -220_000, text: "OLD-INPUT-PRIVATE", from: sender)
            let personal = input("direct-request", offset: -219_000, text: "STALE-DIRECT-PRIVATE")
            let delegation = input("delegated-request", offset: -219_000,
                                   text: "  核对\n\t 文档\u{202E}\u{0000} " + String(repeating: "长", count: 180), from: sender)
            let response = entry("delegated-request", "send-message", timestamp: baseTime + 1000,
                                 extras: ["message": ["text": "DELIVERED-OUTPUT-PRIVATE"]])
            try writeSlice(roster(account), ["rows": bots], to: directory)
            try writeSlice(receiverFile, ["entries": [delegation, older]], to: directory)
            try writeSlice(personFile, ["entries": [personal]], to: directory)
            try writeSlice(unknownFile, ["entries": [input("unknown-request", offset: -219_000,
                                                            text: "UNKNOWN-SENDER-PRIVATE", from: "unknown-sender")]], to: directory)
            try writeSlice(ambiguousFile, ["entries": [input("mixed-request", offset: -2000, text: "MIXED-SENDER-PRIVATE", from: sender),
                                                       input("mixed-request", offset: -1000, text: "MIXED-PERSON-PRIVATE")]], to: directory)
            try writeSlice(competingFile, ["entries": [input("tied-input", offset: -2000, text: "TIED-TEXT-PRIVATE 1"),
                                                       input("tied-input", offset: -2000, text: "TIED-TEXT-PRIVATE 2")]], to: directory)
            try writeSlice(mirror("other-account", receiver), ["entries": [input("another-account-input", offset: -1000,
                                                                                  text: "OTHER-ACCOUNT-PRIVATE", from: sender)]], to: directory)
            let snapshot = GrokLocalSource.snapshot(at: directory, now: now)
            let waiting = runs("waitingRuns", snapshot)
            let receiverKey = eventsOf(snapshot).first { $0["agent"] as? String == "Receiver" }?["agentKey"] as? String
            let pending = waiting.first { $0["agentKey"] == receiverKey }
            let preview = pending?["task"]
            try check(preview?.count == 120 && preview?.hasPrefix("核对 文档 长") == true && preview?.hasSuffix("…") == true,
                      "A verified Bot dispatch beyond the ordinary sixty-second wait shows a bounded, sanitized preview of the latest input")
            try check(waiting.count == 3 && waiting.filter { $0["task"] != nil }.count == 1,
                      "Stale direct or unknown tasks do not extend and mixed or tied inputs do not produce a preview")
            let encoded = try JSONSerialization.data(withJSONObject: snapshot)
            let published = String(decoding: encoded, as: UTF8.self)
            try check(![account, sender, receiver, "PRIVATE", "\u{202E}", "\u{0000}"].contains(where: published.contains),
                      "Only the matching bounded preview is exposed, without control characters or unscoped text")
            let history = try JSONSerialization.data(withJSONObject: eventsOf(snapshot))
            try check(!String(decoding: history, as: UTF8.self).contains("核对"), "Task preview stays out of historical events")

            let later = now.addingTimeInterval(682)
            let expired = GrokLocalSource.snapshot(at: directory, now: later)
            try check(runs("waitingRuns", expired).isEmpty, "The delegated wait expires fifteen minutes after the latest verified input")

            try writeSlice(receiverFile, ["entries": [older, delegation, response]], to: directory)
            let next = GrokLocalSource.snapshot(at: directory, now: now.addingTimeInterval(2))
            try check(!runs("waitingRuns", next).contains { $0["agentKey"] == receiverKey } &&
                      runs("followupRuns", next).first { $0["agentKey"] == receiverKey }?["task"] == preview,
                      "Delivery of a visible response ends the delegated wait without previewing the response")

            let newerRound = input("newer-round", offset: -5000, text: "  人工 \r\n 确认  ")
            try writeSlice(receiverFile, ["entries": [older, delegation, newerRound]], to: directory)
            let replaced = GrokLocalSource.snapshot(at: directory, now: now)
            try check(runs("waitingRuns", replaced).first { $0["agentKey"] == receiverKey }?["task"] == "人工 确认",
                      "A fresh direct round replaces the earlier delegated activity")
        }
    }

    private static func followsDeliveredRepliesAcrossQuietGaps() throws {
        try withDirectory { directory in
            let account = "followup-account"
            let bot = "followup-bot"
            let request = "followup-request"
            let file = mirror(account, bot)
            let input = entry(request, "message", timestamp: baseTime, extras: ["role": "user", "content": "PRIVATE-INPUT"])
            // Reproduce the observed 33.985-second gap between the first two deliveries using synthetic text.
            let replyOffsets = [6978, 40_963, 46_638]
            let replies = replyOffsets.map { entry(request, "send-message", timestamp: baseTime + $0,
                                                    extras: ["message": ["type": "text", "text": "PRIVATE-REPLY"]]) }
            let streamStopped = entry(request, "message", timestamp: baseTime + 35_000,
                                      extras: ["role": "assistant", "isStreaming": false])
            func snapshot(at offset: Int) -> [String: Any] {
                GrokLocalSource.snapshot(at: directory, now: now.addingTimeInterval(Double(offset) / 1000))
            }

            try writeSlice(roster(account), ["rows": [["id": bot, "name": "Bot A"]]], to: directory)
            try writeSlice(file, ["entries": [input]], to: directory)
            let pending = runs("waitingRuns", snapshot(at: 6977)).first
            try check(pending?["id"] != nil, "The flow animates while awaiting the first delivery")
            for (index, offset) in replyOffsets.enumerated() {
                let entries = [input] + Array(replies.prefix(index + 1)) + (index > 0 ? [streamStopped] : [])
                try writeSlice(file, ["entries": entries], to: directory)
                let nextEvidence = index + 1 < replyOffsets.count ? replyOffsets[index + 1] : offset + 45_000
                for instant in [offset + 1, nextEvidence - 1] {
                    let current = snapshot(at: instant)
                    let followups = runs("followupRuns", current)
                    try check(followups.count == 1 && followups[0]["id"] == pending?["id"] && followups[0]["agentKey"] == pending?["agentKey"],
                              "Follow-up keeps the same flow active between visible replies and refreshes for each delivery")
                    try check(followups[0]["at"] == eventsOf(current).first?["lastReplyAt"] as? String &&
                              Set(followups[0].keys) == Set(["id", "agentKey", "at", "task"]) && followups[0]["task"] == "PRIVATE-INPUT",
                              "Follow-up reports opaque keys, the latest visible delivery time and only the incoming task preview")
                    try check(runs("waitingRuns", current).isEmpty && runs("activeRuns", current).isEmpty,
                              "Inferred follow-up and confirmed streaming use separate lanes")
                }
            }
            let quiet = snapshot(at: replyOffsets[2] + 45_001)
            try check(runs("followupRuns", quiet).isEmpty, "Silence after the latest delivery expires the follow-up window")
            try check(runs("unconfirmedRuns", quiet).first?["task"] == "PRIVATE-INPUT", "The quiet run retains only its incoming task preview")
            let encoded = try JSONSerialization.data(withJSONObject: quiet)
            try check(![account, bot, request, "PRIVATE-REPLY"].contains(where: String(decoding: encoded, as: UTF8.self).contains),
                      "Polling never exposes reply text or original identifiers")
            let expired = snapshot(at: replyOffsets[2] + 900_001)
            try check(runs("unconfirmedRuns", expired).isEmpty, "Unconfirmed details expire without inventing a completion")
        }
    }

    private static func retainsUnconfirmedReplyWithoutAssumingCompletion() throws {
        try withDirectory { directory in
            let account = "quiet-account"
            let bot = "quiet-bot"
            let request = "quiet-request"
            let file = mirror(account, bot)
            // Reproduce the timing of the 18:06 task without retaining its actual text or identifiers.
            let input = entry(request, "message", timestamp: baseTime,
                              extras: ["role": "user", "content": "检查样稿", "isStreaming": false])
            let first = entry(request, "send-message", timestamp: baseTime + 4_797,
                              extras: ["message": ["type": "text", "text": "FIRST-PRIVATE-REPLY"]])
            let last = entry(request, "send-message", timestamp: baseTime + 29_449,
                             extras: ["message": ["type": "text", "text": "LAST-PRIVATE-REPLY"]])
            func snapshot(at offset: Int) -> [String: Any] {
                GrokLocalSource.snapshot(at: directory, now: now.addingTimeInterval(Double(offset) / 1000))
            }
            try writeSlice(roster(account), ["rows": [["id": bot, "name": "Bot A"]]], to: directory)
            try writeSlice(file, ["entries": [input, first, last]], to: directory)
            let before = snapshot(at: 74_448)
            let after = snapshot(at: 74_450)
            let waiting = runs("followupRuns", before)
            let quiet = runs("unconfirmedRuns", after)
            try check(waiting.count == 1 && quiet == waiting && runs("unconfirmedRuns", before).isEmpty,
                      "After the measured 45-second quiet window, the same linked launch changes to unconfirmed")
            try check(runs("activeRuns", after).isEmpty && runs("waitingRuns", after).isEmpty && runs("followupRuns", after).isEmpty,
                      "Unconfirmed is reported separately from animated states")
            try check(runs("unconfirmedRuns", snapshot(at: 929_448)) == quiet &&
                      runs("unconfirmedRuns", snapshot(at: 929_450)).isEmpty,
                      "Unconfirmed lasts at most 15 minutes since the actual latest visible reply")

            let stream = entry(request, "message", timestamp: baseTime + 74_848,
                               extras: ["role": "assistant", "isStreaming": true])
            try writeSlice(file, ["entries": [input, first, last, stream]], to: directory)
            let streaming = snapshot(at: 74_850)
            try check(runs("activeRuns", streaming).count == 1 && runs("unconfirmedRuns", streaming).isEmpty,
                      "An explicit stream wins over the unconfirmed phase")

            let newer = entry("new-input", "message", timestamp: baseTime + 74_848,
                              extras: ["role": "user", "content": "新的任务"])
            try writeSlice(file, ["entries": [input, first, last, newer]], to: directory)
            let superseded = snapshot(at: 74_850)
            try check(runs("waitingRuns", superseded).count == 1 && runs("unconfirmedRuns", superseded).isEmpty,
                      "A new turn displaces the older quiet record")

            try writeSlice(file, ["entries": [first, last]], to: directory)
            try check(runs("unconfirmedRuns", after).count == 1 && runs("unconfirmedRuns", snapshot(at: 74_450)).isEmpty,
                      "A delivery with no linked incoming task never creates an unconfirmed record")
        }
    }

    private static func readsOnlyCurrentValidWeeklyQuota() throws {
        try withDirectory { directory in
            let account = "quota-account"
            let quotaKey = "sand.client.slice.account.\(account).weekly-usage.cache"
            func value(
                _ used: Any = 2.2, updated: Any = baseTime - 1000, expires: Any = baseTime + 100_000,
                reset: Any = baseTime + 50_000, included: Any = true, trial: Any = false,
                selectedTeam: Any = NSNull(), readTeam: Any = NSNull(), teamSeat: Any = false
            ) -> [String: Any] {
                ["kind": "present", "expiresAtMs": expires, "selectedTeamId": selectedTeam,
                 "reading": ["readAtMs": updated, "usage": ["percentUsed": used, "nextResetMs": reset,
                      "hasNonZeroIncludedLimit": included, "isSandTrial": trial, "isTeamSeat": teamSeat,
                      "readForTeamId": readTeam, "unpublished": "PRIVATE-BILLING-DETAIL"]]]
            }
            func snapshot() -> [String: Any] { GrokLocalSource.snapshot(at: directory, now: now) }
            func quota() -> [String: Any]? { snapshot()["weeklyQuota"] as? [String: Any] }
            try writeSlice(roster(account), ["rows": [["id": "quota-bot", "name": "Bot A"]]], to: directory)
            let foreign = try writeSlice("sand.client.slice.account.other-account.weekly-usage.cache", value(90),
                                         schemaVersion: 3, to: directory)
            try check(quota() == nil, "A cache for a different account never supplies the quota")

            let url = try writeSlice(quotaKey, value(), schemaVersion: 3, to: directory)
            let valid = quota() ?? [:]
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            try check(Set(valid.keys) == ["remainingPercent", "updatedAt", "resetAt"] && valid["remainingPercent"] as? Double == 97.8 &&
                      valid["updatedAt"] as? String == formatter.string(from: now.addingTimeInterval(-1)) &&
                      valid["resetAt"] as? String == formatter.string(from: now.addingTimeInterval(50)),
                      "Project only the remaining percent and official cache timestamps")
            try writeSlice(quotaKey, value(100, reset: NSNull()), schemaVersion: 3, to: directory)
            try check(quota()?["remainingPercent"] as? Double == 0 && quota()?["resetAt"] == nil,
                      "A valid cache can show exhausted quota without a published reset timestamp")

            let invalid = [value(true), value(101), value(-1), value("2.2"), value(updated: baseTime + 1),
                           value(expires: baseTime), value(reset: baseTime), value(reset: true), value(included: 1),
                           value(included: false), value(trial: true), value(selectedTeam: "other"),
                           value(selectedTeam: "team-a", readTeam: "team-b", teamSeat: true)]
            for test in invalid {
                try writeSlice(quotaKey, test, schemaVersion: 3, to: directory)
                let current = snapshot()
                try check(current["weeklyQuota"] == nil && current["status"] as? String == "connected",
                          "Invalid or stale quota is omitted without disconnecting the roster")
            }
            try writeSlice(quotaKey, value(), schemaVersion: 2, to: directory)
            try check(quota() == nil, "An unrecognized cache version is not parsed")
            try writeSlice(quotaKey, value(20, selectedTeam: "TEAM-PRIVATE", readTeam: "TEAM-PRIVATE", teamSeat: true),
                           schemaVersion: 3, to: directory)
            try check(quota()?["remainingPercent"] as? Double == 80 && quota()?["selectedTeamId"] == nil,
                      "A team meter must match both scopes and never exposes the team identity")
            try FileManager.default.removeItem(at: url)
            try FileManager.default.createSymbolicLink(at: url, withDestinationURL: foreign)
            try check(quota() == nil, "A linked quota slice is never read")
            try FileManager.default.removeItem(at: url)
            try Data(count: 64 * 1024 + 1).write(to: url)
            try check(quota() == nil, "An oversized quota slice is rejected before parsing")
        }
    }

    private static func ignoresInvalidOrSupersededFollowups() throws {
        try withDirectory { directory in
            let account = "followup-filter-account"
            func input(_ request: String, _ offset: Int) -> [String: Any] {
                entry(request, "message", timestamp: baseTime + offset, extras: ["role": "user", "content": "INPUT"])
            }
            func reply(_ request: String, _ offset: Int, type: String = "text") -> [String: Any] {
                entry(request, "send-message", timestamp: baseTime + offset, extras: ["message": ["type": type, "text": "OUTPUT"]])
            }
            try writeSlice(roster(account), ["rows": ["stale", "superseded", "ambiguous", "future", "hidden", "out-of-order", "explicit"].map {
                ["id": $0, "name": $0]
            }], to: directory)
            try writeSlice(mirror(account, "stale"), ["entries": [reply("quiet", -45_001)]], to: directory)
            try writeSlice(mirror(account, "superseded"), ["entries": [input("prior", -7000), input("latest", -3000), reply("prior", -1000)]], to: directory)
            try writeSlice(mirror(account, "ambiguous"), ["entries": [input("tied-a", -4000), input("tied-b", -4000), reply("tied-a", -2000)]], to: directory)
            try writeSlice(mirror(account, "future"), ["entries": [input("future", -3000), reply("future", 1000)]], to: directory)
            try writeSlice(mirror(account, "hidden"), ["entries": [reply("widget", -1000, type: "widget"),
                entry("draft", "message", timestamp: baseTime - 3000, extras: ["role": "assistant", "content": "INTERNAL"]),
            ]], to: directory)
            try writeSlice(mirror(account, "out-of-order"), ["entries": [reply("order", -2500), input("order", -1000)]], to: directory)
            try writeSlice(mirror(account, "explicit"), ["entries": [reply("inferred", -1000),
                entry("observed-active", "message", timestamp: baseTime - 2000, extras: ["role": "assistant", "isStreaming": true]),
            ]], to: directory)
            try writeSlice(mirror(account, "off-roster"), ["entries": [reply("off-roster", -1000)]], to: directory)
            try writeSlice(mirror("other-account", "stale"), ["entries": [reply("other-account", -1000)]], to: directory)

            let snapshot = GrokLocalSource.snapshot(at: directory, now: now)
            try check(runs("waitingRuns", snapshot).count == 1 && runs("activeRuns", snapshot).count == 1,
                      "A newer input and an explicit active round remain eligible")
            try check(runs("followupRuns", snapshot).isEmpty,
                      "Stale, ambiguous, superseded, hidden, future, out-of-order or out-of-scope deliveries never infer follow-up")
        }
    }

    private static func ignoresStaleAmbiguousOrInvalidBotActivity() throws {
        try withDirectory { directory in
            let account = "fixture-account"
            func input(_ request: String, _ offset: Int) -> [String: Any] {
                entry(request, "message", timestamp: baseTime + offset, extras: ["role": "user", "content": "INPUT"])
            }
            func assistant(_ request: String, _ offset: Int, _ flag: Any, role: String = "assistant") -> [String: Any] {
                entry(request, "message", timestamp: baseTime + offset, extras: ["role": role, "isStreaming": flag, "seq": 1])
            }
            try writeSlice(roster(account), ["rows": ["stale", "superseded", "ambiguous", "invalid", "tied", "future"].map {
                ["id": $0, "name": $0]
            }], to: directory)
            try writeSlice(mirror(account, "stale"), ["entries": [input("old-wait", -61_000), assistant("old-stream", -301_000, true)]], to: directory)
            try writeSlice(mirror(account, "superseded"), ["entries": [
                input("prior-incomplete", -2000), entry("new-reply", "send-message", timestamp: baseTime - 1000),
            ]], to: directory)
            try writeSlice(mirror(account, "ambiguous"), ["entries": [input("same-a", -1000), input("same-b", -1000)]], to: directory)
            try writeSlice(mirror(account, "invalid"), ["entries": [
                assistant("string-flag", -1000, "true"), assistant("number-flag", -1000, 1), assistant("wrong-role", -1000, true, role: "user"),
            ]], to: directory)
            try writeSlice(mirror(account, "tied"), ["entries": [assistant("contradiction", -1000, false), assistant("contradiction", -1000, true)]], to: directory)
            try writeSlice(mirror(account, "future"), ["entries": [input("future-input", 1000), assistant("future-stream", 1000, true)]], to: directory)
            try writeSlice(mirror(account, "off-roster"), ["entries": [assistant("other-bot", -1000, true)]], to: directory)
            try writeSlice(mirror("other-account", "tied"), ["entries": [assistant("other-account", -1000, true)]], to: directory)
            let snapshot = GrokLocalSource.snapshot(at: directory, now: now)
            try check(snapshot["status"] as? String == "connected", "Negative fixtures exercise the connected path")
            try check(runs("activeRuns", snapshot).isEmpty && runs("waitingRuns", snapshot).isEmpty, "Stale, superseded, ambiguous, malformed, future or out-of-scope observations stay idle")
        }
    }

    private static func groupsOnlyRosterMatches() throws {
        try withDirectory { directory in
            try writeSlice(roster("current"), ["rows": [
                ["id": "bot-a", "name": "A"],
                ["id": "bot-b", "name": "B"],
            ]], to: directory)
            try writeSlice(mirror("current", "bot-a"), ["entries": [
                entry("shared-request", "send-message", timestamp: baseTime + 2000, extras: ["message": ["text": "TEST-REPLY"]]),
                entry("shared-request", "message", timestamp: baseTime, extras: ["role": "user", "content": "TEST-PROMPT"]),
                entry("bot-request", "message", timestamp: baseTime + 300, extras: ["role": "user", "fromAgent": ["id": "private-other-bot"]]),
                entry(nil, "message", timestamp: baseTime + 720, extras: ["id": "entry-only"]),
                entry("wrong-time", "message", timestamp: true),
                entry("tool-not-part-of-view", "event", timestamp: baseTime),
            ]], to: directory)
            try writeSlice(mirror("current", "bot-b"), ["entries": [
                entry("shared-request", "send-message", timestamp: baseTime + 1000),
            ]], to: directory)
            try writeSlice(mirror("current", "deleted-bot"), ["entries": [
                entry("old-bot-request", "message", timestamp: baseTime + 4000),
            ]], to: directory)
            try writeSlice(mirror("signed-out", "bot-a"), ["entries": [
                entry("other-account-request", "message", timestamp: baseTime + 5000),
            ]], to: directory)
            let snapshot = GrokLocalSource.snapshot(at: directory, now: now)
            let events = eventsOf(snapshot)
            try check(snapshot["status"] as? String == "connected", "Connected")
            try check(snapshot["botCount"] as? Int == 2, "Only the roster's bots count")
            try check(snapshot["skippedCount"] as? Int == 2, "Ineligible request/time only")
            try check(events.count == 3, "Grouping and account isolation")
            try check(events.map { $0["agent"] as? String } == ["B", "A", "A"], "Ordered by event start")
            try check(Set(events.compactMap { $0["id"] as? String }).count == 3, "Stable ID per account, Bot and request")
            let agents = events.compactMap { $0["agentKey"] as? String }
            try check(agents.count == 3 && agents[0] != agents[1] && agents[1] == agents[2], "Opaque Bot keys group separate requests")
            try check(events[2]["title"] as? String == "用户发起的回合", "Observed user input")
            try check(events[1]["title"] as? String == "Bot 间对话回合", "Observed Bot input")
            try check(events.map { $0["trigger"] as? String } == ["observed", "bot", "person"], "Triggers match observed input evidence")
            try check(events.allSatisfy { $0["sourceAgentKey"] is NSNull }, "No source Bot inferred from missing roster match")
            try check(snapshot["latestEventAt"] as? String != events.first?["at"] as? String, "Latest observed entry distinct from event start")
            for event in events {
                try check(event["route"] is NSNull && event["status"] is NSNull, "No invented execution state")
                try check(event["inputTokens"] is NSNull && event["actualUsd"] is NSNull && event["requestId"] is NSNull, "No metric estimates or unredacted ID")
            }
            let encoded = try JSONSerialization.data(withJSONObject: snapshot)
            let output = String(decoding: encoded, as: UTF8.self)
            let disallowed = ["TEST-PROMPT", "TEST-REPLY", "private-other-bot", "shared-request", "bot-request", "entry-only", "bot-a", "bot-b", "deleted-bot", "old-bot-request", "signed-out", "other-account-request", "current"]
            try check(!disallowed.contains { output.contains($0) }, "Output excludes message text and private identifiers")
            let repeatSnapshot = GrokLocalSource.snapshot(at: directory, now: now)
            try check(eventsOf(repeatSnapshot).map { $0["id"] as? String } == events.map { $0["id"] as? String }, "Repeat scans emit stable IDs")
            let accountKey = snapshot["accountKey"] as? String
            try check(accountKey?.hasPrefix("local:") == true && repeatSnapshot["accountKey"] as? String == accountKey && !agents.contains(accountKey ?? ""), "Account key is stable, opaque and distinct from Bot keys")
        }
    }

    private static func identifiesOnlyUnambiguousBotSources() throws {
        try withDirectory { directory in
            let account = "fixture-account"
            let sender = "fixture-sender"
            let other = "fixture-other-bot"
            let receiver = "fixture-receiver"
            try writeSlice(roster(account), ["rows": [
                ["id": sender, "name": "来源"],
                ["id": other, "name": "备用"],
                ["id": receiver, "name": "接收"],
            ]], to: directory)
            func input(_ request: String, _ offset: Int, fromAgent: Any? = nil) -> [String: Any] {
                var value: [String: Any] = ["role": "user"]
                value["fromAgent"] = fromAgent
                return entry(request, "message", timestamp: baseTime + offset, extras: value)
            }
            try writeSlice(mirror(account, receiver), ["entries": [
                input("exact", 1, fromAgent: ["id": sender, "name": "PRIVATE-TRANSCRIPT-ALIAS"]),
                input("exact", 2, fromAgent: ["id": sender]),
                input("conflict", 10, fromAgent: ["id": sender]),
                input("conflict", 11, fromAgent: ["id": other]),
                input("mixed", 20, fromAgent: ["id": sender]),
                input("mixed", 21),
                input("missing", 30, fromAgent: ["id": sender]),
                input("missing", 31, fromAgent: ["name": "SENDER-WITHOUT-ID"]),
            ]], to: directory)
            let snapshot = GrokLocalSource.snapshot(at: directory, now: now)
            let bots = snapshot["bots"] as? [[String: String]] ?? []
            let senderKey = bots.first { $0["name"] == "来源" }?["key"]
            let events = eventsOf(snapshot)
            try check(bots.count == 3 && senderKey != nil, "Roster includes Bots without mirrored turns")
            try check(events.map { $0["trigger"] as? String } == ["bot", "observed", "bot", "bot"], "Mixed and incomplete inputs are classified without guessing")
            try check(events.dropLast().allSatisfy { $0["sourceAgentKey"] is NSNull }, "Opposing or missing IDs cannot identify a sender")
            try check(events.last?["sourceAgentKey"] as? String == senderKey, "Repeated exact roster matches identify the same sender")
            let encoded = try JSONSerialization.data(withJSONObject: snapshot)
            let output = String(decoding: encoded, as: UTF8.self)
            try check(![account, sender, other, receiver, "PRIVATE-TRANSCRIPT-ALIAS", "SENDER-WITHOUT-ID"].contains { output.contains($0) }, "Original roster and transcript identifiers stay private")
        }
    }

    private static func waitsOnMoreThanOneAccount() throws {
        try withDirectory { directory in
            try writeSlice(roster("one"), ["rows": [["id": "bot-a", "name": "A"]]], to: directory)
            try writeSlice(roster("two"), ["rows": [["id": "bot-b", "name": "B"]]], to: directory)
            try writeSlice(mirror("one", "bot-a"), ["entries": [entry("a", "message", timestamp: baseTime)]], to: directory)
            try writeSlice(mirror("two", "bot-b"), ["entries": [entry("b", "message", timestamp: baseTime)]], to: directory)
            let snapshot = GrokLocalSource.snapshot(at: directory, now: now)
            try check(snapshot["status"] as? String == "waiting" && snapshot["reason"] as? String == "multipleAccounts", "Multiple accounts state")
            try check(eventsOf(snapshot).isEmpty, "Do not guess the active account")
            try check(GrokLocalSource.currentAccount(at: directory) == nil, "Ambiguous roster cannot authorize handoff or ledger access")
        }
    }

    private static func observesOnlyUnambiguousUserHandoffs() throws {
        try withDirectory { directory in
            let account = "handoff-account"
            let bot = "handoff-receiver"
            let first = String(repeating: "a", count: 32)
            let second = String(repeating: "1", count: 32)
            let singleLine = String(repeating: "c", count: 32)
            try writeSlice(roster(account), ["rows": [["id": bot, "name": "接收"]]], to: directory)
            try writeSlice(mirror(account, bot), ["entries": [
                entry("valid", "message", timestamp: baseTime, extras: ["role": "user", "content": "[WB#\(first)]\r\nPRIVATE-HANDOFF-DRAFT"]),
                entry("valid", "send-message", timestamp: baseTime + 1, extras: ["message": ["text": "PRIVATE-BOT-ANSWER"]]),
                entry("bot-quote", "message", timestamp: baseTime + 2, extras: ["role": "user", "fromAgent": ["id": "sender"], "content": "[WB#\(second)]\nquoted"]),
                entry("assistant-quote", "message", timestamp: baseTime + 3, extras: ["role": "assistant", "content": "[WB#\(second)]\nquoted"]),
                entry("late", "message", timestamp: baseTime + 4, extras: ["role": "user", "content": "not first\n[WB#\(second)]"]),
                entry("suffix", "message", timestamp: baseTime + 5, extras: ["role": "user", "content": "[WB#\(second)]invalid-boundary"]),
                entry("mixed-markers", "message", timestamp: baseTime + 6, extras: ["role": "user", "content": "[WB#\(first)]\nconflicting"]),
                entry("mixed-markers", "message", timestamp: baseTime + 7, extras: ["role": "user", "content": "[WB#\(second)]\nconflicting"]),
                entry("mixed-senders", "message", timestamp: baseTime + 8, extras: ["role": "user", "content": "[WB#\(second)]\nconflicting"]),
                entry("mixed-senders", "message", timestamp: baseTime + 9, extras: ["role": "user", "fromAgent": ["id": "sender"]]),
                entry("single-line", "message", timestamp: baseTime + 10, extras: ["role": "user", "content": "[WB#\(singleLine)] PRIVATE-SINGLE-LINE"]),
            ]], to: directory)
            let snapshot = GrokLocalSource.snapshot(at: directory, now: now)
            let confirmed = eventsOf(snapshot).filter { $0["handoffId"] is String }
            let receipts = Set(confirmed.compactMap { $0["handoffId"] as? String })
            try check(confirmed.count == 2 && receipts == Set([first, singleLine]), "Only unambiguous leading user handoff markers are confirmed")
            let withReply = confirmed.first { $0["handoffId"] as? String == first }
            try check(withReply?["hasBotOutput"] as? Bool == true, "Evidence of output accompanies the receipt")
            let encoded = try JSONSerialization.data(withJSONObject: snapshot)
            let serialized = String(decoding: encoded, as: UTF8.self)
            try check(!["PRIVATE-HANDOFF-DRAFT", "PRIVATE-SINGLE-LINE", "PRIVATE-BOT-ANSWER", account, bot, second].contains { serialized.contains($0) }, "Snapshot exports the receipt token without message contents or invalid markers")
        }
    }

    private static func acceptsOnlyExactInitialHandoffMarkers() throws {
        let token = String(repeating: "a", count: 32)
        let marker = "[WB#\(token)]"
        for line in [marker, marker + " Reply only OK.", marker + "\nReply only OK.", marker + "\r\nReply only OK."] {
            try check(GrokLocalSource.handoffID(in: line) == token, "Exact leading marker recognizes current and historical separators")
        }
        for line in [" " + marker, "quoted " + marker, "line\n" + marker, marker + "/suffix", marker + "\tmessage",
                     marker + "\u{00a0}message", marker + "\rmessage", marker.uppercased()] {
            try check(GrokLocalSource.handoffID(in: line) == nil, "A shifted, quoted, or improperly separated marker cannot confirm an event")
        }
    }

    private static func timesOnlyTextualRepliesWithKnownInput() throws {
        try withDirectory { directory in
            try writeSlice(roster("fixture"), ["rows": [["id": "bot-a", "name": "试验"]]], to: directory)
            let marker = String(repeating: "a", count: 32)
            try writeSlice(mirror("fixture", "bot-a"), ["entries": [
                entry("timed", "send-message", timestamp: baseTime + 2410, extras: ["message": ["content": "PRIVATE-SECOND-REPLY"]]),
                entry("timed", "message", timestamp: baseTime + 180, extras: ["role": "user", "content": "PRIVATE-FOLLOWUP"]),
                entry("timed", "message", timestamp: baseTime + 210, extras: ["role": "assistant", "content": " \n "]),
                entry("timed", "message", timestamp: baseTime + 1010, extras: ["role": "assistant", "content": "PRIVATE-FIRST-REPLY"]),
                entry("timed", "message", timestamp: baseTime + 10, extras: ["role": "user", "content": "[WB#\(marker)]\nPRIVATE-REQUEST"]),
                entry("placeholder", "message", timestamp: baseTime + 4000, extras: ["role": "user", "content": "PRIVATE-REQUEST"]),
                entry("placeholder", "message", timestamp: baseTime + 4300, extras: ["role": "assistant", "content": ["type": "tool"]]),
                entry("placeholder", "send-message", timestamp: baseTime + 4400),
                entry("without-input-time", "message", timestamp: "unknown", extras: ["role": "user", "content": "PRIVATE-REQUEST"]),
                entry("without-input-time", "send-message", timestamp: baseTime + 5500, extras: ["message": ["content": "PRIVATE-REPLY"]]),
                entry("out-of-order", "send-message", timestamp: baseTime + 7000, extras: ["message": ["content": "PRIVATE-REPLY"]]),
                entry("out-of-order", "message", timestamp: baseTime + 7100, extras: ["role": "user", "content": "PRIVATE-REQUEST"]),
            ]], to: directory)
            let snapshot = GrokLocalSource.snapshot(at: directory, now: now)
            let events = eventsOf(snapshot)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            func time(_ offset: Int) -> String {
                formatter.string(from: Date(timeIntervalSince1970: Double(baseTime + offset) / 1000))
            }
            let timed = events.first { $0["handoffId"] as? String == marker }
            try check(timed?["replyAt"] as? String == time(1010) && timed?["latencyMs"] as? Double == 1000, "First visible reply and first valid input determine timing")
            try check(timed?["hasBotOutput"] as? Bool == true, "A visible reply supplies output evidence")
            let placeholder = events.first { $0["at"] as? String == time(4000) }
            try check(placeholder?["hasBotOutput"] as? Bool == true && placeholder?["replyAt"] is NSNull && placeholder?["latencyMs"] is NSNull, "Blank and nontext entries preserve output evidence without inventing reply timing")
            let missing = events.first { $0["at"] as? String == time(5500) }
            try check(missing?["replyAt"] as? String == time(5500) && missing?["latencyMs"] is NSNull, "A reply with no valid input time has no latency")
            let outOfOrder = events.first { $0["at"] as? String == time(7000) }
            try check(outOfOrder?["replyAt"] as? String == time(7000) && outOfOrder?["latencyMs"] is NSNull, "Reply before input cannot establish latency")
            let encoded = try JSONSerialization.data(withJSONObject: snapshot)
            try check(!String(decoding: encoded, as: UTF8.self).contains("PRIVATE-"), "Timing output contains no message contents")
        }
    }

    private static func tracksLatestDeliveredReplyWithinOneRequest() throws {
        try withDirectory { directory in
            let account = "editor-fixture"
            let bot = "editor-bot"
            let request = "editor-request"
            let file = mirror(account, bot)
            let input = entry(request, "message", timestamp: baseTime - 15_000, extras: ["role": "user", "content": "PRIVATE-INPUT"])
            let first = entry(request, "send-message", timestamp: baseTime - 12_000, extras: ["message": ["content": "PRIVATE-FIRST"]])
            let second = entry(request, "send-message", timestamp: baseTime - 9000, extras: ["message": ["type": "text", "text": "PRIVATE-SECOND"]])
            let newest = entry(request, "send-message", timestamp: baseTime - 6000, extras: ["message": ["type": "text", "content": "PRIVATE-NEWEST"]])
            let internalMessage = entry(request, "message", timestamp: baseTime - 3000, extras: ["role": "assistant", "content": "PRIVATE-INTERNAL"])
            let nonText = entry(request, "send-message", timestamp: baseTime - 2000, extras: ["message": ["type": "widget", "text": "PRIVATE-WIDGET"]])
            let whitespace = entry(request, "send-message", timestamp: baseTime - 1000, extras: ["message": ["content": " \n "]])
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

            try writeSlice(roster(account), ["rows": [["id": bot, "name": "文档主编"]]], to: directory)
            try writeSlice(file, ["entries": [input]], to: directory)
            let noReply = eventsOf(GrokLocalSource.snapshot(at: directory, now: now))
            try check(noReply.count == 1 && noReply[0]["lastReplyAt"] as? String == nil, "Input alone does not imply a delivered reply")
            try writeSlice(file, ["entries": [first, input]], to: directory)
            let firstReply = eventsOf(GrokLocalSource.snapshot(at: directory, now: now))
            try check(firstReply.count == 1 && firstReply[0]["replyAt"] as? String == formatter.string(from: now.addingTimeInterval(-12)), "An initial visible reply supplies its delivery time")
            try writeSlice(file, ["entries": [input, newest, nonText, first, internalMessage, second, whitespace]], to: directory)
            let snapshot = GrokLocalSource.snapshot(at: directory, now: now)
            let allReplies = eventsOf(snapshot)
            try check(allReplies.count == 1 && allReplies[0]["id"] as? String == firstReply[0]["id"] as? String, "Later replies retain their original event ID and row")
            try check(allReplies[0]["lastReplyAt"] as? String == formatter.string(from: now.addingTimeInterval(-6)), "Only the most recent visible text delivery advances reply activity")
            try check(allReplies[0]["replyAt"] as? String == firstReply[0]["replyAt"] as? String && allReplies[0]["latencyMs"] as? Double == 3000, "First reply and latency remain unchanged")
            let encoded = try JSONSerialization.data(withJSONObject: snapshot)
            let published = String(decoding: encoded, as: UTF8.self)
            try check(!["PRIVATE-FIRST", "PRIVATE-SECOND", "PRIVATE-NEWEST", "PRIVATE-INTERNAL", "PRIVATE-WIDGET"].contains(where: published.contains),
                      "Reply activity does not preview delivered text or hidden output")
        }
    }

    private static func detectsBotsBeforeTheirTranscriptAppears() throws {
        try withDirectory { directory in
            let account = "roster-first-account"
            let original = ["id": "bot-original", "name": "原有 Bot"]
            let new = ["id": "bot-new", "name": "文档主编"]
            try writeSlice(roster(account), ["rows": [original]], to: directory)
            try writeSlice(mirror("another-account", "bot-original"), ["entries": [entry("foreign", "message", timestamp: baseTime)]], to: directory)
            let rosterOnly = GrokLocalSource.snapshot(at: directory, now: now)
            let firstRoster = (rosterOnly["bots"] as? [[String: String]]) ?? []
            try check(rosterOnly["status"] as? String == "connected" && firstRoster.count == 1, "The current roster is connected before any of its transcripts appear")
            try check(eventsOf(rosterOnly).isEmpty && runs("activeRuns", rosterOnly).isEmpty, "No activity can be borrowed from a different account")

            try writeSlice(mirror(account, "bot-original"), ["entries": [entry("ordinary", "message", timestamp: baseTime)]], to: directory)
            try writeSlice(roster(account), ["rows": [original, new]], to: directory)
            let updated = GrokLocalSource.snapshot(at: directory, now: now)
            let updatedRoster = (updated["bots"] as? [[String: String]]) ?? []
            try check(updated["accountKey"] as? String == rosterOnly["accountKey"] as? String && updatedRoster.contains(firstRoster[0]), "Roster refresh preserves existing opaque account and Bot identity")
            try check(Set(updatedRoster.compactMap { $0["name"] }) == ["原有 Bot", "文档主编"] && eventsOf(updated).count == 1, "An added Bot is visible immediately without a transcript or synthetic event")
        }
    }

    private static func readsVisibleConversationOnlyForSelectedEvent() throws {
        try withDirectory { directory in
            try writeSlice(roster("fixture"), ["rows": [
                ["id": "bot-a", "name": "测试"], ["id": "bot-b", "name": "其他"],
            ]], to: directory)
            try writeSlice(mirror("fixture", "bot-a"), ["entries": [
                entry("wanted", "send-message", timestamp: baseTime + 80, extras: ["message": ["type": "text", "content": "Second"]]),
                entry("wanted", "message", timestamp: baseTime, extras: ["role": "user", "content": "示例问题\n第二行"]),
                entry("wanted", "message", timestamp: baseTime, extras: ["role": "user", "content": "示例问题\n第二行", "fromAgent": NSNull()]),
                entry("wanted", "message", timestamp: baseTime + 2, extras: ["role": "user", "content": "PRIVATE-BOT-INPUT", "fromAgent": ["id": "bot-b"]]),
                entry("wanted", "message", timestamp: baseTime + 3, extras: ["role": "user", "content": "PRIVATE-MALFORMED-SENDER", "fromAgent": false]),
                entry("wanted", "message", timestamp: baseTime + 4, extras: ["role": "assistant", "content": "PRIVATE-ASSISTANT-DRAFT"]),
                entry("wanted", "message", timestamp: baseTime + 5, extras: ["role": "user", "content": " \n "]),
                entry("wanted", "send-message", timestamp: baseTime + 6, extras: ["message": ["type": "widget", "text": "PRIVATE-WIDGET"]]),
                entry("wanted", "tool-output", timestamp: baseTime + 7, extras: ["role": "user", "content": "PRIVATE-FORGED-INPUT"]),
                entry("wanted", "send-message", timestamp: baseTime + 9, extras: ["message": ["type": "text", "content": " \n "]]),
                entry("wanted", "send-message", timestamp: baseTime + 10, extras: ["message": ["text": "First"]]),
                entry("wanted", "send-message", timestamp: baseTime + 18, extras: ["message": ["type": "text", "content": "First"]]),
                entry("wanted", "send-message", timestamp: baseTime + 10, extras: ["message": ["type": "text", "content": "First"]]),
                entry("wanted", "message", timestamp: baseTime + 18, extras: ["role": "user", "content": "First", "fromAgent": NSNull()]),
                entry("wanted", "send-message", timestamp: true, extras: ["message": ["type": "text", "content": "INVALID-TIME"]]),
                entry("other-request", "send-message", timestamp: baseTime + 100, extras: ["message": ["type": "text", "content": "PRIVATE-OTHER-REQUEST"]]),
                entry("other-request", "message", timestamp: baseTime + 101, extras: ["role": "user", "content": "PRIVATE-OTHER-REQUEST-INPUT"]),
                entry("incomplete", "message", timestamp: baseTime + 180, extras: ["role": "user", "content": "PRIVATE-INPUT"]),
            ]], to: directory)
            try writeSlice(mirror("fixture", "bot-b"), ["entries": [
                entry("wanted", "send-message", timestamp: baseTime + 200, extras: ["message": ["type": "text", "content": "PRIVATE-OTHER-BOT"]]),
            ]], to: directory)
            let snapshot = GrokLocalSource.snapshot(at: directory, now: now)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            func formatted(_ offset: Int) -> String {
                formatter.string(from: Date(timeIntervalSince1970: Double(baseTime + offset) / 1000))
            }
            let events = eventsOf(snapshot)
            guard let account = snapshot["accountKey"] as? String,
                  let event = events.first(where: { $0["at"] as? String == formatted(0) }),
                  let observed = event["id"] as? String, let bot = event["agentKey"] as? String,
                  let incomplete = events.first(where: { $0["at"] as? String == formatted(180) })?["id"] as? String
            else { throw AssertionFailure(explanation: "Conversation fixtures should produce opaque event and Bot keys") }
            let conversation = try GrokLocalSource.visibleConversation(accountKey: account, botKey: bot, observedId: observed, at: directory)
            try check(conversation.items.map(\.text) == ["示例问题\n第二行", "First", "First", "First", "Second"], "Copies collapse within a role and timestamp while identical text at other times or from other roles remains visible")
            try check(conversation.items.map(\.role) == [.user, .assistant, .assistant, .user, .assistant], "Only the corresponding human prompts and delivered responses appear")
            try check(conversation.items.map(\.at) == [formatted(0), formatted(10), formatted(18), formatted(18), formatted(80)] && !conversation.truncated, "Messages retain their text and chronological order")
            let noReply = try GrokLocalSource.visibleConversation(accountKey: account, botKey: bot, observedId: incomplete, at: directory)
            try check(noReply.items.map(\.text) == ["PRIVATE-INPUT"] && noReply.items.map(\.role) == [.user] && !noReply.truncated, "The question is visible before a reply arrives")
            let summary = try JSONSerialization.data(withJSONObject: snapshot)
            let encoded = String(decoding: summary, as: UTF8.self)
            try check(!encoded.contains("PRIVATE-") && !encoded.contains("Second") && !encoded.contains("示例问题"), "Polling snapshots still exclude conversation text")
        }
    }

    private static func rejectsMismatchedConversationScope() throws {
        try withDirectory { directory in
            try writeSlice(roster("fixture"), ["rows": [["id": "bot-a", "name": "甲"], ["id": "bot-b", "name": "乙"]]], to: directory)
            let firstMirror = try writeSlice(mirror("fixture", "bot-a"), ["entries": [
                entry("same-request", "send-message", timestamp: baseTime, extras: ["message": ["text": "A"]]),
            ]], to: directory)
            let secondMirror = try writeSlice(mirror("fixture", "bot-b"), ["entries": [
                entry("same-request", "send-message", timestamp: baseTime + 10, extras: ["message": ["text": "B"]]),
            ]], to: directory)
            let snapshot = GrokLocalSource.snapshot(at: directory, now: now)
            let events = eventsOf(snapshot)
            guard let account = snapshot["accountKey"] as? String,
                  let first = events.first(where: { $0["agent"] as? String == "甲" }),
                  let firstKey = first["agentKey"] as? String, let event = first["id"] as? String,
                  let secondKey = events.first(where: { $0["agent"] as? String == "乙" })?["agentKey"] as? String
            else { throw AssertionFailure(explanation: "Scoped reply fixtures should produce opaque IDs") }
            do {
                _ = try GrokLocalSource.visibleConversation(accountKey: secondKey, botKey: firstKey, observedId: event, at: directory)
                throw AssertionFailure(explanation: "A mismatched account key was accepted")
            } catch GrokLocalSource.ConversationError.accountUnavailable {}
            do {
                _ = try GrokLocalSource.visibleConversation(accountKey: account, botKey: secondKey, observedId: event, at: directory)
                throw AssertionFailure(explanation: "An event from another Bot was accepted")
            } catch GrokLocalSource.ConversationError.eventUnavailable {}
            try FileManager.default.removeItem(at: firstMirror)
            try FileManager.default.createSymbolicLink(at: firstMirror, withDestinationURL: secondMirror)
            do {
                _ = try GrokLocalSource.visibleConversation(accountKey: account, botKey: firstKey, observedId: event, at: directory)
                throw AssertionFailure(explanation: "A linked transcript file was read")
            } catch GrokLocalSource.ConversationError.eventUnavailable {}
            try writeSlice(roster("other-account"), ["rows": [["id": "bot-c", "name": "丙"]]], to: directory)
            do {
                _ = try GrokLocalSource.visibleConversation(accountKey: account, botKey: firstKey, observedId: event, at: directory)
                throw AssertionFailure(explanation: "An ambiguous current account was accepted")
            } catch GrokLocalSource.ConversationError.accountUnavailable {}
        }
    }

    private static func capsConversationPerRoleAtValidUnicodeBoundary() throws {
        try withDirectory { directory in
            try writeSlice(roster("fixture"), ["rows": [["id": "bot-a", "name": "甲"]]], to: directory)
            let many = (0..<70).map { index in
                entry("many", "send-message", timestamp: baseTime + 20 + index, extras: ["message": ["text": String(index)]])
            }
            try writeSlice(mirror("fixture", "bot-a"), ["entries": [
                entry("large", "send-message", timestamp: baseTime, extras: ["message": ["text": "A"]]),
                entry("large", "send-message", timestamp: baseTime + 10, extras: [
                    "message": ["text": String(repeating: "😀", count: 13_000)],
                ]),
                entry("large", "message", timestamp: baseTime - 3, extras: ["role": "user", "content": "首问 A"]),
                entry("large", "message", timestamp: baseTime - 2, extras: ["role": "user", "content": String(repeating: "字", count: 17_000)]),
                entry("large", "message", timestamp: baseTime - 1, extras: ["role": "user", "content": "over-limit"]),
                entry("many", "message", timestamp: baseTime + 100, extras: ["role": "user", "content": "Follow-up after reply count is reached"]),
            ] + many], to: directory)
            let snapshot = GrokLocalSource.snapshot(at: directory, now: now)
            let events = eventsOf(snapshot)
            guard let account = snapshot["accountKey"] as? String,
                  let bot = events.first?["agentKey"] as? String,
                  let manyEvent = events.first?["id"] as? String,
                  let largeEvent = events.last?["id"] as? String
            else { throw AssertionFailure(explanation: "Bounded transfer fixtures should produce opaque IDs") }
            let large = try GrokLocalSource.visibleConversation(accountKey: account, botKey: bot, observedId: largeEvent, at: directory)
            let loaded = large.items.filter { $0.role == .assistant }.map(\.text)
            let prompts = large.items.filter { $0.role == .user }.map(\.text)
            let totalPromptCharacters = (48 * 1024 - "首问 A".utf8.count) / "字".utf8.count
            try check(prompts == ["首问 A", String(repeating: "字", count: totalPromptCharacters)], "A large prompt clips at a valid scalar boundary without consuming the reply budget")
            try check(large.truncated && loaded.count == 2 && loaded.last == String(repeating: "😀", count: 12_287), "Byte cap clips at a complete Unicode scalar")
            try check(loaded.reduce(0) { $0 + $1.utf8.count } <= 48 * 1024, "Whole reply response stays within the byte cap")
            let messages = try GrokLocalSource.visibleConversation(accountKey: account, botKey: bot, observedId: manyEvent, at: directory)
            try check(messages.truncated && messages.items.map(\.text) == (0..<64).map(String.init) + ["Follow-up after reply count is reached"], "The reply cap preserves chronological order and does not hide a later prompt")
        }
    }

    private static func opensOnlyAccountRosterTargets() throws {
        try withDirectory { directory in
            let bot = "fixture+bot/?id="
            let token = String(repeating: "d", count: 32)
            let message = "[WB#\(token)] 用 + & # 和 换行 复核。"
            try writeSlice(roster("fixture"), ["rows": [["id": bot, "name": "审阅"]]], to: directory)
            guard let account = GrokLocalSource.currentAccount(at: directory),
                  let target = account.botIDsByKey.first?.key
            else { throw AssertionFailure(explanation: "Current roster can be read for a Bot with no mirrored turns") }
            var body: [String: Any] = [
                "accountKey": account.key, "targetKey": target, "eventId": token, "text": message,
                "url": "file:///private/tmp/irrelevant",
            ]
            let prepared = WorkbenchHandoff(body)?.url(for: account)
            let url = prepared.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
            try check(url?.scheme == "grokbot" && url?.host == "app" && url?.path == "/v1/prompt", "Destination is pinned to the official deep link")
            try check(url?.queryItems == [URLQueryItem(name: "id", value: bot), URLQueryItem(name: "text", value: message)], "Bot identifier and exact text round-trip through URLComponents")
            let expectedQuery = "id=fixture%2Bbot%2F%3Fid%3D&text=%5BWB%23\(token)%5D%20%E7%94%A8%20%2B%20%26%20%23%20%E5%92%8C%20%E6%8D%A2%E8%A1%8C%20%E5%A4%8D%E6%A0%B8%E3%80%82"
            try check(url?.percentEncodedQuery == expectedQuery, "Each query value percent-encodes every byte outside RFC 3986 unreserved characters")
            body["text"] = "[WB#\(token)]\r\n用 + & # 和 换行\n复核。"
            try check(WorkbenchHandoff(body)?.url(for: account) == prepared, "Historical multiline input is sent through the same single-line URL format")
            body["targetKey"] = "local:" + String(repeating: "b", count: 32)
            try check(WorkbenchHandoff(body)?.url(for: account) == nil, "A stale or invented opaque Bot key cannot route")
            body["targetKey"] = target
            body["accountKey"] = "local:" + String(repeating: "c", count: 32)
            try check(WorkbenchHandoff(body)?.url(for: account) == nil, "An opaque key from another account cannot route")
            body["accountKey"] = account.key
            body["text"] = "[WB#\(token)]\n "
            try check(WorkbenchHandoff(body) == nil, "Marker without content is rejected")
            body["text"] = "[WB#\(token)]\n" + String(repeating: "😀", count: 502)
            try check(WorkbenchHandoff(body) == nil, "The trusted bridge enforces the message-length limit")
        }
    }

    private static func storesPrivateAccountLedgers() throws {
        try withDirectory { directory in
            let firstSuffix = String(repeating: "a", count: 32)
            let first = "local:" + firstSuffix
            let second = "local:" + String(repeating: "b", count: 32)
            let ledger = WorkbenchLedger(supportDirectory: directory)
            let missing = try ledger.load(accountKey: first)
            try check(missing == nil, "Absent ledger loads as null")
            try ledger.save("{\"events\":[1]}", accountKey: first)
            try ledger.save("{\"events\":[2]}", accountKey: second)
            try ledger.save("{\"events\":[3]}", accountKey: first)
            let updated = try ledger.load(accountKey: first)
            let separate = try ledger.load(accountKey: second)
            try check(updated == "{\"events\":[3]}" && separate == "{\"events\":[2]}", "Replacements are durable and scoped by account")

            let root = directory.appendingPathComponent("local.grokbot.workbench", isDirectory: true)
            let file = root.appendingPathComponent("events-\(firstSuffix).json")
            let storageMode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
            try check(storageMode?.uintValue == 0o600, "Event ledger contents are private to the current user")
            do {
                try ledger.save("invalid", accountKey: first)
                throw AssertionFailure(explanation: "Malformed JSON was saved")
            } catch WorkbenchLedger.StorageError.invalidData {}
            do {
                try ledger.save("[]", accountKey: "local:../../unsafe")
                throw AssertionFailure(explanation: "Invalid account was accepted")
            } catch WorkbenchLedger.StorageError.invalidAccount {}

            let outside = directory.appendingPathComponent("sentinel.json")
            try Data("[]".utf8).write(to: outside)
            try FileManager.default.removeItem(at: file)
            try FileManager.default.createSymbolicLink(at: file, withDestinationURL: outside)
            do {
                _ = try ledger.load(accountKey: first)
                throw AssertionFailure(explanation: "Symlink payload was read")
            } catch WorkbenchLedger.StorageError.inaccessibleFile {}
            do {
                try ledger.save("[1]", accountKey: first)
                throw AssertionFailure(explanation: "Symlink destination was overwritten")
            } catch WorkbenchLedger.StorageError.inaccessibleFile {}
            let intact = try String(contentsOf: outside, encoding: .utf8)
            try check(intact == "[]", "Unexpected ledger targets stay untouched")
        }
    }

    private static func ignoresUnusableMirrors() throws {
        try withDirectory { directory in
            let sourceData = ["entries": [entry("outside-request", "message", timestamp: baseTime)]]
            let actualFile = try writeSlice("unrelated-file", sourceData, to: directory)
            try writeSlice(roster("one"), ["rows": [
                ["id": "safe", "name": "Safe"], ["id": "linked", "name": "Link"], ["id": "large", "name": "Large"],
            ]], to: directory)
            try writeSlice(mirror("one", "safe"), ["entries": [entry("known-request", "message", timestamp: baseTime)]], to: directory)
            let link = blobURL(mirror("one", "linked"), in: directory)
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: actualFile)
            let large = blobURL(mirror("one", "large"), in: directory)
            try Data(count: 8 * 1024 * 1024 + 1).write(to: large)
            let snapshot = GrokLocalSource.snapshot(at: directory, now: now)
            try check(snapshot["status"] as? String == "connected", "Usable mirrors remain visible")
            try check(snapshot["skippedCount"] as? Int == 2, "Oversized file and symlink skipped")
            try check(eventsOf(snapshot).map { $0["agent"] as? String } == ["Safe"], "Only regular in-bounds matching slice parsed")
        }
    }

    private static func entry(_ request: String?, _ kind: String, timestamp: Any, extras: [String: Any] = [:]) -> [String: Any] {
        var value = extras
        value["kind"] = kind
        value["timestampMs"] = timestamp
        value["requestId"] = request
        return value
    }

    private static func eventsOf(_ snapshot: [String: Any]) -> [[String: Any]] {
        snapshot["events"] as? [[String: Any]] ?? []
    }

    private static func runs(_ key: String, _ snapshot: [String: Any]) -> [[String: String]] {
        snapshot[key] as? [[String: String]] ?? []
    }

    private static func roster(_ account: String) -> String {
        "sand.client.slice.account.\(account).roster.last-roster"
    }

    private static func mirror(_ account: String, _ bot: String) -> String {
        "sand.client.slice.account.\(account).transcript.replicas.\(bot)"
    }

    private static func blobURL(_ key: String, in root: URL) -> URL {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567")
        var output = ""
        var buffer = 0
        var bits = 0
        for byte in key.utf8 {
            buffer = (buffer << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                bits -= 5
                output.append(alphabet[(buffer >> bits) & 31])
            }
            buffer &= (1 << bits) - 1
        }
        if bits > 0 { output.append(alphabet[(buffer << (5 - bits)) & 31]) }
        return root.appendingPathComponent("\(output).blob")
    }

    @discardableResult
    private static func writeSlice(_ key: String, _ value: [String: Any], schemaVersion: Int = 1, to root: URL) throws -> URL {
        let url = blobURL(key, in: root)
        let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": schemaVersion, "value": value])
        try data.write(to: url)
        return url
    }

    private static func withDirectory(_ run: (URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("grok-source-test-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        try run(root)
    }

    private struct AssertionFailure: Error {
        let explanation: String
    }

    private static func check(_ asserted: @autoclosure () -> Bool, _ explanation: String) throws {
        guard asserted() else { throw AssertionFailure(explanation: explanation) }
    }
}
