import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import { BoardYjsSqlResolver } from "../board-yjs/board_yjs_sql.js";
import type { SessionCommandRouter } from "../session/session_command_router.js";
import type { SessionCommandTransportBridge } from "../session/session_command_transport.js";
import { createRecurringSession } from "../session/recurring_session_creation.js";
import { intervenePayload } from "../session/session_action_command_payloads.js";
import type { ModelPresetAvailabilityService } from "../model/model_preset_availability.js";
import type { PushNotifier } from "../push/push_notifier.js";
import type { AdminAccessProvider } from "../admin/admin_access.js";
import type { InMemorySseReplayBroadcaster, SessionStreamEvent } from "../sse/replay_broadcaster.js";
import { CardDispatcher } from "./card_dispatcher.js";
import { CardDispatchRepository } from "./card_dispatch_repository.js";
import { createCardControlPlaneServiceProvider } from "./card_control_plane_runtime.js";
import { readCardDispatchSettings, updateCardDispatchSettings } from "./card_dispatch_settings.js";
export async function createCardDispatchRuntime(options: {
    sqlResolver: LiveDbSqlResolver;
    router: SessionCommandRouter;
    bridge: SessionCommandTransportBridge;
    availability: ModelPresetAvailabilityService;
    notifier: PushNotifier;
    admin: AdminAccessProvider;
    broadcaster: InMemorySseReplayBroadcaster<SessionStreamEvent>;
    warn: (message: string) => void;
    onFolderHeaderUpdated: () => Promise<void>;
}) {
    const resolver = new BoardYjsSqlResolver(options.sqlResolver);
    const resolveSql = () => resolver.resolveSql();
    let dispatcher: CardDispatcher;
    const serviceProvider = createCardControlPlaneServiceProvider({ sqlResolver: options.sqlResolver, broadcaster: options.broadcaster,
        warn: options.warn, onFolderHeaderUpdated: options.onFolderHeaderUpdated, onMutation: change => dispatcher.acceptMutation(change) });
    dispatcher = new CardDispatcher({ repository: new CardDispatchRepository(resolveSql), cards: serviceProvider, warn: options.warn,
        resolveTarget: (card, modelPreset) => {
            // Central agent identities have no default-node field; the configured card node wins, then the documented default.
            const nodeId = card.node_id ?? "eiaserinnys";
            const agentId = card.assignee_agent_id!;
            const preset = modelPreset ?? card.model_preset;
            try {
                const selection = options.router.selectNodeForCreate({ nodeId, profileId: agentId, ...(preset ? { modelPresetId: preset } : {}) });
                const availability = selection.modelPresetId ? options.availability.resolveForNode(nodeId, selection.modelPresetId) : null;
                return { nodeId, agentId: selection.profileId, modelPreset: selection.modelPresetId ?? null, available: availability?.available ?? true,
                    reason: availability?.reason_label ?? availability?.reason ?? null };
            }
            catch (error) {
                return { nodeId, agentId, modelPreset: preset ?? null, available: false, reason: String(error) };
            }
        },
        launch: input => createRecurringSession({ router: options.router, bridge: options.bridge, modelPresetAvailability: options.availability }, { ...input, callerInfo: { source: "system" } }),
        sendMessage: async (sessionId, text) => {
            const parsed = intervenePayload(sessionId, { text, caller_info: { source: "system" } });
            if (!parsed.ok)
                throw new Error(parsed.message);
            const response = await options.bridge.sendPendingCommand(await options.router.routeExistingSessionPendingCommand(parsed.value));
            if (response.status === "error" || response.type === "error")
                throw new Error(String(response.message ?? response.code));
        },
        notify: input => options.notifier.notifyCard(input),
    });
    return { dispatcher, serviceProvider, settingsRoutes: { ...options.admin,
            get: async () => readCardDispatchSettings(await resolveSql()), put: async (input: Parameters<typeof updateCardDispatchSettings>[1]) => {
                const result = await updateCardDispatchSettings(await resolveSql(), input);
                void dispatcher.dispatch();
                return result;
            } } };
}
