import { parseDocument, Scalar, type ScalarTag } from "yaml";

export type LinkKind = "call" | "include" | "pick";
export type LinkFields = {
  call?: string;
  include?: string;
  section?: string;
  when?: string;
  note?: string;
  pick?: "catalog";
  axis?: string[];
  top?: number;
  optional?: boolean;
};

export interface LinkBlock {
  line: number;
  kind: LinkKind;
  fields: LinkFields;
  startOffset: number;
  endOffset: number;
}

export interface LinkBlockError {
  line: number;
  code: string;
  message: string;
}

export interface ParseLinkBlocksResult {
  blocks: LinkBlock[];
  errors: LinkBlockError[];
}

const PY_YAML_11_TRUE_VALUES = new Set(["yes", "Yes", "YES", "true", "True", "TRUE", "on", "On", "ON"]);
const PY_YAML_11_BOOL_TAG: ScalarTag = {
  identify: (value) => typeof value === "boolean",
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
  resolve: (value) => new Scalar(PY_YAML_11_TRUE_VALUES.has(value)),
};

interface Fence {
  char: "`" | "~";
  length: number;
  indent: number;
  line: number;
  startOffset: number;
  contentStartOffset: number;
  isLink: boolean;
  bodyLines: string[];
}

function fenceStart(line: string): { char: "`" | "~"; length: number; indent: number; info: string } | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return undefined;
  const marker = match[2]!;
  const char = marker[0] as "`" | "~";
  const info = match[3]!.trim();
  if (char === "`" && info.includes("`")) return undefined;
  return { char, length: marker.length, indent: match[1]!.length, info };
}

function stripFenceIndent(line: string, indent: number): string {
  let count = 0;
  while (count < indent && line[count] === " ") count += 1;
  return line.slice(count);
}

function fenceClose(line: string, open: Fence): boolean {
  const match = /^ {0,3}(`+|~+)\s*$/.exec(line);
  if (!match) return false;
  const marker = match[1]!;
  return marker[0] === open.char && marker.length >= open.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateFields(value: unknown, source: string): { kind?: LinkKind; fields?: LinkFields; code?: string; message?: string } {
  if (!isRecord(value)) return { code: "kind_count", message: "link block must contain exactly one of call, include, or pick" };
  const keys = Object.keys(value);
  const allowed = new Set(["call", "include", "section", "when", "note", "pick", "axis", "top", "optional"]);
  if (keys.some((key) => !allowed.has(key))) return { code: "unknown_key", message: "link block contains an unknown key" };

  const kinds = (["call", "include", "pick"] as const).filter((key) => key in value);
  if (kinds.length !== 1) return { code: "kind_count", message: "link block must contain exactly one of call, include, or pick" };
  const kind = kinds[0]!;

  for (const key of ["note", "when"] as const) {
    if (key in value && typeof value[key] !== "string") return { code: "bad_type", message: `${key} must be a string` };
  }
  if (kind === "call") {
    if (!hasString(value.call)) return { code: "bad_type", message: "call must be a non-empty skill name" };
    if ("include" in value || "section" in value || "pick" in value || "axis" in value || "top" in value || "optional" in value) {
      return { code: "bad_type", message: "call has keys belonging to another link kind" };
    }
    return { kind, fields: { call: value.call, ...(typeof value.when === "string" ? { when: value.when } : {}), ...(typeof value.note === "string" ? { note: value.note } : {}) } };
  }
  if (kind === "include") {
    if (!hasString(value.include)) return { code: "bad_type", message: "include must be a non-empty document name" };
    if ("call" in value || "pick" in value || "axis" in value || "top" in value || "optional" in value || "when" in value) {
      return { code: "bad_type", message: "include has keys belonging to another link kind" };
    }
    if ("section" in value && typeof value.section !== "string") return { code: "bad_type", message: "section must be a string" };
    if ("section" in value && !/^\s*section\s*:\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*(?:#.*)?$/m.test(source)) {
      return { code: "unquoted_section", message: "section must be quoted" };
    }
    return { kind, fields: { include: value.include, ...(typeof value.section === "string" ? { section: value.section } : {}), ...(typeof value.note === "string" ? { note: value.note } : {}) } };
  }

  if (value.pick !== "catalog" || !Array.isArray(value.axis) || value.axis.length === 0 || value.axis.some((axis) => !hasString(axis))) {
    return { code: "bad_type", message: "pick must be catalog with a non-empty string axis list" };
  }
  if ("call" in value || "include" in value || "section" in value || "when" in value) {
    return { code: "bad_type", message: "pick has keys belonging to another link kind" };
  }
  const top = "top" in value ? value.top : 1;
  const optional = "optional" in value ? value.optional : false;
  if (!Number.isInteger(top) || (top as number) < 1 || typeof optional !== "boolean") {
    return { code: "bad_type", message: "top must be a positive integer and optional must be boolean" };
  }
  return {
    kind,
    fields: {
      pick: "catalog",
      axis: value.axis as string[],
      top: top as number,
      optional,
      ...(typeof value.note === "string" ? { note: value.note } : {}),
    },
  };
}

function parseBlock(source: string): { fields?: LinkFields; kind?: LinkKind; code?: string; message?: string } {
  const document = parseDocument(source, {
    uniqueKeys: true,
    version: "1.1",
    customTags: (tags) => [
      ...tags.filter((tag) => typeof tag === "string" || tag.tag !== PY_YAML_11_BOOL_TAG.tag),
      PY_YAML_11_BOOL_TAG,
    ],
  });
  if (document.errors.length > 0) {
    const duplicate = document.errors.some((error) => error.code === "DUPLICATE_KEY");
    return { code: duplicate ? "duplicate_key" : "yaml", message: document.errors[0]!.message };
  }
  return validateFields(document.toJS(), source);
}

export function parseLinkBlocks(markdown: string): ParseLinkBlocksResult {
  const lines = markdown.split("\n");
  const blocks: LinkBlock[] = [];
  const errors: LinkBlockError[] = [];
  let open: Fence | undefined;
  let offset = 0;

  for (const [index, line] of lines.entries()) {
    const lineStart = offset;
    const lineEnd = lineStart + line.length + (index < lines.length - 1 ? 1 : 0);
    if (open) {
      if (fenceClose(line, open)) {
        if (open.isLink) {
          const parsed = parseBlock(open.bodyLines.join("\n"));
          if (parsed.kind && parsed.fields) {
            blocks.push({ line: open.line, kind: parsed.kind, fields: parsed.fields, startOffset: open.startOffset, endOffset: lineEnd });
          } else {
            errors.push({ line: open.line, code: parsed.code ?? "yaml", message: parsed.message ?? "invalid link block" });
          }
        }
        open = undefined;
      } else if (open.isLink) {
        open.bodyLines.push(stripFenceIndent(line, open.indent));
      }
      offset = lineEnd;
      continue;
    }

    const start = fenceStart(line);
    if (start) {
      open = {
        char: start.char,
        length: start.length,
        indent: start.indent,
        line: index + 1,
        startOffset: lineStart,
        contentStartOffset: lineEnd,
        isLink: start.info === "link",
        bodyLines: [],
      };
    }
    offset = lineEnd;
  }

  if (open?.isLink) errors.push({ line: open.line, code: "unclosed", message: "link code fence is not closed" });
  return { blocks, errors };
}

function normalizeHeading(value: string): string {
  return value
    .replace(/<!--.*?-->/gs, "")
    .replace(/`/g, "")
    .trim()
    .replace(/^#{1,6}\s*/, "")
    .trim()
    .replace(/\s+/g, " ");
}

export type FindSectionResult =
  | { found: true; text: string }
  | { found: false; code: "missing" | "ambiguous" };

export function findSection(markdown: string, section: string): FindSectionResult {
  const lines = markdown.split("\n");
  const headings: Array<{ line: number; level: number; normalized: string }> = [];
  let open: { char: "`" | "~"; length: number } | undefined;
  for (const [index, line] of lines.entries()) {
    if (open) {
      const close = /^ {0,3}(`+|~+)\s*$/.exec(line)?.[1];
      if (close && close[0] === open.char && close.length >= open.length) open = undefined;
      continue;
    }
    const fence = fenceStart(line);
    if (fence) {
      open = { char: fence.char, length: fence.length };
      continue;
    }
    const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/.exec(line);
    if (heading) headings.push({ line: index, level: heading[1]!.length, normalized: normalizeHeading(heading[2]!) });
  }

  const wanted = normalizeHeading(section);
  const matches = headings.filter(({ normalized }) => normalized === wanted);
  if (matches.length === 0) return { found: false, code: "missing" };
  if (matches.length > 1) return { found: false, code: "ambiguous" };
  const match = matches[0]!;
  const end = headings.find((heading) => heading.line > match.line && heading.level <= match.level)?.line ?? lines.length;
  return { found: true, text: lines.slice(match.line, end).join("\n") };
}

export function stripCompileHeader(markdown: string): string {
  const newline = markdown.indexOf("\n");
  const firstLine = newline === -1 ? markdown : markdown.slice(0, newline);
  if (!/^# .+<!--\s*node:[^>]+-->.*$/.test(firstLine)) return markdown;
  return newline === -1 ? "" : markdown.slice(newline + 1);
}
