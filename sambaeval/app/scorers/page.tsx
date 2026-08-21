"use client";
import { apiFetch } from "@/app/lib/api";

import { useEffect, useState } from "react";
import { DEFAULT_JUDGE_PROMPT } from "../lib/types";
import type { LlmJudgeScorerDef, Provider } from "../lib/types";
import { type KwargRow, recordToRows, rowsToRecord } from "../lib/kwargs";

export default function ScorersPage() {
  const [scorers, setScorers] = useState<LlmJudgeScorerDef[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-scorer additional-kwargs editor state — the rows are the source of
  // truth while editing and are folded into `additional_kwargs` on save.
  const [kwargRowsByScorer, setKwargRowsByScorer] = useState<KwargRow[][]>([]);
  const [kwargsOpen, setKwargsOpen] = useState<boolean[]>([]);

  useEffect(() => {
    (async () => {
      const [sRes, pRes] = await Promise.all([
        apiFetch("/api/scorers").then((r) => r.json()),
        apiFetch("/api/providers").then((r) => r.json()),
      ]);
      const list: LlmJudgeScorerDef[] = sRes.scorers ?? [];
      setScorers(list);
      setKwargRowsByScorer(list.map((s) => recordToRows(s.additional_kwargs)));
      // Expand the editor for any scorer that already has kwargs so they're
      // visible on load rather than hidden behind a collapsed section.
      setKwargsOpen(
        list.map((s) => Object.keys(s.additional_kwargs ?? {}).length > 0),
      );
      setProviders(pRes.providers ?? []);
      setLoading(false);
    })();
  }, []);

  const update = (i: number, patch: Partial<LlmJudgeScorerDef>) => {
    setScorers((prev) =>
      prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    );
  };

  const add = () => {
    setScorers((prev) => [
      ...prev,
      {
        name: "",
        provider_name: providers[0]?.name ?? "",
        model: "",
        judge_prompt: DEFAULT_JUDGE_PROMPT,
        max_score: 5,
      },
    ]);
    setKwargRowsByScorer((prev) => [...prev, []]);
    setKwargsOpen((prev) => [...prev, false]);
  };

  const remove = (i: number) => {
    setScorers((prev) => prev.filter((_, idx) => idx !== i));
    setKwargRowsByScorer((prev) => prev.filter((_, idx) => idx !== i));
    setKwargsOpen((prev) => prev.filter((_, idx) => idx !== i));
  };

  const setScorerKwargRows = (i: number, rows: KwargRow[]) =>
    setKwargRowsByScorer((prev) =>
      prev.map((r, idx) => (idx === i ? rows : r)),
    );

  const addKwarg = (i: number) =>
    setScorerKwargRows(i, [
      ...(kwargRowsByScorer[i] ?? []),
      { key: "", valueStr: "" },
    ]);

  const removeKwarg = (i: number, j: number) =>
    setScorerKwargRows(
      i,
      (kwargRowsByScorer[i] ?? []).filter((_, idx) => idx !== j),
    );

  const updateKwargKey = (i: number, j: number, key: string) =>
    setScorerKwargRows(
      i,
      (kwargRowsByScorer[i] ?? []).map((r, idx) =>
        idx === j ? { ...r, key } : r,
      ),
    );

  const updateKwargValueStr = (i: number, j: number, valueStr: string) =>
    setScorerKwargRows(
      i,
      (kwargRowsByScorer[i] ?? []).map((r, idx) =>
        idx === j ? { ...r, valueStr } : r,
      ),
    );

  const toggleKwargsOpen = (i: number) =>
    setKwargsOpen((prev) => prev.map((o, idx) => (idx === i ? !o : o)));

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    // Fold each scorer's kwarg rows into additional_kwargs; drop the key
    // entirely when there are none so it leaves the saved JSON.
    const payload = scorers.map((s, i) => {
      const ak = rowsToRecord(kwargRowsByScorer[i] ?? []);
      const next: LlmJudgeScorerDef = { ...s };
      if (Object.keys(ak).length > 0) {
        next.additional_kwargs = ak;
      } else {
        delete next.additional_kwargs;
      }
      return next;
    });
    const res = await apiFetch("/api/scorers", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scorers: payload }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(data.error ?? "Failed to save scorers");
      return;
    }
    const saved: LlmJudgeScorerDef[] = data.scorers ?? [];
    setScorers(saved);
    setKwargRowsByScorer(saved.map((s) => recordToRows(s.additional_kwargs)));
    setKwargsOpen((prev) =>
      saved.map(
        (s, idx) =>
          prev[idx] ?? Object.keys(s.additional_kwargs ?? {}).length > 0,
      ),
    );
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (loading) return <div className="text-[var(--muted)]">Loading…</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h1 className="text-2xl font-semibold">Scorers</h1>
          <p className="text-[var(--muted)] text-sm mt-1">
            Reusable LLM-as-judge configurations. Experiments reference scorers
            by name; heuristic scoring is defined inline on the experiment.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saved && (
            <span className="text-[var(--success)] text-sm">Saved</span>
          )}
          <button
            onClick={save}
            disabled={saving}
            className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md font-medium disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
      <p className="text-xs text-[var(--muted)] mb-6">
        Judge prompt — placeholders:{" "}
        <code className="text-[var(--accent)] bg-[var(--accent-soft)] px-1 rounded">
          {"{prompt}"}
        </code>
        ,{" "}
        <code className="text-[var(--accent)] bg-[var(--accent-soft)] px-1 rounded">
          {"{output}"}
        </code>
        ,{" "}
        <code className="text-[var(--accent)] bg-[var(--accent-soft)] px-1 rounded">
          {"{expected_output}"}
        </code>
        ,{" "}
        <code className="text-[var(--accent)] bg-[var(--accent-soft)] px-1 rounded">
          {"{max_score}"}
        </code>
        . The judge must respond with JSON of the form{" "}
        <code className="text-[var(--accent)] bg-[var(--accent-soft)] px-1 rounded">
          {'{"score": <integer 0..max_score>, "score_reason": "<text>"}'}
        </code>
        ; sambaeval divides by{" "}
        <code className="text-[var(--accent)] bg-[var(--accent-soft)] px-1 rounded">
          max_score
        </code>{" "}
        to normalize the result to 0–1.
      </p>

      {error && (
        <div className="bg-[var(--danger)]/10 border border-[var(--danger)] text-[var(--danger)] rounded-md p-3 text-sm mb-4">
          {error}
        </div>
      )}

      {providers.length === 0 && (
        <div className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-4 text-sm text-[var(--muted)] mb-4">
          No providers configured. Add one on the Providers page before creating
          a scorer.
        </div>
      )}

      <div className="space-y-3">
        {scorers.map((s, i) => (
          <div
            key={i}
            className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-4"
          >
            <div className="grid grid-cols-12 gap-3 mb-3">
              <div className="col-span-3">
                <label className="text-xs text-[var(--muted)] block mb-1">
                  Name
                </label>
                <input
                  value={s.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                  placeholder="e.g. codegen_judge"
                  spellCheck={false}
                />
              </div>
              <div className="col-span-3">
                <label className="text-xs text-[var(--muted)] block mb-1">
                  Judge provider
                </label>
                <select
                  value={s.provider_name}
                  onChange={(e) =>
                    update(i, { provider_name: e.target.value })
                  }
                >
                  <option value="">— select —</option>
                  {providers.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name || "(unnamed)"}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-3">
                <label className="text-xs text-[var(--muted)] block mb-1">
                  Judge model
                </label>
                <input
                  value={s.model}
                  onChange={(e) => update(i, { model: e.target.value })}
                  placeholder="e.g. gpt-4o-mini"
                />
              </div>
              <div className="col-span-2">
                <label className="text-xs text-[var(--muted)] block mb-1">
                  Max score
                </label>
                <input
                  type="number"
                  min={1}
                  step="1"
                  value={s.max_score}
                  onChange={(e) =>
                    update(i, {
                      max_score: Math.max(1, Number(e.target.value) || 1),
                    })
                  }
                />
              </div>
              <div className="col-span-1 flex items-end justify-end">
                <button
                  onClick={() => remove(i)}
                  className="text-[var(--muted)] hover:text-[var(--danger)] text-xs"
                >
                  Remove
                </button>
              </div>
            </div>
            <label className="text-xs text-[var(--muted)] block mb-1">
              Judge prompt
            </label>
            <textarea
              value={s.judge_prompt}
              onChange={(e) => update(i, { judge_prompt: e.target.value })}
              rows={10}
            />
            <div className="mt-3">
              <button
                type="button"
                onClick={() => toggleKwargsOpen(i)}
                className="text-xs text-[var(--muted)] hover:text-[var(--accent)]"
              >
                {kwargsOpen[i] ? "▾" : "▸"} Additional keyword args
                {(kwargRowsByScorer[i]?.length ?? 0) > 0 && (
                  <span className="ml-1">({kwargRowsByScorer[i].length})</span>
                )}
              </button>
              {kwargsOpen[i] && (
                <div className="mt-2 pl-3 border-l-2 border-[var(--border)]">
                  <p className="text-xs text-[var(--muted)] mb-2">
                    Forwarded as-is to the judge model&apos;s chat completions
                    endpoint (e.g. <code>temperature</code>, <code>top_p</code>,{" "}
                    <code>max_tokens</code>). Values are parsed as JSON — wrap
                    string values in double quotes (e.g.{" "}
                    <code>&quot;text&quot;</code>), otherwise bare{" "}
                    <code>0.2</code> becomes a number, <code>true</code> a
                    boolean, etc.
                  </p>
                  {(kwargRowsByScorer[i] ?? []).map((kw, j) => (
                    <div key={j} className="flex gap-2 mb-2">
                      <input
                        value={kw.key}
                        onChange={(e) => updateKwargKey(i, j, e.target.value)}
                        placeholder="key (e.g. temperature)"
                        spellCheck={false}
                        className="flex-1"
                      />
                      <input
                        value={kw.valueStr}
                        onChange={(e) =>
                          updateKwargValueStr(i, j, e.target.value)
                        }
                        placeholder='value (JSON: 0.2, "stop_word", [1,2])'
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
        <button
          onClick={add}
          disabled={providers.length === 0}
          className="w-full border border-dashed border-[var(--border)] rounded-lg py-3 text-[var(--muted)] hover:text-[var(--accent)] hover:border-[var(--accent)] disabled:opacity-50 disabled:hover:text-[var(--muted)] disabled:hover:border-[var(--border)]"
        >
          + Add Scorer
        </button>
      </div>
    </div>
  );
}
