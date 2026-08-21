"use client";
import { apiFetch } from "@/app/lib/api";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Experiment, Visibility } from "./lib/types";

// Experiment-list scopes, mapped 1:1 to the backend's ?scope= param.
type Scope = "mine" | "public" | "shared" | "all";

const SCOPES: { key: Scope; label: string }[] = [
  { key: "mine", label: "My space" },
  { key: "public", label: "Public" },
  { key: "shared", label: "Shared with me" },
  { key: "all", label: "All" },
];

// Small colored pill for an experiment's visibility.
function VisibilityBadge({ visibility }: { visibility?: Visibility }) {
  if (!visibility) return null;
  const label =
    visibility === "public"
      ? "Public"
      : visibility === "link"
        ? "Link"
        : "Private";
  return (
    <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-[var(--accent-soft)] text-[var(--accent)]">
      {label}
    </span>
  );
}

export default function HomePage() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [scope, setScope] = useState<Scope>("mine");

  // Fetch the experiments for a scope. Callers that want the loading spinner
  // (the tab buttons) flip `setLoading(true)` synchronously in their own event
  // handler; here we only clear it once results are in — keeping every setState
  // after an await so this stays effect-safe.
  const load = useCallback(async (s: Scope) => {
    const res = await apiFetch(`/api/experiments?scope=${s}`);
    const data = await res.json();
    setExperiments(data.experiments ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await apiFetch(`/api/experiments?scope=${scope}`);
      const data = await res.json();
      if (cancelled) return;
      setExperiments(data.experiments ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const createNew = async () => {
    setCreating(true);
    const res = await apiFetch("/api/experiments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New experiment" }),
    });
    const data = await res.json();
    setCreating(false);
    if (data.experiment) {
      window.location.href = `/experiments/${data.experiment.id}`;
    }
  };

  const remove = async (id: string) => {
    if (
      !confirm(
        `Are you sure you want to delete the experiment "${id}"? ` +
          "This also deletes all of its runs and results. This action cannot be undone.",
      )
    )
      return;
    await apiFetch(`/api/experiments/${id}`, { method: "DELETE" });
    setLoading(true);
    load(scope);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Experiments</h1>
        <button
          onClick={createNew}
          disabled={creating}
          className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md font-medium disabled:opacity-50"
        >
          {creating ? "Creating..." : "+ New Experiment"}
        </button>
      </div>

      <div className="flex gap-1 mb-6 border-b border-[var(--border)]">
        {SCOPES.map((s) => {
          const active = s.key === scope;
          return (
            <button
              key={s.key}
              onClick={() => {
                if (s.key !== scope) setLoading(true);
                setScope(s.key);
              }}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-transparent text-[var(--muted)] hover:text-[var(--accent)]"
              }`}
              aria-current={active ? "page" : undefined}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="text-[var(--muted)]">Loading…</div>
      ) : experiments.length === 0 ? (
        <div className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-8 text-center">
          <div className="text-[var(--muted)] mb-2">No experiments yet.</div>
          <button
            onClick={createNew}
            className="text-[var(--accent)] hover:text-[var(--accent-hover)]"
          >
            Create your first experiment →
          </button>
        </div>
      ) : (
        <div className="bg-[var(--panel)] border border-[var(--border)] rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--panel-2)] text-left text-[var(--muted)]">
              <tr>
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Visibility</th>
                <th className="px-4 py-3">Models</th>
                <th className="px-4 py-3">Dataset</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {experiments.map((e) => (
                <tr
                  key={e.id}
                  className="border-t border-[var(--border)] hover:bg-[var(--panel-2)]"
                >
                  <td className="px-4 py-3 font-mono">{e.id}</td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/experiments/${e.id}`}
                      className="text-[var(--accent)] hover:text-[var(--accent-hover)]"
                    >
                      {e.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <VisibilityBadge visibility={e.visibility} />
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    {e.models.length}
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)] font-mono text-xs">
                    {Array.isArray(e.dataset)
                      ? `inline (${e.dataset.length} rows)`
                      : e.dataset || "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {e.is_owner !== false && (
                      <button
                        onClick={() => remove(e.id)}
                        className="text-[var(--muted)] hover:text-[var(--danger)] text-xs"
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
