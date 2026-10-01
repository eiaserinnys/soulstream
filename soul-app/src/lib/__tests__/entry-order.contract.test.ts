import { transformFileSync } from '@babel/core';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');

test('Expo entry evaluates crash-reporting bootstrap before App and its dependency graph', () => {
  const entry = resolve(root, 'index.ts');
  const result = transformFileSync(entry, {
    filename: entry,
    babelrc: false,
    configFile: false,
    presets: [require.resolve('expo/node_modules/babel-preset-expo')],
  });
  const compiled = result?.code ?? '';
  const expoImport = compiled.indexOf('require("expo")');
  const bootstrapImport = compiled.indexOf(
    'require("./src/lib/install-eas-observe-crash-reporting")',
  );
  const appImport = compiled.indexOf('require("./App")');

  expect(expoImport).toBeGreaterThanOrEqual(0);
  expect(bootstrapImport).toBeGreaterThan(expoImport);
  expect(appImport).toBeGreaterThan(bootstrapImport);
});
