import Darwin
import Foundation

enum WorkbenchLanguage: String {
    case chinese = "zh-CN"
    case english = "en"

    private static let preferenceKey = "workbenchLanguage"

    static var current: Self {
        if let preference = UserDefaults.standard.string(forKey: preferenceKey),
           let language = Self(rawValue: preference) {
            return language
        }
        return Locale.preferredLanguages.first?.lowercased().hasPrefix("zh") == true ? .chinese : .english
    }

    func save() {
        UserDefaults.standard.set(rawValue, forKey: Self.preferenceKey)
    }

    static func text(_ chinese: String, _ english: String) -> String {
        current == .chinese ? chinese : english
    }
}

struct WorkbenchHandoff {
    private static let queryUnreserved = CharacterSet(charactersIn:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    )

    let accountKey: String
    let targetKey: String
    let eventID: String
    let text: String

    init?(_ body: [String: Any]) {
        guard let accountKey = body["accountKey"] as? String, Self.isOpaqueKey(accountKey),
              let targetKey = body["targetKey"] as? String, Self.isOpaqueKey(targetKey),
              let eventID = body["eventId"] as? String,
              let text = body["text"] as? String, text.utf16.count <= 1000,
              GrokLocalSource.handoffID(in: text) == eventID,
              text.dropFirst("[WB#\(eventID)]".count).contains(where: { !$0.isWhitespace }),
              !text.utf8.contains(0)
        else { return nil }
        self.accountKey = accountKey
        self.targetKey = targetKey
        self.eventID = eventID
        self.text = text.split(whereSeparator: \.isNewline).joined(separator: " ")
    }

    func url(for account: GrokLocalSource.Account) -> URL? {
        guard account.key == accountKey, let botID = account.botIDsByKey[targetKey],
              let encodedID = botID.addingPercentEncoding(withAllowedCharacters: Self.queryUnreserved),
              let encodedText = text.addingPercentEncoding(withAllowedCharacters: Self.queryUnreserved)
        else { return nil }
        var parts = URLComponents()
        parts.scheme = "grokbot"
        parts.host = "app"
        parts.path = "/v1/prompt"
        parts.percentEncodedQuery = "id=\(encodedID)&text=\(encodedText)"
        return parts.url
    }

    static func isOpaqueKey(_ key: String) -> Bool {
        let prefix = "local:"
        return key.utf8.count == prefix.utf8.count + 32 && key.hasPrefix(prefix) &&
            key.utf8.dropFirst(prefix.utf8.count).allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
}

struct WorkbenchLedger {
    static let maximumBytes = 4 * 1024 * 1024
    private static let folder = "local.grokbot.workbench"
    let supportDirectory: URL

    init(supportDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support", isDirectory: true)) {
        self.supportDirectory = supportDirectory
    }

    enum StorageError: LocalizedError {
        case invalidAccount, invalidData, inaccessibleDirectory, inaccessibleFile

        var errorDescription: String? {
            switch self {
            case .invalidAccount:
                return WorkbenchLanguage.text("当前 Grok Bot 账号已变更，请刷新后重试。", "The Grok Bot account changed. Refresh and try again.")
            case .invalidData:
                return WorkbenchLanguage.text("事件日志格式无效或超过 4 MB。", "The event log is invalid or exceeds 4 MB.")
            case .inaccessibleDirectory:
                return WorkbenchLanguage.text("无法访问本机事件日志目录。", "The local event log folder is inaccessible.")
            case .inaccessibleFile:
                return WorkbenchLanguage.text("无法安全读取或保存本机事件日志。", "Could not safely read or save the local event log.")
            }
        }
    }

    func load(accountKey: String) throws -> String? {
        let filename = try filename(for: accountKey)
        guard let directory = try openDirectory(create: false) else { return nil }
        defer { Darwin.close(directory) }

        let descriptor = openat(directory, filename, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if descriptor < 0 && errno == ENOENT { return nil }
        guard descriptor >= 0 else { throw StorageError.inaccessibleFile }
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? file.close() }

        var info = stat()
        guard fstat(descriptor, &info) == 0, Self.isPrivateFile(info),
              info.st_size > 0, info.st_size <= Self.maximumBytes,
              let bytes = try file.read(upToCount: Self.maximumBytes + 1),
              bytes.count == info.st_size,
              let data = String(data: bytes, encoding: .utf8)
        else { throw StorageError.inaccessibleFile }
        return data
    }

    func save(_ data: String, accountKey: String) throws {
        let filename = try filename(for: accountKey)
        guard !data.isEmpty, data.utf8.count <= Self.maximumBytes else { throw StorageError.invalidData }
        let bytes = Data(data.utf8)
        guard (try? JSONSerialization.jsonObject(with: bytes)) != nil else { throw StorageError.invalidData }
        guard let directory = try openDirectory(create: true) else { throw StorageError.inaccessibleDirectory }
        defer { Darwin.close(directory) }

        var existing = stat()
        let probe = fstatat(directory, filename, &existing, AT_SYMLINK_NOFOLLOW)
        guard probe == 0 ? Self.isPrivateFile(existing) : errno == ENOENT else {
            throw StorageError.inaccessibleFile
        }

        let temporaryName = ".events-\(UUID().uuidString).tmp"
        let descriptor = openat(directory, temporaryName, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw StorageError.inaccessibleFile }
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer {
            try? file.close()
            unlinkat(directory, temporaryName, 0)
        }

        do {
            try file.write(contentsOf: bytes)
            try file.synchronize()
        } catch {
            throw StorageError.inaccessibleFile
        }
        guard renameat(directory, temporaryName, directory, filename) == 0 else {
            throw StorageError.inaccessibleFile
        }
    }

    private func filename(for accountKey: String) throws -> String {
        guard WorkbenchHandoff.isOpaqueKey(accountKey) else { throw StorageError.invalidAccount }
        return "events-\(accountKey.dropFirst("local:".count)).json"
    }

    private func openDirectory(create: Bool) throws -> Int32? {
        let parent = Darwin.open(supportDirectory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw StorageError.inaccessibleDirectory }
        defer { Darwin.close(parent) }

        if create && mkdirat(parent, Self.folder, 0o700) != 0 && errno != EEXIST {
            throw StorageError.inaccessibleDirectory
        }
        let directory = openat(parent, Self.folder, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if directory < 0 && errno == ENOENT && !create { return nil }
        guard directory >= 0 else { throw StorageError.inaccessibleDirectory }
        var info = stat()
        guard fstat(directory, &info) == 0, info.st_uid == geteuid(), (info.st_mode & 0o077) == 0 else {
            Darwin.close(directory)
            throw StorageError.inaccessibleDirectory
        }
        return directory
    }

    private static func isPrivateFile(_ info: stat) -> Bool {
        (info.st_mode & S_IFMT) == S_IFREG && info.st_uid == geteuid() && (info.st_mode & 0o077) == 0
    }
}
