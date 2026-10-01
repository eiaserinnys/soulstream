import AppIntents
import WidgetKit

struct UsageNodeEntity: AppEntity, Identifiable {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "노드")
    static var defaultQuery = UsageNodeQuery()

    let id: String
    let name: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

struct UsageNodeQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [UsageNodeEntity] {
        availableNodes().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [UsageNodeEntity] {
        availableNodes()
    }

    func defaultResult() async -> UsageNodeEntity? {
        availableNodes().first
    }

    private func availableNodes() -> [UsageNodeEntity] {
        UsageWidgetShared.cachedSummary()?.nodes.map {
            UsageNodeEntity(id: $0.nodeId, name: $0.nodeId)
        } ?? []
    }
}

struct UsageWidgetConfigurationIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "주간 사용량"
    static var description = IntentDescription("위젯에서 처음 표시할 노드를 선택합니다.")

    @Parameter(title: "기본 노드")
    var node: UsageNodeEntity?
}

struct PreviousUsageNodeIntent: AppIntent {
    static var title: LocalizedStringResource = "이전 노드"

    @Parameter(title: "현재 노드")
    var currentNodeID: String

    init() {
        currentNodeID = ""
    }

    init(currentNodeID: String) {
        self.currentNodeID = currentNodeID
    }

    func perform() async throws -> some IntentResult {
        UsageWidgetShared.moveSelection(from: currentNodeID, direction: -1)
        WidgetCenter.shared.reloadTimelines(ofKind: UsageWidgetShared.kind)
        return .result()
    }
}

struct NextUsageNodeIntent: AppIntent {
    static var title: LocalizedStringResource = "다음 노드"

    @Parameter(title: "현재 노드")
    var currentNodeID: String

    init() {
        currentNodeID = ""
    }

    init(currentNodeID: String) {
        self.currentNodeID = currentNodeID
    }

    func perform() async throws -> some IntentResult {
        UsageWidgetShared.moveSelection(from: currentNodeID, direction: 1)
        WidgetCenter.shared.reloadTimelines(ofKind: UsageWidgetShared.kind)
        return .result()
    }
}
