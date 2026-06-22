"use client";
import { apiUrl } from "@/app/lib/api";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ResultsTable, { ModelSummaryTable } from "@/app/components/ResultsTable";
import ModelNameCombobox from "@/app/components/ModelNameCombobox";
import ErrorsTable from "@/app/components/ErrorsTable";
import type {
  Experiment,
  LlmJudgeScorerDef,
  ModelConfig,
  PriceMap,
  Provider,
  ResultRow,
  RunErrors,
  RunMeta,
} from "@/app/lib/types";
import { computeCost, priceKey } from "@/app/lib/types";
import {
  type KwargRow,
  recordToRows,
  rowsToRecord,
} from "@/app/lib/kwargs";
import InfoTooltip from "@/app/components/InfoTooltip";

const OUTPUT_GENERATOR_TOOLTIP =
  "Uses scripts/generators/default_generator.py if unspecified. If you would like to define custom behaviors like using the LLM output to invoke a tool, run a SQL query, or a whole agentic workflow to generate the final output, create a new script in scripts/generators/ that subclasses OutputGenerator from base.py and overrides the generate_output method (see sql_query_execution.py for an example). Set the path to your script in this field.";

const DEFAULT_MODEL: ModelConfig = {
  name: "",
  seed: 42,
  system_prompt: "global",
  provider_name: "",
};

interface Progress {
  total: number;
  completed: number;
  errors: number;
  currentLabel?: string;
  runId?: string;
}

type RunMode = "new" | "resume" | "retry" | "merged";

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

// Format a USD cost. Sub-dollar costs get more precision so fractions of a
// cent are still visible; "—" for unknown.
function formatCost(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  const digits = v !== 0 && Math.abs(v) < 1 ? 4 : 2;
  return `$${v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  })}`;
}

// Key for matching a model against default-price tables. Lowercased with all
// non-alphanumerics stripped, so the various spellings of the same model line up
// (e.g. "claude-opus-4-6" vs "claude-opus-4.6", "GPT-4o" vs "gpt-4o").
function defaultsKey(provider: string, model: string): string {
  return `${provider.toLowerCase()}|${model.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

type DefaultPriceMap = Record<string, { input?: number; output?: number }>;

// Effective per-model price as a number, or undefined. The explicit price wins;
// otherwise the default (file or live /models) is used — so a suggested default
// counts as the applied price even when the user never typed it.
function effectivePrice(
  explicit: number | undefined,
  fallback: number | undefined,
): number | undefined {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  return typeof fallback === "number" && Number.isFinite(fallback)
    ? fallback
    : undefined;
}

// Build the `${provider}|${model}` price map used for cost columns, folding the
// editable prices together with their defaults. A model contributes an entry if
// either side resolves; a missing side counts as $0.
function buildEffectivePriceMap(
  models: ModelConfig[],
  defaults: DefaultPriceMap,
): PriceMap {
  const out: PriceMap = {};
  for (const m of models) {
    const def = defaults[defaultsKey(m.provider_name, m.name)] ?? {};
    const input = effectivePrice(m.input_price, def.input);
    const output = effectivePrice(m.output_price, def.output);
    if (input == null && output == null) continue;
    out[priceKey(m.provider_name, m.name)] = {
      input: input ?? 0,
      output: output ?? 0,
    };
  }
  return out;
}

// Total USD cost of a run from its per-(provider, model) token usage and the
// applied prices. Null when the run reports no usage or no matching prices.
function runCost(meta: RunMeta, prices: PriceMap): number | null {
  if (!meta.token_usage || meta.token_usage.length === 0) return null;
  let total = 0;
  let known = false;
  for (const u of meta.token_usage) {
    const c = computeCost(
      u.input_tokens,
      u.output_tokens,
      prices[priceKey(u.provider, u.model)],
    );
    if (c !== null) {
      total += c;
      known = true;
    }
  }
  return known ? total : null;
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
  // The errors.json for the currently-viewed run, fetched whenever viewingRunId
  // changes. Empty object => no errors (the Errors section stays hidden).
  const [errors, setErrors] = useState<RunErrors>({});
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [pendingResume, setPendingResume] = useState<RunMeta | null>(null);
  // Non-null while we're monitoring a server-side run we did NOT start in this
  // tab (e.g. after a page refresh): there's no SSE stream to read, so progress
  // is tracked by polling the runs list instead.
  const [adoptedRunId, setAdoptedRunId] = useState<string | null>(null);
  // "Retry Failed" dialog: null = closed; a string = open with that run_id
  // selected in the dropdown. `retryUseLive` toggles between reproducing the
  // run's original config (false) and applying the experiment's current edited
  // settings to the failed rows (true).
  const [retryRunId, setRetryRunId] = useState<string | null>(null);
  const [retryUseLive, setRetryUseLive] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  // Merge Results dialog state. `mergeOpen` toggles the modal; `mergeFrom` /
  // `mergeInto` are the selected run_ids; `mergeOverwrite` toggles overwriting
  // destination rows on conflict; `mergeConflicts` holds the {from,into}
  // result_id pairs returned when a non-overwrite merge is blocked.
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeFrom, setMergeFrom] = useState<string | null>(null);
  const [mergeInto, setMergeInto] = useState<string | null>(null);
  const [mergeOverwrite, setMergeOverwrite] = useState(false);
  const [mergeConflicts, setMergeConflicts] = useState<
    { from: number; into: number }[] | null
  >(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  // Run mode in the Run section box. "new" starts a fresh run; "merged"
  // generates the current experiment's results into an existing target run
  // (`mergeTargetRunId`), with `runConflictPolicy` deciding what happens to
  // rows that share a (provider, model, example id) with the target.
  const [runMode, setRunMode] = useState<"new" | "merged">("new");
  const [mergeTargetRunId, setMergeTargetRunId] = useState<string | null>(null);
  const [runConflictPolicy, setRunConflictPolicy] = useState<
    "skip" | "overwrite"
  >("skip");
  // Pause dialog state. "waiting" = pause requested, draining in-flight
  // threads; "done" = drain finished, run is paused and resumable. null = no
  // pause in progress.
  const [pauseState, setPauseState] = useState<"waiting" | "done" | null>(null);
  const [terminating, setTerminating] = useState(false);
  // Per-model UI state for the additional-kwargs editor. The rows are the
  // source of truth while editing (preserves insertion order and lets users
  // rename keys mid-typing); they're folded into `model.additional_kwargs`
  // on save.
  const [kwargRowsByModel, setKwargRowsByModel] = useState<KwargRow[][]>([]);
  const [kwargsOpen, setKwargsOpen] = useState<boolean[]>([]);
  // Costs UI state. `pricingByProvider` holds default $/1M prices fetched from
  // each provider's /models endpoint, keyed by model id. `appliedPrices` is the
  // snapshot the cost columns are computed from — it tracks the editable model
  // prices until the user edits one (`pricesDirty`), after which only the
  // "Update Costs" button re-applies them. `pricingOpen` toggles the section.
  const [pricingByProvider, setPricingByProvider] = useState<
    Record<string, Record<string, { input?: number; output?: number }>>
  >({});
  // Default prices from data/pricing_defaults.json (provider -> model ->
  // {input, output}), generated by scripts/update_pricing.py. The primary
  // source of price defaults; live /models pricing fills anything not listed.
  const [fileDefaults, setFileDefaults] = useState<
    Record<string, Record<string, { input?: number; output?: number }>>
  >({});
  const [appliedPrices, setAppliedPrices] = useState<PriceMap>({});
  const [pricesDirty, setPricesDirty] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
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
  // Error message per provider when the /models fetch fails (bad key, wrong
  // api_url, provider unreachable, …). Surfaced inline under the model field
  // so a misconfigured provider doesn't just show an empty dropdown.
  const [modelsErrorByProvider, setModelsErrorByProvider] = useState<
    Record<string, string>
  >({});
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
        if (d.pricing && typeof d.pricing === "object") {
          setPricingByProvider((cur) => ({ ...cur, [providerName]: d.pricing }));
        }
        setModelsErrorByProvider((cur) => {
          const next = { ...cur };
          if (d.error) next[providerName] = String(d.error);
          else delete next[providerName];
          return next;
        });
      })
      .catch((err) => {
        setModelsByProvider((cur) => ({ ...cur, [providerName]: [] }));
        setModelsErrorByProvider((cur) => ({
          ...cur,
          [providerName]: err?.message
            ? `Could not reach the model list: ${err.message}`
            : "Could not reach the model list.",
        }));
      })
      .finally(() => {
        setModelsLoading((cur) => ({ ...cur, [providerName]: false }));
      });
  }, []);

  const fetchRuns = useCallback(async (): Promise<RunMeta[]> => {
    try {
      const r = await fetch(apiUrl(`/api/experiments/${id}/runs`)).then((r) =>
        r.json(),
      );
      const list: RunMeta[] = r.runs ?? [];
      setRuns(list);
      return list;
    } catch {
      return [];
    }
  }, [id]);

  useEffect(() => {
    (async () => {
      const [eRes, pRes, sRes, dRes, rRes, prRes] = await Promise.all([
        fetch(apiUrl(`/api/experiments/${id}`)).then((r) => r.json()),
        fetch(apiUrl("/api/providers")).then((r) => r.json()),
        fetch(apiUrl("/api/scorers")).then((r) => r.json()),
        fetch(apiUrl("/api/datasets")).then((r) => r.json()),
        fetch(apiUrl(`/api/experiments/${id}/results`)).then((r) => r.json()),
        fetch(apiUrl("/api/pricing-defaults")).then((r) => r.json()),
      ]);
      if (eRes.experiment) {
        const e = eRes.experiment as Experiment;
        setExp(e);
        setKwargRowsByModel(
          e.models.map((m) => recordToRows(m.additional_kwargs)),
        );
        // Expand the kwargs editor for any model that already has kwargs so
        // they're visible on load (e.g. a temperature carried in from the
        // experiment JSON), rather than hidden behind a collapsed section.
        setKwargsOpen(
          e.models.map(
            (m) => Object.keys(m.additional_kwargs ?? {}).length > 0,
          ),
        );
      }
      setAllProviders(pRes.providers ?? []);
      setScorers(sRes.scorers ?? []);
      setDatasets(dRes.datasets ?? []);
      if (prRes.pricing && typeof prRes.pricing === "object") {
        setFileDefaults(prRes.pricing);
      }
      if (rRes.results) setResults(rRes.results);
      if (rRes.runId) setViewingRunId(rRes.runId);
      const list = await fetchRuns();
      // A run still marked "running" is executing server-side (this tab didn't
      // start it, or we just refreshed). Reflect it as active and monitor it by
      // polling — there's no SSE stream to reconnect to.
      const live = list.find((r) => r.status === "running");
      if (live) {
        setActiveRunId(live.run_id);
        setProgress({
          total: live.total,
          completed: live.completed,
          errors: live.errors,
          runId: live.run_id,
        });
        setRunning(true);
        setAdoptedRunId(live.run_id);
      }
    })();
  }, [id, fetchRuns]);

  // Tear down monitoring of an adopted run once it reaches a terminal state,
  // loading its final results. A paused run flips the pause dialog to its
  // success state; any other terminal status just dismisses it.
  const finishMonitoring = useCallback(
    async (run: RunMeta | null) => {
      setAdoptedRunId(null);
      setRunning(false);
      setActiveRunId(null);
      setCancelling(false);
      setTerminating(false);
      setPauseState(run?.status === "paused" ? "done" : null);
      if (run) {
        setViewingRunId(run.run_id);
        try {
          const r = await fetch(
            apiUrl(
              `/api/experiments/${id}/results?run_id=${encodeURIComponent(run.run_id)}`,
            ),
          ).then((res) => res.json());
          setResults(r.results ?? null);
        } catch {
          // best-effort: the run list already reflects the final status.
        }
      }
    },
    [id],
  );

  // While monitoring an adopted run (no SSE stream), poll the runs list for
  // progress until the run finishes.
  useEffect(() => {
    if (!adoptedRunId) return;
    let stopped = false;
    const tick = async () => {
      const list = await fetchRuns();
      if (stopped) return;
      const run = list.find((r) => r.run_id === adoptedRunId);
      if (!run) {
        finishMonitoring(null);
        return;
      }
      setProgress({
        total: run.total,
        completed: run.completed,
        errors: run.errors,
        runId: run.run_id,
      });
      if (run.status !== "running") finishMonitoring(run);
    };
    const interval = setInterval(tick, 1500);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [adoptedRunId, fetchRuns, finishMonitoring]);

  // Load the errors.json for whichever run is currently displayed. Keyed on
  // viewingRunId so it follows the run selector, a fresh run finishing, and an
  // adopted run completing — all of which set viewingRunId. Clears to {} when
  // no run is selected so a stale run's errors never linger.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!viewingRunId) {
        if (!cancelled) setErrors({});
        return;
      }
      try {
        const r = await fetch(
          apiUrl(
            `/api/experiments/${id}/errors?run_id=${encodeURIComponent(viewingRunId)}`,
          ),
        ).then((res) => res.json());
        if (!cancelled) setErrors(r.errors ?? {});
      } catch {
        if (!cancelled) setErrors({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, viewingRunId]);

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

  // Default prices keyed by `defaultsKey(provider, model)`. data/
  // pricing_defaults.json is the primary source; live /models pricing fills in
  // anything the file doesn't list (e.g. SambaNova, which self-reports).
  const defaultPrices = useMemo(() => {
    const out: Record<string, { input?: number; output?: number }> = {};
    const add = (
      provider: string,
      model: string,
      entry: { input?: number; output?: number },
      override: boolean,
    ) => {
      const k = defaultsKey(provider, model);
      const cur = out[k] ?? {};
      out[k] = {
        input: override
          ? (entry.input ?? cur.input)
          : (cur.input ?? entry.input),
        output: override
          ? (entry.output ?? cur.output)
          : (cur.output ?? entry.output),
      };
    };
    // Live /models pricing first (lower precedence)…
    for (const [provider, models] of Object.entries(pricingByProvider)) {
      for (const [model, entry] of Object.entries(models)) {
        add(provider, model, entry, false);
      }
    }
    // …then file defaults, which win on conflict.
    for (const [provider, models] of Object.entries(fileDefaults)) {
      for (const [model, entry] of Object.entries(models)) {
        add(provider, model, entry, true);
      }
    }
    return out;
  }, [pricingByProvider, fileDefaults]);

  // The live price map folds each model's explicit price with its default, so
  // suggested defaults are applied to costs immediately — no typing required.
  // While the user is mid-edit (`pricesDirty`) the cost columns hold the frozen
  // `appliedPrices` snapshot instead, so typing doesn't move costs until
  // "Update Costs" is clicked.
  const livePrices = useMemo(
    () => buildEffectivePriceMap(exp?.models ?? [], defaultPrices),
    [exp?.models, defaultPrices],
  );
  const displayPrices = pricesDirty ? appliedPrices : livePrices;

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

  const save = async (modelsOverride?: ModelConfig[]) => {
    setSaving(true);
    setSaved(false);
    const baseModels = modelsOverride ?? exp.models;
    const payload: Experiment = {
      ...exp,
      models: baseModels.map((m, i) => {
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

  // Edit a model's $/1M price. Blank clears the field (reverts to the provider
  // default on next load); marks prices dirty so the cost columns hold until
  // "Update Costs".
  const setModelPrice = (
    i: number,
    field: "input_price" | "output_price",
    raw: string,
  ) => {
    // On the first edit, freeze the currently-displayed costs by snapshotting
    // the live prices, so further typing doesn't move them until "Update Costs".
    if (!pricesDirty) {
      setAppliedPrices(buildEffectivePriceMap(exp.models, defaultPrices));
      setPricesDirty(true);
    }
    const v = raw.trim();
    if (v === "") {
      updateModel(i, { [field]: undefined });
      return;
    }
    const n = Number(v);
    updateModel(i, {
      [field]: Number.isFinite(n) && n >= 0 ? n : undefined,
    });
  };

  // Re-derive every cost column from the current prices (clearing the frozen
  // snapshot) and persist them onto the experiment — no re-run required. Any
  // field the user left blank is materialized from its default first, so the
  // suggested defaults become the experiment's stored prices.
  const updateCosts = async () => {
    const materialized = exp.models.map((m) => {
      const def = defaultPrices[defaultsKey(m.provider_name, m.name)] ?? {};
      const next: ModelConfig = { ...m };
      const input = effectivePrice(m.input_price, def.input);
      const output = effectivePrice(m.output_price, def.output);
      if (input != null) next.input_price = input;
      if (output != null) next.output_price = output;
      return next;
    });
    setPricesDirty(false);
    await save(materialized);
  };

  const streamRun = async (
    mode: RunMode,
    explicitRunId?: string,
    opts?: { useLiveConfig?: boolean; mergeConflict?: "skip" | "overwrite" },
  ) => {
    setRunning(true);
    setRunError(null);
    setProgress(null);
    setResults(null);
    setViewingRunId(null);
    setActiveRunId(null);
    setPauseState(null);
    setTerminating(false);

    const qs = new URLSearchParams({
      concurrency: String(exp.concurrency ?? 4),
      mode,
    });
    if (explicitRunId) qs.set("run_id", explicitRunId);
    if (opts?.useLiveConfig) qs.set("config", "live");
    if (opts?.mergeConflict) qs.set("merge_conflict", opts.mergeConflict);

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
            // A pause request that landed flips the dialog to its success
            // state; any other terminal status (completed before the pause
            // took effect, aborted, …) just dismisses it.
            setPauseState(parsed.meta?.status === "paused" ? "done" : null);
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
    setPauseState(null);
    setTerminating(false);
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
            // A pause request that landed flips the dialog to its success
            // state; any other terminal status (completed before the pause
            // took effect, aborted, …) just dismisses it.
            setPauseState(parsed.meta?.status === "paused" ? "done" : null);
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

  // The Run section's primary action. "New Run" keeps the existing auto/resume
  // flow; "Merged Run" generates the current experiment's results into the
  // chosen target run, checking each (provider, model, example id) for a
  // conflict before running a prompt.
  const runExperiment = async () => {
    if (runMode === "merged") {
      if (!mergeTargetRunId) {
        setRunError("Choose an existing run to merge into.");
        return;
      }
      await save();
      await streamRun("merged", mergeTargetRunId, {
        mergeConflict: runConflictPolicy,
      });
      return;
    }
    await runAuto();
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

  // Runs that finished with at least one failed row — the candidates for
  // "Retry Failed". Already newest-first (the API sorts runs descending). A
  // still-running run is excluded: its failures aren't final and retrying it
  // would collide with the in-flight execution.
  const retryableRuns = runs.filter(
    (r) => r.errors > 0 && r.status !== "running",
  );

  const openRetryDialog = () => {
    if (retryableRuns.length === 0) return;
    setRetryUseLive(false);
    setRetryRunId(retryableRuns[0].run_id);
  };

  const chooseRetry = async () => {
    const target = retryRunId;
    const useLiveConfig = retryUseLive;
    setRetryRunId(null);
    if (!target) return;
    // Applying current settings means the on-disk experiment must reflect the
    // in-progress edits first; the snapshot path needs no save.
    if (useLiveConfig) await save();
    // Re-runs only the failed rows of the chosen run, in place — against either
    // the run's original config snapshot or the experiment's current settings.
    await streamRun("retry", target, { useLiveConfig });
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

  const pauseRun = async () => {
    if (!activeRunId || pauseState) return;
    // Show the dialog immediately; the stream stays open and the "done" event
    // (with status "paused") flips it to its success state once the in-flight
    // threads have drained.
    setPauseState("waiting");
    try {
      await fetch(
        apiUrl(`/api/experiments/${id}/run/pause?run_id=${encodeURIComponent(activeRunId)}`),
        { method: "POST" },
      );
    } catch {
      // best-effort: the drain still completes and emits a done event.
    }
  };

  const terminateThreads = async () => {
    if (!activeRunId || terminating) return;
    setTerminating(true);
    try {
      // Force the worker pool down so the pause doesn't block on in-flight
      // threads. Abandoned tasks write nothing and re-run on resume.
      await fetch(
        apiUrl(`/api/experiments/${id}/run/terminate?run_id=${encodeURIComponent(activeRunId)}`),
        { method: "POST" },
      );
    } catch {
      // best-effort
    } finally {
      setTerminating(false);
    }
  };

  const closePauseDialog = () => setPauseState(null);

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
    const remaining = await fetchRuns();
    // If the deleted run was the one being displayed, fall back to the most
    // recent remaining run so the dropdown never lands on an empty selection.
    if (viewingRunId === runId) {
      const next = remaining[0];
      if (next) {
        await viewRun(next.run_id);
      } else {
        setResults(null);
        setViewingRunId(null);
      }
    }
  };

  // Open the Merge Results dialog, defaulting From/Into to the two most recent
  // runs (newest-first ordering) so the common case needs no selection.
  const openMerge = () => {
    if (running) return;
    setMergeConflicts(null);
    setMergeError(null);
    setMergeOverwrite(false);
    setMergeFrom(runs[0]?.run_id ?? null);
    setMergeInto(runs[1]?.run_id ?? runs[0]?.run_id ?? null);
    setMergeOpen(true);
  };

  const doMerge = async () => {
    if (!mergeFrom || !mergeInto || merging) return;
    setMerging(true);
    setMergeError(null);
    setMergeConflicts(null);
    try {
      const res = await fetch(apiUrl(`/api/experiments/${id}/runs/merge`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_run_id: mergeFrom,
          into_run_id: mergeInto,
          overwrite: mergeOverwrite,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.status === 409 && d.status === "conflict") {
        setMergeConflicts(d.conflicts ?? []);
        return;
      }
      if (!res.ok) {
        setMergeError(d.error ?? `Failed to merge results (${res.status})`);
        return;
      }
      // Success: refresh runs and view the (modified) destination run.
      setMergeOpen(false);
      await fetchRuns();
      await viewRun(mergeInto);
    } finally {
      setMerging(false);
    }
  };

  const percent = progress
    ? Math.round((progress.completed / Math.max(1, progress.total)) * 100)
    : 0;

  // The run currently selected in the results dropdown (the one whose results,
  // stats, and aggregations are shown). `runs` is newest-first, so the default
  // viewingRunId set on load is the most recent run.
  const selectedRun = runs.find((r) => r.run_id === viewingRunId) ?? null;

  // Runs eligible as a "Merged Run" target: those over the same dataset as the
  // experiment's current settings (dataset_key equals the filename, which is
  // what `exp.dataset` holds for file-backed datasets).
  const sameDatasetRuns = runs.filter((r) => r.dataset_key === exp.dataset);

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

      {mergeOpen &&
        (() => {
          const fromRun = runs.find((r) => r.run_id === mergeFrom) ?? null;
          // Restrict "Into" to runs over the same dataset as the chosen "From"
          // (and never the same run) — the dynamic same-dataset filter.
          const intoOptions = runs.filter(
            (r) =>
              r.run_id !== mergeFrom &&
              (!fromRun || r.dataset_key === fromRun.dataset_key),
          );
          const runLabel = (r: RunMeta) =>
            `${formatTimestamp(r.started_at)} — ${r.status} (${r.completed}/${r.total}${r.errors > 0 ? `, ${r.errors} errors` : ""})`;
          const canMerge =
            !!mergeFrom &&
            !!mergeInto &&
            mergeFrom !== mergeInto &&
            !merging;
          return (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <div className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-5 max-w-2xl w-full mx-4 max-h-[85vh] overflow-auto">
                <h3 className="font-medium mb-3">Merge Results</h3>
                <p className="text-sm text-[var(--muted)] mb-4">
                  Results from one experiment run can be merged into those of
                  another experiment run as long as they use the same dataset.
                  That can be used if different runs contain different models or
                  examples from the same dataset. Note that the result_ids in
                  the &apos;From&apos; results will be modified but the
                  &apos;Into&apos; will not be modified.
                </p>

                <label className="text-xs text-[var(--muted)] block mb-1">
                  From
                </label>
                <select
                  value={mergeFrom ?? ""}
                  onChange={(e) => {
                    const next = e.target.value;
                    setMergeFrom(next);
                    setMergeConflicts(null);
                    setMergeError(null);
                    // Keep Into valid: if it no longer shares the dataset (or
                    // equals the new From), reset it to the first valid option.
                    const nextFrom = runs.find((r) => r.run_id === next);
                    const valid = runs.filter(
                      (r) =>
                        r.run_id !== next &&
                        (!nextFrom || r.dataset_key === nextFrom.dataset_key),
                    );
                    if (!valid.some((r) => r.run_id === mergeInto)) {
                      setMergeInto(valid[0]?.run_id ?? null);
                    }
                  }}
                  className="mb-4"
                >
                  {runs.map((r) => (
                    <option key={r.run_id} value={r.run_id}>
                      {runLabel(r)}
                    </option>
                  ))}
                </select>

                <label className="text-xs text-[var(--muted)] block mb-1">
                  Into
                </label>
                <select
                  value={mergeInto ?? ""}
                  onChange={(e) => {
                    setMergeInto(e.target.value);
                    setMergeConflicts(null);
                    setMergeError(null);
                  }}
                  disabled={intoOptions.length === 0}
                  className="mb-4"
                >
                  {intoOptions.length === 0 ? (
                    <option value="">No other run with the same dataset</option>
                  ) : (
                    intoOptions.map((r) => (
                      <option key={r.run_id} value={r.run_id}>
                        {runLabel(r)}
                      </option>
                    ))
                  )}
                </select>

                <label className="flex items-start gap-2 text-sm mb-4 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={mergeOverwrite}
                    onChange={(e) => {
                      setMergeOverwrite(e.target.checked);
                      setMergeConflicts(null);
                      setMergeError(null);
                    }}
                    className="mt-0.5"
                  />
                  <span>Overwrite destination run results when conflicts arise</span>
                </label>

                {mergeConflicts && (
                  <div className="mb-4 border border-[var(--danger)] rounded-md p-3">
                    <p className="text-sm text-[var(--danger)] mb-2">
                      The following rows refer to the same provider, model, and
                      example id
                    </p>
                    <div className="overflow-auto max-h-60">
                      <table className="w-full text-sm">
                        <thead className="bg-[var(--panel-2)]">
                          <tr className="text-[var(--muted)]">
                            <th className="text-left px-3 py-2 border-b border-[var(--border)]">
                              From
                            </th>
                            <th className="text-left px-3 py-2 border-b border-[var(--border)]">
                              Into
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {mergeConflicts.map((c, i) => (
                            <tr
                              key={i}
                              className="border-b border-[var(--border)]"
                            >
                              <td className="px-3 py-2 font-mono">{c.from}</td>
                              <td className="px-3 py-2 font-mono">{c.into}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {mergeError && (
                  <p className="text-sm text-[var(--danger)] mb-4">{mergeError}</p>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setMergeOpen(false)}
                    className="text-[var(--muted)] hover:text-white px-3 py-2 text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={doMerge}
                    disabled={!canMerge}
                    className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-3 py-2 rounded-md text-sm font-medium disabled:opacity-50"
                  >
                    {merging ? "Merging…" : "Merge"}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}

      {retryRunId !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-5 max-w-md w-full mx-4">
            <h3 className="font-medium mb-3">Retry failed rows</h3>
            <p className="text-sm text-[var(--muted)] mb-4">
              Pick a past run; only its failed rows are re-run, in place, using
              the model and dataset config that run originally used. Rows that
              already succeeded are kept.
            </p>
            <label className="text-xs text-[var(--muted)] block mb-1">
              Run
            </label>
            <select
              value={retryRunId}
              onChange={(e) => setRetryRunId(e.target.value)}
              className="mb-4"
            >
              {retryableRuns.map((r) => (
                <option key={r.run_id} value={r.run_id}>
                  {formatTimestamp(r.started_at)} — {r.errors} failed of{" "}
                  {r.total}
                </option>
              ))}
            </select>
            <label className="flex items-start gap-2 text-sm mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={retryUseLive}
                onChange={(e) => setRetryUseLive(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Use current experiment settings
                <span className="block text-xs text-[var(--muted)]">
                  Apply the experiment&apos;s current model/dataset config to the
                  failed rows instead of reproducing the run&apos;s original
                  settings. Saves the experiment first.
                </span>
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setRetryRunId(null)}
                className="text-[var(--muted)] hover:text-white px-3 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                onClick={chooseRetry}
                className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-3 py-2 rounded-md text-sm font-medium"
              >
                Retry Failed
              </button>
            </div>
          </div>
        </div>
      )}

      {pauseState && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-5 max-w-md w-full mx-4">
            {pauseState === "waiting" ? (
              <>
                <div className="flex items-center gap-3 mb-3">
                  <span
                    className="text-2xl animate-spin inline-block"
                    style={{ animationDuration: "2s" }}
                    aria-hidden
                  >
                    ⏳
                  </span>
                  <h3 className="font-medium">Pausing run…</h3>
                </div>
                <p className="text-sm text-[var(--muted)] mb-4">
                  Waiting for running threads to finish executing…
                </p>
                <div className="flex justify-end">
                  <button
                    onClick={terminateThreads}
                    disabled={terminating}
                    className="bg-[var(--danger)] hover:opacity-90 text-white px-3 py-2 rounded-md text-sm font-medium disabled:opacity-50"
                  >
                    {terminating ? "Terminating…" : "Terminate Threads"}
                  </button>
                </div>
                <p className="text-xs text-[var(--muted)] mt-3">
                  Terminating force-stops the running threads so the app
                  doesn&apos;t wait on them. Those tasks produce no results and
                  are re-run when you resume.
                </p>
              </>
            ) : (
              <>
                <h3 className="font-medium mb-3">Run paused</h3>
                <p className="text-sm text-[var(--muted)] mb-4">
                  Experiment has been successfully paused and can be resumed at
                  any time!
                </p>
                <div className="flex justify-end">
                  <button
                    onClick={closePauseDialog}
                    className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-3 py-2 rounded-md text-sm font-medium"
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <section className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-4 mb-4">
        <h2 className="font-medium mb-3">General</h2>
        <div className="grid grid-cols-12 gap-3 mb-3">
          <div className="col-span-6">
            <label className="text-xs text-[var(--muted)] block mb-1">
              Name
            </label>
            <input
              value={exp.name}
              onChange={(e) => update({ name: e.target.value })}
            />
          </div>
          <div className="col-span-6">
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
                  <ModelNameCombobox
                    value={m.name}
                    options={modelsByProvider[m.provider_name] ?? []}
                    onChange={(name) => updateModel(i, { name })}
                    placeholder="e.g. Meta-Llama-3.1-8B-Instruct"
                  />
                  {modelsLoading[m.provider_name] ? (
                    <span className="text-[10px] text-[var(--muted)]">
                      Loading models…
                    </span>
                  ) : m.provider_name &&
                    modelsErrorByProvider[m.provider_name] ? (
                    <span className="text-[10px] text-[var(--danger)]">
                      {modelsErrorByProvider[m.provider_name]} — check this
                      provider&apos;s API key and URL on the{" "}
                      <Link
                        href="/providers"
                        className="underline text-[var(--accent)]"
                      >
                        Providers
                      </Link>{" "}
                      page. You can still type a model name.
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
                      // Clear the model name too: a leftover value from the
                      // previous provider filters the <datalist> down to
                      // nothing, hiding the new provider's models.
                      updateModel(i, { provider_name: e.target.value, name: "" });
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
                <div className="col-span-3">
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
          <div className="col-span-6">
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
                Heuristic (exact match / contains substring)
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

      <section className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-4 mb-4">
        <h2 className="font-medium mb-3">Run</h2>
        <div className="grid grid-cols-12 gap-3 mb-3">
          <div className="col-span-3">
            <label className="text-xs text-[var(--muted)] block mb-1">
              Run concurrency
            </label>
            <input
              type="number"
              min={1}
              max={32}
              value={exp.concurrency ?? 4}
              disabled={running}
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

        <div className="flex items-center gap-5 mb-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="runMode"
              checked={runMode === "new"}
              disabled={running}
              onChange={() => setRunMode("new")}
            />
            New Run
          </label>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="radio"
              name="runMode"
              checked={runMode === "merged"}
              disabled={running}
              onChange={() => {
                setRunMode("merged");
                setRunError(null);
                // Default the target to the most recent same-dataset run.
                if (
                  !mergeTargetRunId ||
                  !sameDatasetRuns.some((r) => r.run_id === mergeTargetRunId)
                ) {
                  setMergeTargetRunId(sameDatasetRuns[0]?.run_id ?? null);
                }
              }}
            />
            Merged Run
          </label>
        </div>

        {runMode === "merged" &&
          (sameDatasetRuns.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">
              No existing run uses this experiment&apos;s current dataset, so
              there is nothing to merge into.
            </p>
          ) : (
            <div className="max-w-xl">
              <label className="text-xs text-[var(--muted)] block mb-1">
                Choose Existing Run
              </label>
              <select
                value={mergeTargetRunId ?? ""}
                disabled={running}
                onChange={(e) => setMergeTargetRunId(e.target.value)}
                className="mb-4"
              >
                {sameDatasetRuns.map((r) => (
                  <option key={r.run_id} value={r.run_id}>
                    {formatTimestamp(r.started_at)} — {r.status} ({r.completed}/
                    {r.total}
                    {r.errors > 0 ? `, ${r.errors} errors` : ""})
                  </option>
                ))}
              </select>

              <p className="text-sm mb-2">
                When conflicts arise with results in the target run that have
                the same provider, model, and example id,
              </p>
              <div className="flex items-center gap-5">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="runConflictPolicy"
                    checked={runConflictPolicy === "skip"}
                    disabled={running}
                    onChange={() => setRunConflictPolicy("skip")}
                  />
                  Skip them (saves time and token costs)
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="radio"
                    name="runConflictPolicy"
                    checked={runConflictPolicy === "overwrite"}
                    disabled={running}
                    onChange={() => setRunConflictPolicy("overwrite")}
                  />
                  Overwrite them (with new experiment settings)
                </label>
              </div>
            </div>
          ))}
      </section>

      <div className="flex items-center justify-center gap-3 mt-6 mb-6">
        {saved && <span className="text-[var(--success)] text-sm">Saved</span>}
        <button
          onClick={() => save()}
          disabled={saving || running}
          className="bg-[var(--panel-2)] border border-[var(--border)] hover:bg-[var(--panel)] px-4 py-2 rounded-md disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        {running ? (
          <>
            <button
              onClick={pauseRun}
              disabled={!activeRunId || pauseState !== null || cancelling}
              className="bg-[var(--panel-2)] border border-[var(--border)] hover:bg-[var(--panel)] px-4 py-2 rounded-md font-medium disabled:opacity-50"
            >
              {pauseState ? "Pausing..." : "Pause"}
            </button>
            <button
              onClick={cancel}
              disabled={cancelling || !activeRunId}
              className="bg-[var(--danger)] hover:opacity-90 text-white px-4 py-2 rounded-md font-medium disabled:opacity-50"
            >
              {cancelling ? "Cancelling..." : "Cancel Run"}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={runExperiment}
              disabled={running || (runMode === "merged" && !mergeTargetRunId)}
              title={
                runMode === "merged" && !mergeTargetRunId
                  ? "Choose an existing run over this dataset to merge into"
                  : undefined
              }
              className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md font-medium disabled:opacity-50"
            >
              Run Experiment
            </button>
            <button
              onClick={openRetryDialog}
              disabled={running || retryableRuns.length === 0}
              title={
                retryableRuns.length === 0
                  ? "No past run has failed rows to retry"
                  : "Re-run only the failed rows of a past run"
              }
              className="bg-[var(--panel-2)] border border-[var(--border)] hover:bg-[var(--panel)] px-4 py-2 rounded-md font-medium disabled:opacity-50"
            >
              Retry Failed
            </button>
          </>
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

      {/* Errors for the currently-viewed run. Hidden entirely when the run has
          no recorded errors. */}
      {Object.values(errors).some((m) => Object.keys(m).length > 0) && (
        <section className="mb-6">
          <h2 className="font-medium mb-4">Errors</h2>
          <ErrorsTable errors={errors} />
        </section>
      )}

      {runs.length > 0 && (
        <section className="mb-6">
          <h2 className="font-medium mb-4">Results</h2>

          {exp.models.length > 0 && (
            <div className="bg-[var(--panel)] border border-[var(--border)] rounded-lg mb-6">
              <button
                type="button"
                onClick={() => setPricingOpen((o) => !o)}
                className="w-full flex items-center justify-between px-4 py-3 text-left"
              >
                <span className="text-sm font-semibold">
                  {pricingOpen ? "▾" : "▸"} Token Pricing &amp; Costs
                </span>
                {pricesDirty && (
                  <span className="text-xs text-[var(--warning)]">
                    Unapplied price changes
                  </span>
                )}
              </button>
              {pricingOpen && (
                <div className="px-4 pb-4">
                  <p className="text-xs text-[var(--muted)] mb-3">
                    Prices are in USD per 1,000,000 tokens and are used only to
                    compute the costs below — they are never sent to the
                    provider. Defaults come from{" "}
                    <code>data/pricing_defaults.json</code> (refresh it with{" "}
                    <code>python scripts/update_pricing.py</code>, which pulls
                    current OpenAI &amp; Anthropic prices); providers not in that
                    file fall back to their live <code>/models</code> pricing
                    (e.g. SambaNova). Fields are pre-filled with these defaults
                    and applied as-is; type to override (or clear a field to
                    revert to the default), then click{" "}
                    <span className="text-white">Update Costs</span> to re-derive
                    every cost from the stored token counts and save — no re-run
                    needed.
                  </p>
                  <div className="overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-[var(--panel-2)]">
                        <tr className="text-[var(--muted)]">
                          <th className="text-left px-3 py-2 border-b border-[var(--border)]">
                            provider
                          </th>
                          <th className="text-left px-3 py-2 border-b border-[var(--border)]">
                            model
                          </th>
                          <th className="text-right px-3 py-2 border-b border-[var(--border)]">
                            input $/1M
                          </th>
                          <th className="text-right px-3 py-2 border-b border-[var(--border)]">
                            output $/1M
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {exp.models.map((m, i) => {
                          const def =
                            defaultPrices[defaultsKey(m.provider_name, m.name)];
                          return (
                            <tr
                              key={i}
                              className="border-b border-[var(--border)]"
                            >
                              <td className="px-3 py-2 font-mono">
                                {m.provider_name || "—"}
                              </td>
                              <td className="px-3 py-2 font-mono">
                                {m.name || "—"}
                              </td>
                              <td className="px-3 py-2 text-right">
                                <input
                                  type="number"
                                  min={0}
                                  step="0.01"
                                  value={m.input_price ?? def?.input ?? ""}
                                  placeholder="0"
                                  onChange={(e) =>
                                    setModelPrice(
                                      i,
                                      "input_price",
                                      e.target.value,
                                    )
                                  }
                                  style={{ width: "8rem" }}
                                  className="text-right"
                                />
                              </td>
                              <td className="px-3 py-2 text-right">
                                <input
                                  type="number"
                                  min={0}
                                  step="0.01"
                                  value={m.output_price ?? def?.output ?? ""}
                                  placeholder="0"
                                  onChange={(e) =>
                                    setModelPrice(
                                      i,
                                      "output_price",
                                      e.target.value,
                                    )
                                  }
                                  style={{ width: "8rem" }}
                                  className="text-right"
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex items-center justify-end gap-3 mt-3">
                    {saved && (
                      <span className="text-[var(--success)] text-sm">
                        Saved
                      </span>
                    )}
                    <button
                      onClick={updateCosts}
                      disabled={saving || running}
                      className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50"
                    >
                      {saving ? "Updating…" : "Update Costs"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Run selector — defaults to the most recent run on load. Picking a
              run loads its results and re-points every table below at it. */}
          <div className="flex items-center gap-3 mb-4">
            <label className="text-sm text-[var(--muted)]">Run</label>
            <select
              value={viewingRunId ?? ""}
              onChange={(e) => viewRun(e.target.value)}
              disabled={running}
              style={{ width: "auto", minWidth: "20rem" }}
            >
              {runs.map((r) => (
                <option key={r.run_id} value={r.run_id}>
                  {formatTimestamp(r.started_at)} — {r.status} ({r.completed}/
                  {r.total}
                  {r.errors > 0 ? `, ${r.errors} errors` : ""})
                </option>
              ))}
            </select>
            {runs.length > 1 && (
              <button
                onClick={openMerge}
                disabled={running}
                title="Merge one run's results into another run that used the same dataset"
                className="bg-[var(--panel-2)] border border-[var(--border)] hover:bg-[var(--panel)] px-3 py-2 rounded-md text-sm disabled:opacity-50"
              >
                Merge Results
              </button>
            )}
          </div>

          {selectedRun && (
            <div className="bg-[var(--panel)] border border-[var(--border)] rounded-lg overflow-auto mb-6">
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
                    <th className="text-right px-3 py-2 border-b border-[var(--border)]">
                      cost
                    </th>
                    <th className="text-left px-3 py-2 border-b border-[var(--border)]">
                      run id
                    </th>
                    <th className="text-right px-3 py-2 border-b border-[var(--border)]"></th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const r = selectedRun;
                    const statusColor =
                      r.status === "completed"
                        ? "text-[var(--success)]"
                        : r.status === "aborted"
                          ? "text-[var(--danger)]"
                          : r.status === "interrupted" || r.status === "paused"
                            ? "text-[var(--warning)]"
                            : "text-[var(--accent)]";
                    return (
                      <tr className="border-b border-[var(--border)]">
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
                        <td className="px-3 py-2 text-right font-mono">
                          {formatCost(runCost(r, displayPrices))}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-[var(--muted)]">
                          {formatRunId(r.run_id)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => deleteRunResults(r.run_id)}
                            disabled={running}
                            title="Permanently delete this run's results"
                            className="text-sm text-[var(--muted)] hover:text-[var(--danger)] disabled:opacity-50"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })()}
                </tbody>
              </table>
            </div>
          )}

          {results && results.length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-semibold mb-3">
                Aggregated Results by Model
              </h3>
              <ModelSummaryTable rows={results} prices={displayPrices} />
            </div>
          )}

          {results && results.length > 0 && (
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold">Individual Results</h3>
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
              <ResultsTable rows={results} scorerType={exp?.scorer?.type} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
