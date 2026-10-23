type SchemaObject = Record<string, unknown>;

const schemaMapKeywords = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;
const singleSchemaKeywords = [
  "items", "additionalProperties", "additionalItems", "contains", "propertyNames", "not", "if", "then", "else",
  "unevaluatedProperties", "unevaluatedItems", "contentSchema",
] as const;
const schemaArrayKeywords = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

/** Remove schema enum entries Gemini rejects while retaining their original contract in the description. */
export function sanitizeAntigravityInputSchema(schema: unknown): unknown {
  if (!isObject(schema)) return schema;

  const sanitized: SchemaObject = { ...schema };
  const enumValues = schema.enum;
  if (Array.isArray(enumValues)) {
    if (enumValues.length === 0) {
      delete sanitized.enum;
    } else if (enumValues.includes("")) {
      delete sanitized.enum;
      const allowedValues = `Allowed values: ${JSON.stringify(enumValues)}. The empty string "" is a valid value and must be passed explicitly when intended.`;
      sanitized.description = typeof schema.description === "string" && schema.description.length > 0
        ? `${schema.description}\n${allowedValues}`
        : allowedValues;
    }
  }

  for (const keyword of schemaMapKeywords) {
    const value = schema[keyword];
    if (!isObject(value)) continue;
    sanitized[keyword] = Object.fromEntries(
      Object.entries(value).map(([name, child]) => [name, sanitizeAntigravityInputSchema(child)]),
    );
  }

  for (const keyword of singleSchemaKeywords) {
    if (!Object.hasOwn(schema, keyword)) continue;
    const value = schema[keyword];
    sanitized[keyword] = keyword === "items" && Array.isArray(value)
      ? value.map(sanitizeAntigravityInputSchema)
      : sanitizeAntigravityInputSchema(value);
  }

  for (const keyword of schemaArrayKeywords) {
    const value = schema[keyword];
    if (Array.isArray(value)) sanitized[keyword] = value.map(sanitizeAntigravityInputSchema);
  }

  const dependencies = schema.dependencies;
  if (isObject(dependencies)) {
    const sanitizedDependencies: SchemaObject = { ...dependencies };
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (isPlainObject(dependency)) sanitizedDependencies[name] = sanitizeAntigravityInputSchema(dependency);
    }
    sanitized.dependencies = sanitizedDependencies;
  }

  return sanitized;
}

function isObject(value: unknown): value is SchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is SchemaObject {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
