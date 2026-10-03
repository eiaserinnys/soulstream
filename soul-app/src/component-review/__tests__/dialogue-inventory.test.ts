import fs from 'node:fs';
import path from 'node:path';
import { alertOwners, dialogueSamples } from '../dialogue-inventory';

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
