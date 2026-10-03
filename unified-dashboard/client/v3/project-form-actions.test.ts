import { describe, expect, it, vi } from "vitest";
import type { PageApiClient } from "@seosoyoung/soul-ui/page";
import { saveProjectFormContext, type ProjectContextSaveSession } from "./project-form-actions";
import { emptyProjectFormValue } from "./project-form-model";

const previous = { guidance: [], atomReferences: [], sessionDefaults: [] };
function fixture() {
  const blocks: any[] = [];
  const getPage = vi.fn(async () => ({ page: { id: 'p', version: 1 }, blocks: [...blocks], state_vector: '' }));
  const applyOperations = vi.fn(async (_id: string, input: any) => {
    for (const op of input.operations) {
      if (op.op === 'create_block') blocks.push({ ...op, id: op.temp_id, page_id: 'p', position_key: op.temp_id });
      if (op.op === 'update_block_text') blocks.find(b => b.id === op.block_id).text = op.text;
    }
    return { page: { id: 'p', version: 2 }, blocks: [...blocks], temp_id_mapping: {}, operation: { id: 'op' } };
  });
  return { api: { getPage, applyOperations } as unknown as PageApiClient, getPage, applyOperations, blocks };
}
describe('folder context submission', () => {
  it('sends guidance and atom in a single batch', async () => {
    const f = fixture();
    const value = { ...emptyProjectFormValue('폴더'), guidance: [{ blockId: null, text: '지침' }], atomReferences: [{ blockId: null, instance: 'atom' as const, nodeId: 'n', nodeTitle: '자료', depth: 3, titlesOnly: false }] };
    await saveProjectFormContext(f.api, 'p', previous, value, {});
    expect(f.applyOperations).toHaveBeenCalledTimes(1);
    expect(f.applyOperations.mock.calls[0][1].operations).toHaveLength(2);
  });
  it('reuses the complete failed request and recovers replay with an empty mapping', async () => {
    const f = fixture(); const session: ProjectContextSaveSession = {};
    const value = { ...emptyProjectFormValue(), guidance: [{ blockId: null, text: '지침' }] };
    f.applyOperations.mockRejectedValueOnce(new Error('응답 손실'));
    await expect(saveProjectFormContext(f.api, 'p', previous, value, session)).rejects.toThrow('응답 손실');
    await saveProjectFormContext(f.api, 'p', previous, value, session);
    expect(f.applyOperations.mock.calls[1][1]).toBe(f.applyOperations.mock.calls[0][1]);
    expect(f.blocks).toHaveLength(1);
  });
  it('resolves the old attempt before submitting edited content under a new key', async () => {
    const f = fixture(); const session: ProjectContextSaveSession = {};
    const value = { ...emptyProjectFormValue(), guidance: [{ blockId: null, text: '이전 지침' }] };
    f.applyOperations.mockRejectedValueOnce(new Error('응답 손실'));
    await expect(saveProjectFormContext(f.api, 'p', previous, value, session)).rejects.toThrow();
    await saveProjectFormContext(f.api, 'p', previous, { ...value, guidance: [{ blockId: null, text: '수정 지침' }] }, session);
    expect(f.applyOperations.mock.calls[1][1]).toBe(f.applyOperations.mock.calls[0][1]);
    expect(f.applyOperations.mock.calls[2][1].idempotencyKey).not.toBe(f.applyOperations.mock.calls[0][1].idempotencyKey);
    expect(f.blocks).toHaveLength(1);
    expect(f.blocks[0].text).toBe('수정 지침');
  });
});
