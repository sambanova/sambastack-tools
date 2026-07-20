"""Post-hoc diagnostics for a SambaEval experiment run.

A run directory (``data/results/<experiment>/<run_id>/``) holds:

  * ``results.csv``    — one row per (model, example) with output, score and
                         per-call metrics (input/output tokens, latency, ...).
  * ``experiment.json``— the experiment definition (models, system prompt,
                         dataset, seeds, additional kwargs).

`ResultAnalyzer` loads those plus the shared ``data/providers.json`` and the
experiment's dataset, and offers two diagnostics:

  * `largest_output_token_diff(model_a, model_b)` — find the examples where two
    models disagreed most on how many output tokens they generated (handy for
    spotting runaway generations). Returns the top-N rows and can render them as
    the markdown table.
  * `curl_for_result(result_id)` — rebuild the exact chat-completions request
    that produced a given result row, as a runnable ``curl`` command, so the
    call can be reproduced against the provider by hand.

This is read-only tooling: it never mutates the run, and it talks to no network.

Example
-------
    from result_analysis import ResultAnalyzer

    ra = ResultAnalyzer(
        "data/results/spider_example/2026-06-16T18-00-16-671Z"
    )
    print(ra.format_diff_table("MiniMax-M2.7", "gpt-oss-120b"))
    print(ra.curl_for_result(2887))   # the MiniMax row for example 886
"""

from __future__ import annotations

import csv
import json
import os
import shlex
import sys

# Repo root: scripts/diagnostics/result_analysis.py -> sambaeval/
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PROVIDERS_FILE = os.path.join(ROOT, "data", "providers.json")
DATASETS_DIR = os.path.join(ROOT, "data", "datasets")

# Env var the generated curl reads the API key from, per provider. The script
# never reads the key itself — it only emits the variable name into the command.
PROVIDER_API_KEY_ENV = {
    "SambaNova": "SAMBANOVA_API_KEY",
    "Anthropic": "ANTHROPIC_API_KEY",
    "OpenAI": "OPENAI_API_KEY",
}

# results.csv stores ints as text; allow huge fields (a runaway generation can
# blow past the csv module's default 128 KB field cap).
csv.field_size_limit(sys.maxsize)


def _floats(rows: list[dict], key: str) -> list[float]:
    vals: list[float] = []
    for row in rows:
        raw = row.get(key)
        if raw in (None, ""):
            continue
        try:
            vals.append(float(raw))
        except (TypeError, ValueError):
            continue
    return vals


def _mean(vals: list[float]) -> float | None:
    return sum(vals) / len(vals) if vals else None


def _max(vals: list[float]) -> float | None:
    return max(vals) if vals else None


def _as_int(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _fmt(value, ndigits: int) -> str:
    if value is None:
        return "-"
    return f"{value:.{ndigits}f}" if ndigits else f"{int(round(value))}"


class ResultAnalyzer:
    """Read-only analyzer over a single experiment run directory."""

    def __init__(self, run_dir: str) -> None:
        self.run_dir = os.path.abspath(os.path.expanduser(run_dir))
        self.results_path = os.path.join(self.run_dir, "results.csv")
        self.experiment_path = os.path.join(self.run_dir, "experiment.json")
        if not os.path.isfile(self.results_path):
            raise FileNotFoundError(f"No results.csv in {self.run_dir!r}")
        if not os.path.isfile(self.experiment_path):
            raise FileNotFoundError(f"No experiment.json in {self.run_dir!r}")

        with open(self.experiment_path, "r", encoding="utf-8") as f:
            self.experiment = json.load(f)
        with open(self.results_path, "r", newline="", encoding="utf-8") as f:
            self.rows = list(csv.DictReader(f))

        self._providers: list[dict] | None = None
        self._dataset: dict[str, dict] | None = None

    # ------------------------------------------------------------------ #
    # Diagnostic 1: largest per-example output-token difference          #
    # ------------------------------------------------------------------ #
    def largest_output_token_diff(
        self, model_a: str, model_b: str, top_n: int = 5
    ) -> list[dict]:
        """Examples ranked by |output_tokens(model_a) - output_tokens(model_b)|.

        Returns up to ``top_n`` dicts with keys ``example_id``, ``<model_a>``,
        ``<model_b>`` and ``diff``, sorted by descending ``diff``. Examples
        where either model is missing or has no recorded output-token count are
        skipped.
        """
        a = self._output_tokens_by_example(model_a)
        b = self._output_tokens_by_example(model_b)

        ranked: list[dict] = []
        for example_id in a.keys() & b.keys():
            ta, tb = a[example_id], b[example_id]
            ranked.append(
                {
                    "example_id": example_id,
                    model_a: ta,
                    model_b: tb,
                    "diff": abs(ta - tb),
                }
            )
        ranked.sort(key=lambda r: r["diff"], reverse=True)
        return ranked[:top_n]

    def format_diff_table(
        self, model_a: str, model_b: str, top_n: int = 5
    ) -> str:
        """`largest_output_token_diff` rendered as a markdown table."""
        ranked = self.largest_output_token_diff(model_a, model_b, top_n)
        header = f"| example_id | {model_a} | {model_b} | diff |"
        sep = "|---|---|---|---|"
        lines = [header, sep]
        for r in ranked:
            lines.append(
                f"| {r['example_id']} | {r[model_a]} | {r[model_b]} | {r['diff']} |"
            )
        return "\n".join(lines)

    def _output_tokens_by_example(self, model: str) -> dict[str, int]:
        out: dict[str, int] = {}
        seen = False
        for row in self.rows:
            if row.get("model") != model:
                continue
            seen = True
            raw = row.get("output_tokens")
            if raw is None or raw == "":
                continue
            try:
                out[row["example_id"]] = int(raw)
            except (TypeError, ValueError):
                continue
        if not seen:
            raise KeyError(
                f"No rows for model {model!r}. Models in run: "
                f"{sorted({r.get('model') for r in self.rows})}"
            )
        return out

    # ------------------------------------------------------------------ #
    # General inspection helpers (reusable across runs)                  #
    # ------------------------------------------------------------------ #
    def models(self) -> list[str]:
        """Distinct model names present in the run, in stable sorted order."""
        return sorted({r.get("model") for r in self.rows if r.get("model")})

    def model_summary(self) -> list[dict]:
        """Per-model rollup: example count, pass rate and token/latency means.

        ``pass_rate`` is the mean of the numeric ``score`` column. Token and
        latency means ignore rows with a missing/blank value. Useful as a quick
        first look at a fresh run before drilling into specific examples.
        """
        per_model: dict[str, list[dict]] = {}
        for row in self.rows:
            per_model.setdefault(row.get("model"), []).append(row)

        summary: list[dict] = []
        for model in sorted(per_model):
            rows = per_model[model]
            summary.append(
                {
                    "model": model,
                    "examples": len(rows),
                    "pass_rate": _mean(_floats(rows, "score")),
                    "mean_input_tokens": _mean(_floats(rows, "input_tokens")),
                    "mean_output_tokens": _mean(_floats(rows, "output_tokens")),
                    "max_output_tokens": _max(_floats(rows, "output_tokens")),
                    "mean_latency_ms": _mean(_floats(rows, "latency_ms")),
                }
            )
        return summary

    def format_model_summary(self) -> str:
        """`model_summary` rendered as a markdown table."""
        rows = self.model_summary()
        header = (
            "| model | examples | pass_rate | mean_in_tok | mean_out_tok "
            "| max_out_tok | mean_latency_ms |"
        )
        sep = "|---|---|---|---|---|---|---|"
        lines = [header, sep]
        for r in rows:
            lines.append(
                f"| {r['model']} | {r['examples']} | {_fmt(r['pass_rate'], 3)} | "
                f"{_fmt(r['mean_input_tokens'], 1)} | {_fmt(r['mean_output_tokens'], 1)} | "
                f"{_fmt(r['max_output_tokens'], 0)} | {_fmt(r['mean_latency_ms'], 1)} |"
            )
        return "\n".join(lines)

    def top_output_tokens(self, model: str, top_n: int = 10) -> list[dict]:
        """Rows for ``model`` with the most output tokens (spot runaways).

        Each dict carries ``result_id``, ``example_id``, ``output_tokens``,
        ``input_tokens``, ``num_llm_calls``, ``score`` and ``status``, sorted by
        descending output tokens. ``num_llm_calls`` matters when triaging a
        runaway: the executor *sums* output tokens across a generator's LLM
        calls, so a high count with ``num_llm_calls > 1`` is retry accumulation,
        while ``num_llm_calls == 1`` is a single degenerate generation.
        """
        rows: list[dict] = []
        for row in self.rows:
            if row.get("model") != model:
                continue
            raw = row.get("output_tokens")
            if raw in (None, ""):
                continue
            try:
                tokens = int(raw)
            except (TypeError, ValueError):
                continue
            rows.append(
                {
                    "result_id": row.get("result_id"),
                    "example_id": row.get("example_id"),
                    "output_tokens": tokens,
                    "input_tokens": row.get("input_tokens"),
                    "num_llm_calls": row.get("num_llm_calls"),
                    "score": row.get("score"),
                    "status": row.get("status"),
                }
            )
        rows.sort(key=lambda r: r["output_tokens"], reverse=True)
        return rows[:top_n]

    def format_top_output_tokens(self, model: str, top_n: int = 10) -> str:
        """`top_output_tokens` rendered as a markdown table."""
        rows = self.top_output_tokens(model, top_n)
        header = (
            "| result_id | example_id | output_tokens | input_tokens "
            "| num_llm_calls | score | status |"
        )
        sep = "|---|---|---|---|---|---|---|"
        lines = [header, sep]
        for r in rows:
            lines.append(
                f"| {r['result_id']} | {r['example_id']} | {r['output_tokens']} | "
                f"{r['input_tokens']} | {r['num_llm_calls']} | {r['score']} | "
                f"{r['status']} |"
            )
        return "\n".join(lines)

    def score_disagreements(self, model_a: str, model_b: str) -> list[dict]:
        """Examples where the two models earned different ``score`` values.

        Returns dicts with ``example_id``, ``<model_a>`` and ``<model_b>``
        scores (as floats), sorted by example_id — handy for finding where one
        model passed and the other failed.
        """
        a = self._scores_by_example(model_a)
        b = self._scores_by_example(model_b)
        out: list[dict] = []
        for example_id in a.keys() & b.keys():
            if a[example_id] != b[example_id]:
                out.append(
                    {"example_id": example_id, model_a: a[example_id], model_b: b[example_id]}
                )
        out.sort(key=lambda r: _as_int(r["example_id"]))
        return out

    def get_result(self, result_id) -> dict:
        """The raw results.csv row for ``result_id`` (all columns)."""
        return dict(self._row_by_result_id(result_id))

    def _scores_by_example(self, model: str) -> dict[str, float]:
        out: dict[str, float] = {}
        for row in self.rows:
            if row.get("model") != model:
                continue
            raw = row.get("score")
            if raw in (None, ""):
                continue
            try:
                out[row["example_id"]] = float(raw)
            except (TypeError, ValueError):
                continue
        return out

    # ------------------------------------------------------------------ #
    # Diagnostic 2: reproduce a result row as a curl command            #
    # ------------------------------------------------------------------ #
    def build_request(
        self, result_id, *, stream: bool = True, include_usage: bool = True
    ) -> dict:
        """Reconstruct the chat-completions request behind ``result_id``.

        Returns ``{"url", "body", "provider", "env_var"}`` where ``body`` is the
        exact request payload the generator sent (system + user messages, seed,
        additional kwargs), plus ``stream`` and ``stream_options.include_usage``
        per the flags. ``env_var`` is the conventional env var holding that
        provider's API key. Shared by `curl_for_result` and any caller that
        wants to actually issue the request.
        """
        row = self._row_by_result_id(result_id)
        model_name = row["model"]
        provider_name = row["provider"]
        example_id = row["example_id"]

        model_cfg = self._model_config(model_name, provider_name)
        provider = self._provider(provider_name)
        system_prompt = self._resolve_system_prompt(model_cfg)
        user_prompt = self._user_prompt(example_id)

        messages: list[dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": user_prompt})

        body: dict = {"model": model_name, "messages": messages}
        seed = model_cfg.get("seed")
        if isinstance(seed, int) and not isinstance(seed, bool):
            body["seed"] = seed
        extra = model_cfg.get("additional_kwargs")
        if isinstance(extra, dict):
            for k, v in extra.items():
                if v is not None:
                    body[k] = v
        if stream:
            body["stream"] = True
        if include_usage:
            # SambaNova returns the usage block (with completion_tokens) even on
            # a non-streamed call when stream_options.include_usage is set.
            body["stream_options"] = {"include_usage": True}

        return {
            "url": self._chat_completions_url(provider["api_url"]),
            "body": body,
            "provider": provider_name,
            "env_var": PROVIDER_API_KEY_ENV.get(provider_name, "API_KEY"),
        }

    def curl_for_result(self, result_id, *, stream: bool = True) -> str:
        """Rebuild the chat-completions request behind ``result_id`` as curl.

        Resolves the row's model and example, reconstructs the request body the
        generator sent and the provider endpoint, and returns a runnable
        ``curl`` command. Streams with usage by default (``stream``/
        ``stream_options.include_usage``), matching the generator and surfacing
        the recorded token counts in the final SSE chunk; pass ``stream=False``
        for a plain blocking request.
        """
        req = self.build_request(result_id, stream=stream, include_usage=stream)
        payload = json.dumps(req["body"], ensure_ascii=False)
        # Reference the key via an env var rather than embedding it, so the
        # command can be copied without leaking the secret. The auth header is
        # double-quoted so the shell expands $VAR; everything else stays
        # single-quoted. The key itself is never read by this script.
        return (
            f"curl {shlex.quote(req['url'])} \\\n"
            f"  -H 'Content-Type: application/json' \\\n"
            f'  -H "Authorization: Bearer ${req["env_var"]}" \\\n'
            f"  -d {shlex.quote(payload)}"
        )

    def _row_by_result_id(self, result_id) -> dict:
        target = str(result_id)
        for row in self.rows:
            if row.get("result_id") == target:
                return row
        raise KeyError(f"No result with result_id={result_id!r} in {self.results_path!r}")

    def _model_config(self, model_name: str, provider_name: str) -> dict:
        models = self.experiment.get("models", [])
        for m in models:
            if m.get("name") == model_name and m.get("provider_name") == provider_name:
                return m
        # Fall back to a name-only match if provider isn't recorded per model.
        for m in models:
            if m.get("name") == model_name:
                return m
        raise KeyError(
            f"Model {model_name!r} (provider {provider_name!r}) not in experiment.json"
        )

    def _resolve_system_prompt(self, model_cfg: dict) -> str:
        """Same precedence the runner uses: model override > experiment global.

        (There is no per-row system-prompt override in the stored dataset, so
        the row level of precedence doesn't apply when reconstructing.)
        """
        model_sp = model_cfg.get("system_prompt", "global")
        if not model_sp or model_sp == "global":
            return self.experiment.get("system_prompt", "") or ""
        return model_sp

    def _provider(self, provider_name: str) -> dict:
        if self._providers is None:
            with open(PROVIDERS_FILE, "r", encoding="utf-8") as f:
                self._providers = json.load(f)
        for p in self._providers:
            if p.get("name") == provider_name:
                return p
        raise KeyError(f"Provider {provider_name!r} not found in {PROVIDERS_FILE!r}")

    def _user_prompt(self, example_id: str) -> str:
        if self._dataset is None:
            self._dataset = self._load_dataset()
        ex = self._dataset.get(str(example_id))
        if ex is None:
            raise KeyError(
                f"example_id {example_id!r} not found in dataset "
                f"{self.experiment.get('dataset')!r}"
            )
        # A dataset row carries either a bare `prompt` (the user turn) or an
        # explicit `messages` array; mirror the runner's handling of `prompt`.
        if ex.get("messages"):
            last_user = [m for m in ex["messages"] if m.get("role") == "user"]
            return (last_user[-1] if last_user else ex["messages"][-1]).get("content", "")
        return ex.get("prompt", "")

    def _load_dataset(self) -> dict[str, dict]:
        name = self.experiment.get("dataset")
        if not name:
            raise KeyError("experiment.json has no 'dataset'")
        path = name if os.path.isabs(name) else os.path.join(DATASETS_DIR, name)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Dataset not found: {path!r}")
        out: dict[str, dict] = {}
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                ex = json.loads(line)
                out[str(ex.get("example_id"))] = ex
        return out

    @staticmethod
    def _chat_completions_url(api_url: str) -> str:
        trimmed = api_url.rstrip("/")
        if trimmed.endswith("/chat/completions"):
            return trimmed
        return f"{trimmed}/chat/completions"


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", help="path to a run directory (holds results.csv)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_diff = sub.add_parser("diff", help="top output-token differences between two models")
    p_diff.add_argument("model_a")
    p_diff.add_argument("model_b")
    p_diff.add_argument("--top", type=int, default=5)

    p_curl = sub.add_parser("curl", help="reproduce a result_id as a curl command")
    p_curl.add_argument("result_id")
    p_curl.add_argument(
        "--no-stream",
        dest="stream",
        action="store_false",
        help="emit a plain blocking request instead of streaming with usage",
    )

    sub.add_parser("summary", help="per-model rollup (pass rate, token/latency means)")

    p_top = sub.add_parser("top", help="rows for a model with the most output tokens")
    p_top.add_argument("model")
    p_top.add_argument("--top", type=int, default=10)

    p_dis = sub.add_parser("disagree", help="examples where two models scored differently")
    p_dis.add_argument("model_a")
    p_dis.add_argument("model_b")

    args = parser.parse_args()
    ra = ResultAnalyzer(args.run_dir)
    if args.cmd == "diff":
        print(ra.format_diff_table(args.model_a, args.model_b, args.top))
    elif args.cmd == "curl":
        print(ra.curl_for_result(args.result_id, stream=args.stream))
    elif args.cmd == "summary":
        print(ra.format_model_summary())
    elif args.cmd == "top":
        print(ra.format_top_output_tokens(args.model, args.top))
    elif args.cmd == "disagree":
        rows = ra.score_disagreements(args.model_a, args.model_b)
        print(f"{len(rows)} disagreement(s)")
        for r in rows:
            print(
                f"example_id={r['example_id']} {args.model_a}={r[args.model_a]} "
                f"{args.model_b}={r[args.model_b]}"
            )
