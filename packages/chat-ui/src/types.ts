export const CHAT_UI_LIMITS = {
  maxDocumentBytes: 131072, // 입력을 JSON으로 직렬화한 UTF-8 길이
  maxNodes: 200,
  maxNodeDepth: 12,
  maxExprDepth: 12,
  maxComputed: 100,
} as const;

/** 모든 맵의 키와 id. /^[A-Za-z][A-Za-z0-9_]{0,47}$/ */
export type Key = string;

export type ChatUiDocumentV1 = {
  schema_version: 1;
  title?: string;
  body: Node[];
  units?: Record<Key, Unit>;
  data?: Record<Key, DataValue>;
  fields?: Record<Key, Field>;
  computed?: Record<Key, Expr>;
  sources?: Record<Key, Source>;
  assumptions?: string[];
};

/** validate가 돌려주는 정규형. 생략된 맵과 배열을 빈 값으로 채운다. */
export type NormalizedChatUiDocumentV1 =
  Required<Omit<ChatUiDocumentV1, "title">> & { title?: string };

/** dims는 차원 지수 맵. 원 {"currency:KRW":1}, 원/개 {"currency:KRW":1,"count":-1},
 *  시간 {"time":1}, 무차원(비율) {}. scale은 같은 차원의 기준 단위 대비 배율(h=3600, min=60, s=1). */
export type Unit = { dims: Record<string, number>; symbol: string; scale: number };

export type Scalar = string | boolean | number;
/** value가 number면 unit 필수. source는 sources의 키. */
export type DataValue = { value: Scalar; unit?: Key; source?: Key };

export type Option = { id: Key; label: string };
export type Field =
  | { type: "number"; initial: number; min: number; max: number; step: number; unit: Key }
  | { type: "text"; initial: string; maxLength: number }
  | { type: "boolean"; initial: boolean }
  | { type: "choice"; initial: Key; options: Option[] }
  | { type: "selection"; initial: Key[]; options: Option[] };

export type ValueRef = { data: Key } | { field: Key } | { computed: Key };

export type TextPart =
  | string
  | { value: ValueRef; format?: "plain" | "number" | "percent"; digits?: number; unit?: Key };

export type Expr =
  | { op: "const"; value: Scalar; unit?: Key } // number면 unit 필수
  | { op: "ref"; ref: ValueRef }
  | { op: "add" | "mul"; args: Expr[] }        // 둘 이상
  | { op: "sub" | "div"; args: [Expr, Expr] }
  | { op: "eq" | "lt" | "lte"; args: [Expr, Expr] }
  | { op: "and" | "or"; args: Expr[] }         // 둘 이상
  | { op: "not"; args: [Expr] }
  | { op: "if"; args: [Expr, Expr, Expr] };

export type Source =
  | { type: "assumption"; label: string; note?: string }
  | { type: "external_link"; label: string; url: string }; // https만

export type FieldValue = number | string | boolean | string[];

export type ComposeAction = { type: "compose"; parts?: TextPart[] };
export type Action =
  | { type: "set"; field: Key; value: FieldValue }
  | { type: "reset" }
  | { type: "open_source"; source: Key }
  | { type: "copy" }
  | ComposeAction;

type NodeBase = { id: Key; visibleWhen?: Expr };
export type Node = NodeBase & (
  | { kind: "heading"; level: 1 | 2 | 3; parts: TextPart[] }
  | { kind: "text"; parts: TextPart[]; emphasis?: "strong" }
  | { kind: "caption"; parts: TextPart[] }
  | { kind: "group"; layout: "stack" | "row" | "wrap"; children: Node[] }
  | { kind: "slider"; field: Key; label: string }
  | { kind: "checkbox"; field: Key; label: string }
  | { kind: "form"; items: Array<{ field: Key; label: string }>; submitLabel: string; action: ComposeAction }
  | { kind: "button"; label: string; action: Action }
  | { kind: "entity"; label: string; details: TextPart[]; source?: Key }
  | { kind: "citation"; source: Key }
);

export type ChatUiState = { values: Record<Key, FieldValue> };

export type Value =
  | { type: "number"; base: number; dims: Record<string, number> } // base = 선언 값 × unit.scale
  | { type: "string"; value: string }
  | { type: "boolean"; value: boolean }
  | { type: "list"; value: string[] }
  | { type: "error"; code: "DIV_BY_ZERO" | "OUT_OF_RANGE"; message: string };

export type ValidationIssue = { path: string; reason: string };
export type ValidationResult =
  | { ok: true; document: NormalizedChatUiDocumentV1 }
  | { ok: false; errors: ValidationIssue[] };
