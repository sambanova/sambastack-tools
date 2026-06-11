#!/usr/bin/env node
/**
 * End-to-end test for sambaeval.
 *
 * Starts `next dev` in the background, then uses the HTTP API to:
 *   1. Verify the SambaNova provider is configured.
 *   2. Create a "code completion" dataset (5 prompts).
 *   3. Create an experiment that runs three SambaNova models with an
 *      LLM-as-judge scorer (gpt-oss-120b).
 *   4. Run the experiment and stream progress events.
 *   5. Print the per-model summary from the resulting CSV.
 *
 * The dataset, experiment JSON, and results CSV are left in place under
 * data/ as example artifacts. providers.json is gitignored — pre-populate
 * it with your SambaNova API key before running.
 *
 * Usage:
 *   node scripts/test_end_to_end.mjs
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.PORT || "3001";
const BASE = `http://localhost:${PORT}`;

const PROVIDER_NAME = "SambaNova";
const MODELS = [
  "MiniMax-M2.7",
  "gemma-3-12b-it",
  "Meta-Llama-3.3-70B-Instruct",
];
const JUDGE_MODEL = "gpt-oss-120b";
const JUDGE_MAX_SCORE = 5;
const SCORER_NAME = "codegen_judge";
const EXPERIMENT_ID = "codegen_example";
const DATASET_NAME = "codegen_example.csv";

const DATASET_ROWS = [
  {
    example_id: 1,
    prompt:
      "Complete the following Python function. Reply with ONLY the body expression that goes in the blank, no quotes, no explanation.\n\n```python\ndef factorial(n):\n    if n <= 1:\n        return 1\n    return ___\n```",
    expected_output: "n * factorial(n - 1)",
  },
  {
    example_id: 2,
    prompt:
      "Complete the following JavaScript function to reverse a string. Reply with ONLY the missing method name (no quotes, no explanation).\n\n```js\nfunction reverseString(s) {\n    return s.split(\"\").___().join(\"\");\n}\n```",
    expected_output: "reverse",
  },
  {
    example_id: 3,
    prompt:
      "Complete the Python list comprehension to keep only the even numbers from `nums`. Reply with ONLY the missing condition expression, no quotes, no explanation.\n\n```python\nevens = [x for x in nums if ___]\n```",
    expected_output: "x % 2 == 0",
  },
  {
    example_id: 4,
    prompt:
      "Complete the Python function to compute the area of a circle. Use math.pi. Reply with ONLY the missing return expression, no quotes, no explanation.\n\n```python\nimport math\ndef circle_area(r):\n    return ___\n```",
    expected_output: "math.pi * r * r",
  },
  {
    example_id: 5,
    prompt:
      "Complete the SQL query that counts users grouped by country. Reply with ONLY the missing aggregate expression, no quotes, no explanation.\n\n```sql\nSELECT country, ___ FROM users GROUP BY country;\n```",
    expected_output: "COUNT(*)",
  },
];

const JUDGE_PROMPT = `You are an impartial code reviewer evaluating whether a model's completion is semantically equivalent to a reference completion.

User prompt:
{prompt}

Reference completion:
{expected_output}

Model completion:
{output}

Give an INTEGER score from 0 to {max_score}, where:
- {max_score} = semantically / functionally equivalent to the reference (trivial whitespace, parentheses, or notation differences are fine)
- 0 = incorrect, unrelated, or fails to complete the code
- values in between = graded partial credit (correct logic with minor extras / missing parts)

Respond with a single JSON object and NOTHING ELSE, of the form:
{"score": <integer 0..{max_score}>, "score_reason": "<one or two sentences explaining the score>"}`;

function toCsv(rows) {
  const escape = (v) => {
    const s = String(v);
    if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const headers = ["example_id", "prompt", "expected_output", "weight"];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(
      [
        escape(r.example_id),
        escape(r.prompt),
        escape(r.expected_output),
        escape(r.weight ?? 1.0),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

async function jsonFetch(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} → ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function streamRun(url) {
  const res = await fetch(url, { method: "POST" });
  if (!res.ok || !res.body) {
    throw new Error(`POST ${url} → ${res.status}: ${await res.text()}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastProgress = null;
  let doneData = null;
  let errorMessage = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const ev of events) {
      let event = "message";
      let data = "";
      for (const line of ev.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (event === "progress") {
        lastProgress = parsed;
        const pct = Math.round(
          (parsed.completed / Math.max(1, parsed.total)) * 100,
        );
        process.stdout.write(
          `\r  [${"█".repeat(Math.floor(pct / 5)).padEnd(20, "░")}] ${pct}% (${parsed.completed}/${parsed.total})${parsed.errors > 0 ? `  errors=${parsed.errors}` : ""}   `,
        );
      } else if (event === "done") {
        doneData = parsed;
      } else if (event === "error") {
        errorMessage = parsed.message;
      }
    }
  }
  process.stdout.write("\n");
  if (errorMessage) throw new Error(errorMessage);
  return { progress: lastProgress, done: doneData };
}

function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function summarize(results) {
  const groups = new Map();
  for (const r of results) {
    const key = `${r.provider}/${r.model}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const rows = [];
  for (const [key, rs] of groups) {
    const inTok = rs.map((r) => r.input_tokens).filter((x) => x != null);
    const outTok = rs.map((r) => r.output_tokens).filter((x) => x != null);
    const latency = rs.map((r) => r.latency_ms).filter((x) => x != null);
    const ttft = rs.map((r) => r.ttft_ms).filter((x) => x != null);
    const tps = rs.map((r) => r.tps).filter((x) => x != null);
    rows.push({
      group: key,
      n: rs.length,
      score: rs.reduce((s, r) => s + Number(r.score ?? 0), 0),
      sumIn: inTok.reduce((a, b) => a + b, 0),
      sumOut: outTok.reduce((a, b) => a + b, 0),
      medianLatency: median(latency),
      medianTtft: median(ttft),
      medianTps: median(tps),
    });
  }
  return rows.sort((a, b) => a.group.localeCompare(b.group));
}

async function main() {
  console.log(`[test] Starting next dev on port ${PORT} ...`);
  const dev = spawn("npx", ["next", "dev", "-p", PORT], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "development" },
  });
  let devOutput = "";
  dev.stdout.on("data", (c) => { devOutput += c.toString(); });
  dev.stderr.on("data", (c) => { devOutput += c.toString(); });

  const cleanup = () => {
    if (!dev.killed) dev.kill("SIGTERM");
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(1); });

  try {
    await waitForServer(`${BASE}/api/providers`);
    console.log("[test] Server is up.");

    // 1. Verify SambaNova provider exists in providers.json.
    const { providers } = await jsonFetch(`${BASE}/api/providers`);
    const samba = providers.find((p) => p.name === PROVIDER_NAME);
    if (!samba || !samba.api_key) {
      throw new Error(
        `Provider "${PROVIDER_NAME}" must be configured with an api_key in data/providers.json before running this test.`,
      );
    }
    console.log(`[test] Found provider: ${samba.name} → ${samba.api_url}`);

    // 2. Create dataset via API.
    console.log(`[test] Creating dataset ${DATASET_NAME} ...`);
    await jsonFetch(`${BASE}/api/datasets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: DATASET_NAME,
        content: toCsv(DATASET_ROWS),
      }),
    });

    // 2b. Upsert the scorer via the scorers API (PUT semantics replace the
    //     full list; merge with whatever's already there so we don't clobber
    //     the user's other scorers).
    console.log(`[test] Upserting scorer ${SCORER_NAME} ...`);
    const { scorers: existingScorers } = await jsonFetch(`${BASE}/api/scorers`);
    const scorerDef = {
      name: SCORER_NAME,
      provider_name: PROVIDER_NAME,
      model: JUDGE_MODEL,
      temperature: 0,
      judge_prompt: JUDGE_PROMPT,
      max_score: JUDGE_MAX_SCORE,
    };
    const mergedScorers = [
      ...existingScorers.filter((s) => s.name !== SCORER_NAME),
      scorerDef,
    ];
    await jsonFetch(`${BASE}/api/scorers`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scorers: mergedScorers }),
    });

    // 3. Create experiment via API (with an explicit slug so the file on
    //    disk is data/experiments/codegen_example.json).
    console.log("[test] Creating experiment ...");
    const expBody = {
      id: EXPERIMENT_ID,
      name: "Code completion example",
      dataset: DATASET_NAME,
      system_prompt:
        "You are a careful code assistant. When asked to complete code, reply with only the requested fragment — no markdown fences, no commentary.",
      models: MODELS.map((name) => ({
        name,
        temperature: 0.0,
        seed: 42,
        system_prompt: "global",
        provider_name: PROVIDER_NAME,
      })),
      scorer: {
        type: "llm",
        scorer_name: SCORER_NAME,
      },
      output_generator: "",
    };
    const { experiment } = await jsonFetch(`${BASE}/api/experiments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(expBody),
    });
    console.log(
      `[test] Created experiment ${experiment.id} → data/experiments/${experiment.id}.json`,
    );

    // 4. Run experiment, stream progress.
    console.log("[test] Running experiment ...");
    await streamRun(
      `${BASE}/api/experiments/${experiment.id}/run?concurrency=4`,
    );

    // 5. Read results from disk, print summary.
    const csvRes = await fetch(
      `${BASE}/api/experiments/${experiment.id}/results?format=csv`,
    );
    if (!csvRes.ok) {
      throw new Error(`Fetch results CSV → ${csvRes.status}: ${await csvRes.text()}`);
    }
    const csv = await csvRes.text();
    console.log("[test] Fetched results CSV via /results endpoint\n");

    const { results } = await jsonFetch(
      `${BASE}/api/experiments/${experiment.id}/results`,
    );
    if (!Array.isArray(results)) {
      throw new Error("Results endpoint did not return rows");
    }

    const summary = summarize(results);
    console.log("Per-model summary:");
    console.log(
      "  provider/model".padEnd(50),
      "n".padStart(3),
      "score".padStart(7),
      "Σin".padStart(8),
      "Σout".padStart(8),
      "latency(ms)".padStart(12),
      "ttft(ms)".padStart(10),
      "tok/s".padStart(8),
    );
    for (const s of summary) {
      console.log(
        `  ${s.group.padEnd(48)}`,
        String(s.n).padStart(3),
        s.score.toFixed(2).padStart(7),
        String(s.sumIn).padStart(8),
        String(s.sumOut).padStart(8),
        (s.medianLatency?.toFixed(1) ?? "—").padStart(12),
        (s.medianTtft?.toFixed(1) ?? "—").padStart(10),
        (s.medianTps?.toFixed(1) ?? "—").padStart(8),
      );
    }

    // Sanity checks.
    const expectedRows = MODELS.length * DATASET_ROWS.length;
    if (results.length !== expectedRows) {
      throw new Error(
        `Expected ${expectedRows} result rows, got ${results.length}`,
      );
    }
    if (!csv.includes("input_tokens")) {
      throw new Error("Results CSV is missing the input_tokens column");
    }
    console.log(
      `\n[test] OK — ${results.length} rows, all expected columns present.`,
    );
  } catch (err) {
    console.error("\n[test] FAILED:", err.message);
    if (devOutput) {
      console.error("\n--- next dev output (tail) ---");
      console.error(devOutput.split("\n").slice(-30).join("\n"));
    }
    cleanup();
    process.exit(1);
  } finally {
    cleanup();
  }
}

main();
