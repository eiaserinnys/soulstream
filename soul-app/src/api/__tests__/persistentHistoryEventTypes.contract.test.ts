import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { PERSISTENT_HISTORY_EVENT_TYPES } from '../persistentHistoryEventTypes';

test('PAS history requests the canonical timeline types plus complete in canonical order', () => {
  const canonicalEventTypes = readCanonicalTimelineEventTypes();
  expect(PERSISTENT_HISTORY_EVENT_TYPES).toEqual([
    ...canonicalEventTypes,
    'complete',
  ]);
});

function readCanonicalTimelineEventTypes(): string[] {
  const sourcePath = path.resolve(
    __dirname,
    '../../../../packages/wire-schema/generated/typescript/index.ts',
  );
  const source = fs.readFileSync(sourcePath, 'utf8');
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let values: string[] | undefined;

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'SESSION_TIMELINE_EVENT_TYPES') continue;
      const initializer = declaration.initializer && ts.isAsExpression(declaration.initializer)
        ? declaration.initializer.expression
        : declaration.initializer;
      if (!initializer || !ts.isArrayLiteralExpression(initializer)) continue;
      values = initializer.elements.map((element) => {
        if (!ts.isStringLiteral(element)) throw new Error('Canonical timeline event type must be a string literal.');
        return element.text;
      });
    }
  }

  if (!values) throw new Error('SESSION_TIMELINE_EVENT_TYPES array was not found in generated source.');
  return values;
}
