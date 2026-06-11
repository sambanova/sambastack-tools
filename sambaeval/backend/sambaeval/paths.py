"""Filesystem layout for SambaEval data.

All state lives under a single data directory (no database). The directory is
resolved from the ``SAMBAEVAL_DATA_DIR`` environment variable when set, falling
back to ``<repo>/sambaeval/data`` (two parents up from this package).
"""

from __future__ import annotations

import os
from pathlib import Path


def _default_data_dir() -> Path:
    # paths.py lives at sambaeval/backend/sambaeval/paths.py
    # parents[2] == the product directory "sambaeval", so /data sits beside app/.
    return Path(__file__).resolve().parents[2] / "data"


def data_dir() -> Path:
    env = os.environ.get("SAMBAEVAL_DATA_DIR")
    return Path(env).expanduser().resolve() if env else _default_data_dir()


def experiments_dir() -> Path:
    return data_dir() / "experiments"


def datasets_dir() -> Path:
    return data_dir() / "datasets"


def results_dir() -> Path:
    return data_dir() / "results"


def scorers_dir() -> Path:
    return data_dir() / "scorers"


def providers_file() -> Path:
    return data_dir() / "providers.json"


def scorer_file_path(name: str) -> Path:
    # basename guards against path traversal.
    safe = os.path.basename(name)
    return scorers_dir() / f"{safe}.json"


def experiment_file_path(experiment_id: str) -> Path:
    return experiments_dir() / f"{experiment_id}.json"


def dataset_file_path(name: str) -> Path:
    safe = os.path.basename(name)
    return datasets_dir() / safe


def experiment_runs_dir(experiment_id: str) -> Path:
    return results_dir() / experiment_id


def run_dir(experiment_id: str, run_id: str) -> Path:
    return experiment_runs_dir(experiment_id) / run_id


def run_results_path(experiment_id: str, run_id: str) -> Path:
    return run_dir(experiment_id, run_id) / "results.csv"


def run_meta_path(experiment_id: str, run_id: str) -> Path:
    return run_dir(experiment_id, run_id) / "run.json"


def run_experiment_snapshot_path(experiment_id: str, run_id: str) -> Path:
    return run_dir(experiment_id, run_id) / "experiment.json"
