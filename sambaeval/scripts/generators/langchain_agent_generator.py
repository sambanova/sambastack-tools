"""LangChain-agent SQL tool-use OutputGenerator for sambaeval.

Demonstrates driving a tool-use loop with a third-party agent framework rather
than hand-rolling the OpenAI tool-call loop. This generator hands an
``execute_sql_query`` tool to a LangChain agent built on ``ChatOpenAI`` and lets
the agent run the tool-call loop. The tool executes SQL against the bundled
``data/datasets/chinook.db`` and returns up to 50 rows as JSON. The agent's
final natural-language answer is what gets returned to sambaeval.

``ChatOpenAI`` talks to whichever OpenAI-compatible endpoint the experiment's
provider points at (``api_url`` / ``api_key`` from ``data/providers.json``), so
the same provider/model rows used by the hand-rolled generator work here too.

Metrics: the agent makes its LLM calls inside the LangChain runtime rather than
through ``self.stream_completion``, so token usage / TTFT / TPS are captured via
a callback handler that funnels every model call into ``self._record_call`` —
keeping per-row aggregation identical to the base class.
"""

import json
import os
import sqlite3
import time

from base import OutputGenerator, ROOT, run_cli

from langchain.agents import create_agent
from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI


CHINOOK_DB = os.path.join(ROOT, "data", "datasets", "chinook.db")
MAX_TOOL_TURNS = 6
MAX_ROWS_RETURNED = 50


def _uses_responses_api(llm: ChatOpenAI) -> bool:
    """Whether this ChatOpenAI will call OpenAI's Responses API.

    The Responses API rejects Chat-Completions-only params like ``seed``.
    Uses langchain-openai's own resolver (which folds in the ``use_responses_api``
    flag, ``reasoning``, and model-specific preferences such as gpt-5 / codex).
    Best-effort: if that internal API is unavailable, fall back to the explicit
    flag and assume Chat Completions otherwise.
    """
    try:
        return bool(llm._use_responses_api({}))
    except Exception:
        return llm.use_responses_api is True


def execute_sql(sql: str) -> str:
    conn = sqlite3.connect(CHINOOK_DB)
    try:
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(sql)
        rows = [dict(r) for r in cursor.fetchmany(MAX_ROWS_RETURNED)]
        return json.dumps({"rows": rows}, default=str)
    finally:
        conn.close()


@tool
def execute_sql_query(sql: str) -> str:
    """Execute a read-only SQL query against the Chinook SQLite database and
    return the resulting rows as JSON. Use this to look up data needed to
    answer the user's question.

    Args:
        sql: A valid SQLite SELECT statement.
    """
    try:
        return execute_sql(sql)
    except Exception as e:  # surface errors back to the model, like the OpenAI loop
        return json.dumps({"error": str(e)})


class _MetricsCallbackHandler(BaseCallbackHandler):
    """Record one ``_record_call`` per model call from LangChain callbacks.

    Captures client-side timing (start, first streamed token, end) and pulls
    token usage from the response. If the provider exposes its own timing
    fields (e.g. SambaNova's ``time_to_first_token`` / ``total_latency`` /
    ``completion_tokens_after_first_per_sec`` in ``response_metadata``), those
    are forwarded so ``_record_call`` prefers them over the client estimates,
    matching the base generator's behavior.
    """

    def __init__(self, generator: OutputGenerator) -> None:
        self._generator = generator
        self._t_start: float | None = None
        self._t_first: float | None = None

    def on_chat_model_start(self, *args, **kwargs) -> None:
        self._t_start = time.perf_counter()
        self._t_first = None

    def on_llm_new_token(self, *args, **kwargs) -> None:
        if self._t_first is None:
            self._t_first = time.perf_counter()

    def on_llm_end(self, response, **kwargs) -> None:
        t_end = time.perf_counter()
        usage_dict: dict = {}

        msg = None
        try:
            msg = response.generations[0][0].message
        except (IndexError, AttributeError):
            msg = None

        if msg is not None:
            um = getattr(msg, "usage_metadata", None) or {}
            if um:
                usage_dict["prompt_tokens"] = um.get("input_tokens")
                usage_dict["completion_tokens"] = um.get("output_tokens")
            rmeta = getattr(msg, "response_metadata", None) or {}
            for key in (
                "time_to_first_token",
                "total_latency",
                "completion_tokens_after_first_per_sec",
            ):
                if rmeta.get(key) is not None:
                    usage_dict[key] = rmeta[key]

        if "prompt_tokens" not in usage_dict and getattr(response, "llm_output", None):
            tu = response.llm_output.get("token_usage") or {}
            usage_dict["prompt_tokens"] = tu.get("prompt_tokens")
            usage_dict["completion_tokens"] = tu.get("completion_tokens")

        self._generator._record_call(
            usage_dict=usage_dict,
            t_start=self._t_start if self._t_start is not None else t_end,
            t_first=self._t_first,
            t_end=t_end,
        )


class LangChainAgentGenerator(OutputGenerator):
    def _build_llm(self) -> ChatOpenAI:
        """Construct a ChatOpenAI bound to the experiment's provider/model.

        Honors the experiment seed and ``additional_kwargs`` the same way
        ``completion_kwargs`` does: ``seed`` and ``temperature`` map to the
        native ChatOpenAI arguments; any remaining extras are passed through
        ``model_kwargs`` into the request body.

        ``seed`` is a Chat Completions parameter; some models (e.g. gpt-5 /
        codex / reasoning models) route through OpenAI's Responses API, which
        rejects ``seed``. We therefore attach ``seed`` only when the resolved
        model uses Chat Completions.
        """
        extra = dict(self.model.get("additional_kwargs") or {})
        temperature = extra.pop("temperature", None)

        kwargs: dict = {
            "model": self.model["name"],
            "base_url": self.provider["api_url"],
            "api_key": self.provider["api_key"],
            "streaming": True,
            "stream_usage": True,
        }
        if temperature is not None:
            kwargs["temperature"] = temperature
        if extra:
            kwargs["model_kwargs"] = extra

        llm = ChatOpenAI(**kwargs)

        seed = self.model.get("seed")
        if isinstance(seed, bool):
            pass  # bool is a subclass of int but never a valid seed
        elif isinstance(seed, (int, float)) and not _uses_responses_api(llm):
            llm.seed = int(seed)
        return llm

    def generate_output(
        self, system_prompt: str, messages: list[dict]
    ) -> str:
        if not messages:
            return ""

        # The final message is the current user turn (the agent's input);
        # everything before it is prior conversation history.
        history: list = []
        for m in messages[:-1]:
            role = m.get("role")
            content = m.get("content", "") or ""
            if role == "assistant":
                history.append(AIMessage(content=content))
            elif role == "user":
                history.append(HumanMessage(content=content))
            # other roles (system/tool) are not expected in dataset rows
        history.append(HumanMessage(content=messages[-1].get("content", "") or ""))

        llm = self._build_llm()
        agent = create_agent(
            llm,
            [execute_sql_query],
            system_prompt=system_prompt or None,
        )

        callbacks = [_MetricsCallbackHandler(self)]
        result = agent.invoke(
            {"messages": history},
            config={
                "callbacks": callbacks,
                # Each tool turn is ~2 graph steps (model call + tool); add
                # headroom so the loop can finish with a final answer.
                "recursion_limit": MAX_TOOL_TURNS * 2 + 1,
            },
        )

        final = result["messages"][-1]
        content = getattr(final, "content", final)
        if isinstance(content, list):
            # Some providers return content as a list of blocks; join text parts.
            content = "".join(
                part.get("text", "") if isinstance(part, dict) else str(part)
                for part in content
            )
        return content if isinstance(content, str) else str(content)


if __name__ == "__main__":
    run_cli(LangChainAgentGenerator)
