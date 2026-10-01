import AppIntents
import SwiftUI
import WidgetKit

struct UsageWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: UsageWidgetEntry

    var body: some View {
        Group {
            switch entry.state {
            case .credentialsMissing:
                statusView(
                    title: "앱에서 로그인 필요",
                    detail: "앱을 열고 로그인하면 위젯에 연결됩니다.",
                    icon: "person.crop.circle.badge.exclamationmark"
                )
            case .serverPending:
                statusView(
                    title: "서버 대기 중",
                    detail: "사용량 서버가 준비되면 자동으로 갱신됩니다.",
                    icon: "clock.badge.exclamationmark"
                )
            case .connectionError:
                if let node = entry.node {
                    content(node, connectionError: true)
                } else {
                    statusView(
                        title: "연결 오류",
                        detail: "마지막 성공 데이터가 아직 없습니다.",
                        icon: "wifi.exclamationmark"
                    )
                }
            case .ready:
                if let node = entry.node {
                    content(node, connectionError: false)
                } else {
                    statusView(
                        title: "서버 대기 중",
                        detail: "첫 사용량 수집을 기다리고 있습니다.",
                        icon: "clock"
                    )
                }
            }
        }
        .containerBackground(for: .widget) {
            Color("$widgetBackground")
        }
        .widgetURL(URL(string: "soulstream://usage"))
    }

    private func statusView(title: String, detail: String, icon: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("주간 사용량", systemImage: icon)
                .font(.headline)
            Spacer()
            Text(title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(detail)
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func content(_ node: UsageSummaryNode, connectionError: Bool) -> some View {
        VStack(alignment: .leading, spacing: family == .systemSmall ? 6 : 8) {
            HStack(spacing: 8) {
                if family == .systemMedium {
                    Button(intent: PreviousUsageNodeIntent(currentNodeID: node.nodeId)) {
                        Image(systemName: "chevron.left")
                    }
                    .buttonStyle(.plain)
                }
                Text(node.nodeId)
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if family == .systemMedium {
                    Button(intent: NextUsageNodeIntent(currentNodeID: node.nodeId)) {
                        Image(systemName: "chevron.right")
                    }
                    .buttonStyle(.plain)
                }
            }

            if node.gauges.isEmpty {
                Spacer()
                Text("표시할 주간 한도가 없습니다.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
            } else {
                ForEach(node.gauges.prefix(3)) { gauge in
                    gaugeRow(gauge)
                }
            }

            Spacer(minLength: 0)
            Text(
                connectionError
                    ? "연결 오류 · " + updatedLabel(node.fetchedAt, stale: true)
                    : updatedLabel(node.fetchedAt, stale: node.stale)
            )
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
    }

    private func gaugeRow(_ gauge: UsageGauge) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(gauge.label)
                    .font(.caption)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let resetCountdown = gauge.resetCountdown(
                    at: entry.date,
                    compact: family == .systemSmall
                ) {
                    Text(resetCountdown)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
                Text("\(Int(gauge.remainingPercent.rounded()))%")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .fixedSize(horizontal: true, vertical: false)
            }
            ProgressView(value: gauge.remainingPercent, total: 100)
                .tint(gauge.remainingPercent < 20 ? .orange : .accentColor)
        }
    }

    private func updatedLabel(_ value: String?, stale: Bool) -> String {
        guard let value else {
            return "갱신 대기 중"
        }
        let preciseISO = ISO8601DateFormatter()
        preciseISO.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = preciseISO.date(from: value) ?? ISO8601DateFormatter().date(from: value) else {
            return "갱신 대기 중"
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "M/d HH:mm 갱신"
        return (stale ? "마지막 " : "") + formatter.string(from: date)
    }
}

struct UsageWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: UsageWidgetShared.kind,
            intent: UsageWidgetConfigurationIntent.self,
            provider: UsageWidgetProvider()
        ) { entry in
            UsageWidgetView(entry: entry)
        }
        .configurationDisplayName("주간 사용량")
        .description("노드별 Claude·Fable·Codex 주간 남은 양을 표시합니다.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct UsageWidgetBundle: WidgetBundle {
    var body: some Widget {
        UsageWidget()
    }
}
