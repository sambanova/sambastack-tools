"""Convert the Spider 1.0 text-to-SQL benchmark into the format SambaEval consumes.

Spider (https://yale-lily.github.io/spider) is a large-scale, cross-domain
text-to-SQL benchmark: natural-language questions over 200 multi-table SQLite
databases. Given a database schema and a question, a system must produce the
SQL query that answers it. The standard metric is *execution accuracy* (EX):
run the predicted SQL and the gold SQL against the database's SQLite file and
compare the result sets. So — like SciCode — there are no "gold answer strings"
to put in `expected_output`; instead `expected_output` is the literal
"contains:PASS" and the spider_generator executes both queries to decide
PASS/FAIL.

This script reads the raw Spider download (the dev split + the shared schema
file) from data/datasets/spider1/spider_data/ and emits:

1. data/datasets/spider_dev.jsonl
       The SambaEval dataset — one row per question:
       {example_id, prompt, expected_output, weight}. `prompt` is the rendered
       database schema (CREATE TABLE statements with primary/foreign keys, built
       from tables.json) followed by the question. `example_id` is the row index
       within dev.json; the generator uses it to look up the question's db_id and
       gold query in the fixture below.

2. data/datasets/spider1/spider_examples.jsonl
       A self-contained runtime fixture read by
       scripts/generators/spider_generator.py: per example, the db_id and the
       gold SQL query. Keeping the gold query here (rather than in the dataset
       row's `expected_output`) keeps it out of the model's prompt and lets the
       generator grade by execution.

The large SQLite database files (data/datasets/spider1/spider_data/database/)
are NOT consumed here — they are needed only at *run* time by the generator,
which is pointed at them via `spider_db_path`. They are gitignored; see the
folder README for download instructions.

Usage:
    python scripts/convert_spider.py            # writes spider_dev.jsonl + fixture
"""

from __future__ import annotations

import argparse
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPIDER_DIR = os.path.join(ROOT, "data", "datasets", "spider1")
# The raw download unzips to a `spider_data/` subfolder (older bundles used
# `spider/`); we accept either. Both are gitignored — see the folder README.
SOURCE_CANDIDATES = (
    os.path.join(SPIDER_DIR, "spider_data"),
    os.path.join(SPIDER_DIR, "spider"),
    SPIDER_DIR,  # files dropped directly in the folder
)

DATASET_DEV_OUT = os.path.join(ROOT, "data", "datasets", "spider_dev.jsonl")
FIXTURE_OUT = os.path.join(SPIDER_DIR, "spider_examples.jsonl")

# Instruction appended after the schema + question so the model returns a bare
# query the generator can execute (no prose, no fences required but tolerated).
ANSWER_INSTRUCTION = (
    "Using valid SQLite, answer the question with a single SQL query. "
    "Return only the SQL query."
)


def _load_json(path: str) -> object:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _find_source() -> str:
    """Return the directory holding dev.json + tables.json, or raise."""
    for root in SOURCE_CANDIDATES:
        if os.path.isfile(os.path.join(root, "dev.json")) and os.path.isfile(
            os.path.join(root, "tables.json")
        ):
            return root
    raise SystemExit(
        "Spider source not found. Download spider_data.zip and unzip it into "
        f"{os.path.relpath(SPIDER_DIR, ROOT)} so that dev.json and tables.json "
        "are present (see that folder's README for the download link)."
    )


def build_schema_strings(tables: list[dict]) -> dict[str, str]:
    """Render one CREATE-TABLE-style schema string per db_id from tables.json.

    Includes column types, primary keys, and foreign keys — the schema detail
    strong Spider prompting baselines provide to the model.
    """
    schemas: dict[str, str] = {}
    for db in tables:
        db_id = db["db_id"]
        table_names = db["table_names_original"]
        # column_names_original: [[table_idx, col_name], ...]; index 0 is the
        # synthetic [-1, "*"] entry, which we skip.
        columns = db["column_names_original"]
        column_types = db["column_types"]
        primary_keys = set(db.get("primary_keys", []))
        # foreign_keys: [[from_col_idx, to_col_idx], ...]
        foreign_keys = db.get("foreign_keys", [])

        # Group columns (and whether each is a PK) by their owning table.
        per_table: list[list[tuple[str, str, bool]]] = [
            [] for _ in table_names
        ]
        for col_idx, (tbl_idx, col_name) in enumerate(columns):
            if tbl_idx < 0:
                continue  # the "*" pseudo-column
            per_table[tbl_idx].append(
                (col_name, column_types[col_idx], col_idx in primary_keys)
            )

        # Resolve foreign keys to (from_table, from_col, to_table, to_col).
        fks_by_table: list[list[str]] = [[] for _ in table_names]
        for from_idx, to_idx in foreign_keys:
            from_tbl, from_col = columns[from_idx]
            to_tbl, to_col = columns[to_idx]
            if from_tbl < 0 or to_tbl < 0:
                continue
            fks_by_table[from_tbl].append(
                f'  FOREIGN KEY ("{from_col}") REFERENCES '
                f'"{table_names[to_tbl]}"("{to_col}")'
            )

        blocks: list[str] = []
        for tbl_idx, tbl_name in enumerate(table_names):
            lines = [f'CREATE TABLE "{tbl_name}" (']
            body: list[str] = [
                f'  "{name}" {ctype}' for name, ctype, _ in per_table[tbl_idx]
            ]
            pk_cols = [name for name, _, is_pk in per_table[tbl_idx] if is_pk]
            if pk_cols:
                cols = ", ".join(f'"{c}"' for c in pk_cols)
                body.append(f"  PRIMARY KEY ({cols})")
            body.extend(fks_by_table[tbl_idx])
            lines.append(",\n".join(body))
            lines.append(");")
            blocks.append("\n".join(lines))
        schemas[db_id] = "\n\n".join(blocks)
    return schemas


def build_prompt(schema: str, question: str) -> str:
    return (
        f"{schema}\n\n"
        f"-- Question: {question.strip()}\n\n"
        f"{ANSWER_INSTRUCTION}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.parse_args()

    source = _find_source()
    dev = _load_json(os.path.join(source, "dev.json"))
    tables = _load_json(os.path.join(source, "tables.json"))
    schemas = build_schema_strings(tables)

    dataset_rows: list[dict] = []
    fixture_rows: list[dict] = []
    missing_schema: set[str] = set()
    for example_id, ex in enumerate(dev):
        db_id = ex["db_id"]
        question = ex["question"]
        gold_query = ex["query"]
        schema = schemas.get(db_id)
        if schema is None:
            missing_schema.add(db_id)
            schema = f"-- (schema for {db_id} not found in tables.json)"
        dataset_rows.append(
            {
                "example_id": example_id,
                "prompt": build_prompt(schema, question),
                # The spider_generator executes the predicted query against the
                # database and emits "PASS"/"FAIL ..."; the heuristic scorer's
                # contains: prefix awards full weight when the output contains
                # "PASS" (an incorrect query yields "FAIL", which does not).
                "expected_output": "contains:PASS",
                "weight": 1.0,
            }
        )
        fixture_rows.append(
            {
                "example_id": example_id,
                "db_id": db_id,
                "question": question,
                "gold_query": gold_query,
            }
        )

    os.makedirs(SPIDER_DIR, exist_ok=True)
    with open(FIXTURE_OUT, "w", encoding="utf-8") as f:
        for row in fixture_rows:
            f.write(json.dumps(row) + "\n")
    with open(DATASET_DEV_OUT, "w", encoding="utf-8") as f:
        for row in dataset_rows:
            f.write(json.dumps(row) + "\n")

    print(
        f"Wrote fixture:  {os.path.relpath(FIXTURE_OUT, ROOT)} "
        f"({len(fixture_rows)} examples)"
    )
    print(
        f"Wrote dataset:  {os.path.relpath(DATASET_DEV_OUT, ROOT)} "
        f"({len(dataset_rows)} examples)"
    )
    if missing_schema:
        print(
            f"WARNING: {len(missing_schema)} db_id(s) had no schema in "
            f"tables.json: {', '.join(sorted(missing_schema))}"
        )


if __name__ == "__main__":
    main()
