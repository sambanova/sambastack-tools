"""Spider 1.0 execution-accuracy OutputGenerator for SambaEval.

Spider is a cross-domain text-to-SQL benchmark; correctness is decided by
*executing* the model's predicted SQL and the gold SQL against the question's
SQLite database and comparing the result sets (execution accuracy, EX). This
generator reproduces that flow for one question per dataset row:

1. Generate one SQL query for the row's prompt (schema + question), then extract
   the bare query from the model's response (tolerating ```sql fences / prose).
2. Look up the question's db_id and gold query by `self.example_id` in the
   converted fixture (data/datasets/spider1/spider_examples.jsonl).
3. Execute the predicted and gold queries against the db_id's SQLite file
   (opened READ-ONLY, with a row cap and statement timeout), and compare the
   result sets with Spider's semantics (multiset of rows unless the gold query
   has a top-level ORDER BY; tolerant to SELECT column order). See
   spider_eval_utils.py.
4. Emit "PASS" when the result sets match, else "FAIL\\n<reason>". The
   experiment scores this with the heuristic scorer's contains: mode
   ("contains:PASS"), so a match earns the row's full weight and a mismatch 0 —
   the dataset's mean score is execution accuracy.

REQUIRED ONE-TIME SETUP: download the Spider databases (the `database/` folder
inside spider_data.zip) and set `spider_db_path` below to that folder. The
SQLite files are large and gitignored — never committed. See the Spider section
of the README and data/datasets/spider1/README.md.

SECURITY: this generator executes model-generated SQL. SQL is far lower-risk
than arbitrary Python, so (unlike the SciCode generator's container sandbox) we
execute in-process against a connection opened READ-ONLY via SQLite's URI
`mode=ro`, which rejects any statement that would write. As defense-in-depth we
also (a) refuse multi-statement predictions, (b) reject statements that are not
a single SELECT/WITH read query by keyword screen, (c) cap returned rows, and
(d) abort long-running queries with a wall-clock interrupt. This is appropriate
for a trusted benchmark; do not point it at untrusted databases.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import threading

from base import OutputGenerator, ROOT, run_cli
from spider_eval_utils import gold_order_matters, result_eq


# ---------------------------------------------------------------------------
# >>> EDIT THIS IF YOU EXTRACTED THE DATA ELSEWHERE <<<  Path to the Spider
# `database/` folder (the one holding <db_id>/<db_id>.sqlite for every
# database). Defaults to the in-repo location where the README tells you to
# unzip spider_data.zip; resolved relative to the repo root, and '~' / env vars
# are expanded.
# ---------------------------------------------------------------------------
spider_db_path = os.path.join(
    ROOT, "data", "datasets", "spider1", "spider_data", "database"
)


FIXTURE_PATH = os.path.join(
    ROOT, "data", "datasets", "spider1", "spider_examples.jsonl"
)

# Abort a single query after this many wall-clock seconds (per query).
QUERY_TIMEOUT_SECONDS = 30
# Cap rows pulled back from either query — guards a runaway cross join from
# exhausting memory. Far above any gold result set in the dev split.
MAX_ROWS = 100_000
# Extra attempts to re-generate when the response yields no extractable SQL.
EMPTY_GENERATION_RETRIES = 2

# A predicted query must be a single read statement. We screen on the leading
# keyword (after stripping comments) rather than parsing SQL.
_READ_LEADING = ("select", "with")


def _resolved_db_root() -> str:
    """Absolute path to the Spider database/ folder, expanding '~' / env vars."""
    return os.path.abspath(
        os.path.expandvars(os.path.expanduser(spider_db_path))
    )


def _db_file(db_id: str) -> str:
    return os.path.join(_resolved_db_root(), db_id, f"{db_id}.sqlite")


_SQL_FENCE_RE = re.compile(r"```sql\b[ \t]*\r?\n?(.*?)```", re.DOTALL | re.IGNORECASE)
_ANY_FENCE_RE = re.compile(r"```[ \t]*\r?\n?(.*?)```", re.DOTALL)
_LINE_COMMENT_RE = re.compile(r"--[^\n]*")
_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)


def extract_sql(response: str) -> str:
    """Pull a single SQL query out of a model response.

    Prefers the last ```sql fenced block, then any ``` block, then the raw
    text. Strips trailing semicolons and a leading "SQL:" label some models
    emit. Returns the first statement only.
    """
    blocks = _SQL_FENCE_RE.findall(response)
    if not blocks:
        blocks = _ANY_FENCE_RE.findall(response)
    if blocks:
        non_empty = [b for b in blocks if b.strip()]
        sql = (non_empty[-1] if non_empty else blocks[-1])
    else:
        sql = response
    sql = sql.strip()
    sql = re.sub(r"^\s*sql\s*:\s*", "", sql, flags=re.IGNORECASE)
    # Keep only the first statement (up to the first semicolon that ends it).
    sql = sql.split(";")[0]
    return sql.strip()


def _strip_comments(sql: str) -> str:
    sql = _BLOCK_COMMENT_RE.sub(" ", sql)
    sql = _LINE_COMMENT_RE.sub(" ", sql)
    return sql.strip()


def is_read_only(sql: str) -> bool:
    """True iff `sql` is a single SELECT/WITH read query (best-effort screen)."""
    body = _strip_comments(sql)
    if not body:
        return False
    if ";" in body.rstrip(";"):  # an interior semicolon => multiple statements
        return False
    first = body.lstrip("(").split(None, 1)[0].lower() if body else ""
    return first in _READ_LEADING


def load_example(example_id) -> dict | None:
    if example_id is None:
        return None
    target = str(example_id)
    with open(FIXTURE_PATH, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            ex = json.loads(line)
            if str(ex["example_id"]) == target:
                return ex
    return None


def _run_query(db_file: str, sql: str) -> tuple[list | None, str]:
    """Execute `sql` read-only against `db_file`.

    Returns (rows, "") on success or (None, error) on failure. The connection
    is opened with SQLite's URI `mode=ro` so any write is rejected by the
    engine itself; a watchdog interrupts queries exceeding the timeout.
    """
    uri = f"file:{db_file}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=QUERY_TIMEOUT_SECONDS)
    # Decode bytes leniently — some Spider DBs store non-UTF-8 text.
    conn.text_factory = lambda b: b.decode("utf-8", "replace")
    timer = threading.Timer(QUERY_TIMEOUT_SECONDS, conn.interrupt)
    timer.start()
    try:
        cur = conn.execute(sql)
        rows = cur.fetchmany(MAX_ROWS)
        return rows, ""
    except sqlite3.Error as e:
        return None, f"{type(e).__name__}: {e}"
    finally:
        timer.cancel()
        conn.close()


class SpiderGenerator(OutputGenerator):
    def _generate_sql(self, system_prompt: str, messages: list[dict]) -> str:
        full: list[dict] = []
        if system_prompt:
            full.append({"role": "system", "content": system_prompt})
        full.extend(messages)
        kwargs = self.completion_kwargs()
        sql = ""
        for _ in range(EMPTY_GENERATION_RETRIES + 1):
            response = self.stream_completion(full, **kwargs)
            sql = extract_sql(response)
            if sql.strip():
                return sql
        return sql

    def generate_output(self, system_prompt: str, messages: list[dict]) -> str:
        ex = load_example(self.example_id)
        if ex is None:
            return (
                f"FAIL\nNo Spider example with id {self.example_id!r} in the "
                "fixture. Re-run scripts/convert_spider.py."
            )
        db_id = ex["db_id"]
        gold_query = ex["gold_query"]
        db_file = _db_file(db_id)
        if not os.path.isfile(db_file):
            return (
                f"FAIL\nDatabase file not found: {db_file!r}. Download the "
                "Spider databases and set spider_db_path in spider_generator.py "
                "(see the Spider section of the README)."
            )

        predicted = self._generate_sql(system_prompt, messages)
        if not predicted.strip():
            return "FAIL\nmodel returned no SQL query"
        if not is_read_only(predicted):
            return f"FAIL\nrejected non-read-only / multi-statement query:\n{predicted}"

        pred_rows, pred_err = _run_query(db_file, predicted)
        if pred_err:
            return f"FAIL\npredicted query error: {pred_err}\nquery:\n{predicted}"

        gold_rows, gold_err = _run_query(db_file, gold_query)
        if gold_err:
            # A failing gold query means a broken fixture/DB, not a model error.
            return f"FAIL\ngold query error (check fixture/DB): {gold_err}"

        order_matters = gold_order_matters(gold_query)
        if result_eq(pred_rows, gold_rows, order_matters):
            return "PASS"
        return (
            f"FAIL\nresult mismatch (order_matters={order_matters})\n"
            f"predicted: {predicted}\ngold: {gold_query}"
        )


if __name__ == "__main__":
    run_cli(SpiderGenerator)
