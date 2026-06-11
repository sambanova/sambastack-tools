"""Base OutputGenerator for sambaeval.

To define custom output-generation behavior (tool use, SQL execution, an
agentic workflow, etc.), create a new script in this directory that
imports `OutputGenerator` and `run_cli` from this module, subclasses
`OutputGenerator`, overrides `generate_output` (and optionally
`stream_completion` if you need access to streamed tool calls or other
non-text deltas), and ends with `run_cli(YourSubclass)`.

To have token usage, TTFT, and tokens/sec recorded for your custom
generator, route every LLM call through `self.stream_completion(...)`.
If you override `stream_completion`, call `self._record_call(...)` once
per call so timing math stays consistent with the base implementation.
Multiple calls (e.g. a reflection loop or tool-use loop) are aggregated
per row: tokens and latency are summed, TTFT and TPS are median-aggregated
across calls.

Timing fields are taken from the provider's `usage` object when it
exposes them (e.g. SambaNova returns `time_to_first_token`,
`total_latency`, and `completion_tokens_after_first_per_sec`). For
providers that don't, we fall back to client-side measurements derived
from the streaming chunks.

A generator script must emit a single JSON object on stdout of the form
    {"output": "...", "metrics": {...} | null}
`run_cli` handles that for you.
"""

import json
import os
import statistics
import sys
import time

from openai import OpenAI


ROOT = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
PROVIDERS_FILE = os.path.join(ROOT, "data", "providers.json")


def load_provider(provider_name: str) -> dict:
    """Look up a provider's full details (api_url, api_key) by name."""
    with open(PROVIDERS_FILE, "r", encoding="utf-8") as f:
        providers = json.load(f)
    for p in providers:
        if p.get("name") == provider_name:
            return p
    raise KeyError(
        f"Provider {provider_name!r} not found in {PROVIDERS_FILE}"
    )


class OutputGenerator:
    def __init__(self, provider: dict, model: dict) -> None:
        self.provider = provider
        self.model = model
        # Dataset row id for the example being generated. Set by `run_cli`
        # before `generate_output` is called. Generators that need to look
        # up per-row fixtures (test cases, reference data, etc.) can read
        # this; generators that don't can ignore it.
        self.example_id: int | None = None
        self._client: OpenAI | None = None
        self._calls: list[dict] = []

    def _get_client(self) -> OpenAI:
        if self._client is None:
            self._client = OpenAI(
                base_url=self.provider["api_url"],
                api_key=self.provider["api_key"],
            )
        return self._client

    def _record_call(
        self,
        *,
        usage_dict: dict,
        t_start: float,
        t_first: float | None,
        t_end: float,
    ) -> None:
        """Compute per-call metrics from raw streaming timings and append.

        Subclasses that override `stream_completion` should call this once
        per LLM call so token/latency aggregation behaves the same way as
        the default implementation.
        """
        input_tokens = usage_dict.get("prompt_tokens")
        output_tokens = usage_dict.get("completion_tokens")

        server_ttft_s = usage_dict.get("time_to_first_token")
        server_latency_s = usage_dict.get("total_latency")
        server_tps = usage_dict.get("completion_tokens_after_first_per_sec")

        ttft_ms = (
            server_ttft_s * 1000.0
            if server_ttft_s is not None
            else ((t_first - t_start) * 1000.0 if t_first is not None else None)
        )
        latency_ms = (
            server_latency_s * 1000.0
            if server_latency_s is not None
            else (t_end - t_start) * 1000.0
        )
        if server_tps is not None:
            tps = server_tps
        else:
            gen_seconds = (
                t_end - t_first if t_first is not None and t_end > t_first else None
            )
            tps = (
                output_tokens / gen_seconds
                if (output_tokens and gen_seconds and gen_seconds > 0)
                else None
            )

        self._calls.append(
            {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "latency_ms": latency_ms,
                "ttft_ms": ttft_ms,
                "tps": tps,
            }
        )

    def stream_completion(self, messages: list[dict], **kwargs) -> str:
        """Stream a chat completion, record per-call metrics, return text.

        Custom generators should call this for every LLM call so token
        usage and latency get recorded. Any extra OpenAI request kwargs
        (tools, response_format, etc.) can be passed via **kwargs.

        Override this in subclasses that need to capture more than text
        from the stream (e.g. tool calls). Call `self._record_call(...)`
        once per call in your override.
        """
        client = self._get_client()
        t_start = time.perf_counter()
        t_first: float | None = None
        text_parts: list[str] = []
        usage_dict: dict = {}

        stream = client.chat.completions.create(
            model=self.model["name"],
            messages=messages,
            stream=True,
            stream_options={"include_usage": True},
            **kwargs,
        )
        for chunk in stream:
            chunk_usage = getattr(chunk, "usage", None)
            if chunk_usage is not None:
                usage_dict = chunk_usage.model_dump()
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            content = getattr(delta, "content", None)
            if content:
                if t_first is None:
                    t_first = time.perf_counter()
                text_parts.append(content)
        t_end = time.perf_counter()

        self._record_call(
            usage_dict=usage_dict,
            t_start=t_start,
            t_first=t_first,
            t_end=t_end,
        )
        return "".join(text_parts)

    def aggregate_metrics(self) -> dict | None:
        if not self._calls:
            return None

        def _sum_or_none(key: str) -> int | None:
            vals = [c[key] for c in self._calls if c[key] is not None]
            return sum(vals) if vals else None

        def _median_or_none(key: str) -> float | None:
            vals = [c[key] for c in self._calls if c[key] is not None]
            return statistics.median(vals) if vals else None

        return {
            "input_tokens": _sum_or_none("input_tokens"),
            "output_tokens": _sum_or_none("output_tokens"),
            "latency_ms": _sum_or_none("latency_ms"),
            "ttft_ms": _median_or_none("ttft_ms"),
            "tps": _median_or_none("tps"),
            "num_llm_calls": len(self._calls),
        }

    def completion_kwargs(self) -> dict:
        """Build the per-call kwargs sent to the chat completions endpoint.

        Pulls temperature, seed (if set), and the contents of
        `additional_kwargs` off the model dict. Subclasses that drive
        their own LLM calls should use `**self.completion_kwargs()` so
        the experiment's seed / extra kwargs are honored consistently.
        """
        kwargs: dict = {"temperature": self.model.get("temperature", 0.0)}
        seed = self.model.get("seed")
        if isinstance(seed, bool):
            pass  # bool is a subclass of int but never a valid seed
        elif isinstance(seed, (int, float)):
            kwargs["seed"] = int(seed)
        extra = self.model.get("additional_kwargs")
        if isinstance(extra, dict):
            kwargs.update(extra)
        return kwargs

    def generate_output(
        self, system_prompt: str, messages: list[dict]
    ) -> str:
        full_messages: list[dict] = []
        if system_prompt:
            full_messages.append({"role": "system", "content": system_prompt})
        full_messages.extend(messages)

        return self.stream_completion(full_messages, **self.completion_kwargs())


def run_cli(generator_cls: type[OutputGenerator]) -> None:
    """Shared `__main__` entry point for generator scripts.

    Parses argv, reads the dataset row from stdin (`{"messages": [...],
    "system_prompt": <str|null>, "example_id": <int|null>}`), loads the
    experiment and provider, resolves the active system prompt, sets
    `generator.example_id`, runs the generator, and writes a single JSON
    object to stdout. Generator scripts should end with:

        if __name__ == "__main__":
            run_cli(MyGeneratorClass)
    """
    if len(sys.argv) < 3:
        print(
            f"usage: {os.path.basename(sys.argv[0])} <experiment_json_path> <model_index>",
            file=sys.stderr,
        )
        sys.exit(2)

    experiment_path = sys.argv[1]
    model_index = int(sys.argv[2])
    row = json.loads(sys.stdin.read())
    messages = row.get("messages") or []
    row_system_prompt = row.get("system_prompt")
    example_id = row.get("example_id")

    with open(experiment_path, "r", encoding="utf-8") as f:
        experiment = json.load(f)

    model = experiment["models"][model_index]
    provider = load_provider(model["provider_name"])

    # Precedence: row override > model override > experiment global.
    if row_system_prompt is not None:
        system_prompt = row_system_prompt
    else:
        model_system_prompt = model.get("system_prompt", "global")
        if not model_system_prompt or model_system_prompt == "global":
            system_prompt = experiment.get("system_prompt", "")
        else:
            system_prompt = model_system_prompt

    generator = generator_cls(provider, model)
    generator.example_id = example_id
    output = generator.generate_output(system_prompt, messages)
    metrics = generator.aggregate_metrics()

    sys.stdout.write(json.dumps({"output": output, "metrics": metrics}))
