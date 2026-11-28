import { copyFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const catalogPath = resolve('packages/model-catalog/data/model-catalog.yaml');

export function copyCatalog(root) {
  const target = join(root, 'packages/model-catalog/data/model-catalog.yaml');
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(catalogPath, target);
  return target;
}

export function copyCommonFiles(root) {
  cpSync(resolve('install/common-files'), join(root, 'install/common-files'), { recursive: true });
  copyInstallerText(root);
}

export function copyInstallerText(root) {
  const target = join(root, 'install/seed/locales/ko/installer.json');
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(resolve('install/seed/locales/ko/installer.json'), target);
}

export function installDefaults() {
  return JSON.parse(readFileSync(catalogPath, 'utf8').match(/^install_defaults: (.+)$/m)[1]);
}
