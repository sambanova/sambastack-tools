"""Compare output-token counts for one result with stream on vs. off.

Reconstructs the exact chat-completions request behind a result row (via
`ResultAnalyzer.build_request`) and issues it twice against the provider — once
with ``stream: true`` and once with ``stream: false`` — then reports the
``completion_tokens`` reported by each.

Both calls set ``stream_options.include_usage`` so the provider returns the
usage block in either mode. SambaNova reports completion tokens in
``usage.completion_tokens``: for the non-streamed call it's in the single JSON
response; for the streamed call it's in the final SSE chunk (the one whose
``choices`` is empty and ``usage`` is populated).

The API key is read from the provider's conventional env var (e.g.
``SAMBANOVA_API_KEY``) — it is never read from providers.json.

Usage
-----
    export SAMBANOVA_API_KEY=...
    python3 scripts/diagnostics/compare_stream_modes.py \
        data/results/spider_example/2026-06-16T18-00-16-671Z 2887

``result_id`` defaults to 2887 (MiniMax-M2.7 on Spider example 886, the runaway
that recorded 97,500 output tokens).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request

# Allow importing the sibling module whether run as a script or imported.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from result_analysis import ResultAnalyzer  # noqa: E402

DEFAULT_RUN_DIR = "data/results/spider_example/2026-06-16T18-00-16-671Z"
DEFAULT_RESULT_ID = "2887"


def _post(url: str, api_key: str, body: dict, timeout: float):
    """POST ``body`` as JSON and return the opened HTTP response object."""
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "Accept": "text/event-stream" if body.get("stream") else "application/json",
        },
        method="POST",
    )
    return urllib.request.urlopen(req, timeout=timeout)


def run_blocking(url: str, api_key: str, body: dict, timeout: float) -> dict:
    """Issue a non-streamed request; return {completion_tokens, content_len}."""
    with _post(url, api_key, body, timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    usage = data.get("usage") or {}
    choices = data.get("choices") or [{}]
    content = (choices[0].get("message") or {}).get("content") or ""
    return {
        "completion_tokens": usage.get("completion_tokens"),
        "content_len": len(content),
    }


def run_streaming(url: str, api_key: str, body: dict, timeout: float) -> dict:
    """Issue a streamed request; return {completion_tokens, content_len}.

    Concatenates the content deltas and reads ``usage`` from whichever SSE
    chunk carries it (the final one for SambaNova).
    """
    completion_tokens = None
    content_parts: list[str] = []
    with _post(url, api_key, body, timeout) as resp:
        for raw in resp:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data:"):
                continue
            payload = line[len("data:"):].strip()
            if payload == "[DONE]":
                break
            chunk = json.loads(payload)
            usage = chunk.get("usage")
            if usage:
                completion_tokens = usage.get("completion_tokens")
            for choice in chunk.get("choices") or []:
                delta = choice.get("delta") or {}
                if delta.get("content"):
                    content_parts.append(delta["content"])
    return {
        "completion_tokens": completion_tokens,
        "content_len": len("".join(content_parts)),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", nargs="?", default=DEFAULT_RUN_DIR)
    parser.add_argument("result_id", nargs="?", default=DEFAULT_RESULT_ID)
    parser.add_argument(
        "--timeout", type=float, default=900.0,
        help="per-request timeout in seconds (default 900; a runaway can be slow)",
    )
    args = parser.parse_args()

    ra = ResultAnalyzer(args.run_dir)
    row = ra.get_result(args.result_id)
    env_var = ResultAnalyzer.build_request(ra, args.result_id)["env_var"]
    api_key = os.environ.get(env_var)
    if not api_key:
        sys.exit(f"Set the API key env var first: export {env_var}=...")

    print(
        f"result_id={args.result_id}  model={row['model']}  "
        f"example_id={row['example_id']}  provider={row['provider']}"
    )
    print(f"recorded output_tokens in results.csv: {row.get('output_tokens')}\n")

    results = {}
    for mode, stream, runner in (
        ("stream=False", False, run_blocking),
        ("stream=True", True, run_streaming),
    ):
        req = ra.build_request(args.result_id, stream=stream, include_usage=True)
        print(f"-> requesting {mode} ...", flush=True)
        out = runner(req["url"], api_key, req["body"], args.timeout)
        results[mode] = out
        print(
            f"   completion_tokens={out['completion_tokens']}  "
            f"content_chars={out['content_len']}"
        )

    a = results["stream=False"]["completion_tokens"]
    b = results["stream=True"]["completion_tokens"]
    print("\n=== comparison ===")
    print(f"stream=False completion_tokens: {a}")
    print(f"stream=True  completion_tokens: {b}")
    if a is not None and b is not None:
        print(f"difference (False - True): {a - b}")
        print("match!" if a == b else "MISMATCH — output token counts differ.")
    else:
        print("could not read completion_tokens from one or both responses.")


if __name__ == "__main__":
    main()
