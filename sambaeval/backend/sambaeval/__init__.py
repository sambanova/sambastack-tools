"""SambaEval — Python evaluation engine (library + CLI).

``run_experiment`` is imported lazily so the lighter-weight modules (models,
datasets, scoring) can be used without pulling in the executor.
"""

from __future__ import annotations

from .models import (
    DatasetRow,
    Experiment,
    LlmJudgeScorerDef,
    ModelConfig,
    Provider,
    ResultRow,
    RunMeta,
)

__all__ = [
    "DatasetRow",
    "Experiment",
    "LlmJudgeScorerDef",
    "ModelConfig",
    "Provider",
    "ResultRow",
    "RunMeta",
    "run_experiment",
]


def __getattr__(name: str):  # PEP 562 lazy export
    if name == "run_experiment":
        from .executor import run_experiment

        return run_experiment
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
