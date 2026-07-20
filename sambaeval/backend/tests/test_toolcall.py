"""Tests for per-row tool definitions and tool-call capture.

Tool calling is a base-level capability, so everything here runs against public
code — no private generator required. Three layers, all fully offline:
  * dataset parsing: a row's ``tools`` list flows into ``DatasetRow.tools``;
  * base capture: ``stream_completion`` accumulates streamed ``tool_calls``
    deltas into ``last_tool_calls`` and ``parsed_tool_calls`` decodes them;
  * default generator: the default generator (which just runs
    ``OutputGenerator``) forwards the ``tools`` / ``tool_choice`` request kwargs
    to the provider and captures the model's tool-call reply.

The generator layers stub the OpenAI client with a fake stream, so no provider
is contacted and no API key is needed.
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from sambaeval.datasets import row_from_obj

# base.py and the default generator live in scripts/generators/, imported the
# same way the executor's in-process loader reaches them (base is always on
# sys.path). Tool calling is a base capability, so the default generator (which
# just runs OutputGenerator) exercises it — no private generator needed.
_GENERATORS = Path(__file__).resolve().parents[2] / "scripts" / "generators"
if str(_GENERATORS) not in sys.path:
    sys.path.insert(0, str(_GENERATORS))

import base  # noqa: E402
import default_generator  # noqa: E402


# --------------------------------------------------------------------------- #
# dataset parsing
# --------------------------------------------------------------------------- #

def _tool(name):
    return {"type": "function", "function": {"name": name, "parameters": {}}}


def test_row_parses_tools_list():
    row = row_from_obj({
        "example_id": 1,
        "messages": [{"role": "user", "content": "hi"}],
        "tools": [_tool("query_event_step"), _tool("aggregate_event_step")],
    })
    assert row.tools is not None
    assert [t["function"]["name"] for t in row.tools] == [
        "query_event_step", "aggregate_event_step"]


def test_row_without_tools_is_none():
    row = row_from_obj({
        "example_id": 2,
        "messages": [{"role": "user", "content": "hi"}],
    })
    assert row.tools is None


def test_row_non_list_tools_coerced_to_none():
    row = row_from_obj({
        "example_id": 3,
        "prompt": "hi",
        "tools": "not-a-list",
    })
    assert row.tools is None


# --------------------------------------------------------------------------- #
# fake stream plumbing
# --------------------------------------------------------------------------- #

def _delta(content=None, tool_calls=None):
    return SimpleNamespace(content=content, tool_calls=tool_calls)


def _tc_delta(index, *, id=None, name=None, arguments=None):
    return SimpleNamespace(
        index=index, id=id,
        function=SimpleNamespace(name=name, arguments=arguments),
    )


def _chunk(delta=None, usage=None):
    choices = [] if delta is None else [SimpleNamespace(delta=delta)]
    return SimpleNamespace(choices=choices, usage=usage)


class _Usage:
    def __init__(self, d):
        self._d = d

    def model_dump(self):
        return dict(self._d)


class _FakeCompletions:
    def __init__(self, chunks, sink):
        self._chunks = chunks
        self._sink = sink

    def create(self, **kwargs):
        self._sink.update(kwargs)  # record what was sent (tools, etc.)
        return iter(self._chunks)


class _FakeClient:
    def __init__(self, chunks, sink):
        self.chat = SimpleNamespace(completions=_FakeCompletions(chunks, sink))


def _install_fake(gen, chunks):
    sink: dict = {}
    gen._client = _FakeClient(chunks, sink)
    return sink


def _make_generator(cls):
    # provider/model dicts are only read for name/api_url/api_key; the fake
    # client bypasses the real OpenAI construction.
    return cls(
        {"name": "SambaNova", "api_url": "http://x", "api_key": "unused"},
        {"name": "MiniMax-M2.7", "seed": 42},
    )


# --------------------------------------------------------------------------- #
# base capture
# --------------------------------------------------------------------------- #

def test_stream_completion_accumulates_tool_calls_across_deltas():
    gen = _make_generator(base.OutputGenerator)
    chunks = [
        _chunk(_delta(tool_calls=[_tc_delta(0, id="call_1", name="query_event_step")])),
        _chunk(_delta(tool_calls=[_tc_delta(0, arguments='{"masterRef":')])),
        _chunk(_delta(tool_calls=[_tc_delta(0, arguments='"ILC335"}')])),
        _chunk(_delta(content="")),
        _chunk(usage=_Usage({"prompt_tokens": 10, "completion_tokens": 5})),
    ]
    _install_fake(gen, chunks)

    text = gen.stream_completion([{"role": "user", "content": "hi"}])
    assert text == ""
    assert len(gen.last_tool_calls) == 1
    assert gen.last_tool_calls[0]["name"] == "query_event_step"
    assert gen.last_tool_calls[0]["arguments"] == '{"masterRef":"ILC335"}'
    # metrics recorded exactly one call
    assert gen.aggregate_metrics()["num_llm_calls"] == 1


def test_parsed_tool_calls_decodes_and_falls_back():
    gen = _make_generator(base.OutputGenerator)
    gen.last_tool_calls = [
        {"id": "a", "name": "good", "arguments": '{"x": 1}'},
        {"id": "b", "name": "bad", "arguments": "{not json"},
        {"id": "c", "name": "empty", "arguments": ""},
    ]
    parsed = gen.parsed_tool_calls()
    assert parsed[0] == {"name": "good", "arguments": {"x": 1}}
    assert parsed[1] == {"name": "bad", "arguments": "{not json"}  # raw fallback
    assert parsed[2] == {"name": "empty", "arguments": {}}


def test_text_only_stream_leaves_no_tool_calls():
    gen = _make_generator(base.OutputGenerator)
    chunks = [
        _chunk(_delta(content="hello ")),
        _chunk(_delta(content="world")),
        _chunk(usage=_Usage({"prompt_tokens": 3, "completion_tokens": 2})),
    ]
    _install_fake(gen, chunks)
    assert gen.stream_completion([{"role": "user", "content": "hi"}]) == "hello world"
    assert gen.last_tool_calls == []


# --------------------------------------------------------------------------- #
# default generator: tool forwarding + capture (public, no private artifact)
# --------------------------------------------------------------------------- #
# The default generator (default_generator.py) just runs OutputGenerator, so
# tool calling is exercised at the base level: stream_completion forwards the
# `tools` / `tool_choice` request kwargs to the provider and captures the
# model's tool-call reply.

def test_default_generator_forwards_tools_and_captures_calls():
    gen = _make_generator(default_generator.OutputGenerator)
    tools = [_tool("query_event_step")]
    chunks = [
        _chunk(_delta(tool_calls=[
            _tc_delta(0, id="c1", name="query_event_step",
                      arguments='{"masterRef":"ILC335"}')])),
        _chunk(usage=_Usage({"prompt_tokens": 20, "completion_tokens": 8})),
    ]
    sink = _install_fake(gen, chunks)

    text = gen.stream_completion(
        [{"role": "user", "content": "check it"}],
        tools=tools,
        tool_choice="auto",
    )
    # tools / tool_choice forwarded verbatim to the request
    assert sink["tools"] == tools
    assert sink["tool_choice"] == "auto"
    # the model's tool call was captured and decodes cleanly
    assert text == ""
    assert gen.parsed_tool_calls() == [
        {"name": "query_event_step", "arguments": {"masterRef": "ILC335"}}]


def test_default_generator_without_tools_sends_no_tools_kwarg():
    gen = _make_generator(default_generator.OutputGenerator)
    chunks = [
        _chunk(_delta(content="just text")),
        _chunk(usage=_Usage({"prompt_tokens": 4, "completion_tokens": 2})),
    ]
    sink = _install_fake(gen, chunks)
    # The default generate_output path sends no tool kwargs.
    out = gen.generate_output("", [{"role": "user", "content": "hi"}])
    assert out == "just text"
    assert "tools" not in sink
    assert "tool_choice" not in sink
    assert gen.parsed_tool_calls() == []


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
