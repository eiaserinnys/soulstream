import { estimateInputTokens } from "@soulstream/model-catalog/input-token-estimate";
import type { InputMaterialPartV1 } from "@soulstream/wire-schema";

import {
  ATOM_CONTEXT_HEADER,
  formatAtomMarkdown,
  type AtomContextSpec,
} from "./atom_context.js";
import { isContextRenderMode } from "./compiler/render_modes.js";

export type InputMaterialCategory = InputMaterialPartV1["category"];

export function createInputMaterialPart(
  category: InputMaterialCategory,
  sourceKey: string | null,
  text: string,
  storedTokenEstimate?: number | null,
): InputMaterialPartV1 {
  const approximateTokens = estimateInputTokens({
    storedTokenEstimate,
    charsUtf16: text.length,
  });
  return {
    category,
    source_key: sourceKey,
    raw_chars_utf16: text.length,
    approximate_tokens: approximateTokens,
    estimate_source: typeof storedTokenEstimate === "number"
      ? "manifest"
      : approximateTokens === null ? null : "derived_chars",
  };
}

export function createInputMaterialFramingPart(
  location: string,
  index: number,
  text: string,
): InputMaterialPartV1 {
  return createInputMaterialPart("framing", `framing/${location}/${index}`, text);
}

export function scopeInputMaterialParts(
  parts: readonly InputMaterialPartV1[],
  location: string,
): InputMaterialPartV1[] {
  let framingIndex = 0;
  return parts.map((part) => ({
    ...part,
    source_key: part.category === "framing"
      ? `framing/${location}/${framingIndex++}`
      : `${location}/${part.source_key ?? "content"}`,
  }));
}

export function scopeFormattedContextParts(
  parts: readonly InputMaterialPartV1[],
  location: string,
): InputMaterialPartV1[] {
  let framingIndex = 0;
  return parts.map((part) => {
    if (part.category === "framing") {
      return {
        ...part,
        source_key: `framing/${location}/context_items/${framingIndex++}`,
      };
    }
    const key = part.source_key?.split("/") ?? [];
    const itemIndex = key[1] ?? "0";
    const atomSource = key[2] === "atom" ? key.slice(3).join("/") : null;
    return {
      ...part,
      source_key: atomSource
        ? `${location}/context/${itemIndex}/atom/${atomSource}`
        : `${location}/context/${itemIndex}`,
    };
  });
}

export function inputMaterialPartsMatchText(
  parts: readonly InputMaterialPartV1[] | undefined,
  text: string,
): parts is readonly InputMaterialPartV1[] {
  if (!parts || parts.some((part) => part.raw_chars_utf16 === null)) return false;
  return parts.reduce((sum, part) => sum + (part.raw_chars_utf16 ?? 0), 0) === text.length;
}

export function systemPromptMaterialParts(
  parts: readonly InputMaterialPartV1[] | undefined,
  systemPrompt: string,
): InputMaterialPartV1[] {
  return inputMaterialPartsMatchText(parts, systemPrompt)
    ? [...parts]
    : [createInputMaterialPart(
        "system_prompt",
        "fallback:system_source_breakdown",
        systemPrompt,
      )];
}

export function backendRolloverInputMaterialParts(
  prompt: string,
  systemPrompt: string | undefined,
): InputMaterialPartV1[] {
  return [
    createInputMaterialPart("combined_visible", "fallback:bounded_replay:prompt", prompt),
    ...(systemPrompt
      ? [createInputMaterialPart(
          "system_prompt",
          "fallback:system_source_breakdown",
          systemPrompt,
        )]
      : []),
  ];
}

export function selectAlignedInputMaterialItems<T>(
  items: readonly T[],
  parts: readonly (readonly InputMaterialPartV1[] | null)[] | undefined,
  include: (item: T) => boolean,
): { items: T[]; parts: Array<readonly InputMaterialPartV1[] | null> } {
  const selectedItems: T[] = [];
  const selectedParts: Array<readonly InputMaterialPartV1[] | null> = [];
  items.forEach((item, index) => {
    if (!include(item)) return;
    selectedItems.push(item);
    selectedParts.push(parts?.[index] ?? null);
  });
  return { items: selectedItems, parts: selectedParts };
}

export function appendInputMaterialTextSegment(
  base: InputMaterialTextSegment,
  addition: InputMaterialTextSegment,
  location: string,
): InputMaterialTextSegment {
  if (!addition.text) return { text: base.text, parts: [...base.parts] };
  return joinInputMaterialSegments([
    base,
    {
      text: addition.text,
      parts: scopeFormattedContextParts(addition.parts, location),
    },
  ], "\n\n", location);
}

export interface InputMaterialTextSegment {
  text: string;
  parts: readonly InputMaterialPartV1[];
}

export function joinInputMaterialSegments(
  segments: readonly InputMaterialTextSegment[],
  separator: string,
  location: string,
): InputMaterialTextSegment {
  let text = "";
  const parts: InputMaterialPartV1[] = [];
  let framingIndex = 0;
  segments.forEach((segment, index) => {
    if (index > 0 && separator.length > 0) {
      text += separator;
      parts.push(createInputMaterialFramingPart(location, framingIndex++, separator));
    }
    text += segment.text;
    parts.push(...segment.parts);
  });
  return { text, parts };
}

export interface ContextSectionForMaterial {
  source: AtomContextSpec & {
    id: string;
    instance: "atom" | "atom-nl";
  };
  markdown: string | null;
  status: string;
}

export function assembleContextSectionsWithMaterial(
  sections: readonly ContextSectionForMaterial[],
): InputMaterialTextSegment {
  const rendered = sections.flatMap((section, index) =>
    section.status === "filtered" ? [] : [{ section, index }]);
  if (rendered.length === 0) return { text: "", parts: [] };
  if (rendered.length === 1) {
    const entry = rendered[0]!;
    if (entry.section.markdown === null) return { text: "", parts: [] };
    const body = formatAtomMarkdown(entry.section.markdown);
    const headerPart = createInputMaterialFramingPart(
      "context_compiler",
      0,
      ATOM_CONTEXT_HEADER,
    );
    const sourcePart = createInputMaterialPart(
      "soulstream_injection",
      `source/${entry.section.source.instance}/${entry.section.source.id}/${entry.index}`,
      body,
      estimateInputTokens({ charsUtf16: body.length }),
    );
    return {
      text: `${ATOM_CONTEXT_HEADER}${body}`,
      parts: [headerPart, sourcePart],
    };
  }

  const included = rendered.flatMap((entry) => {
    const { section } = entry;
    if (!section.markdown) return [];
    const body = formatAtomMarkdown(section.markdown);
    const prefix = isContextRenderMode(section.source.mode)
      ? ""
      : [
          `## atom node: ${section.source.nodeId}`,
          `depth=${section.source.depth}, titles_only=${section.source.titlesOnly}`,
          "",
        ].join("\n") + "\n";
    const sourcePart = createInputMaterialPart(
      "soulstream_injection",
      `source/${section.source.instance}/${section.source.id}/${entry.index}`,
      body,
      estimateInputTokens({ charsUtf16: body.length }),
    );
    return [{ prefix, body, sourcePart }];
  });
  if (included.length === 0) return { text: "", parts: [] };

  let text = `${ATOM_CONTEXT_HEADER}\n`;
  const parts: InputMaterialPartV1[] = [
    createInputMaterialFramingPart("context_compiler", 0, `${ATOM_CONTEXT_HEADER}\n`),
  ];
  let framingIndex = 1;
  included.forEach((entry, index) => {
    if (index > 0) {
      text += "\n\n";
      parts.push(createInputMaterialFramingPart("context_compiler", framingIndex++, "\n\n"));
    }
    text += entry.prefix + entry.body;
    if (entry.prefix) {
      parts.push(createInputMaterialFramingPart("context_compiler", framingIndex++, entry.prefix));
    }
    parts.push(entry.sourcePart);
  });
  return { text, parts };
}
