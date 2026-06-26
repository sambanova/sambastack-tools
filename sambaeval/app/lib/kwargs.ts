// Shared helpers for the "additional keyword args" editors (experiment models
// and judge scorers). The editor keeps an ordered list of {key, valueStr} rows
// as the source of truth while editing — preserving insertion order and letting
// users rename keys mid-typing — and folds them into a Record on save.

export type KwargRow = { key: string; valueStr: string };

export function parseKwargValue(s: string): unknown {
  // Try JSON first so numbers, booleans, arrays, and explicitly-quoted strings
  // round-trip as their actual types. Fall back to the raw text so a user typing
  // `stop_word` (unquoted) still produces *something* — though the help text
  // tells them to quote string values explicitly.
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function rowsToRecord(rows: KwargRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (key === "") continue;
    out[key] = parseKwargValue(r.valueStr);
  }
  return out;
}

export function recordToRows(
  rec: Record<string, unknown> | undefined,
): KwargRow[] {
  if (!rec) return [];
  return Object.entries(rec).map(([k, v]) => ({
    key: k,
    valueStr: JSON.stringify(v),
  }));
}
