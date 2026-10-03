import fs from 'node:fs';
import path from 'node:path';
import { alertOwners, dialogueSamples, dialoguePreviewGroups, getDialoguePreviewSample } from '../dialogue-inventory';

function sources(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? entry.name === '__tests__' || entry.name === 'component-review' ? [] : sources(path.join(root, entry.name))
      : /\.tsx?$/.test(entry.name) ? [path.join(root, entry.name)] : []);
}
it('covers every live modal owner and groups every native Alert caller', () => {
  const root = path.resolve(__dirname, '../..');
  const files = sources(root);
  const modals = files.filter(file => /<AppModalSurface\b|<Modal\b/.test(fs.readFileSync(file, 'utf8')))
    .filter(file => !file.endsWith('AppModalSurface.tsx')).map(file => path.relative(path.join(root, 'components'), file)).sort();
  expect(dialogueSamples.map(sample => sample.source).sort()).toEqual(modals);
  const alerts = files.filter(file => /(?:RNAlert|Alert)\.alert\s*\(/.test(fs.readFileSync(file, 'utf8')))
    .map(file => path.relative(root, file)).sort();
  expect([...alertOwners].sort()).toEqual(alerts);
});

it('allows exactly the real modal and detail preview IDs in the dialogues section', () => {
  const ids = [...dialogueSamples.map(s => s.value), 'card-detail', 'folder-detail', 'session-detail'];
  expect(dialoguePreviewGroups.map(g => g.items.length)).toEqual([3, 4, 3, 2, 2, 3]);
  expect(dialoguePreviewGroups.flatMap(g => g.items.map(item => item.value)).sort()).toEqual(ids.sort());
  for (const id of ids) expect(getDialoguePreviewSample('?section=dialogues&sample=' + id)).toBe(id);
  expect(getDialoguePreviewSample('?section=rows&sample=card-create')).toBeNull();
  expect(getDialoguePreviewSample('?section=dialogues&sample=unknown')).toBeNull();
  expect(getDialoguePreviewSample('?section=dialogues')).toBeNull();
});
