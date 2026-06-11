"use client";
import { apiUrl } from "@/app/lib/api";

import { useEffect, useState } from "react";
import type { Provider } from "../lib/types";

export default function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch(apiUrl("/api/providers"))
      .then((r) => r.json())
      .then((d) => {
        setProviders(d.providers ?? []);
        setLoading(false);
      });
  }, []);

  const update = (i: number, patch: Partial<Provider>) => {
    setProviders((prev) =>
      prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)),
    );
  };

  const add = () => {
    setProviders((prev) => [
      ...prev,
      { name: "", api_url: "https://api.openai.com/v1", api_key: "" },
    ]);
  };

  const remove = (i: number) => {
    setProviders((prev) => prev.filter((_, idx) => idx !== i));
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    await fetch(apiUrl("/api/providers"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providers }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  if (loading) return <div className="text-[var(--muted)]">Loading…</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Providers</h1>
          <p className="text-[var(--muted)] text-sm mt-1">
            OpenAI-compatible inference endpoints. Used as templates when
            building experiments.
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

      <div className="space-y-3">
        {providers.map((p, i) => (
          <div
            key={i}
            className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-4 grid grid-cols-12 gap-3"
          >
            <div className="col-span-3">
              <label className="text-xs text-[var(--muted)] block mb-1">
                Name
              </label>
              <input
                value={p.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="e.g. sambanova"
              />
            </div>
            <div className="col-span-5">
              <label className="text-xs text-[var(--muted)] block mb-1">
                API URL
              </label>
              <input
                value={p.api_url}
                onChange={(e) => update(i, { api_url: e.target.value })}
                placeholder="https://api.example.com/v1"
              />
            </div>
            <div className="col-span-3">
              <label className="text-xs text-[var(--muted)] block mb-1">
                API Key
              </label>
              <input
                type="password"
                value={p.api_key}
                onChange={(e) => update(i, { api_key: e.target.value })}
                placeholder="sk-..."
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
        ))}
        <button
          onClick={add}
          className="w-full border border-dashed border-[var(--border)] rounded-lg py-3 text-[var(--muted)] hover:text-[var(--accent)] hover:border-[var(--accent)]"
        >
          + Add Provider
        </button>
      </div>
    </div>
  );
}
