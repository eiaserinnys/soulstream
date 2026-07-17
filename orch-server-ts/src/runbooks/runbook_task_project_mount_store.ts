import type { PageMutationApplication } from "../page/page_mutation_core.js";
import {
  assertDatabaseMutationVersion,
  commitPageMutationInTransaction,
} from "../page/page_repository.js";
import { getPageYjsDocumentName } from "../page/page_yjs_model.js";
import type { BoardYjsQuerySql } from "../board-yjs/board_yjs_sql.js";

export async function commitTaskProjectMount(
  transaction: BoardYjsQuerySql,
  input: {
    pageId: string;
    operationId: string;
    application: PageMutationApplication;
  },
) {
  const commitInput = {
    documentName: getPageYjsDocumentName(input.pageId),
    operationId: input.operationId,
    application: input.application,
  };
  await assertDatabaseMutationVersion(transaction, commitInput);
  return await commitPageMutationInTransaction(transaction, commitInput);
}
