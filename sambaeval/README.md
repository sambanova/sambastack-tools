<a href="https://sambanova.ai/">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/light-logo.png" height="100">
  <img alt="SambaNova logo" src="../images/dark-logo.png" height="100">
</picture>
</a>

# SambaEval

Local LLM evaluation workbench. Configure providers, build experiments with one or more models, score them against a dataset, and explore the results — including token usage, TTFT, and tokens-per-second per row.

SambaEval runs two ways from one evaluation engine:

- **File mode (default, zero infra):** drive evals from the CLI (`sambaeval run experiment.json`) or a simple local web UI; all state is plain files under `data/` — no database, no services.
- **Database mode (multi-user web app):** Postgres + object storage (MinIO/S3) + a decoupled worker + Google sign-in, giving each user a private-by-default space that can be shared by link or made public. Run the whole stack locally with Docker Compose, or deploy it with the Helm chart. This is the hosted/shared configuration.

The backend is selected by `SAMBAEVAL_STORAGE_BACKEND` (`files` default, or `db`). The CLI and Python library are always available; the web UI is optional in file mode and central in database mode.

## Contents

- [Stack](#stack)
- [Quick start](#quick-start)
  - [CLI (no UI)](#cli-no-ui)
  - [Optional: the web UI](#optional-the-web-ui)
- [Running the web app (database-backed)](#running-the-web-app-database-backed)
  - [Local (Docker Compose)](#local-docker-compose)
  - [Seeding the database](#seeding-the-database)
- [Command-line interface](#command-line-interface)
- [File layout](#file-layout)
  - [Example experiments at a glance](#example-experiments-at-a-glance)
- [The web UI (optional)](#the-web-ui-optional)
- [Configuring providers](#configuring-providers)
- [Experiment schema](#experiment-schema)
- [Dataset schema](#dataset-schema)
- [Scoring](#scoring)
  - [Scorers](#scorers)
- [Running an experiment](#running-an-experiment)
- [Results](#results)
- [Merging runs in experiments](#merging-runs-in-experiments)
  - [Starting a new run from an existing run](#starting-a-new-run-from-an-existing-run)
  - [Combining runs at the end of a run](#combining-runs-at-the-end-of-a-run)
- [Custom output generators](#custom-output-generators)
- [SciCode example](#scicode-example-executing-model-code)
  - [One-time setup: the numeric reference data](#one-time-setup-the-numeric-reference-data)
  - [Regenerating / resizing the dataset](#regenerating--resizing-the-dataset)
  - [Running model code safely](#running-model-code-safely)
- [Spider 1.0 example (text-to-SQL)](#spider-10-example-text-to-sql)
- [Testing](#testing)

## Stack

The evaluation engine is a **Python package** (`sambaeval`) — dataset loading, the concurrent run engine, scoring, and output generation (model calls, tool-use loops, sandboxed code execution). You use it directly as a **CLI** or **library**, or run it behind an **HTTP API** that the web UI talks to. It has two storage backends, chosen by `SAMBAEVAL_STORAGE_BACKEND`:

- **`files`** (default) — single-user; all state (provider configs, experiments, datasets, results) is plain files under `data/`. No database, no services.
- **`db`** — multi-user; results + run metadata in **Postgres**, dataset blobs in **MinIO/S3**, per-user provider keys encrypted at rest, runs executed by a **decoupled worker**, users authenticated via **Google** (or a local dev user). This is what the Docker Compose stack and the Helm chart deploy.

- **Engine / CLI / library / API:** Python 3.11+ — the `sambaeval` package (`sambaeval run` CLI; `sambaeval-server` FastAPI app; `sambaeval-worker` run executor). See [backend/README.md](backend/README.md).
- **Web UI:** Next.js 16 (App Router) + React 19 + TypeScript + Tailwind CSS v4 — talks to the API over HTTP (`NEXT_PUBLIC_API_BASE_URL`, default `http://localhost:8000`).
- **Database mode adds** Postgres, MinIO, the worker, Alembic migrations, and auth — all wired by `deploy/local/docker-compose.yml` (local) and `helm/sambaeval` (prod). Design + deployment details: [private/prodplan.md](private/prodplan.md).

## Quick start

You only need Python to run evals — the web UI is optional.

### CLI (no UI)

One-time setup from the project root:

```bash
python -m venv .venv
.venv/bin/python -m pip install -e backend
cp data/providers.json.example data/providers.json
```

Open `data/providers.json` and set a real `api_key`, then run any experiment:

```bash
.venv/bin/sambaeval run data/experiments/codegen_example.json --concurrency 4
```

That runs an example end-to-end and writes results under `data/results/`. (`.venv/bin/sambaeval` calls the CLI without activating the venv; or run `source .venv/bin/activate` once, after which plain `sambaeval …` works.) See [Command-line interface](#command-line-interface) for full usage.

### Optional: the web UI

This runs the UI in **file mode** (single-user, no database) — for the multi-user, database-backed app (Postgres + worker + auth) see [Running the web app (database-backed)](#running-the-web-app-database-backed).

For interactive editing and result browsing, run the backend API and the frontend as two processes, in two terminals.

Terminal 1 — backend API (serves <http://localhost:8000>):

```bash
.venv/bin/python -m pip install -e 'backend[server]'
.venv/bin/sambaeval-server
```

Terminal 2 — frontend (serves <http://localhost:3001>):

```bash
npm install
npm run dev
```

Open <http://localhost:3001>. (SambaEval defaults to 3001 so it can run side-by-side with SambaWiz on 3000.) The UI talks to the backend at `http://localhost:8000`; set `NEXT_PUBLIC_API_BASE_URL` to point elsewhere. Set your inference keys on the **Providers** page — see [Configuring providers](#configuring-providers) for where they're stored (`data/providers.json` in file mode, or per-user in the database in db mode).

## Running the web app (database-backed)

The multi-user web app (`SAMBAEVAL_STORAGE_BACKEND=db`) stores state in Postgres + MinIO, executes runs on a decoupled worker, and authenticates users. Run the whole stack locally with Docker Compose, or deploy it with the Helm chart (`helm/sambaeval`; see [private/prodplan.md](private/prodplan.md)).

### Local (Docker Compose)

```bash
make dev-stack     # build + start postgres, minio, api, worker, frontend
make dev-seed      # load the public example content (see Seeding below)
# open http://localhost:3001   — the local dev auth signs you in automatically
```

`make dev-stack` creates `deploy/local/.env` from `deploy/local/.env.example` and brings up all five services; the api runs `alembic upgrade head` on boot. `AUTH_BACKEND=dev` (the local default) auto-signs-in a fixed dev user, so no Google client is needed locally. Stop with `make dev-stop`; wipe the volumes with `make dev-nuke`. (MinIO is published on host ports `9100/9101` and Postgres on `5433` to avoid clashing with other local stacks.)

> **Code-execution runs (SciCode) need a native worker.** The compose `worker` container has no container runtime — Compose cannot run podman-in-docker — so a SciCode run claimed by it aborts with "no `podman` executable". Stop that container and run the worker on the host instead, where Podman lives:
>
> ```bash
> docker compose -f deploy/local/docker-compose.yml stop worker
> cd backend && \
>   DATABASE_URL='postgresql+psycopg://sambaeval:sambaeval@localhost:5433/sambaeval' \
>   S3_ENDPOINT_URL='http://localhost:9100' \
>   .venv/bin/sambaeval-worker
> ```
>
> The host-facing ports replace the compose-internal `postgres:5432` / `minio:9000` from `.env`. Everything else (api, frontend, Postgres, MinIO) stays in Compose.

### Seeding the database

A fresh database starts empty except for the **system user** and the **generator catalog**, which are seeded automatically on api startup. The public example content — experiments, scorers, datasets, and the precomputed example results under `data/` — is loaded by a one-time, **idempotent backfill**, all owned by the system user and marked public (re-running is safe: experiments/scorers/datasets upsert, existing runs are skipped).

Because the prod images do **not** bake in the `data/` tree, the seed content is shipped through the object store: upload it once, then a backfill pulls it and loads Postgres + MinIO.

**Local** — `make dev-seed` runs both steps for you:

```bash
make dev-seed
#  = make seed-upload           # push data/ -> MinIO under the `seed/` prefix
#    then, in the api container: sambaeval-backfill --seed-prefix seed
```

**Production** — the same two steps:

```bash
# 1) Once, from a checkout that has the example data/, pointed at the prod object store:
sambaeval-seed push --data-dir data --prefix seed
# 2) Enable the Helm seed Job (a post-install hook that runs after the DB migration):
helm upgrade --install sambaeval helm/sambaeval \
  -f helm/sambaeval/values-prod.yaml --set seed.enabled=true
```

The seed bundle contains only what the backfill consumes (`experiments/*.json`, `scorers/*.json`, top-level `datasets/*.{jsonl,csv}`, and the `results/` tree). Large fixtures (`chinook.db`, `*.h5`, `scicode/`, `spider1/`) are **excluded** — they come through the admin API when the code-execution sandbox is enabled.

## Command-line interface

The CLI runs experiments headlessly — no web server, no Node. It's the primary way to use SambaEval in scripts and CI.

```bash
.venv/bin/sambaeval run <experiment.json> [--concurrency N] [--resume]
```

- `<experiment.json>` — path to an experiment file, anywhere on disk.
- `--concurrency N` — max concurrent tasks (1–32); defaults to the experiment's `concurrency`, or 4.
- `--resume` — resume the latest unfinished run for this experiment instead of starting fresh.

It writes results to `data/results/<id>/<run_id>/` (the same place the UI reads from), prints per-model average scores, and exits non-zero if any row errored.

- **`providers.json` is required.** Unlike the UI, the CLI does not auto-create it — copy `data/providers.json.example` to `data/providers.json` and add your key.
- **Experiment files can be self-contained.** The `dataset` and the LLM-judge definition can be inlined directly in the experiment JSON, so a single file is fully portable — no separate dataset/scorer files needed.

SambaEval is also an importable library: `from sambaeval import run_experiment`. See [backend/README.md](backend/README.md) for the complete CLI reference, the self-contained experiment schema, and the library API.

## File layout

In **file mode** (the default), all evaluation state — provider configs, experiment definitions, datasets, and results — is stored as plain files under `data/`, so it's easy to inspect, diff, and version-control; the app reads and writes these files directly. In **database mode**, this same `data/` tree becomes the **seed source** — loaded once via the backfill (see [Seeding the database](#seeding-the-database)) — and the live state then lives in Postgres + MinIO instead.

```
data/
├── providers.json                       # autogenerated; gitignored — holds API keys
├── experiments/
│   └── <id>.json                        # experiment definitions
├── scorers/
│   └── <name>.json                      # reusable LLM-as-judge configs
├── datasets/
│   ├── *.csv / *.jsonl                  # eval datasets
│   ├── chinook.db                       # SQLite fixture used by the SQL example
│   └── scicode/                         # SciCode fixture (+ your gitignored test_data.h5)
└── results/
    └── <id>/
        └── <run_id>/                    # one directory per run
            ├── results.csv              # per-row outputs, scores, and metrics
            ├── run.json                 # run status + counts
            └── experiment.json          # snapshot of the experiment at run time
```

The example experiments (`codegen_example`, `langchainagent_example`, `scicode_example`, `spider_example`), their datasets, the scorers they reference (`codegen_judge`, `langchainagent_judge`), and one set of result CSVs are committed so the repo is runnable out of the box. `providers.json` and `test_data.h5` are gitignored — the former is autogenerated and holds secrets, the latter is the large SciCode reference file you download yourself (see [SciCode example](#scicode-example-executing-model-code) below). The SciCode and Spider examples additionally need large datasets you download separately before they can actually *run* (see their sections below).

### Example experiments at a glance

| Experiment | Dataset File | Scorer Type | LLM Workflow | Expected Runtime |
| ---------- | ------------ | ----------- | ------------ | ---------------- |
| `codegen_example` | `codegen_example.jsonl` | LLM-as-judge | Code generation | ~8 sec with run concurrency of 4 |
| `langchainagent_example` | `langchainagent_example.jsonl` | LLM-as-judge | SQL tool use driven by a LangChain agent (`ChatOpenAI`) | ~12 sec with run concurrency of 4 |
| `scicode_example` | `scicode_dev.jsonl` | Heuristic | Code generation & execution in sandbox | ~24 min for the 15 dev examples with run concurrency of 4 |
| `spider_example` | `spider_dev.jsonl` | Heuristic (execution accuracy) | SQL generation & read-only execution vs. gold | needs the ~1.7 GB Spider DB download to run; scales with models × the 1,034 dev rows — see [Spider 1.0 example](#spider-10-example-text-to-sql) |

## The web UI (optional)

The web UI is a convenience layer over the same `data/` files and backend the CLI uses — handy for interactive editing and browsing results, but never required. The concept sections that follow (providers, experiments, datasets, scoring) apply whether you drive runs from the CLI or the UI; in the UI, each maps to a page. In the left-hand nav the pages are ordered by **expected frequency of use** — **Experiments**, then **Datasets** and **Scorers**, with **Providers** last — while the sections below are ordered setup-first, so each concept is introduced before the ones that depend on it.

## Configuring providers

![The Providers page: a table of OpenAI-compatible endpoints, each with a name, API URL, and API key, plus an "Add Provider" button.](images/providers.png)

A provider is a reusable definition of an OpenAI-compatible inference endpoint — a name, an `api_url`, and an `api_key` — that experiments reference by name for both their models and their LLM judge. **Where you set your keys depends on which storage backend you run** (`SAMBAEVAL_STORAGE_BACKEND`):

**Web app (database backend — the multi-user/deployment default).** Set your keys in the UI: open the app, sign in, and go to the **Providers** page (left nav) → *Add Provider* → fill in the name, API URL, and API key → **Save**. Keys are **per-user (bring-your-own) and stored encrypted in the database** — one user's keys are never visible to another, and nothing is written to disk in cleartext. There is **no `data/providers.json`** in this mode. (Under the hood the page calls `PUT /api/providers`; the app encrypts each key at rest with its `CREDS_KEY`.) This is the path for the deployment and the local docker-compose stack.

**CLI / single-user file mode (`SAMBAEVAL_STORAGE_BACKEND=files`).** Providers live in `data/providers.json` (gitignored — it holds secrets and must never be committed). The web UI auto-creates it on first read with a placeholder SambaNova entry; the CLI does not, so copy `data/providers.json.example` to `data/providers.json` and edit it:

```jsonc
[
  {
    "name": "SambaNova",
    "api_url": "https://api.sambanova.ai/v1",
    "api_key": "Obtain from https://cloud.sambanova.ai/apis"
  }
]
```

Either way, the provider's `name` is what experiments reference (`models[].provider_name`, the LLM judge's `provider_name`), and the endpoint must speak the OpenAI-compatible `/chat/completions` API — works with OpenAI, SambaNova Cloud, vLLM, Ollama (via its OpenAI shim), and most modern inference gateways.

## Experiment schema

![The experiment editor: General settings (name, dataset, run concurrency, "run on first N examples", global system prompt, output generator) above a Models section with per-model name, provider, temperature, seed, and system-prompt override.](images/experiment_config.png)

An experiment is a JSON document that specifies one or more models, a dataset, a system prompt, and a scoring strategy — everything needed to reproduce a single evaluation run. Each experiment lives at `data/experiments/<id>.json` and can be created from the Experiments page in the UI or hand-edited.

```jsonc
{
  "id": "codegen_example",
  "name": "Code completion example",
  "system_prompt": "You are a careful code assistant. Reply with only the requested fragment.",
  "dataset": "codegen_example.csv",
  "models": [
    {
      "name": "Meta-Llama-3.3-70B-Instruct",
      "provider_name": "SambaNova",
      "seed": 42,
      "system_prompt": "global",
      "additional_kwargs": { "temperature": 0, "top_p": 0.9, "max_tokens": 1024 },
      "input_price": 0.6,
      "output_price": 1.2
    }
  ],
  "scorer": {
    "type": "llm",
    "scorer_name": "codegen_judge"
  },
  "output_generator": ""
}
```

- `models[].provider_name` must match a `name` in `providers.json`.
- `models[].system_prompt`: `"global"` to use the experiment-level `system_prompt`, or explicit text that overrides for that one model.
- `models[].seed` is optional. Sent as the `seed` field on the chat completions request when set; omit (or leave the field blank in the UI) for non-deterministic sampling.
- **There is no top-level `temperature` field.** The newest frontier models reject an explicit temperature (or reject `0.0`), so there's no universal default — set `temperature` (and any other sampling param) via `additional_kwargs` on the models that support it; otherwise it's simply never sent. A stray `"temperature"` at the model level is **ignored**.
- `models[].additional_kwargs` is optional. Each entry is forwarded as-is to the provider's `/chat/completions` body (e.g. `temperature`, `top_p`, `top_k`, `max_tokens`, `stop`). In the UI editor, values are parsed as JSON, so wrap string values in double quotes (`"<|im_end|>"`); bare `42` becomes a number, `true` becomes a boolean, etc.
- `models[].input_price` / `models[].output_price` are optional (USD per 1,000,000 tokens). They're used **only** to compute per-model and per-run costs in the Results view — never sent to the provider — and can be edited after a run to recompute costs without re-running. See [Results](#results).
- `scorer` is optional and defaults to the heuristic scorer when omitted — `{ "type": "heuristic" }` or `{ "type": "llm", "scorer_name": "<name>" }`. See [Scoring](#scoring) for the two types.
- `output_generator` is optional. Blank/missing → the default generator script (`scripts/generators/default_generator.py`). See [Custom output generators](#custom-output-generators) below.

## Dataset schema

![The Datasets page: an editable grid of rows (example id, prompt, expected output, weight) with "Add row" and "Save Dataset" controls, and a list of available datasets below with Download/Delete actions.](images/datasets.png)

A dataset is a CSV file of test prompts and the expected outputs they should produce. Datasets live at `data/datasets/*.csv`, can be shared across multiple experiments, and use the header `example_id,prompt,expected_output,weight`. The `weight` column is optional — omit it (or leave the cell empty) and rows default to `1.0`.

> **How the UI lists datasets:** the picker does a **non-recursive** `readdir` of `data/datasets/`, keeping only `.csv`/`.jsonl` entries — each is expected to parse against the schema above. So non-dataset fixtures are kept out of the listing by either extension (`chinook.db`) or location (the SciCode `scicode_problems.jsonl` fixture lives in the `scicode/` subfolder), which is why those live where they do.

| Column   | Type   | Notes                                                                                                                  |
| -------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| example_id | int  | Unique row id within the dataset.                                                                                      |
| prompt   | string | User prompt sent to the model. Can span multiple lines if the field is properly CSV-quoted.                            |
| expected_output | string | Expected output. The **heuristic scorer** treats `contains:NEEDLE` as a substring match; otherwise it's exact-match. |
| weight   | float  | **Optional**, defaults to `1.0`. Score multiplier — heuristic returns `weight` on a hit; the LLM judge multiplies its normalized score by `weight`. Use it to (a) stress the relative importance of examples in the final score (e.g. weight a critical regression case at `5.0` and trivia at `0.5`), and (b) combine multiple `contains:` checks for a single logical example by splitting it across several rows with partial weights — e.g. two rows with weight `0.5` each, one asserting `contains:Paris` and one asserting `contains:France`, sum to a max of `1.0` only when both substrings appear. |

## Scoring

Each row of model output is graded against the dataset's expected output to produce the row's final `score`. The scorer is configured per experiment via the `scorer` field and comes in two flavors:

- **Heuristic** (`{"type":"heuristic"}`): exact-match by default, `contains:NEEDLE` prefix for substring match. Returns `weight` on a hit, `0` otherwise. Defined inline on the experiment — there is no separate file.
- **LLM judge** (`{"type":"llm","scorer_name":"<name>"}`): references a reusable scorer definition at `data/scorers/<name>.json`. See [Scorers](#scorers) below.

### Scorers

![The Scorers page: reusable LLM-as-judge configurations, each with a name, judge provider/model, temperature, max score, and a judge-prompt template using {prompt}/{expected_output}/{output}/{max_score} placeholders.](images/scorers.png)

LLM-as-judge configurations live in their own module so they can be reused across experiments. Each scorer is a JSON file at `data/scorers/<name>.json`:

```jsonc
{
  "name": "codegen_judge",
  "provider_name": "SambaNova",
  "model": "gpt-oss-120b",
  "judge_prompt": "...{prompt}...{expected_output}...{output}...{max_score}...",
  "max_score": 5,
  "additional_kwargs": { "temperature": 0 }
}
```

At run time, sambaeval looks up the scorer by name, renders `judge_prompt` with `{prompt}`, `{expected_output}`, `{output}`, and `{max_score}` placeholders, calls the configured judge model with `response_format: json_object`, expects `{"score": <int>, "score_reason": "<text>"}`, normalizes the integer to `[0, 1]` and multiplies by `weight`. A default judge prompt is defined as `DEFAULT_JUDGE_PROMPT` in the backend ([backend/sambaeval/scoring.py](backend/sambaeval/scoring.py)); the UI keeps an in-sync copy in [app/lib/types.ts](app/lib/types.ts) to prefill the editor.

Like a model, a judge takes no top-level `temperature`; pass sampling params via the scorer's optional `additional_kwargs`, which are forwarded as-is to the judge's `/chat/completions` call.

Manage scorers from the **Scorers** page in the UI, or hand-edit the JSON files directly.

## Running an experiment

However you start a run — `sambaeval run` on the command line (see [Command-line interface](#command-line-interface)) or the **Run** button in the UI — the backend executes the chosen output generator for every `(model, dataset row)` pair, scores each output, and writes the combined results to disk.

It runs `models × dataset_rows` as tasks with a bounded thread pool (default 4, set via `--concurrency` or the Run page). Each task calls the output generator **in-process**, captures `output` + `metrics`, then scores against `dataset.expected_output`. Results are written incrementally to `data/results/<id>/<run_id>/results.csv` (alongside `run.json` and an `experiment.json` snapshot); when driven over the HTTP API, progress also streams back as Server-Sent Events.

**Controlling a run.** Because results are written incrementally, a run can be stopped and picked back up without losing finished rows. From the UI a run can be **paused** (a graceful drain — in-flight tasks finish and are saved, the rest stop), **terminated** (in-flight work abandoned, but the run stays resumable), or **cancelled** (force-stopped). A paused or interrupted run can be **resumed** — from the UI or with `sambaeval run … --resume` — and only the rows that didn't finish are re-generated. **Retry Failed** re-runs just the `error` rows of a past run (even a completed one), carrying the successful rows over and updating the run in place; by default it reproduces the run's original model config, or it can apply the experiment's current settings.

## Results

![The Results view: a per-model summary table (# examples, overall score %, token totals, median latency/TTFT/throughput) above a sortable, filterable per-row table whose score column is shown as a percent.](images/experiment_results.png)

Experiment results are generated by the backend and contain evaluation scores for each test in the given dataset across all models in the experiment, alongside per-row token usage and latency metrics. They are stored at `data/results/<id>/<run_id>/results.csv` and surfaced in the UI as a sortable, filterable table.

| Column          | Meaning                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| result_id       | Row id within the result file.                                           |
| provider, model | The provider/model that produced this row's output.                      |
| example_id      | Dataset row id (joins back to `dataset.example_id`).                     |
| output          | Final text emitted by the output generator (after any tool-use loop).    |
| score           | Final score (weight-multiplied for both scorers).                        |
| score_reason    | Judge's stated reasoning (LLM scorer only).                              |
| input_tokens    | Sum of prompt tokens across all LLM calls for this row.                  |
| output_tokens   | Sum of completion tokens across all LLM calls for this row.              |
| latency_ms      | Sum of per-call latency across all LLM calls for this row.               |
| ttft_ms         | Median time-to-first-token across all LLM calls for this row.            |
| tps             | Median completion tokens/sec across all LLM calls for this row.          |
| num_llm_calls   | Number of LLM calls the generator made for this row (1 for default, >1 for tool-use loops). |

Server-reported timings (`time_to_first_token`, `total_latency`, `completion_tokens_after_first_per_sec`) are preferred; the generator falls back to client-side measurements derived from the streaming chunks when the provider doesn't expose them.

The results table in the UI is sortable on every column and filterable by unique values per column.

**Errors.** A failed row is recorded both in `results.csv` (its `output` carries the `ERROR: …` / `[JUDGE ERROR: …]` message) and in a per-run `errors.json` — keyed by `example_id` then `provider/model`, each entry tagged with the failing `phase` (`generation` or `scoring`). The file is created lazily on the first error and removed once the last one clears; the UI surfaces these in a dedicated **Errors** section (reconstructing them from `results.csv` for older runs that predate the log).

**Costs.** When a model carries `input_price`/`output_price`, the Results view's **Token Pricing & Costs** panel multiplies them by the run's stored token counts to show per-model and per-run cost. Prices are treated as *result config*: edit one and click **Update Costs** to recompute from the existing token counts — no re-run, no tokens spent. Defaults are pre-filled from [data/pricing_defaults.json](data/pricing_defaults.json), which [scripts/update_pricing.py](scripts/update_pricing.py) refreshes for OpenAI/Anthropic.

## Merging runs in experiments

Two runs of the same experiment can be combined into one set of results — useful when different runs cover different models or different examples of the **same dataset** (e.g. you ran some models yesterday and want the rest folded into the same result set). Both runs must use the same dataset; the UI only offers runs that match.

Rows are identified by their `(provider, model, example_id)` key. A **conflict** is a key that exists in both runs. There are two ways to merge, depending on whether you want to *generate* new results into an existing run or *combine* two runs that have already finished.

### Starting a new run from an existing run

On the experiment page, the **Run** section has a **New Run** / **Merged Run** choice. Pick **Merged Run**, choose the target under **Choose Existing Run**, decide how conflicts are handled, then start the run as usual. The current experiment's settings (models, dataset, scorer, …) are used to generate results directly into that existing target run, in place:

- A **new** key (a `(provider, model, example_id)` the target doesn't have yet) is generated and appended.
- A **conflict** is resolved by the "When conflicts arise…" radio, checked **before** a prompt is run:
  - **Skip them** (default) — keep the target's existing row and run nothing for that key (no tokens spent).
  - **Overwrite them** — re-generate and replace the target's row in place (its `result_id` is kept stable).
- Target rows the current experiment doesn't touch (models or examples only present in the target) are preserved untouched.

> **Caveats — progress counting.** Because results are merged into the existing run, the progress tracker treats the previous run's rows as part of the total: the **total count includes the target run's existing example count**, and the **completed count continues from that previous count** rather than restarting at zero. So a merge that adds 10 new examples to a run that already had 40 reports progress as `40 → 50`, not `0 → 10`. If the merged run is later paused and resumed, it rebuilds from its own rows (preserving the rows the current experiment doesn't cover), so no results are lost.

### Combining runs at the end of a run

To combine two runs that have **already finished** (without generating anything new), use the **Merge Results** button next to the **Run** selector in the **Results** section. The dialog takes a **From** run and an **Into** run:

- The **From** run's rows are merged into the **Into** run. The `result_id`s of the **From** rows are renumbered to continue past the **Into** run's maximum, while the **Into** run's rows keep their `result_id`s.
- If a conflict arises and **Overwrite destination run results when conflicts arise** is unchecked, the merge is blocked and the conflicting `result_id` pairs are listed in a From/Into table so you can review them. Check the box to let the **From** rows overwrite the conflicting **Into** rows.

This path never calls a model — it only reshuffles existing result rows — so it's the right choice when both runs are complete and you just want their results in one place.

## Custom output generators

An output generator is the Python class that turns a `(system_prompt, messages)` pair into the row's final `output` string. The default generator does a single streaming chat completion; custom generators can implement tool use, multi-turn conversations, retrieval, or any other orchestration before producing the final answer. All generators live in [scripts/generators/](scripts/generators/) and are referenced by path from an experiment's `output_generator` field.

To customize behavior — tool use, SQL execution, multi-turn flows, agentic loops — write a new script that subclasses the base `OutputGenerator` and point your experiment's `output_generator` field at it.

**Base class:** [scripts/generators/base.py](scripts/generators/base.py) defines `OutputGenerator` with:

- `__init__(provider, model)` — stores the provider and model dicts.
- `stream_completion(messages, **kwargs) -> str` — one streaming OpenAI-compatible chat completion. Records token usage and timing automatically. Subclasses can override this if they need to capture more than text from the stream (e.g. tool calls).
- `_record_call(usage_dict, t_start, t_first, t_end)` — helper for subclasses that override `stream_completion`; appends one row to the per-call metrics list so aggregation stays consistent.
- `generate_output(system_prompt, messages) -> str` — the method **most subclasses override**. Default does a single `stream_completion`.
- `aggregate_metrics() -> dict | None` — sums tokens/latency and takes medians of TTFT/TPS across all `_record_call` entries.

**Custom script skeleton:**

```python
# scripts/generators/my_custom.py
from base import OutputGenerator, run_cli

class MyGenerator(OutputGenerator):
    def generate_output(self, system_prompt: str, messages: list[dict]) -> str:
        # Call self.stream_completion() one or more times, do whatever
        # orchestration you need, return the final text.
        ...

# Optional: lets you run the script standalone for quick testing. The backend
# does NOT use this path — it imports the class and calls it in-process.
if __name__ == "__main__":
    run_cli(MyGenerator)
```

Then set `"output_generator": "scripts/generators/my_custom.py"` on your experiment.

**Worked example — SQL tool use via a LangChain agent:** [scripts/generators/langchain_agent_generator.py](scripts/generators/langchain_agent_generator.py) shows how to drive a tool-use loop with a third-party agent framework instead of hand-rolling it. It:

1. Wraps an `execute_sql_query` tool (runs SQL against `data/datasets/chinook.db`, returns up to 50 rows as JSON) and hands it to a LangChain agent built with `create_agent` over `ChatOpenAI`. `ChatOpenAI` points at whatever OpenAI-compatible endpoint the experiment's provider configures (`api_url` / `api_key`), so the same provider/model rows work as for the default generator.
2. Overrides `generate_output` to convert the row's `(system_prompt, messages)` into the agent's input (final user turn) plus prior `chat_history`, invokes the agent (which runs the tool-call loop internally until it produces a final answer or hits the recursion cap), and returns the agent's final text.
3. Because the agent's LLM calls happen inside the LangChain runtime rather than through `stream_completion`, metrics are captured with a `BaseCallbackHandler` that funnels each model call into `self._record_call(...)` — so token usage, TTFT, and TPS still aggregate per row exactly like the base class.

The matching experiment [data/experiments/langchainagent_example.json](data/experiments/langchainagent_example.json) embeds the Chinook schema in its system prompt and uses an LLM judge to score the natural-language answers.

**How generators run:** the backend loads your script **in-process** — it imports the module, picks the generator class your script designates via `run_cli(<Class>)` (so a script can define helper subclasses alongside the real one; with no `run_cli` it falls back to the sole `OutputGenerator` subclass, or the base class for the default script), instantiates it once per `(model, dataset row)`, calls `generate_output(...)`, and reads `aggregate_metrics()`. There is no subprocess and no stdin/stdout protocol. Provider lookup and the `system_prompt: "global"` precedence are handled by the backend before `generate_output` is called, so a custom generator usually only overrides `generate_output`. The dataset row's `example_id` is exposed as `self.example_id`, which custom generators can use to look up per-row fixtures (the SciCode example below relies on this).

## SciCode example (executing model code)

[SciCode](https://scicode-bench.github.io/) is a benchmark of real scientific-coding problems, each decomposed into ordered sub-steps. Unlike the other examples, correctness is decided by **executing** the generated code against numeric reference outputs — so this example ships a custom generator that generates each sub-step, runs its test cases, and reports `PASS`/`FAIL`. The pieces:

- [scripts/convert_scicode.py](scripts/convert_scicode.py) — converts the upstream SciCode problems into a self-contained fixture ([data/datasets/scicode/scicode_problems.jsonl](data/datasets/scicode/scicode_problems.jsonl), all 80 problems) and two SambaEval datasets split by SciCode's official dev/test sets: [data/datasets/scicode_dev.jsonl](data/datasets/scicode_dev.jsonl) (15 problems) and [data/datasets/scicode_test.jsonl](data/datasets/scicode_test.jsonl) (65 problems).
- [scripts/generators/scicode_generator.py](scripts/generators/scicode_generator.py) — the custom generator. Looks up the problem by `self.example_id`, generates each sub-step sequentially (feeding prior generated code forward), executes each step's tests against `test_data.h5`, and emits a `{passed}/{total} sub-steps passed` summary (prefixed `PASS` only when every sub-step passes, otherwise `FAIL`).
- [scripts/generators/scicode_test_utils.py](scripts/generators/scicode_test_utils.py) — h5 reader and value-comparison helpers vendored from SciCode.
- [data/experiments/scicode_example.json](data/experiments/scicode_example.json) — wires the dataset to the generator with a heuristic `ratio:` scorer.

Because the generator runs the tests and emits the verdict, `expected_output` is `ratio:` and **no LLM judge is involved** — the heuristic scorer reads the `{passed}/{total}` fraction from the generator's output and awards that fraction of the row's weight. A problem where 2 of 10 sub-steps pass therefore scores 0.2 rather than 0.

For how the fixture is built, where to download the source files, and SciCode's with-/no-background setting (`SCICODE_WITH_BACKGROUND`), see [data/datasets/scicode/README.md](data/datasets/scicode/README.md).

### One-time setup: the numeric reference data

The reference outputs live in `test_data.h5` (~1 GB), which is **not committed** (it's too large and is gitignored as `*.h5`):

1. Download `test_data.h5` from the SciCode numeric test data:
   <https://drive.google.com/drive/folders/1W5GZW6_bdiDAiipuFMqdUhvUaHIj6-pR>
2. Save it anywhere on your machine (e.g. `~/scicode/test_data.h5`).
3. Make it reachable, either by pointing at your local copy:
   ```bash
   export SCICODE_H5_PATH=/absolute/path/to/test_data.h5
   ```
   or — better for anything with a worker (the DB-backed app, or a cluster) — by publishing it **once** to the object store, after which any worker fetches it automatically:
   ```bash
   sambaeval-seed push-fixture /absolute/path/to/test_data.h5 --name scicode/test_data.h5
   ```

   (Editing `test_data_h5_path` in [scripts/generators/scicode_generator.py](scripts/generators/scicode_generator.py) still works, but needs a source change to reach a worker process.)

A run resolves the file in that order — explicit path, then the object store — and caches the download under `FIXTURE_CACHE_DIR` (default `~/.cache/sambaeval/fixtures`), so only the first run pays for it. If it's available nowhere, the run is **aborted before it starts** and the run's status line shows that reason, rather than quietly scoring every row 0.

The same command is how the fixture gets into a deployed cluster — MinIO has no ingress, so tunnel to it with the kubeconfig you already have:

```bash
kubectl -n "$NS" port-forward svc/sambaeval-minio 9100:9000   # leave running
S3_ENDPOINT_URL=http://localhost:9100 \
  S3_ACCESS_KEY=... S3_SECRET_KEY=... \
  sambaeval-seed push-fixture ./test_data.h5 --name scicode/test_data.h5
```

### Regenerating / resizing the dataset

The committed dataset covers all 80 problems. To regenerate it or cut it to a cheaper subset, see [data/datasets/scicode/README.md](data/datasets/scicode/README.md).

### Running model code safely

> **The SciCode generator executes model-generated Python.** By default it runs each sub-step inside an **ephemeral, network-less Podman container** (via [llm-sandbox](https://github.com/vndee/llm-sandbox)) — a fresh container per execution, destroyed immediately after. Sub-steps run sequentially within a row, and the sandbox caps *concurrent* containers at **4** (memory-bound; see "Automatic startup & sizing" below) — a run configured for more parallelism is warned and throttled to 4, not the number of rows.

This path has **no Docker dependency** — it uses Podman, and mounts are passed as plain OCI dicts. (The `docker` Python package is pulled in transitively by `llm-sandbox`, but it's just a client library; no Docker daemon, Desktop, or `~/.docker/config.json` is required.)

> **Run Podman rootless.** The container is the only real isolation boundary, and its hardening assumes rootless Podman — container-root is then mapped to an unprivileged host UID via a user namespace. Please don't run Podman as root (or via `sudo podman`), as that weakens every guard below. You can confirm rootless mode with `podman info --format '{{.Host.Security.Rootless}}'`, which should print `true`.

**One-time image build** (bakes in the scientific stack so the container needs no network at run time):

```bash
podman build -t scicode-sandbox -f scripts/generators/scicode_sandbox.Dockerfile .
```

If that build fails pulling the base image with a credential-helper error, it's because Podman falls back to `~/.docker/config.json` and a `credsStore`/`credHelpers` entry there errors. Build with an empty auth file so Podman does an anonymous pull and never touches the Docker config:

```bash
printf '{"auths":{}}' > /tmp/empty-auth.json
podman build --authfile /tmp/empty-auth.json -t scicode-sandbox -f scripts/generators/scicode_sandbox.Dockerfile .
```

**Automatic startup & sizing.** On macOS/Windows, Podman runs inside a single shared Linux VM (`podman-machine-default`). Before a run's first sub-step, the backend brings that VM up for you — if it's stopped it is **auto-started** and the run waits until the daemon actually answers; if the VM can't be made ready, the **whole run aborts** with a clear message instead of silently scoring every step `0` (the failure mode that looks like "all my models regressed"). There is only ever **one** VM: it is started once per process, guarded so parallel tasks don't race, and every container runs inside it.

To keep parallel containers from oversubscribing that VM, sizing is bounded: each container is capped at **800 MB** and at most **4** run at once, and the VM is grown to **4 GB** if it's smaller (never above — a VM you've deliberately made larger is left alone). So `4 × 800 MB` fits under 4 GB with headroom for the VM itself. Ask for more concurrency and you'll get a warning and a cap back to 4. On native Linux (no VM — e.g. GitHub Actions), there's nothing to start and this is a no-op; if you'd rather manage Podman yourself, set `SCICODE_AUTO_START_PODMAN=0` and the run aborts (rather than starting anything) when the daemon isn't already up.

**Backend selection** via the `SCICODE_SANDBOX` env var:

| `SCICODE_SANDBOX` | Behaviour |
| ----------------- | --------- |
| `podman` (default) | Ephemeral Podman container per execution. `test_data.h5` is bind-mounted read-only; `network_mode=none`; all capabilities dropped (`cap_drop=ALL`); memory/pids/CPU and open-file (`ulimits`) caps; execution force-killed after `STEP_TIMEOUT_SECONDS`. Assumes **rootless** Podman, so container-root maps to an unprivileged host UID. (A read-only rootfs, non-root in-container user, and `no-new-privileges` are *not* applied — this podman-py/crun stack can't express them without breaking execution; see the comment in `_run_in_sandbox`.) |
| `subprocess`      | **Unsandboxed** local execution — dev/CI only, **not a security boundary**. |

Other env vars:

- `SCICODE_SANDBOX_IMAGE` — image name (default `scicode-sandbox`).
- `SCICODE_SANDBOX_MEM` — per-container memory limit (default `800m`; see "Automatic startup & sizing" above). Raise it for a heavier problem set, but keep `4 × limit` under the VM's memory or containers will be OOM-killed.
- `SCICODE_AUTO_START_PODMAN` — auto-start the Podman VM when it's down (default on; `0` to manage Podman yourself, in which case a down daemon aborts the run).
- `SCICODE_PODMAN_START_TIMEOUT` — seconds to wait for the VM to boot and become reachable (default `180`).
- `SCICODE_PODMAN_MACHINE` — name of the Podman machine to manage (default `podman-machine-default`).
- `SCICODE_WITH_BACKGROUND` — include SciCode's per-step scientist background in the prompt when the fixture has it (default on; `0` forces the no-background setting).

Two guards apply on **every** backend as defense-in-depth — **not** a boundary on their own:

- **Static screening** — generated code is parsed (AST) and rejected if it imports modules outside the problem's declared dependencies, or uses dangerous builtins (`open`, `exec`, `eval`, `__import__`, …) or sandbox-escape attribute tricks. Python is dynamic, so this is bypassable; treat it as a quality signal.
- **(subprocess backend only)** the process is launched with a **scrubbed environment** (API keys stripped) and **POSIX resource limits** (`setrlimit` on CPU/file-size/processes; the memory cap is **not enforced on macOS**).

**Why a container per execution** rather than one shared long-lived container or a per-row container: the generator both calls the LLM (needs network + your API key) *and* runs untrusted code (must have neither), so only the execution step is containerized — the generator itself stays on the host. A fresh container per execution gives full isolation with no cross-run state to reset, and self-bounds concurrency to the worker pool. If container churn ever dominates runtime, llm-sandbox also supports a **pooled** mode (`create_pool_manager` / `PoolConfig`) that keeps a warm pool of N containers — a drop-in optimization.

**Other sandbox options** (if you don't want Podman/llm-sandbox): Docker directly with `--network none` + `--memory`/`--cpus` + `--read-only` + a non-root user; or, Linux-native and lighter, **bubblewrap** (unprivileged user namespaces; pair with cgroups for limits), **nsjail** (namespaces + seccomp + cgroups in one), or **gVisor** (`runsc`, a user-space kernel intercepting syscalls — the strongest boundary, usable as a Docker runtime). **firejail** is the easiest CLI but is SUID-root, which adds its own attack surface.

## Spider 1.0 example (text-to-SQL)

[Spider 1.0](https://yale-lily.github.io/spider) is a text-to-SQL benchmark: given a database schema and a natural-language question, the model must produce a SQL query. Like SciCode, correctness is decided by **execution** rather than an LLM judge — the predicted query is run read-only against the question's SQLite database and its result set compared to the gold query's, so the dataset mean is **execution accuracy (EX)**. The pieces:

- [scripts/convert_spider.py](scripts/convert_spider.py) — converts the upstream Spider download into the committed dataset [data/datasets/spider_dev.jsonl](data/datasets/spider_dev.jsonl) (1,034 dev questions; `prompt` = the CREATE-TABLE schema + question, `expected_output` = `contains:PASS`) and the fixture [data/datasets/spider1/spider_examples.jsonl](data/datasets/spider1/spider_examples.jsonl) (`db_id` + gold query per example, kept out of the model's prompt).
- [scripts/generators/spider_generator.py](scripts/generators/spider_generator.py) — the custom generator; executes the model's SQL against the question's database and emits `PASS`/`FAIL` per row, which the heuristic `contains:PASS` scorer turns into a 0/1 score.
- [scripts/generators/spider_eval_utils.py](scripts/generators/spider_eval_utils.py) — the result-set comparison semantics.
- [data/experiments/spider_example.json](data/experiments/spider_example.json) — wires the dataset to the generator.

The committed dataset and fixture are runnable out of the box, but **executing** the benchmark needs the raw Spider databases (the unzipped `spider_data.zip`, ~1.7 GB), which are gitignored. For the download link, where to put it, how to regenerate the fixture, and notes on the metric and splits, see [data/datasets/spider1/README.md](data/datasets/spider1/README.md).

## Testing

The quickest end-to-end smoke test is to run an example experiment through the CLI against a real provider (this costs real tokens, so it's manual, not CI):

```bash
.venv/bin/sambaeval run data/experiments/codegen_example.json --concurrency 4
```

It exercises the full path — dataset loading, the concurrent run engine, in-process output generation, scoring, and results writing — and prints per-model average scores. A populated `data/providers.json` is required.

For fast, offline regression coverage there's a pytest suite under [backend/tests/](backend/tests/) that drives the real executor and HTTP API with a deterministic echo generator — no provider, network, or API key needed. It covers the run lifecycle (pause/terminate/cancel/resume), Retry Failed, the error log, and run merging, and runs in CI on every push/PR touching `sambaeval/**` ([.github/workflows/sambaeval-ci.yml](../.github/workflows/sambaeval-ci.yml)). See [backend/tests/TESTS.md](backend/tests/TESTS.md) for the full catalog.

```bash
cd backend && uv sync --extra test && uv run python -m pytest tests/ -v
```
