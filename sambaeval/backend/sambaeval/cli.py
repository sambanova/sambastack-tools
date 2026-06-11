"""Command-line entry point — run an experiment without the UI.

Usage:
    sambaeval run <experiment.json> [--concurrency N] [--resume]

Everything the run needs comes from the experiment file (which may inline its
dataset and LLM-judge definition) plus the shared data/ directory. The one
hard requirement that lives outside the experiment file is
``data/providers.json`` (API keys); the CLI errors clearly if it is missing.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import storage
from .executor import ExecutorProgress, run_experiment
from .models import Experiment


def _eprint(*args) -> None:
    print(*args, file=sys.stderr)


def _load_experiment(path: Path) -> Experiment:
    if not path.exists():
        _eprint(f"error: experiment file not found: {path}")
        raise SystemExit(2)
    try:
        return Experiment.model_validate_json(path.read_text(encoding="utf-8"))
    except Exception as err:  # noqa: BLE001
        _eprint(f"error: invalid experiment file {path}:\n{err}")
        raise SystemExit(2)


def _check_providers(experiment: Experiment) -> None:
    if not storage.providers_file_exists():
        _eprint(
            f"error: {storage.paths.providers_file()} does not exist.\n"
            "Create it (see data/providers.json.example) with your API "
            "endpoints and keys before running."
        )
        raise SystemExit(2)
    providers = {p.name for p in storage.list_providers()}
    needed = {m.provider_name for m in experiment.models}
    scorer = experiment.scorer
    if scorer is not None and scorer.type == "llm":
        if scorer.definition is not None:
            needed.add(scorer.definition.provider_name)
        elif scorer.scorer_name:
            sc = storage.get_scorer(scorer.scorer_name)
            if sc is not None:
                needed.add(sc.provider_name)
    missing = sorted(n for n in needed if n and n not in providers)
    if missing:
        _eprint(
            "error: these providers are referenced by the experiment but are "
            f"not in providers.json: {', '.join(missing)}"
        )
        raise SystemExit(2)


def _progress(p: ExecutorProgress) -> None:
    pct = (p.completed / p.total * 100) if p.total else 100.0
    label = f" — {p.current_label}" if p.current_label else ""
    _eprint(
        f"\r[{p.completed}/{p.total}] {pct:5.1f}%  errors={p.errors}{label}      ",
    )


def _print_summary(experiment: Experiment, result) -> None:
    rows = result.results
    # Per-model average score (mean over that model's rows).
    by_model: dict[str, list[float]] = {}
    for r in rows:
        by_model.setdefault(f"{r.provider}/{r.model}", []).append(r.score)
    print()
    print(f"Run {result.run_id}: {result.meta.status}")
    print(f"  completed={result.meta.completed}  errors={result.meta.errors}")
    print("  average score by model:")
    for name, scores in sorted(by_model.items()):
        avg = sum(scores) / len(scores) if scores else 0.0
        print(f"    {name}: {avg:.3f}  (n={len(scores)})")
    results_dir = storage.paths.run_dir(experiment.id, result.run_id)
    print(f"  results: {results_dir}")


def _cmd_run(args: argparse.Namespace) -> int:
    experiment = _load_experiment(Path(args.experiment).expanduser())
    _check_providers(experiment)

    concurrency = args.concurrency
    if concurrency is None:
        concurrency = experiment.concurrency or 4
    concurrency = max(1, min(32, concurrency))

    mode = "resume" if args.resume else "new"
    result = run_experiment(
        experiment,
        concurrency=concurrency,
        mode=mode,
        on_progress=_progress,
    )
    _print_summary(experiment, result)
    return 1 if result.meta.errors > 0 else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sambaeval", description="SambaEval CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="Run an experiment from a JSON file")
    run.add_argument("experiment", help="Path to the experiment JSON file")
    run.add_argument(
        "--concurrency",
        type=int,
        default=None,
        help="Max concurrent tasks (1-32). Default: experiment.concurrency or 4.",
    )
    run.add_argument(
        "--resume",
        action="store_true",
        help="Resume the latest non-completed run for this experiment id.",
    )
    run.set_defaults(func=_cmd_run)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
