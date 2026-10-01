import { describe, it, expect, vi } from 'vitest';
import { compileDecisionInstructions } from '../../src/card-orchestration/decision_instructions.js';

const profile = { id: 'ariella-orchestrator', atom_contexts: [
  { node_id: 'trusted-node-1', depth: 5, titles_only: false },
  { node_id: 'trusted-node-2', depth: 1, titles_only: true },
] };
const atom = { enabled: true, serverUrl: 'https://trusted-atom.invalid', apiKey: 'host-only-test-key' };
const logger = { warn: vi.fn() };

describe('trusted profile decision instruction compilation', () => {
  it('compiles only profile-selected nodes and produces a reproducible content revision', async () => {
    const fetchContext = vi.fn(async (_config, spec) => ({ status: 'ok' as const, markdown: `instructions for ${spec.nodeId}` }));
    const result = await compileDecisionInstructions(profile, atom, logger, fetchContext);
    const repeat = await compileDecisionInstructions(profile, atom, logger, fetchContext);
    expect(result).toEqual(repeat);
    expect(result.revision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fetchContext.mock.calls.slice(0, 2).map((call) => call[1].nodeId)).toEqual(['trusted-node-1', 'trusted-node-2']);
    expect(result.text).not.toContain(atom.apiKey);
  });

  it('refuses partial compilation and does not silently continue on failed instruction fetch', async () => {
    const fetchContext = vi.fn().mockResolvedValueOnce({ status: 'ok', markdown: 'partial rules' }).mockResolvedValueOnce({ status: 'error', markdown: null });
    await expect(compileDecisionInstructions(profile, atom, logger, fetchContext)).rejects.toThrow('decision_instructions_unavailable');
  });

  it('does not substitute generic profile instructions when atom is disabled or unsupported controls are present', async () => {
    const fetchContext = vi.fn();
    await expect(compileDecisionInstructions(profile, { ...atom, enabled: false }, logger, fetchContext)).rejects.toThrow('unavailable');
    await expect(compileDecisionInstructions({ ...profile, atom_contexts: [{ ...profile.atom_contexts[0]!, mode: 'conditional' }] }, atom, logger, fetchContext)).rejects.toThrow('unsupported');
    expect(fetchContext).not.toHaveBeenCalled();
  });
});
