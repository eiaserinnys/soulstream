// A deliberately narrow SQL recognizer, not a general PostgreSQL parser. Unknown
// syntax and malformed lexical constructs must retain the quiescence gate.
function tokenize(sql) {
  const statements = [];
  let tokens = [];
  let stack = [];
  let i = 0;
  const pushStatement = () => {
    if (tokens.length) statements.push(tokens);
    tokens = [];
  };
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) { depth++; i += 2; }
        else if (sql.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error("unterminated comment");
      continue;
    }
    if (c === "'" || c === '"') {
      const start = i++;
      let closed = false;
      while (i < sql.length) {
        // Backslash strings depend on PostgreSQL settings (and E'' escapes).
        // Do not guess where a quoted value ends.
        if (sql[i] === "\\") throw new Error("ambiguous quote escape");
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) throw new Error("unterminated quote");
      tokens.push({ kind: c === "'" ? "string" : "ident", value: sql.slice(start, i) });
      continue;
    }
    if (c === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/);
      if (!match) throw new Error("unknown dollar syntax");
      const end = sql.indexOf(match[0], i + match[0].length);
      if (end < 0) throw new Error("unterminated dollar quote");
      tokens.push({ kind: "dollar", value: sql.slice(i, end + match[0].length) });
      i = end + match[0].length;
      continue;
    }
    const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z_0-9$]*/);
    if (word) { tokens.push({ kind: "word", value: word[0].toUpperCase() }); i += word[0].length; continue; }
    const number = sql.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (number) { tokens.push({ kind: "number", value: number[0] }); i += number[0].length; continue; }
    if (c === ";") {
      if (stack.length) throw new Error("semicolon inside expression");
      pushStatement(); i++; continue;
    }
    if (c === "(" || c === "[") stack.push(c);
    if (c === ")" || c === "]") {
      if (stack.pop() !== (c === ")" ? "(" : "[")) throw new Error("unbalanced delimiters");
    }
    if (sql.startsWith("::", i)) { tokens.push({ kind: "symbol", value: "::" }); i += 2; continue; }
    if (!/[(),.\[\]=+*/<>!~|&@?:%^-]/.test(c)) throw new Error("unknown character");
    tokens.push({ kind: "symbol", value: c }); i++;
  }
  if (stack.length) throw new Error("unbalanced delimiters");
  pushStatement();
  return statements;
}

const is = (tokens, index, value) => tokens[index]?.kind === "word" && tokens[index].value === value;
const identifier = (token) => token && (token.kind === "word" || token.kind === "ident");
function nameAt(tokens, start) {
  if (!identifier(tokens[start])) return null;
  const parts = [tokens[start].kind === "word" ? tokens[start].value.toLowerCase() : tokens[start].value.slice(1, -1).replaceAll('""', '"')];
  let end = start + 1;
  if (tokens[end]?.value === ".") {
    if (!identifier(tokens[end + 1])) return null;
    const part = tokens[end + 1];
    parts.push(part.kind === "word" ? part.value.toLowerCase() : part.value.slice(1, -1).replaceAll('""', '"'));
    end += 2;
  }
  return { key: JSON.stringify(parts), end };
}
function closingParen(tokens, start) {
  if (tokens[start]?.value !== "(") return -1;
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].value === "(") depth++;
    if (tokens[i].value === ")" && --depth === 0) return i;
  }
  return -1;
}
function validType(tokens) {
  // Do not let a second ALTER action or expression masquerade as a type.
  const name = nameAt(tokens, 0);
  if (!name) return false;
  let i = name.end;
  if (is(tokens, 0, "DOUBLE") && is(tokens, i, "PRECISION")) i++;
  else if ((is(tokens, 0, "CHARACTER") || is(tokens, 0, "BIT")) && is(tokens, i, "VARYING")) i++;
  if (tokens[i]?.value === "(") {
    i++;
    if (tokens[i++]?.kind !== "number") return false;
    if (tokens[i]?.value === ",") {
      i++;
      if (tokens[i++]?.kind !== "number") return false;
    }
    if (tokens[i++]?.value !== ")") return false;
  }
  if ((is(tokens, 0, "TIMESTAMP") || is(tokens, 0, "TIME"))
      && (is(tokens, i, "WITH") || is(tokens, i, "WITHOUT"))
      && is(tokens, i + 1, "TIME") && is(tokens, i + 2, "ZONE")) i += 3;
  while (tokens[i]?.value === "[" && tokens[i + 1]?.value === "]") i += 2;
  return i === tokens.length;
}
function constant(tokens) {
  let i = 0;
  if (["+", "-"].includes(tokens[i]?.value)) i++;
  const value = tokens[i++];
  if (!value || !(value.kind === "string" || value.kind === "number"
      || (value.kind === "word" && ["TRUE", "FALSE", "NULL"].includes(value.value)))) return false;
  if (i === tokens.length) return true;
  if (tokens[i++]?.value !== "::") return false;
  return validType(tokens.slice(i));
}
function additiveColumn(tokens, start) {
  if (!(is(tokens, start, "ADD") && is(tokens, start + 1, "COLUMN")
      && is(tokens, start + 2, "IF") && is(tokens, start + 3, "NOT")
      && is(tokens, start + 4, "EXISTS") && identifier(tokens[start + 5]))) return false;
  const definition = tokens.slice(start + 6);
  if (definition.some((t) => t.kind === "word" && ["REFERENCES", "CHECK", "GENERATED", "UNIQUE", "PRIMARY", "CONSTRAINT", "COLLATE"].includes(t.value))) return false;
  const firstClause = definition.findIndex((t) => t.kind === "word" && ["DEFAULT", "NOT", "NULL"].includes(t.value));
  const type = firstClause < 0 ? definition : definition.slice(0, firstClause);
  if (!validType(type)) return false;
  let rest = firstClause < 0 ? [] : definition.slice(firstClause);
  let notNull = false;
  let hasDefault = false;
  if (is(rest, 0, "NOT") && is(rest, 1, "NULL")) { notNull = true; rest = rest.slice(2); }
  else if (is(rest, 0, "NULL")) rest = rest.slice(1);
  if (is(rest, 0, "DEFAULT")) {
    rest = rest.slice(1);
    // PostgreSQL also accepts NOT NULL after DEFAULT.
    if (rest.length >= 2 && is(rest, rest.length - 2, "NOT") && is(rest, rest.length - 1, "NULL")) {
      notNull = true; rest = rest.slice(0, -2);
    }
    hasDefault = constant(rest);
    if (!hasDefault) return false;
    rest = [];
  }
  return rest.length === 0 && (!notNull || hasDefault);
}
function additiveStatement(tokens, created) {
  if (is(tokens, 0, "CREATE") && is(tokens, 1, "TABLE") && is(tokens, 2, "IF")
      && is(tokens, 3, "NOT") && is(tokens, 4, "EXISTS")) {
    const table = nameAt(tokens, 5);
    if (!table || closingParen(tokens, table.end) !== tokens.length - 1 || tokens.length <= table.end + 2) return false;
    created.add(table.key);
    return true;
  }
  if (is(tokens, 0, "CREATE")) {
    let i = 1;
    const unique = is(tokens, i, "UNIQUE");
    if (unique) i++;
    if (!(is(tokens, i, "INDEX") && is(tokens, i + 1, "IF") && is(tokens, i + 2, "NOT") && is(tokens, i + 3, "EXISTS"))) return false;
    const index = nameAt(tokens, i + 4);
    if (!index || !is(tokens, index.end, "ON")) return false;
    const table = nameAt(tokens, index.end + 1);
    if (!table || (unique && !created.has(table.key))) return false;
    const rest = tokens.slice(table.end);
    return rest.length > 2 && rest.some((t) => t.value === "(");
  }
  if (is(tokens, 0, "ALTER") && is(tokens, 1, "TABLE")) {
    const table = nameAt(tokens, 2);
    if (!table) return false;
    if (is(tokens, table.end, "SET")) {
      return closingParen(tokens, table.end + 1) === tokens.length - 1 && tokens.length > table.end + 3;
    }
    return additiveColumn(tokens, table.end);
  }
  if (is(tokens, 0, "COMMENT") && is(tokens, 1, "ON")) {
    const at = tokens.findIndex((t, i) => i > 2 && t.kind === "word" && t.value === "IS");
    return at > 3 && at === tokens.length - 2
      && (tokens[at + 1].kind === "string" || is(tokens, at + 1, "NULL"));
  }
  return false;
}

export function classifyMigrationSql(sql) {
  if (typeof sql !== "string") return { additive: false, offending: "invalid SQL" };
  try {
    const statements = tokenize(sql);
    if (!statements.length) return { additive: false, offending: "empty SQL" };
    const created = new Set();
    for (const tokens of statements) {
      if (!additiveStatement(tokens, created)) {
        return { additive: false, offending: tokens.map((t) => t.value).join(" ").slice(0, 240) };
      }
    }
    return { additive: true, offending: null };
  } catch (error) {
    return { additive: false, offending: error.message };
  }
}
