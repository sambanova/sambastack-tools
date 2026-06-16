"""Refresh data/pricing_defaults.json with OpenAI + Anthropic default token prices.

These prices seed the defaults in the SambaEval Results "Token Pricing & Costs"
UI, which reads every default off the generated file.

Why not scrape openai.com / claude.com directly? Their pricing pages can't be
read from a script: https://openai.com/api/pricing/ returns a 403 bot-challenge
to non-browser clients, and both pages render the numbers client-side. Instead
we read the same figures from the `token-costs` project, which runs daily
crawlers over those exact pages and publishes small, machine-readable JSON
snapshots already normalized to USD per 1,000,000 tokens:

    https://mikkotikkanen.github.io/token-costs/api/v1/openai.json
    https://mikkotikkanen.github.io/token-costs/api/v1/anthropic.json

(rationale: https://www.fixerofthenorth.com/blog/stop-hardcoding-ai-token-costs-to-code)

Output shape — provider name -> model name -> {input, output} in USD per
1,000,000 tokens (the exact unit the app's price fields use):

    {
      "Anthropic": {"claude-opus-4.5": {"input": 5, "output": 25}, ...},
      "OpenAI":    {"gpt-4o": {"input": 1.25, "output": 5}, ...}
    }

Merge behavior (so manual edits survive a refresh):
  * The first time a provider has no entries, it is seeded from the full crawl.
  * After that, only models ALREADY in the file have their prices refreshed.
    Manually-added models (and models that have since disappeared upstream) are
    left untouched, and brand-new upstream models are NOT pulled in — add the
    model name to the file yourself to start tracking it.
  * Providers this script does not fetch are left entirely alone.
If a source's JSON shape changes and parsing yields nothing, that provider's
existing entries are kept untouched and the failure is reported (then ask Claude
to update the parser).

Usage:
    python scripts/update_pricing.py
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, "data", "pricing_defaults.json")

# Provider name (as it should appear in the file, matching the provider names
# configured in the app) -> token-costs JSON endpoint.
SOURCES = {
    "OpenAI": "https://mikkotikkanen.github.io/token-costs/api/v1/openai.json",
    "Anthropic": "https://mikkotikkanen.github.io/token-costs/api/v1/anthropic.json",
}


def _fetch_json(url: str) -> dict:
    req = urllib.request.Request(
        url, headers={"User-Agent": "sambaeval-update-pricing"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _parse_token_costs(doc: dict) -> dict[str, dict[str, float]]:
    """Extract {model_name: {"input", "output"}} from a token-costs document.

    Shape: ``{"current": {"date": ..., "models": {name: {input, output, ...}}}}``.
    Prices are already USD per 1,000,000 tokens. Only models reporting BOTH an
    input and output price are kept.
    """
    models = (doc.get("current") or {}).get("models") or {}
    out: dict[str, dict[str, float]] = {}
    for name, info in models.items():
        if not isinstance(info, dict):
            continue
        try:
            inp = float(info["input"])
            outp = float(info["output"])
        except (KeyError, TypeError, ValueError):
            continue
        out[name] = {"input": inp, "output": outp}
    return out


def main() -> None:
    argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    ).parse_args()

    # Start from the existing file so providers we don't fetch are preserved.
    data: dict = {}
    if os.path.exists(OUT_PATH):
        try:
            with open(OUT_PATH, encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, ValueError):
            pass

    failures: list[tuple[str, str]] = []
    for provider, url in SOURCES.items():
        try:
            doc = _fetch_json(url)
            prices = _parse_token_costs(doc)
            if not prices:
                raise ValueError(
                    "no model prices parsed — the source JSON shape may have changed"
                )
            date = (doc.get("current") or {}).get("date", "?")
            existing = data.get(provider)
            if not isinstance(existing, dict) or not existing:
                # First run for this provider (no curated list yet): take the
                # full crawl so the file bootstraps from scratch.
                data[provider] = dict(prices)
                print(f"{provider}: seeded {len(prices)} models (snapshot {date})")
            else:
                # Refresh prices for models we already track; leave everything
                # else (manually-added models, models gone from the source)
                # untouched, and do NOT pull in brand-new upstream models.
                updated = 0
                for model, price in prices.items():
                    if model in existing:
                        existing[model] = price
                        updated += 1
                print(
                    f"{provider}: updated {updated} of {len(existing)} tracked "
                    f"models; left {len(prices) - updated} new upstream models out "
                    f"(snapshot {date})"
                )
        except Exception as err:  # noqa: BLE001
            failures.append((provider, str(err)))
            print(f"{provider}: FAILED — {err} (kept existing entries)")

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")
    print(f"Wrote {os.path.relpath(OUT_PATH, ROOT)}")

    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
