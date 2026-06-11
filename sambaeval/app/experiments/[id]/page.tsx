"use client";
import { apiUrl } from "@/app/lib/api";

import { use, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import ResultsTable from "@/app/components/ResultsTable";
import type {
  Experiment,
  LlmJudgeScorerDef,
  ModelConfig,
  Provider,
  ResultRow,
  RunMeta,
} from "@/app/lib/types";
import InfoTooltip from "@/app/components/InfoTooltip";

const OUTPUT_GENERATOR_TOOLTIP =
  "Uses scripts/generators/default_generator.py if unspecified. If you would like to define custom behaviors like using the LLM output to invoke a tool, run a SQL query, or a whole agentic workflow to generate the final output, create a new script in scripts/generators/ that subclasses OutputGenerator from base.py and overrides the generate_output method (see sql_query_execution.py for an example). Set the path to your script in this field.";

const DEFAULT_MODEL: ModelConfig = {
  name: "",
  temperature: 0.0,
  seed: 42,
  system_prompt: "global",
  provider_name: "",
};

type KwargRow = { key: string; valueStr: string };

function parseKwargValue(s: string): unknown {
  // Try JSON first so numbers, booleans, arrays, and explicitly-quoted strings
  // round-trip as their actual types. Fall back to the raw text so a user typing
  // `stop_word` (unquoted) still produces *something* — though the help text
  // tells them to quote string values explicitly.
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function rowsToRecord(rows: KwargRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (key === "") continue;
    out[key] = parseKwargValue(r.valueStr);
  }
  return out;
}

function recordToRows(rec: Record<string, unknown> | undefined): KwargRow[] {
  if (!rec) return [];
  return Object.entries(rec).map(([k, v]) => ({
    key: k,
    valueStr: JSON.stringify(v),
  }));
}

interface Progress {
  total: number;
  completed: number;
  errors: number;
  currentLabel?: string;
  runId?: string;
}

type RunMode = "new" | "resume";

function formatRunId(runId: string): string {
  // Run IDs are ISO timestamps with `:` and `.` replaced by `-`. Make them
  // human-readable without losing information.
  const m = runId.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
  );
  if (m) {
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC`;
  }
  return runId;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

// Wall-clock runtime between a run's start and finish. Returns "—" while the
// run is still going (no finished_at yet) or if either timestamp is missing.
function formatDuration(
  startedAt: string | null,
  finishedAt: string | null,
): string {
  if (!startedAt || !finishedAt) return "—";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export default function ExperimentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [exp, setExp] = useState<Experiment | null>(null);
  const [allProviders, setAllProviders] = useState<Provider[]>([]);
  const [scorers, setScorers] = useState<LlmJudgeScorerDef[]>([]);
  const [datasets, setDatasets] = useState<string[]>([]);
  const [datasetCount, setDatasetCount] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [results, setResults] = useState<ResultRow[] | null>(null);
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [pendingResume, setPendingResume] = useState<RunMeta | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // Per-model UI state for the additional-kwargs editor. The rows are the
  // source of truth while editing (preserves insertion order and lets users
  // rename keys mid-typing); they're folded into `model.additional_kwargs`
  // on save.
  const [kwargRowsByModel, setKwargRowsByModel] = useState<KwargRow[][]>([]);
  const [kwargsOpen, setKwargsOpen] = useState<boolean[]>([]);
  // Cache of available model names per provider, fetched from the provider's
  // /models endpoint. Populates the model-name dropdown; users can still type
  // a name that isn't listed.
  const [modelsByProvider, setModelsByProvider] = useState<
    Record<string, string[]>
  >({});
  // Providers whose /models fetch is in flight (drives a small "loading…" hint).
  const [modelsLoading, setModelsLoading] = useState<Record<string, boolean>>(
    {},
  );
  // Tracks which providers we've already started fetching, so repeated calls
  // (e.g. multiple model rows on the same provider) don't refetch.
  const requestedProviders = useRef<Set<string>>(new Set());
  // Aborts the in-flight run stream from the client side. Cancelling aborts
  // this so the reader loop always terminates and the UI never gets stuck on
  // "Cancelling…", even if the server-side run has already died.
  const runAbortRef = useRef<AbortController | null>(null);

  // Lazily fetch (and cache) the model list for a provider the first time it's
  // referenced by a model row or selected from the provider dropdown.
  const ensureModelsForProvider = useCallback((providerName: string) => {
    if (!providerName || requestedProviders.current.has(providerName)) return;
    requestedProviders.current.add(providerName);
    setModelsLoading((cur) => ({ ...cur, [providerName]: true }));
    fetch(apiUrl(`/api/providers/models?provider=${encodeURIComponent(providerName)}`))
      .then((r) => r.json())
      .then((d) => {
        setModelsByProvider((cur) => ({
          ...cur,
          [providerName]: Array.isArray(d.models) ? d.models : [],
        }));
      })
      .catch(() => {
        setModelsByProvider((cur) => ({ ...cur, [providerName]: [] }));
      })
      .finally(() => {
        setModelsLoading((cur) => ({ ...cur, [providerName]: false }));
      });
  }, []);

  const fetchRuns = useCallback(async () => {
    try {
      const r = await fetch(apiUrl(`/api/experiments/${id}/runs`)).then((r) =>
        r.json(),
      );
      setRuns(r.runs ?? []);
    } catch {
      // ignore
    }
  }, [id]);

  useEffect(() => {
    (async () => {
      const [eRes, pRes, sRes, dRes, rRes] = await Promise.all([
        fetch(apiUrl(`/api/experiments/${id}`)).then((r) => r.json()),
        fetch(apiUrl("/api/providers")).then((r) => r.json()),
        fetch(apiUrl("/api/scorers")).then((r) => r.json()),
        fetch(apiUrl("/api/datasets")).then((r) => r.json()),
        fetch(apiUrl(`/api/experiments/${id}/results`)).then((r) => r.json()),
      ]);
      if (eRes.experiment) {
        const e = eRes.experiment as Experiment;
        setExp(e);
        setKwargRowsByModel(
          e.models.map((m) => recordToRows(m.additional_kwargs)),
        );
        setKwargsOpen(e.models.map(() => false));
      }
      setAllProviders(pRes.providers ?? []);
      setScorers(sRes.scorers ?? []);
      setDatasets(dRes.datasets ?? []);
      if (rRes.results) setResults(rRes.results);
      if (rRes.runId) setViewingRunId(rRes.runId);
      await fetchRuns();
    })();
  }, [id, fetchRuns]);

  // Look up the selected dataset's example count so the "Run on first N
  // examples" field can default to (and cap at) the full dataset size.
  const selectedDataset = exp?.dataset;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selectedDataset) {
        if (!cancelled) setDatasetCount(null);
        return;
      }
      try {
        const d = await fetch(
          apiUrl(`/api/datasets?name=${encodeURIComponent(selectedDataset)}&count=1`),
        ).then((r) => r.json());
        if (!cancelled) {
          setDatasetCount(typeof d.count === "number" ? d.count : null);
        }
      } catch {
        if (!cancelled) setDatasetCount(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedDataset]);

  // Prefetch model lists for every provider already referenced by a model row
  // so the dropdowns are populated as soon as the page loads.
  const referencedProviders = exp?.models
    .map((m) => m.provider_name)
    .filter(Boolean)
    .join(",");
  useEffect(() => {
    if (!referencedProviders) return;
    for (const name of referencedProviders.split(",")) {
      ensureModelsForProvider(name);
    }
  }, [referencedProviders, ensureModelsForProvider]);

  if (!exp) {
    return <div className="text-[var(--muted)]">Loading…</div>;
  }

  const update = (patch: Partial<Experiment>) =>
    setExp((prev) => (prev ? { ...prev, ...patch } : prev));

  // Persist example_count only when it's a real override (a positive integer
  // below the dataset size). Empty / full-size / invalid → undefined = run all.
  const setExampleCount = (raw: string) => {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n <= 0) {
      update({ example_count: undefined });
    } else if (datasetCount != null && n >= datasetCount) {
      update({ example_count: undefined });
    } else {
      update({ example_count: n });
    }
  };

  const updateModel = (i: number, patch: Partial<ModelConfig>) =>
    setExp((prev) =>
      prev
        ? {
            ...prev,
            models: prev.models.map((m, idx) =>
              idx === i ? { ...m, ...patch } : m,
            ),
          }
        : prev,
    );

  const addModel = () => {
    const defaultProvider = allProviders[0]?.name ?? "";
    setExp((prev) =>
      prev
        ? {
            ...prev,
            models: [
              ...prev.models,
              {
                ...DEFAULT_MODEL,
                provider_name: defaultProvider,
              },
            ],
          }
        : prev,
    );
    setKwargRowsByModel((prev) => [...prev, []]);
    setKwargsOpen((prev) => [...prev, false]);
    ensureModelsForProvider(defaultProvider);
  };

  const removeModel = (i: number) => {
    setExp((prev) =>
      prev
        ? { ...prev, models: prev.models.filter((_, idx) => idx !== i) }
        : prev,
    );
    setKwargRowsByModel((prev) => prev.filter((_, idx) => idx !== i));
    setKwargsOpen((prev) => prev.filter((_, idx) => idx !== i));
  };

  const setModelKwargRows = (i: number, rows: KwargRow[]) =>
    setKwargRowsByModel((prev) => prev.map((r, idx) => (idx === i ? rows : r)));

  const addKwarg = (i: number) =>
    setModelKwargRows(i, [
      ...(kwargRowsByModel[i] ?? []),
      { key: "", valueStr: "" },
    ]);

  const removeKwarg = (i: number, j: number) =>
    setModelKwargRows(
      i,
      (kwargRowsByModel[i] ?? []).filter((_, idx) => idx !== j),
    );

  const updateKwargKey = (i: number, j: number, key: string) =>
    setModelKwargRows(
      i,
      (kwargRowsByModel[i] ?? []).map((r, idx) =>
        idx === j ? { ...r, key } : r,
      ),
    );

  const updateKwargValueStr = (i: number, j: number, valueStr: string) =>
    setModelKwargRows(
      i,
      (kwargRowsByModel[i] ?? []).map((r, idx) =>
        idx === j ? { ...r, valueStr } : r,
      ),
    );

  const toggleKwargsOpen = (i: number) =>
    setKwargsOpen((prev) => prev.map((o, idx) => (idx === i ? !o : o)));

  const setScorerType = (type: "heuristic" | "llm") => {
    if (type === "llm") {
      update({
        scorer: {
          type: "llm",
          scorer_name: scorers[0]?.name ?? "",
        },
      });
    } else {
      update({ scorer: { type: "heuristic" } });
    }
  };

  const updateScorerName = (scorer_name: string) =>
    setExp((prev) => {
      if (!prev || prev.scorer?.type !== "llm") return prev;
      return { ...prev, scorer: { type: "llm", scorer_name } };
    });

  const save = async () => {
    setSaving(true);
    setSaved(false);
    const payload: Experiment = {
      ...exp,
      models: exp.models.map((m, i) => {
        const ak = rowsToRecord(kwargRowsByModel[i] ?? []);
        const next: ModelConfig = { ...m };
        if (Object.keys(ak).length > 0) {
          next.additional_kwargs = ak;
        } else {
          delete next.additional_kwargs;
        }
        return next;
      }),
    };
    const res = await fetch(apiUrl(`/api/experiments/${id}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.experiment) {
      const e = data.experiment as Experiment;
      setExp(e);
      setKwargRowsByModel(
        e.models.map((m) => recordToRows(m.additional_kwargs)),
      );
      setKwargsOpen((prev) => e.models.map((_, idx) => prev[idx] ?? false));
    }
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const streamRun = async (mode: RunMode, explicitRunId?: string) => {
    setRunning(true);
    setRunError(null);
    setProgress(null);
    setResults(null);
    setViewingRunId(null);
    setActiveRunId(null);

    const qs = new URLSearchParams({
      concurrency: String(exp.concurrency ?? 4),
      mode,
    });
    if (explicitRunId) qs.set("run_id", explicitRunId);

    const abort = new AbortController();
    runAbortRef.current = abort;
    try {
      const res = await fetch(apiUrl(`/api/experiments/${id}/run?${qs}`), {
        method: "POST",
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text();
        throw new Error(text || `Run failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const ev of events) {
          const lines = ev.split("\n");
          let event = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          const parsed = JSON.parse(data);
          if (event === "progress") {
            setProgress(parsed as Progress);
            if (parsed.runId) setActiveRunId(parsed.runId);
          } else if (event === "done") {
            setResults(parsed.results as ResultRow[]);
            if (parsed.runId) setViewingRunId(parsed.runId);
          } else if (event === "error") {
            setRunError(parsed.message ?? "Unknown error");
          }
        }
      }
    } catch (err) {
      // A client-side abort is an intentional cancel, not a failure.
      if (!isAbortError(err)) {
        setRunError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      runAbortRef.current = null;
      setRunning(false);
      setCancelling(false);
      setActiveRunId(null);
      await fetchRuns();
    }
  };

  const runAuto = async () => {
    await save();
    setRunError(null);

    const qs = new URLSearchParams({
      concurrency: String(exp.concurrency ?? 4),
      mode: "auto",
    });
    const abort = new AbortController();
    runAbortRef.current = abort;
    const probe = await fetch(apiUrl(`/api/experiments/${id}/run?${qs}`), {
      method: "POST",
      signal: abort.signal,
    });
    if (probe.status === 409) {
      const body = await probe.json();
      // Drain the (empty) body so the connection closes cleanly.
      try {
        probe.body?.cancel?.();
      } catch {
        // ignore
      }
      runAbortRef.current = null;
      setPendingResume(body.resumable as RunMeta);
      return;
    }
    if (!probe.ok || !probe.body) {
      const text = await probe.text();
      runAbortRef.current = null;
      setRunError(text || `Run failed (${probe.status})`);
      return;
    }
    // Auto mode with no resumable run = a new run already started. Adopt this
    // response as the stream rather than firing a second request.
    setRunning(true);
    setProgress(null);
    setResults(null);
    setViewingRunId(null);
    setActiveRunId(null);
    try {
      const reader = probe.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const ev of events) {
          const lines = ev.split("\n");
          let event = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          const parsed = JSON.parse(data);
          if (event === "progress") {
            setProgress(parsed as Progress);
            if (parsed.runId) setActiveRunId(parsed.runId);
          } else if (event === "done") {
            setResults(parsed.results as ResultRow[]);
            if (parsed.runId) setViewingRunId(parsed.runId);
          } else if (event === "error") {
            setRunError(parsed.message ?? "Unknown error");
          }
        }
      }
    } catch (err) {
      if (!isAbortError(err)) {
        setRunError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      runAbortRef.current = null;
      setRunning(false);
      setCancelling(false);
      setActiveRunId(null);
      await fetchRuns();
    }
  };

  const chooseResume = async () => {
    const pending = pendingResume;
    setPendingResume(null);
    if (!pending) return;
    await streamRun("resume", pending.run_id);
  };

  const chooseNew = async () => {
    setPendingResume(null);
    await streamRun("new");
  };

  const cancel = async () => {
    if (!activeRunId || cancelling) return;
    setCancelling(true);
    try {
      // Tell the server to abort the run (best-effort: it may already be dead).
      await fetch(
        apiUrl(`/api/experiments/${id}/run/cancel?run_id=${encodeURIComponent(activeRunId)}`),
        { method: "POST" },
      );
    } catch {
      // best-effort
    } finally {
      // Always tear down the client stream so the reader loop ends and the UI
      // leaves the "Cancelling…" state — even if the server-side run had
      // already died and the cancel request found nothing to abort. The
      // stream's finally block then refreshes the run list, where the orphaned
      // run shows up as "interrupted".
      runAbortRef.current?.abort();
    }
  };

  const viewRun = async (runId: string) => {
    if (running) return;
    const r = await fetch(
      apiUrl(`/api/experiments/${id}/results?run_id=${encodeURIComponent(runId)}`),
    ).then((r) => r.json());
    setResults(r.results ?? null);
    setViewingRunId(r.runId ?? runId);
  };

  const deleteRunResults = async (runId: string) => {
    if (running) return;
    if (
      !window.confirm(
        "Delete this run's results? This permanently removes its CSV file and cannot be undone.",
      )
    ) {
      return;
    }
    setRunError(null);
    const res = await fetch(
      apiUrl(`/api/experiments/${id}/runs?run_id=${encodeURIComponent(runId)}`),
      { method: "DELETE" },
    );
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setRunError(d.error ?? `Failed to delete run (${res.status})`);
      return;
    }
    // If the deleted run was the one being displayed, clear the results view.
    if (viewingRunId === runId) {
      setResults(null);
      setViewingRunId(null);
    }
    await fetchRuns();
  };

  const percent = progress
    ? Math.round((progress.completed / Math.max(1, progress.total)) * 100)
    : 0;

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/"
          className="text-[var(--muted)] text-sm hover:text-[var(--accent)]"
        >
          ← Experiments
        </Link>
        <h1 className="text-2xl font-semibold mt-1">Experiment: {exp.id}</h1>
      </div>

      {pendingResume && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-5 max-w-md w-full mx-4">
            <h3 className="font-medium mb-3">Resume previous run?</h3>
            <p className="text-sm text-[var(--muted)] mb-4">
              A previous run started {formatTimestamp(pendingResume.started_at)}{" "}
              is incomplete ({pendingResume.completed}/{pendingResume.total}{" "}
              rows, status:{" "}
              <span className="font-mono">{pendingResume.status}</span>). Resume
              from where it left off, or start a fresh run? Past runs are kept
              in history either way.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingResume(null)}
                className="text-[var(--muted)] hover:text-white px-3 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={chooseResume}
                className="bg-[var(--panel-2)] border border-[var(--border)] hover:bg-[var(--panel)] px-3 py-2 rounded-md text-sm"
              >
                Resume
              </button>
              <button
                onClick={chooseNew}
                className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-3 py-2 rounded-md text-sm font-medium"
              >
                Start new run
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-4 mb-4">
        <h2 className="font-medium mb-3">General</h2>
        <div className="grid grid-cols-12 gap-3 mb-3">
          <div className="col-span-5">
            <label className="text-xs text-[var(--muted)] block mb-1">
              Name
            </label>
            <input
              value={exp.name}
              onChange={(e) => update({ name: e.target.value })}
            />
          </div>
          <div className="col-span-4">
            <label className="text-xs text-[var(--muted)] block mb-1">
              Dataset
            </label>
            <select
              value={exp.dataset}
              onChange={(e) => update({ dataset: e.target.value })}
            >
              <option value="">— select dataset —</option>
              {datasets.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-3">
            <label className="text-xs text-[var(--muted)] block mb-1">
              Run concurrency
            </label>
            <input
              type="number"
              min={1}
              max={32}
              value={exp.concurrency ?? 4}
              onChange={(e) =>
                update({
                  concurrency: Math.max(
                    1,
                    Math.min(32, Number(e.target.value) || 1),
                  ),
                })
              }
            />
          </div>
        </div>
        {exp.dataset && (
          <div className="flex items-center gap-2 text-sm mb-3">
            <span className="text-[var(--muted)]">Run on first</span>
            <input
              type="number"
              min={1}
              max={datasetCount ?? undefined}
              value={exp.example_count ?? datasetCount ?? ""}
              onChange={(e) => setExampleCount(e.target.value)}
              // Inline width: the global `input { width: 100% }` rule is
              // unlayered and outranks Tailwind's `w-*` utilities, so a class
              // wouldn't stick. Sized to fit an 8-digit count plus the spinner.
              style={{ width: "7rem" }}
              aria-label="Number of examples to run"
            />
            <span className="text-[var(--muted)]">examples</span>
            {datasetCount != null && (
              <span className="text-xs text-[var(--muted)]">
                (dataset has {datasetCount})
              </span>
            )}
          </div>
        )}
        <label className="text-xs text-[var(--muted)] block mb-1">
          Global system prompt (used by models with system_prompt =
          &quot;global&quot;)
        </label>
        <textarea
          value={exp.system_prompt}
          onChange={(e) => update({ system_prompt: e.target.value })}
          rows={4}
        />
        <div className="mt-3">
          <label className="text-xs text-[var(--muted)] inline-flex items-center mb-1">
            Output generator
            <InfoTooltip text={OUTPUT_GENERATOR_TOOLTIP} />
          </label>
          <input
            value={exp.output_generator ?? ""}
            onChange={(e) => update({ output_generator: e.target.value })}
            placeholder="(blank → scripts/generators/default_generator.py)"
            spellCheck={false}
          />
        </div>
      </section>

      <section className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-4 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-medium">Models</h2>
          <button
            onClick={addModel}
            className="text-sm bg-[var(--panel-2)] border border-[var(--border)] hover:bg-[var(--panel)] px-3 py-1.5 rounded-md"
            disabled={allProviders.length === 0}
            title={
              allProviders.length === 0
                ? "Add a provider in the Providers page first"
                : undefined
            }
          >
            + Add Model
          </button>
        </div>
        {allProviders.length === 0 && (
          <p className="text-[var(--muted)] text-sm mb-2">
            No providers configured. Visit the{" "}
            <Link href="/providers" className="text-[var(--accent)]">
              Providers page
            </Link>{" "}
            to add one.
          </p>
        )}
        <div className="space-y-3">
          {exp.models.length === 0 && (
            <p className="text-[var(--muted)] text-sm">No models yet.</p>
          )}
          {exp.models.map((m, i) => (
            <div
              key={i}
              className="border border-[var(--border)] rounded-md p-3 bg-[var(--panel-2)]"
            >
              <div className="grid grid-cols-12 gap-2 mb-2">
                <div className="col-span-4">
                  <label className="text-xs text-[var(--muted)] block mb-1">
                    Model name
                  </label>
                  <input
                    value={m.name}
                    onChange={(e) => updateModel(i, { name: e.target.value })}
                    placeholder="e.g. Meta-Llama-3.1-8B-Instruct"
                    list={`model-options-${i}`}
                    spellCheck={false}
                  />
                  <datalist id={`model-options-${i}`}>
                    {(modelsByProvider[m.provider_name] ?? []).map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                  {modelsLoading[m.provider_name] ? (
                    <span className="text-[10px] text-[var(--muted)]">
                      Loading models…
                    </span>
                  ) : m.provider_name &&
                    (modelsByProvider[m.provider_name]?.length ?? 0) === 0 ? (
                    <span className="text-[10px] text-[var(--muted)]">
                      No models found — type a name
                    </span>
                  ) : (
                    m.provider_name && (
                      <span className="text-[10px] text-[var(--muted)]">
                        {modelsByProvider[m.provider_name].length} models
                        available — pick or type
                      </span>
                    )
                  )}
                </div>
                <div className="col-span-3">
                  <label className="text-xs text-[var(--muted)] block mb-1">
                    Provider
                  </label>
                  <select
                    value={m.provider_name}
                    onChange={(e) => {
                      updateModel(i, { provider_name: e.target.value });
                      ensureModelsForProvider(e.target.value);
                    }}
                  >
                    <option value="">— select —</option>
                    {allProviders.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name || "(unnamed)"}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-span-1">
                  <label className="text-xs text-[var(--muted)] block mb-1">
                    Temp
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    value={m.temperature}
                    onChange={(e) =>
                      updateModel(i, { temperature: Number(e.target.value) })
                    }
                  />
                </div>
                <div className="col-span-2">
                  <label className="text-xs text-[var(--muted)] block mb-1">
                    Seed
                  </label>
                  <input
                    type="number"
                    value={m.seed ?? ""}
                    placeholder="(none)"
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "") {
                        updateModel(i, { seed: undefined });
                      } else {
                        const n = Number(v);
                        updateModel(i, {
                          seed: Number.isFinite(n) ? n : undefined,
                        });
                      }
                    }}
                  />
                </div>
                <div className="col-span-2 flex items-end justify-end">
                  <button
                    onClick={() => removeModel(i)}
                    className="text-[var(--muted)] hover:text-[var(--danger)] text-xs"
                  >
                    Remove
                  </button>
                </div>
              </div>
              <label className="text-xs text-[var(--muted)] block mb-1">
                System prompt (&quot;global&quot; to use the experiment&apos;s
                global prompt, otherwise overrides it)
              </label>
              <textarea
                value={m.system_prompt}
                onChange={(e) =>
                  updateModel(i, { system_prompt: e.target.value })
                }
                rows={2}
              />
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => toggleKwargsOpen(i)}
                  className="text-xs text-[var(--muted)] hover:text-[var(--accent)]"
                >
                  {kwargsOpen[i] ? "▾" : "▸"} Additional keyword args
                  {(kwargRowsByModel[i]?.length ?? 0) > 0 && (
                    <span className="ml-1">({kwargRowsByModel[i].length})</span>
                  )}
                </button>
                {kwargsOpen[i] && (
                  <div className="mt-2 pl-3 border-l-2 border-[var(--border)]">
                    <p className="text-xs text-[var(--muted)] mb-2">
                      Forwarded as-is to the provider&apos;s chat completions
                      endpoint (e.g. <code>top_p</code>, <code>top_k</code>,{" "}
                      <code>max_tokens</code>, <code>stop</code>). Values are
                      parsed as JSON — wrap string values in double quotes (e.g.{" "}
                      <code>&quot;&lt;|im_end|&gt;&quot;</code>), otherwise they
                      will not be interpreted as strings (bare <code>42</code>{" "}
                      becomes a number, <code>true</code> a boolean, etc.).
                    </p>
                    {(kwargRowsByModel[i] ?? []).map((kw, j) => (
                      <div key={j} className="flex gap-2 mb-2">
                        <input
                          value={kw.key}
                          onChange={(e) => updateKwargKey(i, j, e.target.value)}
                          placeholder="key (e.g. top_p)"
                          spellCheck={false}
                          className="flex-1"
                        />
                        <input
                          value={kw.valueStr}
                          onChange={(e) =>
                            updateKwargValueStr(i, j, e.target.value)
                          }
                          placeholder='value (JSON: 0.9, "stop_word", [1,2])'
                          spellCheck={false}
                          className="flex-1"
                        />
                        <button
                          type="button"
                          onClick={() => removeKwarg(i, j)}
                          title="Remove"
                          className="text-[var(--muted)] hover:text-[var(--danger)] px-2"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => addKwarg(i)}
                      className="text-sm bg-[var(--panel-2)] border border-[var(--border)] hover:bg-[var(--panel)] px-3 py-1.5 rounded-md"
                    >
                      + Add kwarg
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-4 mb-4">
        <h2 className="font-medium mb-3">Scorer</h2>
        <div className="grid grid-cols-12 gap-3 mb-3">
          <div className="col-span-4">
            <label className="text-xs text-[var(--muted)] flex items-center mb-1">
              Type
              <InfoTooltip
                align="left"
                text={
                  'Heuristic: If expected_output starts with "contains:", checks substring; otherwise exact match. Awards row weight on success.\n\nLLM-as-a-Judge: Each row is scored by a judge model. Final score = judge\'s 0–1 rating × row weight.'
                }
              />
            </label>
            <select
              value={exp.scorer?.type ?? "heuristic"}
              onChange={(e) =>
                setScorerType(e.target.value as "heuristic" | "llm")
              }
            >
              <option value="heuristic">
                Heuristic (exact match / contains:)
              </option>
              <option value="llm">LLM-as-a-Judge</option>
            </select>
          </div>
        </div>
        {exp.scorer?.type === "llm" && (
          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-6">
              <label className="text-xs text-[var(--muted)] block mb-1">
                Scorer
              </label>
              <select
                value={exp.scorer.scorer_name}
                onChange={(e) => updateScorerName(e.target.value)}
              >
                <option value="">— select —</option>
                {scorers.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-6 text-xs text-[var(--muted)] flex items-end pb-2">
              {scorers.length === 0 ? (
                <>
                  No scorers defined yet. Create one on the{" "}
                  <Link href="/scorers" className="text-[var(--accent)] ml-1">
                    Scorers page
                  </Link>
                  .
                </>
              ) : (
                <>
                  Manage scorers on the{" "}
                  <Link href="/scorers" className="text-[var(--accent)] ml-1">
                    Scorers page
                  </Link>
                  .
                </>
              )}
            </div>
          </div>
        )}
      </section>

      <div className="flex items-center justify-center gap-3 mt-6 mb-6">
        {saved && <span className="text-[var(--success)] text-sm">Saved</span>}
        <button
          onClick={save}
          disabled={saving || running}
          className="bg-[var(--panel-2)] border border-[var(--border)] hover:bg-[var(--panel)] px-4 py-2 rounded-md disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        {running ? (
          <button
            onClick={cancel}
            disabled={cancelling || !activeRunId}
            className="bg-[var(--danger)] hover:opacity-90 text-white px-4 py-2 rounded-md font-medium disabled:opacity-50"
          >
            {cancelling ? "Cancelling..." : "Cancel Run"}
          </button>
        ) : (
          <button
            onClick={runAuto}
            disabled={running}
            className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md font-medium disabled:opacity-50"
          >
            Run Experiment
          </button>
        )}
      </div>

      {(progress || runError) && (
        <section className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-4 mb-4">
          <h2 className="font-medium mb-3">Active Run</h2>

          {progress && (
            <div className="mb-3">
              <div className="flex items-center justify-between text-xs text-[var(--muted)] mb-1">
                <span>
                  {progress.completed} / {progress.total} ·{" "}
                  {progress.errors > 0 && (
                    <span className="text-[var(--danger)]">
                      {progress.errors} errors
                    </span>
                  )}
                  {activeRunId && (
                    <span className="ml-2 font-mono">
                      run {formatRunId(activeRunId)}
                    </span>
                  )}
                </span>
                <span>{percent}%</span>
              </div>
              <div className="h-2 bg-[var(--panel-2)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--accent)] transition-all"
                  style={{ width: `${percent}%` }}
                />
              </div>
              {progress.currentLabel && (
                <p className="text-xs text-[var(--muted)] mt-1 font-mono truncate">
                  {progress.currentLabel}
                </p>
              )}
            </div>
          )}

          {runError && (
            <div className="bg-[var(--danger)]/10 border border-[var(--danger)] text-[var(--danger)] rounded-md p-3 text-sm mb-3">
              {runError}
            </div>
          )}
        </section>
      )}

      {runs.length > 0 && (
        <section className="mb-6">
          <h2 className="font-medium mb-4">Results</h2>

          {results && results.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold">
                  By Model
                  {viewingRunId && (
                    <span className="ml-2 text-[var(--muted)] font-mono font-normal">
                      · {formatRunId(viewingRunId)}
                    </span>
                  )}
                </h3>
                <a
                  href={
                    viewingRunId
                      ? apiUrl(`/api/experiments/${id}/results?format=csv&run_id=${encodeURIComponent(viewingRunId)}`)
                      : apiUrl(`/api/experiments/${id}/results?format=csv`)
                  }
                  className="text-sm text-[var(--accent)] hover:text-[var(--accent-hover)]"
                >
                  Export CSV ↓
                </a>
              </div>
              <ResultsTable rows={results} />
            </div>
          )}

          <h3 className="text-sm font-semibold mb-3">By Run</h3>
          <div className="bg-[var(--panel)] border border-[var(--border)] rounded-lg overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel-2)]">
                <tr className="text-[var(--muted)]">
                  <th className="text-left px-3 py-2 border-b border-[var(--border)]">
                    started
                  </th>
                  <th className="text-left px-3 py-2 border-b border-[var(--border)]">
                    status
                  </th>
                  <th className="text-right px-3 py-2 border-b border-[var(--border)]">
                    progress
                  </th>
                  <th className="text-right px-3 py-2 border-b border-[var(--border)]">
                    errors
                  </th>
                  <th className="text-right px-3 py-2 border-b border-[var(--border)]">
                    total runtime
                  </th>
                  <th className="text-left px-3 py-2 border-b border-[var(--border)]">
                    run id
                  </th>
                  <th className="text-right px-3 py-2 border-b border-[var(--border)]"></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const isViewing = r.run_id === viewingRunId;
                  const statusColor =
                    r.status === "completed"
                      ? "text-[var(--success)]"
                      : r.status === "aborted"
                        ? "text-[var(--danger)]"
                        : r.status === "interrupted"
                          ? "text-[var(--warning)]"
                          : "text-[var(--accent)]";
                  return (
                    <tr
                      key={r.run_id}
                      className="border-b border-[var(--border)] hover:bg-[var(--panel-2)]"
                    >
                      <td className="px-3 py-2">
                        {formatTimestamp(r.started_at)}
                      </td>
                      <td className={`px-3 py-2 font-mono ${statusColor}`}>
                        {r.status}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {r.completed}/{r.total}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {r.errors}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {formatDuration(r.started_at, r.finished_at)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-[var(--muted)]">
                        {formatRunId(r.run_id)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {isViewing ? (
                          <span className="text-xs text-[var(--muted)]">
                            viewing
                          </span>
                        ) : (
                          <button
                            onClick={() => viewRun(r.run_id)}
                            disabled={running}
                            className="text-sm text-[var(--accent)] hover:text-[var(--accent-hover)] disabled:opacity-50"
                          >
                            View
                          </button>
                        )}
                        <button
                          onClick={() => deleteRunResults(r.run_id)}
                          disabled={running}
                          title="Permanently delete this run's results"
                          className="text-sm text-[var(--muted)] hover:text-[var(--danger)] disabled:opacity-50 ml-3"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
