import { describe, expect, it, vi } from "vitest";
import { compileSkill, IncludeResolutionError } from "../src/skills/skill_compile.js";
import type { DomainCatalogEntry, LoadedAtomBody, SkillCatalogEntry } from "../src/skills/skill_catalog.js";

function body(nodeId: string, markdown: string, version = 1, childCount = 0): LoadedAtomBody {
  return { nodeId, markdown, version, childCount };
}

function skill(name: string, bodyNodeId: string, description = `${name} description`): SkillCatalogEntry {
  return { name, description, bodyNodeId, nodeId: `entry-${name}` };
}

function catalog(name: string, axis: string[], composition: "orthogonal" | "bundle" = "orthogonal", bodyNodeId = `body-${name}`): DomainCatalogEntry {
  return { name, description: `${name} description`, bodyNodeId, axis, composition };
}

function setup(markdown: string, options: {
  skills?: SkillCatalogEntry[];
  catalogs?: DomainCatalogEntry[];
  bodies?: Record<string, LoadedAtomBody>;
  score?: (keys: string[]) => Promise<Array<{ key: string; score: number }>>;
  childCount?: number;
} = {}) {
  const current = skill("main", "main-body");
  const allSkills = options.skills ?? [current];
  const available = options.bodies ?? {};
  const readBody = vi.fn(async (nodeId: string) => {
    const value = available[nodeId];
    if (!value) throw new Error(`missing body ${nodeId}`);
    return value;
  });
  const loadCatalogs = vi.fn(async () => options.catalogs ?? []);
  const score = vi.fn(async (input: { items: Array<{ key: string }> }) =>
    options.score
      ? options.score(input.items.map(({ key }) => key))
      : input.items.map(({ key }) => ({ key, score: 0.8 })),
  );
  return {
    current,
    readBody,
    loadCatalogs,
    score,
    run: (intent?: string, pins?: string[]) => compileSkill({
      skill: current,
      entryVersion: 3,
      body: body("main-body", markdown, 7, options.childCount ?? 0),
      skills: allSkills,
      readBody,
      loadCatalogs,
      score,
      ...(intent === undefined ? {} : { intent }),
      ...(pins === undefined ? {} : { pins }),
    }),
  };
}

describe("load_skill compiler", () => {
  it("does not load catalogs or call Jev when the skill has no pick", async () => {
    const h = setup("# Main\n\nPlain instructions.\n");
    const result = await h.run();
    expect(result.compiled_markdown).toBe("# Main\n\nPlain instructions.\n");
    expect(h.loadCatalogs).not.toHaveBeenCalled();
    expect(h.score).not.toHaveBeenCalled();
  });

  it("selects only candidates without Jev and pins reproduce the same choice", async () => {
    const only = setup("```link\npick: catalog\naxis: [light.setup]\n```", {
      catalogs: [catalog("single", ["light.setup"])],
    });
    only.readBody.mockResolvedValue(body("body-single", "## Single\nlight data"));
    const onlyResult = await only.run();
    expect(only.score).not.toHaveBeenCalled();
    expect(onlyResult.pins).toEqual(["single"]);
    expect(onlyResult.compiled_markdown).toContain("> 링크: pick [light.setup] → single (only)");

    const markdown = "```link\npick: catalog\naxis: [camera.framing]\n```";
    const first = setup(markdown, {
      catalogs: [catalog("wide", ["camera.framing"]), catalog("close", ["camera.framing"])],
      score: async (keys) => keys.map((key) => ({ key, score: key === "wide" ? 0.9 : 0.4 })),
    });
    first.readBody.mockImplementation(async (nodeId) => body(nodeId, `# ${nodeId}\nsource`));
    const compiled = await first.run("wide portrait");
    const replay = setup(markdown, {
      catalogs: [catalog("wide", ["camera.framing"]), catalog("close", ["camera.framing"])],
    });
    replay.readBody.mockImplementation(async (nodeId) => body(nodeId, `# ${nodeId}\nsource`));
    const replayed = await replay.run(undefined, compiled.pins);
    expect(first.score).toHaveBeenCalledTimes(1);
    expect(replay.score).not.toHaveBeenCalled();
    expect(compiled.links[0]?.selected.map(({ name }) => name)).toEqual(replayed.links[0]?.selected.map(({ name }) => name));
    expect(compiled.compiled_markdown).toContain("> 링크: pick [camera.framing] → wide (Jev 0.90)");
    expect(replayed.compiled_markdown).toContain("> 링크: pick [camera.framing] → wide (pins)");
  });

  it("calls Jev once for several blocks and applies top to each block", async () => {
    const h = setup([
      "```link", "pick: catalog", "axis: [camera.framing]", "top: 1", "```", "",
      "```link", "pick: catalog", "axis: [light.setup]", "top: 1", "```",
    ].join("\n"), {
      catalogs: [
        catalog("wide", ["camera.framing"]), catalog("close", ["camera.framing"]),
        catalog("soft", ["light.setup"]), catalog("hard", ["light.setup"]),
      ],
      score: async (keys) => keys.map((key, index) => ({ key, score: 0.9 - index * 0.1 })),
    });
    h.readBody.mockImplementation(async (nodeId) => body(nodeId, `# ${nodeId}\ntext`));
    const result = await h.run("portrait");
    expect(h.score).toHaveBeenCalledTimes(1);
    expect(h.score.mock.calls[0]![0].items.map(({ key }) => key)).toEqual(["wide", "close", "soft", "hard"]);
    expect(result.links.filter((link) => link.kind === "pick").map((link) => link.selected.map(({ name }) => name))).toEqual([
      ["wide"], ["soft"],
    ]);
  });

  it("recomputes only candidates after earlier blocks select overlapping catalogs", async () => {
    const h = setup([
      "```link", "pick: catalog", "axis: [\"x\"]", "```", "",
      "```link", "pick: catalog", "axis: [\"y\"]", "```",
    ].join("\n"), {
      catalogs: [catalog("a", ["x", "y"]), catalog("b", ["y"])],
    });
    h.readBody.mockImplementation(async (nodeId) => body(nodeId, `${nodeId} body`));

    const result = await h.run();

    expect(h.score).not.toHaveBeenCalled();
    expect(result.links.filter(({ kind }) => kind === "pick").map(({ selected }) =>
      selected.map(({ name, reason }) => ({ name, reason })),
    )).toEqual([
      [{ name: "a", reason: "only" }],
      [{ name: "b", reason: "only" }],
    ]);
    expect(result.warnings.map(({ code }) => code)).not.toContain("unresolved_pick");

    const withIntent = await h.run("portrait");
    expect(h.score).not.toHaveBeenCalled();
    expect(withIntent.links.filter(({ kind }) => kind === "pick").map(({ selected }) => selected.map(({ name, reason }) => ({ name, reason })))).toEqual([
      [{ name: "a", reason: "only" }],
      [{ name: "b", reason: "only" }],
    ]);
  });

  it("counts bundle-axis exclusions before deciding a later block is only", async () => {
    const h = setup([
      "```link", "pick: catalog", "axis: [\"x\"]", "```", "",
      "```link", "pick: catalog", "axis: [\"y\", \"z\"]", "top: 1", "```",
    ].join("\n"), {
      catalogs: [
        catalog("bundle", ["x", "y"], "bundle"),
        catalog("covered-y", ["y"]),
        catalog("free-z", ["z"]),
      ],
    });
    h.readBody.mockImplementation(async (nodeId) => body(nodeId, `${nodeId} body`));

    const result = await h.run();

    expect(h.score).not.toHaveBeenCalled();
    expect(result.links.filter(({ kind }) => kind === "pick").map(({ selected }) =>
      selected.map(({ name, reason }) => ({ name, reason })),
    )).toEqual([
      [{ name: "bundle", reason: "only" }],
      [{ name: "free-z", reason: "only" }],
    ]);
    expect(result.links[1]?.excluded).toContainEqual({ name: "covered-y", reason: "bundle_axis" });
  });

  it("applies the 0.25 floor only to optional blocks", async () => {
    const h = setup([
      "```link", "pick: catalog", "axis: [required.axis]", "```", "",
      "```link", "pick: catalog", "axis: [optional.axis]", "optional: true", "```",
    ].join("\n"), {
      catalogs: [catalog("required-low", ["required.axis"]), catalog("optional-low", ["optional.axis"])],
      score: async (keys) => keys.map((key) => ({ key, score: 0.2 })),
    });
    h.readBody.mockImplementation(async (nodeId) => body(nodeId, "catalog body"));
    const result = await h.run("anything");
    expect(result.links[0]?.selected.map(({ name }) => name)).toEqual(["required-low"]);
    expect(result.links[1]?.selected).toEqual([]);
    expect(result.links[1]?.excluded).toContainEqual({ name: "optional-low", reason: "below_floor" });
  });

  it("opens a skill with a candidate list and jev_failed warning when Jev is unavailable", async () => {
    const h = setup("```link\npick: catalog\naxis: [camera.framing]\n```", {
      catalogs: [catalog("wide", ["camera.framing"]), catalog("close", ["camera.framing"])],
      score: async () => { throw new Error("Jev unavailable"); },
    });
    const result = await h.run("frame the portrait");
    expect(result.name).toBe("main");
    expect(result.compiled_markdown).toContain("wide: wide description");
    expect(result.compiled_markdown).toContain("close: close description");
    expect(result.warnings.map(({ code }) => code)).toContain("jev_failed");
    expect(result.links[0]?.selected).toEqual([]);
  });

  it("marks a pick block covered by a previously selected bundle", async () => {
    const h = setup([
      "```link", "pick: catalog", "axis: [subject.identity]", "```", "",
      "```link", "pick: catalog", "axis: [color.palette]", "```",
    ].join("\n"), {
      catalogs: [
        catalog("psychedelic-maid-canon", ["subject.identity", "color.palette"], "bundle"),
        catalog("vivid-palette", ["color.palette"]),
      ],
      score: async (keys) => keys.map((key) => ({ key, score: key === "psychedelic-maid-canon" ? 0.9 : 0.8 })),
    });
    h.readBody.mockImplementation(async (nodeId) => body(nodeId, "catalog body"));
    const result = await h.run("maid portrait");
    expect(result.compiled_markdown).toContain("> 링크: pick [color.palette] → (bundle psychedelic-maid-canon이 담당)");
    expect(result.links[1]?.excluded).toContainEqual({ name: "vivid-palette", reason: "bundle_axis" });
  });

  it("includes whole documents or sections, renders shard metadata, and expands only nested calls", async () => {
    const target = skill("guide", "guide-body");
    const h = setup([
      "```link", "include: guide", "section: \"Needed section\"", "```", "",
      "```link", "include: palette", "```",
    ].join("\n"), {
      catalogs: [{ ...catalog("palette", ["color.palette"]), shards: [{ name: "warm", nodeId: "shard-1", cues: ["sunset"] }] }],
      bodies: {
        "guide-body": body("guide-body", "# Guide\n## Needed section\nText\n\n```link\ncall: helper\n```\n\n```link\ncall: malformed\nquery: ignored\n```\n\n```link\ninclude: ignored\n```\n\n```link\npick: catalog\naxis: [ignored]\n```"),
        "body-palette": body("body-palette", "# Palette\nPalette overview"),
      },
      skills: [skill("main", "main-body"), target, skill("helper", "helper-body", "Helper procedure")],
    });
    const result = await h.run();
    expect(result.compiled_markdown).toContain("> 링크: include guide 「Needed section」");
    expect(result.compiled_markdown).toContain("> 링크: call helper");
    expect(result.compiled_markdown).toContain("query: ignored");
    expect(result.compiled_markdown).toContain("```link\ncall: malformed\nquery: ignored\n```");
    expect(result.compiled_markdown).toContain("include: ignored");
    expect(result.compiled_markdown).toContain("name | node_id | cues");
    expect(result.compiled_markdown).toContain("warm | shard-1 | sunset");
    expect(result.warnings.map(({ code }) => code)).toEqual(expect.arrayContaining(["invalid_link_block", "nested_link_unresolved"]));
    expect(result.links.some(({ kind }) => kind === "pick")).toBe(false);
    expect(h.readBody.mock.calls.map(([nodeId]) => nodeId)).toEqual(["guide-body", "body-palette"]);
  });

  it("finds included sections in the catalog body node without reading child shard bodies", async () => {
    const h = setup("```link\ninclude: palette\nsection: \"Shard-only section\"\n```", {
      catalogs: [{
        ...catalog("palette", ["color.palette"]),
        shards: [{ name: "warm", nodeId: "shard-warm", cues: ["sunset"] }],
      }],
      bodies: { "body-palette": body("body-palette", "# Palette\n## Overview\nRoot text") },
    });

    await expect(h.run()).rejects.toMatchObject({
      name: "IncludeResolutionError",
      broken: [{ line: 1, target: "palette", section: "Shard-only section", cause: "절 없음" }],
    });
    expect(h.readBody.mock.calls.map(([nodeId]) => nodeId)).toEqual(["body-palette"]);
    expect(h.readBody).not.toHaveBeenCalledWith("shard-warm");
  });

  it("includes catalog bindings in the combined selection and renders them below the include source", async () => {
    const h = setup("```link\ninclude: style\n```\n\n```link\ninclude: layout\n```", {
      catalogs: [
        {
          ...catalog("style", ["style.axis"]),
          bindings: [{ targetCatalog: "layout", targetAxis: "layout.axis", sheetTemplate: "style-guide" }],
        },
        catalog("layout", ["layout.axis"]),
      ],
      bodies: {
        "body-style": body("body-style", "style body"),
        "body-layout": body("body-layout", "layout body"),
      },
    });

    const result = await h.run();
    expect(result.active_bindings).toEqual([{
      source_catalog: "style",
      target_catalog: "layout",
      target_axis: "layout.axis",
      sheet_template: "style-guide",
    }]);
    expect(result.compiled_markdown.indexOf("> 바인딩: style → layout (style-guide)")).toBeGreaterThan(
      result.compiled_markdown.indexOf("> 링크: include style"),
    );
  });

  it("fails when an include name matches both a skill and a catalog", async () => {
    const h = setup("```link\ninclude: shared\n```", {
      skills: [skill("main", "main-body"), skill("shared", "shared-skill-body")],
      catalogs: [catalog("shared", ["shared.axis"])],
      bodies: { "shared-skill-body": body("shared-skill-body", "skill body") },
    });

    await expect(h.run()).rejects.toMatchObject({
      name: "IncludeResolutionError",
      broken: [{ line: 1, target: "shared", cause: "이름 공간에서 대상이 모호함" }],
    });
  });

  it("fails the full load with every broken include and the manual recovery instruction", async () => {
    const h = setup([
      "```link", "include: missing", "```", "",
      "```link", "include: guide", "section: \"Missing heading\"", "```", "",
      "```link", "include: guide", "section: \"Duplicate\"", "```",
    ].join("\n"), {
      skills: [skill("main", "main-body"), skill("guide", "guide-body")],
      bodies: { "guide-body": body("guide-body", "## Duplicate\none\n## Duplicate\ntwo") },
    });
    await expect(h.run()).rejects.toBeInstanceOf(IncludeResolutionError);
    await expect(h.run()).rejects.toThrow("compile_subtree");
    await expect(h.run()).rejects.toThrow("line 1");
    await expect(h.run()).rejects.toThrow("line 5");
    await expect(h.run()).rejects.toThrow("line 10");
  });

  it("leaves missing calls and unresolved picks open with warnings, warns for body children, and reports total chars without a size warning", async () => {
    const long = "x".repeat(30_001);
    const h = setup(`\`\`\`link\ncall: absent\n\`\`\`\n\n\`\`\`link\npick: catalog\naxis: [unknown.axis]\n\`\`\`\n\n${long}`, {
      catalogs: [catalog("unrelated", ["other.axis"])],
      childCount: 1,
    });
    const result = await h.run();
    expect(result.compiled_markdown).toContain("> 링크 오류:");
    expect(result.warnings.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "missing_call", "unresolved_pick", "body_has_children",
    ]));
    expect(result.warnings.map(({ code }) => code)).not.toContain("large_compiled");
    expect(result.total_chars).toBeGreaterThan(30_000);
  });

  it("does not choose catalogs that an earlier include already expanded", async () => {
    const h = setup("```link\ninclude: single\n```\n\n```link\npick: catalog\naxis: [light.setup]\n```", {
      catalogs: [catalog("single", ["light.setup"])],
      bodies: { "body-single": body("body-single", "single source") },
    });
    const result = await h.run();
    expect(h.score).not.toHaveBeenCalled();
    expect(result.links[1]?.excluded).toContainEqual({ name: "single", reason: "already_expanded" });
    expect(result.compiled_markdown).toContain("> 링크: pick [light.setup] → single (위에서 펼침)");
    expect(result.warnings.map(({ code }) => code)).not.toContain("unresolved_pick");
  });
});
