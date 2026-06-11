"""Scoring — heuristic and LLM-judge.

Heuristic scorer (exact / contains: / ratio:) and an LLM-judge scorer that
renders a prompt, calls a judge model, and parses a normalized score.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Optional

from .models import LlmJudgeScorerDef, Message, ModelConfig, Provider
from .openai_client import call_model

DEFAULT_JUDGE_PROMPT = """You are an impartial evaluator. Given a user prompt, an expected reference answer, and a model-generated response, decide how well the model response answers the prompt and matches the expected reference.

User prompt:
{prompt}

Expected reference:
{expected_output}

Model response:
{output}

Give an INTEGER score from 0 to {max_score}, where:
- {max_score} = fully correct and aligned with the expected reference, OR functionally / semantically equivalent (trivial whitespace, formatting, or notation differences should not be penalized)
- 0 = completely wrong, unrelated, or refuses to answer
- values in between = graded partial credit

Respond with a single JSON object and NOTHING ELSE, of the form:
{"score": <integer 0..{max_score}>, "score_reason": "<one or two sentences explaining the score>"}"""


def messages_to_transcript(messages: list[Message]) -> str:
    if len(messages) == 1 and messages[0].role == "user":
        return messages[0].content
    return "\n".join(f"{m.role}: {m.content}" for m in messages)


def heuristic_score(expected: str, output: str, weight: float) -> float:
    w = weight if math.isfinite(weight) else 1.0
    trimmed = expected.strip()
    out = output.strip()
    lower = trimmed.lower()
    if lower.startswith("contains:"):
        needle = trimmed[len("contains:") :].strip()
        return w if needle in out else 0.0
    if lower.startswith("ratio:"):
        # Partial credit: first "N/M" fraction in the output. M==0 => full
        # credit; no fraction => 0.
        m = re.search(r"(\d+)\s*/\s*(\d+)", out)
        if not m:
            return 0.0
        num = float(m.group(1))
        denom = float(m.group(2))
        if denom == 0:
            return w
        return max(0.0, min(1.0, num / denom)) * w
    return w if out == trimmed else 0.0


@dataclass
class JudgeResult:
    score: float
    score_reason: Optional[str]


def _extract_json_object(text: str) -> Optional[str]:
    trimmed = text.strip()
    if trimmed.startswith("{"):
        return trimmed
    start = trimmed.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(trimmed)):
        ch = trimmed[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return trimmed[start : i + 1]
    return None


def _parse_judge_response(text: str, max_score: int) -> JudgeResult:
    def clamp(n: float) -> float:
        return max(0.0, min(float(max_score), n)) / max_score

    candidate = _extract_json_object(text)
    if candidate:
        try:
            parsed = json.loads(candidate)
            raw_score = float(parsed.get("score"))
            score = clamp(raw_score) if math.isfinite(raw_score) else 0.0
            reason = parsed.get("score_reason")
            reason = reason if isinstance(reason, str) and reason else None
            return JudgeResult(score=score, score_reason=reason)
        except (ValueError, TypeError, json.JSONDecodeError):
            pass

    match = re.search(r"-?\d+(?:\.\d+)?", text)
    n = float(match.group(0)) if match else 0.0
    score = clamp(n) if math.isfinite(n) else 0.0
    return JudgeResult(
        score=score,
        score_reason=f"[unparseable judge response] {text.strip()[:500]}",
    )


def render_judge_prompt(
    template: str,
    *,
    prompt: str,
    output: str,
    expected_output: str,
    max_score: int,
) -> str:
    return (
        template.replace("{prompt}", prompt)
        .replace("{output}", output)
        .replace("{expected_output}", expected_output)
        .replace("{max_score}", str(max_score))
    )


def llm_judge_score(
    *,
    scorer: LlmJudgeScorerDef,
    provider: Provider,
    prompt: str,
    expected: str,
    output: str,
    weight: float,
) -> JudgeResult:
    w = weight if math.isfinite(weight) else 1.0
    max_score = scorer.max_score if scorer.max_score and scorer.max_score > 0 else 5
    rendered = render_judge_prompt(
        scorer.judge_prompt,
        prompt=prompt,
        output=output,
        expected_output=expected,
        max_score=max_score,
    )
    judge_output = call_model(
        provider=provider,
        model=ModelConfig(
            name=scorer.model,
            temperature=scorer.temperature,
            system_prompt="",
            provider_name=provider.name,
        ),
        system_prompt="",
        user_prompt=rendered,
        response_format={"type": "json_object"},
    )
    result = _parse_judge_response(judge_output, max_score)
    return JudgeResult(score=result.score * w, score_reason=result.score_reason)
