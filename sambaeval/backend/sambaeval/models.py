"""Pydantic data models for SambaEval.

Two inline forms let an experiment file be fully self-contained:
  * ``Experiment.dataset`` may be a filename (str) OR a list of inline rows.
    Inline rows are coerced by ``datasets.load_dataset`` using the exact same
    rules as the JSONL parser, so the inline shape == one JSONL row per item.
  * ``LlmJudgeScorer`` may reference a scorer file by ``scorer_name`` OR embed
    the full judge ``definition`` inline.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Optional, Union

from pydantic import BaseModel, Field

Role = Literal["system", "user", "assistant", "tool"]


class Message(BaseModel):
    model_config = {"extra": "ignore"}

    role: Role
    content: str
    tool_calls: Optional[Any] = None
    tool_call_id: Optional[str] = None
    name: Optional[str] = None


class Provider(BaseModel):
    model_config = {"extra": "ignore"}

    name: str
    api_url: str
    api_key: str


class ModelConfig(BaseModel):
    model_config = {"extra": "ignore"}

    name: str
    # Temperature is not a first-class field: the newest frontier models reject
    # an explicit temperature (or reject 0.0), and there's no universal default.
    # Set it (and any other sampling param) via additional_kwargs on the models
    # that support it; otherwise the parameter is simply never sent.
    seed: Optional[int] = None
    # "" or "global" => fall back to the experiment-level system_prompt.
    system_prompt: str = "global"
    provider_name: str
    additional_kwargs: Optional[dict[str, Any]] = None
    # Token pricing in USD per 1,000,000 tokens, used only to compute run/model
    # costs in the Results UI (never sent to the provider). Treated as a "result
    # config": editing it and clicking "Update Costs" re-derives costs from the
    # stored token counts without re-running the experiment. Defaults are
    # pre-filled from the provider's /models pricing when available.
    input_price: Optional[float] = None
    output_price: Optional[float] = None


class LlmJudgeScorerDef(BaseModel):
    model_config = {"extra": "ignore"}

    name: str
    provider_name: str
    model: str
    judge_prompt: str
    max_score: int = 5
    # Extra request kwargs forwarded to the judge model's chat completions call
    # (e.g. temperature, top_p, max_tokens). Same mechanism as a model's
    # additional_kwargs — temperature is configured here, not as its own field.
    additional_kwargs: Optional[dict[str, Any]] = None


class HeuristicScorer(BaseModel):
    model_config = {"extra": "ignore"}

    type: Literal["heuristic"] = "heuristic"


class LlmJudgeScorer(BaseModel):
    """LLM-judge scorer: reference a file by name OR embed the definition.

    Exactly one of ``scorer_name`` / ``definition`` should be set; resolution
    (and the "missing" error) happens in scoring/executor — a missing scorer
    surfaces as a per-row JUDGE ERROR.
    """

    model_config = {"extra": "ignore"}

    type: Literal["llm"] = "llm"
    scorer_name: Optional[str] = None
    definition: Optional[LlmJudgeScorerDef] = None


Scorer = Annotated[
    Union[HeuristicScorer, LlmJudgeScorer],
    Field(discriminator="type"),
]


class Experiment(BaseModel):
    model_config = {"extra": "ignore"}

    id: str
    name: str
    models: list[ModelConfig]
    system_prompt: str = ""
    # filename in data/datasets/ OR inline list of raw rows (coerced later).
    dataset: Union[str, list[Any]]
    scorer: Optional[Scorer] = None
    output_generator: Optional[str] = None
    concurrency: Optional[int] = None
    example_count: Optional[int] = None
    # True when the experiment lives in the private (gitignored) tree. Derived
    # from its file location on read; on save it decides which tree to write to.
    # Not persisted in the experiment JSON — the folder is the source of truth.
    private: bool = False


class DatasetRow(BaseModel):
    model_config = {"extra": "ignore"}

    example_id: int
    messages: list[Message]
    system_prompt: Optional[str] = None
    expected_output: str = ""
    weight: float = 1.0
    # OpenAI-style tool/function definitions available to the model for this
    # row (the JSON schemas, not the calls). Passed through to generators that
    # drive tool-calling evals; ignored by text-only generators.
    tools: Optional[list[Any]] = None


class ResultRow(BaseModel):
    model_config = {"extra": "ignore"}

    result_id: int
    status: Literal["completed", "error"]
    provider: str
    model: str
    example_id: int
    output: str
    score: float
    weight: float
    score_reason: Optional[str] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    latency_ms: Optional[float] = None
    ttft_ms: Optional[float] = None
    tps: Optional[float] = None
    num_llm_calls: Optional[int] = None


RunStatus = Literal["running", "completed", "aborted", "interrupted", "paused"]


class RunMeta(BaseModel):
    model_config = {"extra": "ignore"}

    run_id: str
    status: RunStatus
    started_at: str
    finished_at: Optional[str] = None
    resumed_at: list[str] = Field(default_factory=list)
    total: int
    completed: int = 0
    errors: int = 0
    # True once results from the current experiment have been merged into this
    # run (mode="merged"). Such a run's rows span more than the experiment's
    # current model×dataset grid, so resuming/retrying it must rebuild from its
    # own rows and preserve the ones the grid doesn't cover, rather than pruning
    # them as orphans. Absent in pre-existing run.json files → defaults False.
    merged: bool = False
    # True when the run was started for only a subset of the experiment's models
    # (a "partial" run). Like a merged run, its grid is defined by its own rows —
    # not the full experiment — so resuming/retrying must rebuild from those rows
    # and must not re-expand to the models the run deliberately left out.
    partial: bool = False
