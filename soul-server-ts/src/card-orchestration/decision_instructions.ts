import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { AgentProfile } from '../agent_registry.js';
import { fetchAtomMarkdownResult, formatAtomMarkdown, type AtomFetchConfig, type AtomContextSpec } from '../context/atom_context.js';

export interface CompiledDecisionInstructions { text: string; revision: string }

/** Uses the trusted server profile only. Neither card text nor the judging model chooses atom nodes. */
export async function compileDecisionInstructions(profile: Pick<AgentProfile, 'id' | 'atom_contexts'>,
  atom: AtomFetchConfig, logger: Pick<Logger, 'warn'>,
  fetchContext: typeof fetchAtomMarkdownResult = fetchAtomMarkdownResult): Promise<CompiledDecisionInstructions> {
  const contexts = profile.atom_contexts;
  if (!contexts?.length || !atom.enabled) throw new Error('decision_instructions_unavailable');
  const sections: string[] = [];
  for (const context of contexts) {
    // The reused REST compiler does not forward these conditional/index controls.
    // Fail closed instead of silently changing the profile's instruction meaning.
    if (context.mode !== undefined || context.applies_when !== undefined) throw new Error('decision_context_spec_unsupported');
    const spec: AtomContextSpec = { nodeId: context.node_id, depth: context.depth,
      titlesOnly: context.titles_only, includeIds: context.include_ids };
    const result = await fetchContext(atom, spec, logger);
    if (result.status !== 'ok' || !result.markdown?.trim()) throw new Error('decision_instructions_unavailable');
    sections.push(formatAtomMarkdown(result.markdown));
  }
  const text = sections.join('\n\n');
  return { text, revision: `sha256:${createHash('sha256').update(JSON.stringify([profile.id, text])).digest('hex')}` };
}
