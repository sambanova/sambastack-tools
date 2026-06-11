"""Dataset loading and normalization.

Supports three sources, all producing a normalized ``list[DatasetRow]``:
  * a ``.jsonl`` filename in data/datasets/
  * a ``.csv`` filename in data/datasets/
  * an inline ``list`` of raw row objects on ``Experiment.dataset`` — each item
    follows the same shape as one JSONL row.
"""

from __future__ import annotations

import csv
import io
import json
from typing import Any

from .models import DatasetRow, Message
from .paths import dataset_file_path

_VALID_ROLES = {"system", "user", "assistant", "tool"}


def coerce_messages(value: Any, example_id: int) -> list[Message]:
    if not isinstance(value, list) or len(value) == 0:
        raise ValueError(
            f'row {example_id}: "messages" must be a non-empty array'
        )
    out: list[Message] = []
    for i, raw in enumerate(value):
        if not isinstance(raw, dict):
            raise ValueError(f"row {example_id}: messages[{i}] must be an object")
        role = raw.get("role")
        if role not in _VALID_ROLES:
            raise ValueError(
                f"row {example_id}: messages[{i}].role must be "
                "system|user|assistant|tool"
            )
        content = raw.get("content")
        if not isinstance(content, str):
            raise ValueError(
                f"row {example_id}: messages[{i}].content must be a string"
            )
        msg = Message(role=role, content=content)
        if raw.get("tool_calls") is not None:
            msg.tool_calls = raw["tool_calls"]
        if isinstance(raw.get("tool_call_id"), str):
            msg.tool_call_id = raw["tool_call_id"]
        if isinstance(raw.get("name"), str):
            msg.name = raw["name"]
        out.append(msg)
    return out


def row_from_obj(row: dict[str, Any]) -> DatasetRow:
    """Coerce one raw row object (JSONL line or inline item) into a DatasetRow."""
    try:
        example_id = int(row["example_id"])
    except (KeyError, TypeError, ValueError):
        raise ValueError('"example_id" is required') from None

    has_prompt = isinstance(row.get("prompt"), str)
    has_messages = row.get("messages") is not None
    if has_prompt and has_messages:
        raise ValueError(
            f'row {example_id}: set either "prompt" or "messages", not both'
        )
    if not has_prompt and not has_messages:
        raise ValueError(
            f'row {example_id}: either "prompt" or "messages" is required'
        )

    if has_messages:
        messages = coerce_messages(row["messages"], example_id)
    else:
        messages = [Message(role="user", content=row["prompt"])]

    system_prompt = row.get("system_prompt")
    if not isinstance(system_prompt, str):
        system_prompt = None

    expected = row.get("expected_output")
    expected_output = expected if isinstance(expected, str) else ""

    weight = row.get("weight")
    weight = float(weight) if isinstance(weight, (int, float)) else 1.0

    return DatasetRow(
        example_id=example_id,
        messages=messages,
        system_prompt=system_prompt,
        expected_output=expected_output,
        weight=weight,
    )


def parse_jsonl(raw: str) -> list[DatasetRow]:
    out: list[DatasetRow] = []
    for i, line in enumerate(raw.split("\n")):
        stripped = line.strip()
        if stripped == "":
            continue
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError as err:
            raise ValueError(f"JSONL line {i + 1}: {err}") from err
        out.append(row_from_obj(obj))
    return out


def parse_csv(raw: str) -> list[DatasetRow]:
    reader = csv.DictReader(io.StringIO(raw))
    out: list[DatasetRow] = []
    for r in reader:
        weight_raw = (r.get("weight") or "").strip()
        out.append(
            DatasetRow(
                example_id=int(r["example_id"]),
                messages=[Message(role="user", content=r.get("prompt") or "")],
                system_prompt=None,
                expected_output=r.get("expected_output") or "",
                weight=float(weight_raw) if weight_raw else 1.0,
            )
        )
    return out


def load_dataset(dataset: str | list[Any]) -> list[DatasetRow]:
    """Resolve an experiment's ``dataset`` field into normalized rows."""
    if isinstance(dataset, list):
        return [row_from_obj(item) for item in dataset]
    if dataset.lower().endswith(".jsonl"):
        raw = dataset_file_path(dataset).read_text(encoding="utf-8")
        return parse_jsonl(raw)
    raw = dataset_file_path(dataset).read_text(encoding="utf-8")
    return parse_csv(raw)
