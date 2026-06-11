#!/usr/bin/env node
/**
 * Regression test that runs every example experiment already on disk
 * (data/experiments/*.json) end-to-end against the real provider configured
 * in data/providers.json.
 *
 * Unlike test_end_to_end.mjs, which exercises the create-dataset and
 * create-experiment API flows from scratch, this test assumes the example
 * datasets, experiments, and (where applicable) custom output generator
 * scripts already exist. It's the regression test to run after a refactor
 * that touches the executor, the Python generator scripts, the experiment
 * schema, or any of the lib/ glue between them.
 *
 * Each experiment is run via POST /api/experiments/<id>/run; progress is
 * streamed; results are read back via the results endpoint and checked
 * for row count, judge scores, and presence of metric columns.
 *
 * Usage:
 *   node scripts/test_run_examples.mjs                 # run all examples
 *   node scripts/test_run_examples.mjs codegen_example # run a subset
 *
 * Requires data/providers.json to be populated with a real api_key for
 * every provider referenced by the experiments. Not wired into CI; this
 * test calls a live LLM and costs real tokens.
 */

import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.PORT || "3001";
const BASE = `http://localhost:${PORT}`;
const CONCURRENCY = process.env.CONCURRENCY || "4";

const SHOW_OUTPUTS = process.env.SHOW_OUTPUTS === "1";

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for ${url}`);
}

async function preflightPortIsFree(port) {
  // If something already answers on the target port, `next dev` will
  // silently bind to a different one and the test will hang waiting for
  // a server that never comes up here. Detect that up front so the
  // failure mode is "clear error in <1s" instead of "60s timeout".
  try {
    const res = await fetch(`http://localhost:${port}/api/providers`, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      throw new Error(
        `Port ${port} already has a SambaEval dev server (or something speaking the same API) running. ` +
          `Stop it first — e.g. \`lsof -nP -iTCP:${port} -sTCP:LISTEN\` to find it — then retry.`,
      );
    }
    // Any other response means *something* is on the port; refuse rather
    // than gamble that it'll get out of next dev's way.
    throw new Error(
      `Port ${port} is occupied by another process (HTTP ${res.status}). ` +
        `Stop it first — e.g. \`lsof -nP -iTCP:${port} -sTCP:LISTEN\` — then retry.`,
    );
  } catch (err) {
    if (
      err instanceof TypeError ||
      err?.name === "TimeoutError" ||
      err?.cause?.code === "ECONNREFUSED"
    ) {
      return; // nothing listening — good
    }
    throw err;
  }
}

async function jsonFetch(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} → ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

async function streamRun(expId) {
  const url = `${BASE}/api/experiments/${expId}/run?concurrency=${CONCURRENCY}`;
  const res = await fetch(url, { method: "POST" });
  if (!res.ok || !res.body) {
    throw new Error(`POST ${url} → ${res.status}: ${await res.text()}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastProgress = null;
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
          `\r    [${"█".repeat(Math.floor(pct / 5)).padEnd(20, "░")}] ${pct}% (${parsed.completed}/${parsed.total})${parsed.errors > 0 ? `  errors=${parsed.errors}` : ""}   `,
        );
      } else if (event === "error") {
        errorMessage = parsed.message;
      }
    }
  }
  process.stdout.write("\n");
  if (errorMessage) throw new Error(errorMessage);
  return lastProgress;
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
    const lat = rs.map((r) => r.latency_ms).filter((x) => x != null);
    const ttft = rs.map((r) => r.ttft_ms).filter((x) => x != null);
    const tps = rs.map((r) => r.tps).filter((x) => x != null);
    const nCalls = rs.map((r) => r.num_llm_calls).filter((x) => x != null);
    const errors = rs.filter((r) =>
      String(r.output ?? "").startsWith("ERROR"),
    ).length;
    rows.push({
      group: key,
      n: rs.length,
      errors,
      score: rs.reduce((s, r) => s + Number(r.score ?? 0), 0),
      sumIn: inTok.reduce((a, b) => a + b, 0),
      sumOut: outTok.reduce((a, b) => a + b, 0),
      medianLatency: median(lat),
      medianTtft: median(ttft),
      medianTps: median(tps),
      medianCalls: median(nCalls),
    });
  }
  return rows.sort((a, b) => a.group.localeCompare(b.group));
}

function printSummary(summary) {
  console.log(
    "    " +
      "provider/model".padEnd(48) +
      "n".padStart(3) +
      "  " +
      "score".padStart(7) +
      "  " +
      "errs".padStart(4) +
      "  " +
      "Σin".padStart(7) +
      "  " +
      "Σout".padStart(7) +
      "  " +
      "lat(ms)".padStart(8) +
      "  " +
      "ttft(ms)".padStart(8) +
      "  " +
      "tok/s".padStart(6) +
      "  " +
      "#calls".padStart(6),
  );
  for (const s of summary) {
    console.log(
      "    " +
        s.group.padEnd(48) +
        String(s.n).padStart(3) +
        "  " +
        s.score.toFixed(2).padStart(7) +
        "  " +
        String(s.errors).padStart(4) +
        "  " +
        String(s.sumIn).padStart(7) +
        "  " +
        String(s.sumOut).padStart(7) +
        "  " +
        (s.medianLatency?.toFixed(0) ?? "—").padStart(8) +
        "  " +
        (s.medianTtft?.toFixed(0) ?? "—").padStart(8) +
        "  " +
        (s.medianTps?.toFixed(1) ?? "—").padStart(6) +
        "  " +
        (s.medianCalls?.toFixed(1) ?? "—").padStart(6),
    );
  }
}

function printOutputs(results) {
  const byExample = new Map();
  for (const r of results) {
    if (!byExample.has(r.example_id)) byExample.set(r.example_id, []);
    byExample.get(r.example_id).push(r);
  }
  for (const [eid, rs] of [...byExample].sort((a, b) => a[0] - b[0])) {
    console.log(`    example_id=${eid}`);
    for (const r of rs) {
      const out = String(r.output ?? "").replace(/\s+/g, " ").slice(0, 140);
      console.log(`      [${r.score}] ${r.model.padEnd(28)} → ${out}`);
    }
  }
}

async function loadExperimentsToRun(filter) {
  const expDir = path.join(ROOT, "data", "experiments");
  const files = (await readdir(expDir)).filter((f) => f.endsWith(".json"));
  const all = [];
  for (const f of files) {
    const exp = JSON.parse(
      await readFile(path.join(expDir, f), "utf8"),
    );
    all.push(exp);
  }
  if (filter.length === 0) return all;
  const wanted = new Set(filter);
  const missing = filter.filter((id) => !all.some((e) => e.id === id));
  if (missing.length > 0) {
    throw new Error(`No experiment on disk for: ${missing.join(", ")}`);
  }
  return all.filter((e) => wanted.has(e.id));
}

async function loadDatasetRowCount(name) {
  const raw = await readFile(
    path.join(ROOT, "data", "datasets", name),
    "utf8",
  );
  if (name.toLowerCase().endsWith(".jsonl")) {
    return raw.split("\n").filter((line) => line.trim() !== "").length;
  }
  // CSV: quoted-field-aware row counter — newlines inside "..." don't end a row.
  let rows = 0;
  let inQuotes = false;
  let nonEmpty = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inQuotes) {
      if (c === '"') {
        if (raw[i + 1] === '"') i++;
        else inQuotes = false;
      }
    } else if (c === '"') {
      inQuotes = true;
      nonEmpty = true;
    } else if (c === "\n") {
      if (nonEmpty) rows++;
      nonEmpty = false;
    } else if (c !== "\r" && c !== " " && c !== "\t") {
      nonEmpty = true;
    } else if (c === " " || c === "\t") {
      // whitespace alone doesn't make a row non-empty
    }
  }
  if (nonEmpty) rows++;
  return Math.max(0, rows - 1); // subtract header
}

async function loadScorerProvider(scorerName) {
  try {
    const raw = await readFile(
      path.join(ROOT, "data", "scorers", `${scorerName}.json`),
      "utf8",
    );
    return JSON.parse(raw).provider_name;
  } catch {
    throw new Error(
      `Scorer "${scorerName}" not found in data/scorers/${scorerName}.json`,
    );
  }
}

async function runOne(exp, providerNames) {
  console.log(`\n── ${exp.id} ──`);
  console.log(
    `    dataset=${exp.dataset}  models=${exp.models.length}  ` +
      `output_generator=${exp.output_generator || "(default)"}`,
  );

  // Verify every provider referenced by the experiment (and its scorer) is
  // configured.
  const judgeProvider =
    exp.scorer?.type === "llm"
      ? await loadScorerProvider(exp.scorer.scorer_name)
      : null;
  const referenced = new Set([
    ...exp.models.map((m) => m.provider_name),
    ...(judgeProvider ? [judgeProvider] : []),
  ]);
  for (const p of referenced) {
    if (!providerNames.has(p)) {
      throw new Error(
        `Provider "${p}" referenced by ${exp.id} is not configured in data/providers.json`,
      );
    }
  }

  const expectedRows = exp.models.length * (await loadDatasetRowCount(exp.dataset));
  const t0 = Date.now();
  await streamRun(exp.id);
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);

  const { results } = await jsonFetch(
    `${BASE}/api/experiments/${exp.id}/results`,
  );
  if (!Array.isArray(results)) {
    throw new Error(`Results endpoint for ${exp.id} returned no rows`);
  }
  if (results.length !== expectedRows) {
    throw new Error(
      `${exp.id}: expected ${expectedRows} result rows, got ${results.length}`,
    );
  }

  // CSV from the API should also have the metric columns.
  const csvRes = await fetch(
    `${BASE}/api/experiments/${exp.id}/results?format=csv`,
  );
  if (!csvRes.ok) {
    throw new Error(
      `${exp.id}: failed to fetch results CSV: ${csvRes.status} ${await csvRes.text()}`,
    );
  }
  const csv = await csvRes.text();
  for (const col of [
    "input_tokens",
    "output_tokens",
    "latency_ms",
    "ttft_ms",
    "tps",
    "num_llm_calls",
  ]) {
    if (!csv.includes(col)) {
      throw new Error(`${exp.id}: results CSV missing column "${col}"`);
    }
  }

  const summary = summarize(results);
  printSummary(summary);
  if (SHOW_OUTPUTS) {
    console.log("");
    printOutputs(results);
  }

  const totalErrors = summary.reduce((s, r) => s + r.errors, 0);
  if (totalErrors > 0) {
    throw new Error(
      `${exp.id}: ${totalErrors}/${results.length} rows failed (output begins with "ERROR")`,
    );
  }
  const totalScore = summary.reduce((s, r) => s + r.score, 0);
  if (totalScore <= 0) {
    throw new Error(
      `${exp.id}: all judge scores were 0 — something is wrong with the model outputs or the judge`,
    );
  }

  console.log(
    `    OK — ${results.length} rows in ${elapsedS}s, ${totalErrors} errors, total score ${totalScore.toFixed(2)}.`,
  );
  return { id: exp.id, rows: results.length, elapsedS, totalErrors, totalScore };
}

async function main() {
  const filter = process.argv.slice(2);

  await preflightPortIsFree(PORT);

  console.log(`[test] Starting next dev on port ${PORT} ...`);
  const dev = spawn("npx", ["next", "dev", "-p", PORT], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "development" },
  });
  let devOutput = "";
  dev.stdout.on("data", (c) => {
    devOutput += c.toString();
  });
  dev.stderr.on("data", (c) => {
    devOutput += c.toString();
  });
  const cleanup = () => {
    if (!dev.killed) dev.kill("SIGTERM");
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(1);
  });

  try {
    await waitForServer(`${BASE}/api/providers`);
    console.log("[test] Server is up.");

    const { providers } = await jsonFetch(`${BASE}/api/providers`);
    const providerNames = new Set(
      providers.filter((p) => p.api_key).map((p) => p.name),
    );

    const experiments = await loadExperimentsToRun(filter);
    if (experiments.length === 0) {
      throw new Error("No experiments to run.");
    }
    console.log(
      `[test] Running ${experiments.length} experiment(s): ${experiments.map((e) => e.id).join(", ")}`,
    );

    const outcomes = [];
    for (const exp of experiments) {
      outcomes.push(await runOne(exp, providerNames));
    }

    console.log("\n[test] All experiments passed:");
    for (const o of outcomes) {
      console.log(
        `  ${o.id}: ${o.rows} rows, ${o.elapsedS}s, score ${o.totalScore.toFixed(2)}`,
      );
    }
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
