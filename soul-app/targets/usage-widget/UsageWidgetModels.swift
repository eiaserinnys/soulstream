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
        if let value = providers.claude?.weeklyRemainingPercent {
            result.append(UsageGauge(
                id: "claude",
                label: "Claude",
                remainingPercent: value,
                resetAt: providers.claude?.weeklyResetAt
            ))
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
                resetAt: quota.resetAt
            ))
        }
        if let value = providers.codex?.weeklyRemainingPercent {
            result.append(UsageGauge(
                id: "codex",
                label: "Codex",
                remainingPercent: value,
                resetAt: providers.codex?.weeklyResetAt
            ))
        }
        return result
    }
}

struct UsageSummaryProviders: Codable {
    let claude: UsageSummaryProvider?
    let codex: UsageSummaryProvider?
    let gemini: UsageSummaryProvider?
}

struct UsageSummaryProvider: Codable {
    let status: String
    let weeklyRemainingPercent: Double?
    let weeklyResetAt: Double?
    let shortRemainingPercent: Double?
    let shortResetAt: Double?
    let quotas: [UsageSummaryQuota]
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
