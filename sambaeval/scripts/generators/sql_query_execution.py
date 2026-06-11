"""SQL tool-use OutputGenerator for sambaeval.

Demonstrates how to extend the base `OutputGenerator` to drive a
tool-use loop. The model is given a single `execute_sql_query` tool
that runs SQL against the bundled `data/datasets/chinook.db` file and
returns the resulting rows as JSON. The model decides what SQL to run;
this script just executes it and feeds the results back. The final
natural-language answer from the model is what gets returned to
sambaeval.

Two methods are overridden from the base class:

- `stream_completion`: extended to also accumulate streamed
  `delta.tool_calls` and return them alongside the text.
- `generate_output`: drives the tool-use loop, executing each
  `execute_sql_query` call against chinook.db and appending the
  result as a `role=tool` message until the model produces a final
  text answer.
"""

import json
import os
import sqlite3
import time

from base import OutputGenerator, ROOT, run_cli


CHINOOK_DB = os.path.join(ROOT, "data", "datasets", "chinook.db")
MAX_TOOL_TURNS = 6
MAX_ROWS_RETURNED = 50

SQL_TOOL = {
    "type": "function",
    "function": {
        "name": "execute_sql_query",
        "description": (
            "Execute a read-only SQL query against the Chinook SQLite "
            "database and return the resulting rows as JSON. Use this "
            "to look up data needed to answer the user's question."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": "A valid SQLite SELECT statement.",
                }
            },
            "required": ["sql"],
        },
    },
}


def execute_sql(sql: str) -> str:
    conn = sqlite3.connect(CHINOOK_DB)
    try:
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(sql)
        rows = [dict(r) for r in cursor.fetchmany(MAX_ROWS_RETURNED)]
        return json.dumps({"rows": rows}, default=str)
    finally:
        conn.close()


class SQLQueryGenerator(OutputGenerator):
    def stream_completion(
        self, messages: list[dict], **kwargs
    ) -> tuple[str, list[dict]]:
        """Stream a completion, return (text, tool_calls).

        Overrides the base method so the caller can also see streamed
        tool calls. `tool_calls` is a list of OpenAI-shaped tool-call
        dicts (id, type, function with name and concatenated arguments)
        ready to replay into a subsequent assistant message.
        """
        client = self._get_client()
        t_start = time.perf_counter()
        t_first: float | None = None
        text_parts: list[str] = []
        usage_dict: dict = {}
        tool_calls_acc: dict[int, dict] = {}

        stream = client.chat.completions.create(
            model=self.model["name"],
            messages=messages,
            stream=True,
            stream_options={"include_usage": True},
            **kwargs,
        )
        for chunk in stream:
            chunk_usage = getattr(chunk, "usage", None)
            if chunk_usage is not None:
                usage_dict = chunk_usage.model_dump()
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            content = getattr(delta, "content", None)
            if content:
                if t_first is None:
                    t_first = time.perf_counter()
                text_parts.append(content)
            tcs = getattr(delta, "tool_calls", None)
            if tcs:
                if t_first is None:
                    t_first = time.perf_counter()
                for tc in tcs:
                    idx = tc.index if tc.index is not None else 0
                    slot = tool_calls_acc.setdefault(
                        idx,
                        {
                            "id": "",
                            "type": "function",
                            "function": {"name": "", "arguments": ""},
                        },
                    )
                    if tc.id:
                        slot["id"] = tc.id
                    if tc.function is not None:
                        if tc.function.name:
                            slot["function"]["name"] = tc.function.name
                        if tc.function.arguments:
                            slot["function"]["arguments"] += tc.function.arguments
        t_end = time.perf_counter()

        self._record_call(
            usage_dict=usage_dict,
            t_start=t_start,
            t_first=t_first,
            t_end=t_end,
        )

        tool_calls = [tool_calls_acc[i] for i in sorted(tool_calls_acc.keys())]
        return "".join(text_parts), tool_calls

    def generate_output(
        self, system_prompt: str, messages: list[dict]
    ) -> str:
        full_messages: list[dict] = []
        if system_prompt:
            full_messages.append({"role": "system", "content": system_prompt})
        full_messages.extend(messages)

        text = ""
        for _ in range(MAX_TOOL_TURNS):
            text, tool_calls = self.stream_completion(
                full_messages,
                tools=[SQL_TOOL],
                **self.completion_kwargs(),
            )
            if not tool_calls:
                return text

            full_messages.append(
                {
                    "role": "assistant",
                    "content": text or "",
                    "tool_calls": tool_calls,
                }
            )
            for tc in tool_calls:
                try:
                    args = json.loads(tc["function"]["arguments"] or "{}")
                    sql = args.get("sql", "")
                    tool_result = execute_sql(sql)
                except Exception as e:
                    tool_result = json.dumps({"error": str(e)})
                full_messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc["id"],
                        "content": tool_result,
                    }
                )

        return text


if __name__ == "__main__":
    run_cli(SQLQueryGenerator)
