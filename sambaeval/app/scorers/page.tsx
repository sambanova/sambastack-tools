"use client";
import { apiUrl } from "@/app/lib/api";

import { useEffect, useState } from "react";
import { DEFAULT_JUDGE_PROMPT } from "../lib/types";
import type { LlmJudgeScorerDef, Provider } from "../lib/types";

export default function ScorersPage() {
  const [scorers, setScorers] = useState<LlmJudgeScorerDef[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [sRes, pRes] = await Promise.all([
        fetch(apiUrl("/api/scorers")).then((r) => r.json()),
        fetch(apiUrl("/api/providers")).then((r) => r.json()),
      ]);
      setScorers(sRes.scorers ?? []);
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
        temperature: 0,
        judge_prompt: DEFAULT_JUDGE_PROMPT,
        max_score: 5,
      },
    ]);
  };

  const remove = (i: number) => {
    setScorers((prev) => prev.filter((_, idx) => idx !== i));
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    const res = await fetch(apiUrl("/api/scorers"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scorers }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(data.error ?? "Failed to save scorers");
      return;
    }
    setScorers(data.scorers ?? []);
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
              <div className="col-span-1">
                <label className="text-xs text-[var(--muted)] block mb-1">
                  Temp
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={s.temperature}
                  onChange={(e) =>
                    update(i, { temperature: Number(e.target.value) })
                  }
                />
              </div>
              <div className="col-span-1">
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
