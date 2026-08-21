"""One-time backfill: seed the DB + object store from the on-disk ``data/`` tree
(prodplan §5). Everything is owned by the system user and made **public**.

Idempotent: experiments/scorers/datasets upsert; runs are skipped if already
present. Reads the files directly (not through the DB-bound storage layer) and
writes through the DB backend under the system-owner context.

Run:  python -m sambaeval.backfill   [--data-dir PATH]
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from sqlalchemy import select

from . import bootstrap, context, paths, storage
from .db import session_scope
from .models import Experiment, LlmJudgeScorerDef, RunMeta
from .models_db import SYSTEM_USER_ID, Result, Run, RunError
from .storage import parse_rows  # file CSV parser (not rebound)


def _dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _seed_experiments(data: Path) -> int:
    n = 0
    d = data / "experiments"
    if not d.exists():
        return 0
    for f in sorted(d.glob("*.json")):
        try:
            raw = json.loads(f.read_text(encoding="utf-8"))
            raw["id"] = f.stem
            raw["private"] = False  # seeded content is public
            exp = Experiment.model_validate(raw)
            storage.save_experiment(exp)
            n += 1
        except Exception as err:  # noqa: BLE001
            print(f"  ! experiment {f.name}: {err}")
    return n


def _seed_scorers(data: Path) -> int:
    n = 0
    d = data / "scorers"
    if not d.exists():
        return 0
    for f in sorted(d.glob("*.json")):
        try:
            raw = json.loads(f.read_text(encoding="utf-8"))
            scorer = LlmJudgeScorerDef.model_validate({**raw, "name": raw.get("name") or f.stem})
            storage.save_scorer(scorer)
            n += 1
        except Exception as err:  # noqa: BLE001
            print(f"  ! scorer {f.name}: {err}")
    return n


def _seed_datasets(data: Path) -> int:
    n = 0
    d = data / "datasets"
    if not d.exists():
        return 0
    for f in sorted(d.iterdir()):
        if not f.is_file() or f.suffix.lower() not in (".jsonl", ".csv"):
            # Large fixtures (chinook.db, *.h5) and dir datasets (scicode/,
            # spider1/) belong to the deferred sandbox path — skip for the PoV.
            continue
        try:
            storage.write_dataset(f.name, f.read_text(encoding="utf-8"), private=False)
            n += 1
        except Exception as err:  # noqa: BLE001
            print(f"  ! dataset {f.name}: {err}")
    return n


def _seed_runs(data: Path) -> int:
    n = 0
    results_root = data / "results"
    if not results_root.exists():
        return 0
    for exp_dir in sorted(results_root.iterdir()):
        if not exp_dir.is_dir():
            continue
        exp_id = exp_dir.name
        for run_dir in sorted(exp_dir.iterdir()):
            if not run_dir.is_dir():
                continue
            run_label = run_dir.name
            meta_path = run_dir / "run.json"
            if not meta_path.exists():
                continue
            with session_scope() as session:
                exists = session.execute(
                    select(Run).where(
                        Run.experiment_id == exp_id, Run.run_label == run_label
                    )
                ).scalar_one_or_none()
                if exists is not None:
                    continue
                try:
                    meta = RunMeta.model_validate_json(meta_path.read_text(encoding="utf-8"))
                except Exception as err:  # noqa: BLE001
                    print(f"  ! run.json {exp_id}/{run_label}: {err}")
                    continue
                snapshot = {}
                snap_path = run_dir / "experiment.json"
                if snap_path.exists():
                    try:
                        snapshot = json.loads(snap_path.read_text(encoding="utf-8"))
                    except Exception:  # noqa: BLE001
                        snapshot = {}
                run = Run(
                    experiment_id=exp_id,
                    owner_id=SYSTEM_USER_ID,
                    run_label=run_label,
                    status=meta.status,
                    config_snapshot=snapshot or None,
                    total=meta.total,
                    completed=meta.completed,
                    errors=meta.errors,
                    merged=meta.merged,
                    partial=meta.partial,
                    visibility="public",
                    started_at=_dt(meta.started_at),
                    finished_at=_dt(meta.finished_at),
                    resumed_at=list(meta.resumed_at or []),
                )
                session.add(run)
                session.flush()
                # results.csv
                csv_path = run_dir / "results.csv"
                if csv_path.exists():
                    for r in parse_rows(csv_path.read_text(encoding="utf-8")):
                        session.add(
                            Result(
                                run_id=run.id,
                                result_id=r.result_id,
                                status=r.status,
                                provider=r.provider,
                                model=r.model,
                                example_id=r.example_id,
                                output=r.output,
                                score=r.score,
                                weight=r.weight,
                                score_reason=r.score_reason,
                                input_tokens=r.input_tokens,
                                output_tokens=r.output_tokens,
                                latency_ms=r.latency_ms,
                                ttft_ms=r.ttft_ms,
                                tps=r.tps,
                                num_llm_calls=r.num_llm_calls,
                            )
                        )
                # errors.json -> run_errors
                err_path = run_dir / "errors.json"
                if err_path.exists():
                    try:
                        errs = json.loads(err_path.read_text(encoding="utf-8"))
                    except Exception:  # noqa: BLE001
                        errs = {}
                    for ex_id, by_model in (errs or {}).items():
                        for pm, detail in (by_model or {}).items():
                            session.add(
                                RunError(
                                    run_id=run.id,
                                    example_id=int(ex_id),
                                    provider_model=pm,
                                    phase=(detail or {}).get("phase"),
                                    message=(detail or {}).get("message"),
                                )
                            )
                n += 1
    return n


def backfill(data_dir: Optional[Path] = None) -> None:
    data = data_dir or paths.data_dir()
    print(f"[backfill] seeding from {data}")
    bootstrap.bootstrap()
    with context.owner(SYSTEM_USER_ID):
        ne = _seed_experiments(data)
        ns = _seed_scorers(data)
        nd = _seed_datasets(data)
        nr = _seed_runs(data)
    print(f"[backfill] experiments={ne} scorers={ns} datasets={nd} runs={nr}")


def main() -> None:
    ap = argparse.ArgumentParser(prog="sambaeval-backfill")
    ap.add_argument("--data-dir", type=str, default=None, help="seed from a local data/ tree")
    ap.add_argument(
        "--seed-prefix",
        type=str,
        default=None,
        help="pull the seed bundle from the object store under this prefix, then backfill "
        "(the prod path — see seed_bundle.py). Mutually exclusive with --data-dir.",
    )
    args = ap.parse_args()
    if args.seed_prefix:
        import tempfile

        from . import seed_bundle

        tmp = tempfile.mkdtemp(prefix="sambaeval-seed-")
        seed_bundle.pull(args.seed_prefix, tmp)
        backfill(Path(tmp))
        return
    backfill(Path(args.data_dir).expanduser().resolve() if args.data_dir else None)


if __name__ == "__main__":
    main()
