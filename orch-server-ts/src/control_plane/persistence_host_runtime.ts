import { BoardYjsSqlResolver } from "../board-yjs/board_yjs_sql.js";
import type { LiveDbSqlResolver } from "../runtime/live_db_sql.js";
import type { SqlClient } from "./control_plane_types.js";
import { ClaudeBackgroundTaskRepository } from "./repositories/claude_background_task_repository.js";
import { ClaudeTranscriptRepository } from "./repositories/claude_transcript_repository.js";
import { SessionDeliveryRepository } from "./repositories/session_delivery_repository.js";
import { SessionPageBindingRepository } from "./repositories/session_page_binding_repository.js";
import { SessionMutationRepository } from "./repositories/session_mutation_repository.js";
import { SessionReadRepository } from "./repositories/session_read_repository.js";
import { EventReadRepository } from "./repositories/event_read_repository.js";
import { SessionStoryReadRepository } from "./repositories/session_story_read_repository.js";
import { SessionReadCompositeRepository } from "./repositories/session_read_composite.js";
import type { SessionDeletionPort } from "../session/session_deletion_service.js";

export interface PersistenceHostRepositories {
  deliveries: SessionDeliveryRepository;
  claudeBackgroundTasks: ClaudeBackgroundTaskRepository;
  claudeTranscripts: ClaudeTranscriptRepository;
  sessionPageBindings: SessionPageBindingRepository;
  sessionMutations: SessionMutationRepository;
  sessionReads: SessionReadRepository;
  eventReads: EventReadRepository;
  storyReads: SessionStoryReadRepository;
  sessionReadComposites: SessionReadCompositeRepository;
}

export function createPersistenceHostRepositoryProvider(
  sqlResolver: LiveDbSqlResolver,
  sessionDeletion: SessionDeletionPort,
): () => Promise<PersistenceHostRepositories> {
  const resolver = new BoardYjsSqlResolver(sqlResolver);
  let repositories: PersistenceHostRepositories | undefined;
  return async () => {
    if (repositories) return repositories;
    const sql = await resolver.resolveSql() as unknown as SqlClient;
    const sessionReads = new SessionReadRepository(sql);
    const eventReads = new EventReadRepository(sql);
    const storyReads = new SessionStoryReadRepository(sql);
    repositories = {
      deliveries: new SessionDeliveryRepository(sql),
      claudeBackgroundTasks: new ClaudeBackgroundTaskRepository(sql),
      claudeTranscripts: new ClaudeTranscriptRepository(sql),
      sessionPageBindings: new SessionPageBindingRepository(sql),
      sessionMutations: new SessionMutationRepository(sql, sessionDeletion),
      sessionReads,
      eventReads,
      storyReads,
      sessionReadComposites: new SessionReadCompositeRepository(
        sessionReads,
        eventReads,
        storyReads,
      ),
    };
    return repositories;
  };
}
