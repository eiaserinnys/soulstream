export {
  type PendingMutationHandle as PageEditorPendingHandle,
  createPendingMutationHandle as createPageEditorPendingHandle,
  hasPendingDashboardMutations as hasPendingPageEditorMutations,
  waitForDashboardMutationsToFlush as waitForPageEditorMutationsToFlush,
} from "../pending-mutation-registry";
