import Foundation
import WidgetKit

enum UsageWidgetShared {
    static let appGroup = "group.me.eiaserinnys.soulstream"
    static let kind = "UsageWidget"
    static let serverURLKey = "usageWidget.serverURL"
    static let authTokenKey = "usageWidget.authToken"
    static let lastSummaryKey = "usageWidget.lastSummary"
    static let selectedNodeKey = "usageWidget.selectedNode"
    static let configuredNodeKey = "usageWidget.configuredNode"

    static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroup)
    }

    static func cachedSummary() -> UsageSummary? {
        guard let data = defaults?.data(forKey: lastSummaryKey) else { return nil }
        return try? JSONDecoder().decode(UsageSummary.self, from: data)
    }

    static func cache(data: Data) {
        defaults?.set(data, forKey: lastSummaryKey)
    }

    static func selectedNode(in summary: UsageSummary, configuredNodeID: String?) -> UsageSummaryNode? {
        guard !summary.nodes.isEmpty else { return nil }
        if defaults?.string(forKey: configuredNodeKey) != configuredNodeID {
            defaults?.set(configuredNodeID, forKey: configuredNodeKey)
            defaults?.removeObject(forKey: selectedNodeKey)
        }
        if let selected = defaults?.string(forKey: selectedNodeKey),
           let node = summary.nodes.first(where: { $0.nodeId == selected }) {
            return node
        }
        if let configuredNodeID,
           let node = summary.nodes.first(where: { $0.nodeId == configuredNodeID }) {
            return node
        }
        return summary.nodes[0]
    }

    static func moveSelection(from currentNodeID: String, direction: Int) {
        guard let summary = cachedSummary(), !summary.nodes.isEmpty else { return }
        let current = summary.nodes.firstIndex(where: { $0.nodeId == currentNodeID }) ?? 0
        let count = summary.nodes.count
        let next = (current + direction % count + count) % count
        defaults?.set(summary.nodes[next].nodeId, forKey: selectedNodeKey)
    }
}

struct UsageSummary: Codable {
    let generatedAt: String
    let collectedAt: String?
    let nodes: [UsageSummaryNode]
}

struct UsageSummaryNode: Codable, Identifiable {
    var id: String { nodeId }
    let nodeId: String
    let fetchedAt: String?
    let stale: Bool
    let staleSince: String?
    let providers: UsageSummaryProviders

    var gauges: [UsageGauge] {
        var result: [UsageGauge] = []
        if let claude = providers.claude {
            let pool = claude.mode == "pool" ? claude.pool : nil
            let allBlocked = pool.map { $0.totalCount > 0 && $0.availableCount == 0 } ?? false
            let label = pool.map { $0.totalCount >= 2 ? "Claude \($0.availableCount)/\($0.totalCount)" : "Claude" } ?? "Claude"
            let value = allBlocked ? 0 : (claude.weeklyRemainingPercent ?? pool?.bestWeeklyRemainingPercent)
            if let value {
                let poolResetAt = pool?.bestWeeklyResetsAt.flatMap { epochSeconds(from: $0) }
                result.append(UsageGauge(
                    id: "claude",
                    label: label,
                    remainingPercent: value,
                    resetAt: allBlocked ? nil : claude.weeklyResetAt ?? poolResetAt,
                    resetLabel: allBlocked ? releaseLabel(pool?.earliestAvailableAt) : nil
                ))
            }
        }
        if let quota = providers.claude?.quotas.first(where: { quota in
            let identity = [quota.id, quota.label, quota.model ?? ""]
                .joined(separator: " ")
                .lowercased()
            return quota.window == "7d"
                && quota.id.hasPrefix("claude:weekly_scoped:")
                && identity.contains("fable")
        }), let value = quota.remainingPercent {
            result.append(UsageGauge(
                id: "fable",
                label: quota.model ?? quota.label,
                remainingPercent: value,
                resetAt: quota.resetAt,
                resetLabel: nil
            ))
        }
        if let value = providers.codex?.weeklyRemainingPercent {
            result.append(UsageGauge(
                id: "codex",
                label: "Codex",
                remainingPercent: value,
                resetAt: providers.codex?.weeklyResetAt,
                resetLabel: nil
            ))
        }
        if let value = providers.antigravity?.weeklyRemainingPercent {
            result.append(UsageGauge(
                id: "antigravity",
                label: "Antigravity",
                remainingPercent: value,
                resetAt: providers.antigravity?.weeklyResetAt,
                resetLabel: nil
            ))
        }
        return result
    }
}

struct UsageSummaryProviders: Codable {
    let claude: UsageSummaryProvider?
    let codex: UsageSummaryProvider?
    let antigravity: UsageSummaryProvider?
}

struct UsageSummaryProvider: Codable {
    let status: String
    let weeklyRemainingPercent: Double?
    let weeklyResetAt: Double?
    let shortRemainingPercent: Double?
    let shortResetAt: Double?
    let quotas: [UsageSummaryQuota]
    let mode: String?
    let accounts: [UsageSummaryClaudeAccount]?
    let pool: UsageSummaryClaudePool?
    let fablePool: UsageSummaryClaudePool?

    enum CodingKeys: String, CodingKey {
        case status, weeklyRemainingPercent, weeklyResetAt, shortRemainingPercent, shortResetAt, quotas
        case mode, accounts, pool
        case fablePool = "fable_pool"
    }
}

struct UsageSummaryClaudePool: Codable {
    let availableCount: Int
    let totalCount: Int
    let bestWeeklyRemainingPercent: Double?
    let bestWeeklyResetsAt: String?
    let earliestAvailableAt: String?

    enum CodingKeys: String, CodingKey {
        case availableCount = "available_count"
        case totalCount = "total_count"
        case bestWeeklyRemainingPercent = "best_weekly_remaining_percent"
        case bestWeeklyResetsAt = "best_weekly_resets_at"
        case earliestAvailableAt = "earliest_available_at"
    }
}

struct UsageSummaryClaudeAccount: Codable {
    let id: String?
    let email: String?
    let plan: String?
    let enabled: Bool?
    let priority: Double?
    let authState: String?
    let usage: UsageSummaryClaudeAccountUsage?
    let observedAt: String?
    let blocked: UsageSummaryClaudeBlocked?
    let activeSessions: Int?

    enum CodingKeys: String, CodingKey {
        case id, email, plan, enabled, priority, usage, blocked
        case authState = "auth_state"
        case observedAt = "observed_at"
        case activeSessions = "active_sessions"
    }
}

struct UsageSummaryClaudeAccountUsage: Codable {
    let fiveHour: UsageSummaryClaudeWindow?
    let sevenDay: UsageSummaryClaudeWindow?
    let fableWeekly: UsageSummaryClaudeWindow?

    enum CodingKeys: String, CodingKey {
        case fiveHour = "five_hour"
        case sevenDay = "seven_day"
        case fableWeekly = "fable_weekly"
    }
}

struct UsageSummaryClaudeWindow: Codable {
    let usedPercent: Double?
    let resetsAt: String?

    enum CodingKeys: String, CodingKey {
        case usedPercent = "used_percent"
        case resetsAt = "resets_at"
    }
}

struct UsageSummaryClaudeBlocked: Codable {
    let until: String?
    let scope: String?
}

struct UsageSummaryQuota: Codable {
    let id: String
    let label: String
    let window: String?
    let model: String?
    let remainingPercent: Double?
    let resetAt: Double?
}

struct UsageGauge: Identifiable {
    let id: String
    let label: String
    let remainingPercent: Double
    let resetAt: Double?
    let resetLabel: String?

    func resetCountdown(at date: Date, compact: Bool) -> String? {
        guard let resetAt else { return nil }

        let secondsRemaining = max(0, Int(resetAt - date.timeIntervalSince1970))
        let secondsPerDay = 24 * 60 * 60
        let secondsPerHour = 60 * 60

        if secondsRemaining >= secondsPerDay {
            let days = secondsRemaining / secondsPerDay
            guard !compact else { return "\(days)일" }
            let hours = (secondsRemaining % secondsPerDay) / secondsPerHour
            return "\(days)일 \(hours)시간"
        }
        if secondsRemaining >= secondsPerHour {
            return "\(secondsRemaining / secondsPerHour)시간"
        }
        return "\(secondsRemaining / 60)분"
    }
}

private func epochSeconds(from value: String) -> Double? {
    guard let date = parseISO8601(value) else { return nil }
    return date.timeIntervalSince1970
}

private func releaseLabel(_ value: String?) -> String? {
    guard let value, let date = parseISO8601(value) else { return nil }
    let formatter = DateFormatter()
    formatter.locale = .autoupdatingCurrent
    formatter.dateFormat = "HH:mm"
    return "\(formatter.string(from: date)) 해제 예정"
}

private func parseISO8601(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
}

enum UsageWidgetLoadState {
    case ready
    case credentialsMissing
    case serverPending
    case connectionError
}

struct UsageWidgetEntry: TimelineEntry {
    let date: Date
    let node: UsageSummaryNode?
    let state: UsageWidgetLoadState

    static let placeholder = UsageWidgetEntry(
        date: Date(),
        node: nil,
        state: .serverPending
    )
}
