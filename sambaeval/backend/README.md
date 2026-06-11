# SambaEval — Python engine (library + CLI)

This package is SambaEval's backend — the evaluation engine (dataset loading,
the concurrent thread pool, heuristic + LLM-judge scoring, output generation,
results/run-metadata writing). It's available three ways: as an importable
Python library, a `sambaeval` command-line tool, and an HTTP API
(`sambaeval-server`) that the web UI talks to.

## Install

Install editable into the project's Python venv. From the `sambaeval/` project
root (create the venv first with `python -m venv .venv` if you don't have one):

```bash
.venv/bin/python -m pip install -e backend
```

This adds `pydantic` and `httpx` alongside the existing generator dependencies
(`openai`, `numpy`, `scipy`, `sympy`, `h5py`, `llm-sandbox`). It also installs
the `sambaeval` and `sambaeval-server` console scripts.

> **Running the commands:** the console scripts live in `.venv/bin/`, so they
> are not on your `PATH` unless the venv is active. Either call them by path
> (`.venv/bin/sambaeval …`) or `source .venv/bin/activate` once and then use
> `sambaeval …` / `sambaeval-server` bare. The examples below assume the venv is
> active; prefix `.venv/bin/` otherwise.

## Run an experiment

```bash
sambaeval run <experiment.json> [--concurrency N] [--resume]
```

- `<experiment.json>` — path to an experiment file (anywhere on disk).
- `--concurrency N` — max concurrent tasks, clamped to `1–32`. Defaults to the
  experiment's `concurrency` field, or `4`.
- `--resume` — resume the latest non-completed run for this experiment id
  instead of starting fresh (completed `(model, example)` rows are carried over).

Progress streams to stderr; on completion it prints per-model average scores,
completed/error counts, and the results directory. Exit code is `1` if any row
errored, else `0`.

```
$ sambaeval run data/experiments/codegen_example.json --concurrency 4
[15/15] 100.0%  errors=0 — SambaNova/Meta-Llama-3.3-70B-Instruct #5

Run 2026-06-11T16-45-15-273Z: completed
  completed=15  errors=0
  average score by model:
    SambaNova/Meta-Llama-3.3-70B-Instruct: 1.000  (n=5)
    SambaNova/MiniMax-M2.7: 1.000  (n=5)
    SambaNova/gemma-4-31B-it: 1.000  (n=5)
  results: data/results/codegen_example/2026-06-11T16-45-15-273Z
```

Results are written exactly where the UI writes them —
`data/results/<experiment_id>/<run_id>/` (`results.csv`, `run.json`, and an
`experiment.json` snapshot) — so runs are interchangeable with the UI and show
up in it.

## What must exist outside the experiment file

The CLI is designed so an experiment file can be **self-contained** (see below),
but two things necessarily live outside it:

1. **`data/providers.json`** — your OpenAI-compatible endpoints and API keys.
   Unlike the UI (which auto-creates a placeholder), **the CLI errors if this
   file is missing** rather than silently writing a stub. Copy the template,
   then edit `api_key` before running:

   ```bash
   cp data/providers.json.example data/providers.json
   ```

2. **A custom `output_generator`**, if you use one — it's a path to a Python
   script under `scripts/generators/` (Python can't be inlined into JSON). The
   default generator needs no file; leave `output_generator` blank.

## Self-contained experiment files

The CLI extends the experiment schema so the dataset and the LLM-judge can be
embedded directly, in addition to being referenced by filename:

- **`dataset`** — a filename in `data/datasets/` **or** an inline list of rows.
- **`scorer`** (LLM judge) — `{"type":"llm","scorer_name":"<name>"}` referencing
  `data/scorers/<name>.json`, **or** `{"type":"llm","definition":{...}}` with the
  full judge definition inline.

A fully self-contained example (no files in `data/datasets/` or `data/scorers/`
required — only `providers.json`):

```jsonc
{
  "id": "inline_demo",
  "name": "Inline demo",
  "system_prompt": "You are a careful assistant. Answer with only the value.",
  "models": [
    { "name": "Meta-Llama-3.3-70B-Instruct", "provider_name": "SambaNova",
      "temperature": 0, "seed": 42, "system_prompt": "global" }
  ],
  "dataset": [
    { "example_id": 1, "prompt": "Capital of France?",
      "expected_output": "contains:Paris", "weight": 1.0 },
    { "example_id": 2, "messages": [{ "role": "user", "content": "2+2?" }],
      "expected_output": "4", "weight": 1.0 }
  ],
  "scorer": {
    "type": "llm",
    "definition": {
      "name": "inline_judge", "provider_name": "SambaNova",
      "model": "gpt-oss-120b", "temperature": 0, "max_score": 5,
      "judge_prompt": "Prompt:\n{prompt}\nExpected:\n{expected_output}\nGot:\n{output}\nScore 0..{max_score} as JSON {\"score\":int,\"score_reason\":str}."
    }
  }
}
```

Inline dataset rows follow the same rules as a JSONL dataset: each needs an
`example_id` and exactly one of `prompt` or `messages`; `expected_output` and
`weight` (default `1.0`) are optional. Omit `scorer` entirely for the heuristic
scorer (`exact` / `contains:` / `ratio:` — see the main README's
[Scoring](../README.md#scoring) section).

## Run the API server

The same engine is exposed over HTTP via a FastAPI app serving the `/api/...`
routes (experiments, providers, datasets, scorers, runs, results, and an SSE
run endpoint). This is what the web UI talks to.

Install the server extra (adds `fastapi` + `uvicorn`), then run it (serves on
<http://127.0.0.1:8000>):

```bash
.venv/bin/python -m pip install -e 'backend[server]'
sambaeval-server
```

The run endpoint (`POST /api/experiments/{id}/run`) streams
`progress`/`done`/`error` Server-Sent Events; closing the connection cancels
the run.

## Use as a library

```python
from sambaeval import Experiment, run_experiment

exp = Experiment.model_validate_json(open("my_experiment.json").read())
result = run_experiment(exp, concurrency=8)        # mode="new" by default
print(result.run_id, result.meta.status, result.meta.completed)
for row in result.results:
    print(row.model, row.example_id, row.score)
```

`run_experiment` accepts an optional `on_progress` callback, a `cancel_event`
(`threading.Event`) for cooperative cancellation, and `mode="resume"` with a
`run_id`.

## Notes

- **Concurrency uses threads** (`ThreadPoolExecutor`). The work is I/O-bound
  (provider HTTP calls; SciCode runs in a Podman container), so the GIL is
  released during the blocking waits and threads give true concurrency while
  keeping the synchronous generator extension API intact.
- **Data directory**: defaults to `<repo>/sambaeval/data`. Override with the
  `SAMBAEVAL_DATA_DIR` environment variable.
- Output generators are loaded **in-process** from `scripts/generators/` — no
  per-task subprocess. The engine uses the class your script passes to
  `run_cli(<Class>)`; with no `run_cli` it uses the sole `OutputGenerator`
  subclass, or the base class (like `default_generator.py`).
