"""Non-streaming chat completion for the LLM judge.

Generators stream their own completions via the OpenAI SDK (see generators/);
this helper is only used by the LLM-judge scorer, which needs a single
blocking call with an optional ``json_object`` response format.
"""

from __future__ import annotations

from typing import Any, Optional

import httpx

from .models import ModelConfig, Provider


def _join_url(base: str, suffix: str) -> str:
    trimmed = base.rstrip("/")
    if trimmed.endswith("/chat/completions"):
        return trimmed
    return f"{trimmed}{suffix}"


def call_model(
    *,
    provider: Provider,
    model: ModelConfig,
    system_prompt: str,
    user_prompt: str,
    response_format: Optional[dict[str, Any]] = None,
    timeout: float = 600.0,
) -> str:
    url = _join_url(provider.api_url, "/chat/completions")
    messages: list[dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": user_prompt})

    body: dict[str, Any] = {
        "model": model.name,
        "messages": messages,
        "temperature": model.temperature,
    }
    if isinstance(model.seed, int):
        body["seed"] = model.seed
    if model.additional_kwargs:
        for k, v in model.additional_kwargs.items():
            if v is not None:
                body[k] = v
    if response_format:
        body["response_format"] = response_format

    resp = httpx.post(
        url,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {provider.api_key}",
        },
        json=body,
        timeout=timeout,
    )
    if resp.status_code >= 400:
        raise RuntimeError(
            f"Provider {provider.name} returned {resp.status_code}: "
            f"{resp.text[:500]}"
        )

    data = resp.json()
    if isinstance(data.get("error"), dict) and data["error"].get("message"):
        raise RuntimeError(data["error"]["message"])
    choices = data.get("choices") or []
    if choices:
        choice = choices[0]
        content = (choice.get("message") or {}).get("content")
        if content is None:
            content = choice.get("text")
        return content or ""
    return ""
