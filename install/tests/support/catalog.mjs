import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const catalogPath = resolve('packages/model-catalog/data/model-catalog.yaml');

export function copyCatalog(root) {
  const target = join(root, 'packages/model-catalog/data/model-catalog.yaml');
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(catalogPath, target);
  return target;
}

export function installDefaults() {
  return JSON.parse(readFileSync(catalogPath, 'utf8').match(/^install_defaults: (.+)$/m)[1]);
}
