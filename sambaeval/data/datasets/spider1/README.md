# Spider 1.0 fixture & conversion

This folder holds the [Spider 1.0](https://yale-lily.github.io/spider) text-to-SQL
fixture used by the `spider_example` experiment, plus the raw upstream inputs
needed to regenerate it and the SQLite databases the generator executes against.
Only `spider_examples.jsonl` (and this README) are committed; everything marked
gitignored must be supplied locally.

## Files

| File | Committed? | Purpose |
| ---- | ---------- | ------- |
| `spider_examples.jsonl` | ✅ yes | The committed fixture the generator reads: per example, `{example_id, db_id, question, gold_query}`. Keeps the gold SQL out of the model's prompt. |
| `../spider_dev.jsonl` | ✅ yes | The SambaEval dataset (1,034 rows): `{example_id, prompt, expected_output, weight}`. `prompt` is the rendered schema + question; `expected_output` is `contains:PASS`. Lives at `data/datasets/spider_dev.jsonl`. |
| `spider_data/` (or `spider/`) | ❌ gitignored | The unzipped raw download: `dev.json`, `train_spider.json`, `tables.json`, and the `database/` folder of SQLite files. Only needed to *regenerate* the fixture and to *run* the benchmark. |
| `spider_data/database/<db_id>/<db_id>.sqlite` | ❌ gitignored | The per-database SQLite files the generator executes predicted/gold SQL against at run time. Large; never committed. |

## Where to get the source files

The questions/queries are also on Hugging Face, **but only the Google Drive
bundle includes the SQLite `database/` files we need to execute SQL.**

1. Download `spider_data.zip` (linked from the [official Spider page](https://yale-lily.github.io/spider)):
   <https://drive.google.com/file/d/1403EGqzIDoHMdQF4c9Bkyl7dZLZ5Wt6J/view>.
   It is **~206 MB zipped** and unzips to **~1.7 GB on disk** (mostly the SQLite
   `database/` files).
2. Unzip it into this folder so you end up with:

   ```
   data/datasets/spider1/spider_data/
     ├── dev.json
     ├── train_spider.json
     ├── tables.json
     └── database/<db_id>/<db_id>.sqlite
   ```

   (Older bundles unzip to `spider/` instead of `spider_data/`; the converter
   accepts either, or the files dropped directly in this folder.)

## Regenerating the fixture

From the project root, after the download is in place:

```bash
python scripts/convert_spider.py   # writes ../spider_dev.jsonl + spider_examples.jsonl
```

This reads `dev.json` + `tables.json` and writes the committed dataset
`../spider_dev.jsonl` (one row per dev question, prompt = CREATE-TABLE schema +
question) and the committed fixture `spider_examples.jsonl` (db_id + gold query
per example). `example_id` is the row index within `dev.json`.

## Running the benchmark

1. Point the generator at the databases. `spider_db_path` near the top of
   `scripts/generators/spider_generator.py` defaults to the in-repo location
   above (`data/datasets/spider1/spider_data/database`), so if you unzipped the
   download into this folder as described, **no change is needed**. If you
   extracted `spider_data.zip` somewhere else, edit that one line to point at
   your `.../database` folder (it expands `~` and env vars).
2. Run the experiment:

   ```bash
   .venv/bin/sambaeval run data/experiments/spider_example.json --concurrency 4
   ```

The generator emits `PASS`/`FAIL` per question by executing the predicted query
read-only against the question's SQLite DB and comparing result sets to the gold
query (see `scripts/generators/spider_eval_utils.py` for the comparison
semantics). The heuristic scorer's `contains:PASS` turns that into a 0/1 score
per row, so the dataset mean is **execution accuracy (EX)**.

## Notes & possible extensions

- **Metric.** This implements single-database **execution accuracy**, the
  widely-reported Spider metric. Spider's more robust *test-suite accuracy*
  ([test-suite-sql-eval](https://github.com/taoyds/test-suite-sql-eval)) runs
  each query against several distilled databases to reduce false positives; it
  needs an extra database download and could be layered on later in
  `spider_generator.py` / `spider_eval_utils.py`.
- **Splits.** Only the public **dev** split is converted (1,034 questions). The
  Spider test set is held out (submissions closed Feb 2024). The `train_spider.json`
  in the download is unused.
- **Schema rendering** includes column types, primary keys, and foreign keys
  (`build_schema_strings` in `scripts/convert_spider.py`).
