"""Minimal CSV codec.

We reimplement (rather than use the stdlib ``csv`` module) so result files
round-trip with stable, minimal quoting: fields are quoted only when they
contain ``, " \\n \\r``, quotes are doubled, rows are joined with ``\\n`` and
the output ends with a trailing newline.
"""

from __future__ import annotations


def parse_records(text: str) -> list[list[str]]:
    records: list[list[str]] = []
    row: list[str] = []
    field = ""
    in_quotes = False
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if in_quotes:
            if ch == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field += '"'
                    i += 2
                    continue
                in_quotes = False
                i += 1
                continue
            field += ch
            i += 1
            continue
        if ch == '"':
            in_quotes = True
            i += 1
            continue
        if ch == ",":
            row.append(field)
            field = ""
            i += 1
            continue
        if ch == "\r":
            i += 1
            continue
        if ch == "\n":
            row.append(field)
            records.append(row)
            row = []
            field = ""
            i += 1
            continue
        field += ch
        i += 1
    if len(field) > 0 or len(row) > 0:
        row.append(field)
        records.append(row)
    return records


def parse_csv(text: str) -> tuple[list[str], list[dict[str, str]]]:
    records = parse_records(text)
    if not records:
        return [], []
    headers = records[0]
    rows: list[dict[str, str]] = []
    for cells in records[1:]:
        if len(cells) == 1 and cells[0] == "":
            continue
        rows.append({h: (cells[i] if i < len(cells) else "") for i, h in enumerate(headers)})
    return headers, rows


def _escape(v: str) -> str:
    if "," in v or '"' in v or "\n" in v or "\r" in v:
        return '"' + v.replace('"', '""') + '"'
    return v


def stringify_csv(headers: list[str], rows: list[list[str]]) -> str:
    lines = [",".join(_escape(h) for h in headers)]
    for row in rows:
        lines.append(",".join(_escape(c) for c in row))
    return "\n".join(lines) + "\n"
