import { describe, expect, it } from "vitest";
import { sanitizeAntigravityInputSchema } from "../../../src/engine/antigravity/mcp_schema_sanitizer.js";

describe("sanitizeAntigravityInputSchema", () => {
  it("removes only incompatible enum declarations and explains the original values", () => {
    const schema = {
      type: "object",
      required: ["variant"],
      properties: {
        variant: { type: "string", enum: ["clean", "logo", ""], description: "Select a variant" },
        clear: { type: "string", enum: [""], description: "" },
        empty: { type: "string", enum: [] },
        normal: { type: "string", enum: ["clean", "logo"] },
        whitespace: { type: "string", enum: [" "] },
        enum: { type: "string", default: "" },
      },
    };
    const original = structuredClone(schema);

    const sanitized = sanitizeAntigravityInputSchema(schema) as typeof schema;

    expect(schema).toEqual(original);
    expect(sanitized).not.toBe(schema);
    expect(sanitized.required).toEqual(["variant"]);
    expect(sanitized.properties.variant).toEqual({
      type: "string",
      description: 'Select a variant\nAllowed values: ["clean","logo",""]. The empty string "" is a valid value and must be passed explicitly when intended.',
    });
    expect(sanitized.properties.clear).toEqual({
      type: "string",
      description: 'Allowed values: [""]. The empty string "" is a valid value and must be passed explicitly when intended.',
    });
    expect(sanitized.properties.empty).toEqual({ type: "string" });
    expect(sanitized.properties.normal).toEqual(schema.properties.normal);
    expect(sanitized.properties.whitespace).toEqual(schema.properties.whitespace);
    expect(sanitized.properties.enum).toEqual(schema.properties.enum);
    expect(sanitizeAntigravityInputSchema(sanitized)).toEqual(sanitized);
  });

  it("walks JSON Schema locations without treating example data as schemas", () => {
    const empty = () => ({ type: "string", enum: ["ok", ""] });
    const schema = {
      properties: { field: empty() },
      patternProperties: { "^x": empty() },
      $defs: { definition: empty() },
      definitions: { legacy: empty() },
      dependentSchemas: { trigger: empty() },
      items: [empty(), true],
      additionalProperties: empty(),
      additionalItems: empty(),
      contains: empty(),
      propertyNames: empty(),
      not: empty(),
      if: empty(),
      then: empty(),
      else: empty(),
      unevaluatedProperties: empty(),
      unevaluatedItems: empty(),
      contentSchema: empty(),
      anyOf: [empty()],
      oneOf: [empty()],
      allOf: [empty()],
      prefixItems: [empty()],
      dependencies: { schemaDependency: empty(), propertyDependency: ["name"] },
      default: { enum: ["ok", ""] },
      examples: [{ enum: ["ok", ""] }],
      const: { enum: ["ok", ""] },
    };

    const sanitized = sanitizeAntigravityInputSchema(schema) as Record<string, unknown>;
    const expectAllowedDescription = (value: unknown) => {
      expect(value).toMatchObject({
        type: "string",
        description: 'Allowed values: ["ok",""]. The empty string "" is a valid value and must be passed explicitly when intended.',
      });
      expect(value).not.toHaveProperty("enum");
    };

    expectAllowedDescription((sanitized.properties as Record<string, unknown>).field);
    expectAllowedDescription((sanitized.patternProperties as Record<string, unknown>)["^x"]);
    expectAllowedDescription((sanitized.$defs as Record<string, unknown>).definition);
    expectAllowedDescription((sanitized.definitions as Record<string, unknown>).legacy);
    expectAllowedDescription((sanitized.dependentSchemas as Record<string, unknown>).trigger);
    for (const key of ["items", "anyOf", "oneOf", "allOf", "prefixItems"] as const) {
      expectAllowedDescription((sanitized[key] as unknown[])[0]);
    }
    for (const key of ["additionalProperties", "additionalItems", "contains", "propertyNames", "not", "if", "then", "else",
      "unevaluatedProperties", "unevaluatedItems", "contentSchema"] as const) {
      expectAllowedDescription(sanitized[key]);
    }
    const dependencies = sanitized.dependencies as Record<string, unknown>;
    expectAllowedDescription(dependencies.schemaDependency);
    expect(dependencies.propertyDependency).toEqual(["name"]);
    expect(sanitized.default).toEqual(schema.default);
    expect(sanitized.examples).toEqual(schema.examples);
    expect(sanitized.const).toEqual(schema.const);
    expect((sanitized.items as unknown[])[1]).toBe(true);
  });
});
