import Foundation
import WidgetKit

private enum UsageFetchError: Error {
    case credentialsMissing
    case serverPending
    case invalidResponse
}

struct UsageWidgetProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> UsageWidgetEntry {
        .placeholder
    }

    func snapshot(
        for configuration: UsageWidgetConfigurationIntent,
        in context: Context
    ) async -> UsageWidgetEntry {
        if context.isPreview { return .placeholder }
        return await makeEntry(configuration: configuration)
    }

    func timeline(
        for configuration: UsageWidgetConfigurationIntent,
        in context: Context
    ) async -> Timeline<UsageWidgetEntry> {
        let entry = await makeEntry(configuration: configuration)
        let refresh = Date().addingTimeInterval(15 * 60)
        return Timeline(entries: [entry], policy: .after(refresh))
    }

    private func makeEntry(configuration: UsageWidgetConfigurationIntent) async -> UsageWidgetEntry {
        do {
            let summary = try await fetchSummary()
            let node = UsageWidgetShared.selectedNode(
                in: summary,
                configuredNodeID: configuration.node?.id
            )
            return UsageWidgetEntry(date: Date(), node: node, state: .ready)
        } catch UsageFetchError.credentialsMissing {
            return UsageWidgetEntry(date: Date(), node: nil, state: .credentialsMissing)
        } catch UsageFetchError.serverPending {
            return UsageWidgetEntry(date: Date(), node: nil, state: .serverPending)
        } catch {
            return cachedEntry(configuration: configuration, state: .connectionError)
        }
    }

    private func cachedEntry(
        configuration: UsageWidgetConfigurationIntent,
        state: UsageWidgetLoadState
    ) -> UsageWidgetEntry {
        guard let lastSummary = UsageWidgetShared.cachedSummary() else {
            return UsageWidgetEntry(date: Date(), node: nil, state: state)
        }
        return UsageWidgetEntry(
            date: Date(),
            node: UsageWidgetShared.selectedNode(
                in: lastSummary,
                configuredNodeID: configuration.node?.id
            ),
            state: state
        )
    }

    private func fetchSummary() async throws -> UsageSummary {
        guard let defaults = UsageWidgetShared.defaults else {
            throw UsageFetchError.credentialsMissing
        }
        guard
            let serverURL = defaults.string(forKey: UsageWidgetShared.serverURLKey),
            !serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            let authToken = defaults.string(forKey: UsageWidgetShared.authTokenKey),
            !authToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            throw UsageFetchError.credentialsMissing
        }
        guard let url = URL(
            string: serverURL.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                + "/api/usage/summary"
        ) else {
            throw UsageFetchError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw UsageFetchError.invalidResponse
        }
        if http.statusCode == 404 {
            throw UsageFetchError.serverPending
        }
        guard (200..<300).contains(http.statusCode) else {
            throw UsageFetchError.invalidResponse
        }
        let summary = try JSONDecoder().decode(UsageSummary.self, from: data)
        UsageWidgetShared.cache(data: data)
        return summary
    }
}
