"""In-process loader for the output generators in scripts/generators/.

Generators run in the same process as the executor (a direct function call per
task — no subprocess). A generator script defines an ``OutputGenerator``
subclass and ends with ``run_cli(ThatClass)``. The ``run_cli`` call only fires
under ``__name__ == "__main__"``, so importing the module here is
side-effect-free; we resolve the entry class from the ``run_cli(<Class>)``
argument (which also lets a script define helper subclasses). Scripts that just
reuse the base class (e.g. default_generator.py) resolve to ``OutputGenerator``.
"""

from __future__ import annotations

import ast
import importlib.util
import sys
import threading
from pathlib import Path
from typing import Any, Optional

from .models import DatasetRow, ModelConfig, Provider

# The generator scripts live at <product>/scripts/generators, fixed relative to
# the repo — NOT relative to the (overridable) data dir. This file is at
# <product>/backend/sambaeval/generators.py, so parents[2] is the product root.
_ROOT = Path(__file__).resolve().parents[2]
_GENERATORS_DIR = _ROOT / "scripts" / "generators"
DEFAULT_GENERATOR = _GENERATORS_DIR / "default_generator.py"

_import_lock = threading.Lock()
_module_cache: dict[str, Any] = {}
_class_cache: dict[str, Any] = {}


def _ensure_generators_on_path() -> None:
    p = str(_GENERATORS_DIR)
    if p not in sys.path:
        sys.path.insert(0, p)


def resolve_generator_path(output_generator: Optional[str]) -> Path:
    if not output_generator or not output_generator.strip():
        return DEFAULT_GENERATOR
    p = Path(output_generator)
    return p if p.is_absolute() else (_ROOT / output_generator)


def _entry_class_name(script_path: Path) -> Optional[str]:
    """The class name passed to ``run_cli(<Name>)`` in the script, if any.

    This is the script's designated entry point (what the old subprocess path
    invoked), so it disambiguates scripts that define helper subclasses (e.g.
    SciCode's debugger variant) alongside the real generator.
    """
    try:
        tree = ast.parse(script_path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return None
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            fn = node.func
            fn_name = (
                fn.id if isinstance(fn, ast.Name)
                else fn.attr if isinstance(fn, ast.Attribute)
                else None
            )
            if fn_name == "run_cli" and node.args and isinstance(node.args[0], ast.Name):
                return node.args[0].id
    return None


def load_generator_class(script_path: Path):
    """Import a generator script and return its OutputGenerator subclass.

    Resolution order:
      1. the class named in ``run_cli(<Name>)`` (the script's declared entry);
      2. otherwise the single OutputGenerator subclass defined in the module
         (or the base class itself, e.g. default_generator.py);
      3. if neither disambiguates, raise with guidance.
    """
    if not script_path.exists():
        raise FileNotFoundError(f"Output generator script not found: {script_path}")
    with _import_lock:
        _ensure_generators_on_path()
        import base  # scripts/generators/base.py — defines OutputGenerator

        key = str(script_path.resolve())
        if key in _class_cache:
            return _class_cache[key]

        mod = _module_cache.get(key)
        if mod is None:
            mod_name = f"sambaeval_gen_{abs(hash(key))}"
            spec = importlib.util.spec_from_file_location(mod_name, script_path)
            if spec is None or spec.loader is None:
                raise ImportError(f"Cannot load generator module from {script_path}")
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _module_cache[key] = mod

        # 1) The class designated via run_cli(<Name>).
        entry = _entry_class_name(script_path)
        if entry:
            cls = getattr(mod, entry, None)
            if isinstance(cls, type) and issubclass(cls, base.OutputGenerator):
                _class_cache[key] = cls
                return cls

        # 2) Single OutputGenerator subclass defined in the module.
        candidates = [
            v
            for v in vars(mod).values()
            if isinstance(v, type)
            and issubclass(v, base.OutputGenerator)
            and v.__module__ == mod.__name__
        ]
        if len(candidates) == 1:
            _class_cache[key] = candidates[0]
            return candidates[0]
        if len(candidates) == 0:
            _class_cache[key] = base.OutputGenerator  # e.g. default_generator.py
            return base.OutputGenerator

        raise RuntimeError(
            f"{script_path} defines multiple OutputGenerator subclasses "
            f"({[c.__name__ for c in candidates]}) and has no run_cli(<Class>) "
            f"entry to disambiguate. End the script with run_cli(<YourClass>)."
        )


def _resolve_system_prompt(
    experiment_system_prompt: str, model: ModelConfig, row: DatasetRow
) -> str:
    """Precedence: row override > model override > experiment global.

    Mirrors run_cli in scripts/generators/base.py.
    """
    if row.system_prompt is not None:
        return row.system_prompt
    msp = model.system_prompt or "global"
    if not msp or msp == "global":
        return experiment_system_prompt or ""
    return msp


def run_generator(
    *,
    generator_cls,
    provider: Provider,
    model: ModelConfig,
    experiment_system_prompt: str,
    row: DatasetRow,
) -> tuple[str, Optional[dict]]:
    """Instantiate a generator and produce (output_text, aggregated_metrics)."""
    system_prompt = _resolve_system_prompt(experiment_system_prompt, model, row)
    generator = generator_cls(provider.model_dump(), model.model_dump())
    generator.example_id = row.example_id
    messages = [m.model_dump(exclude_none=True) for m in row.messages]
    output = generator.generate_output(system_prompt, messages)
    metrics = generator.aggregate_metrics()
    return output, metrics
