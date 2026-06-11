"use client";
import { apiUrl } from "@/app/lib/api";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Experiment } from "./lib/types";

export default function HomePage() {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const refresh = async () => {
    setLoading(true);
    const res = await fetch(apiUrl("/api/experiments"));
    const data = await res.json();
    setExperiments(data.experiments ?? []);
    setLoading(false);
  };

  useEffect(() => {
    (async () => {
      const res = await fetch(apiUrl("/api/experiments"));
      const data = await res.json();
      setExperiments(data.experiments ?? []);
      setLoading(false);
    })();
  }, []);

  const createNew = async () => {
    setCreating(true);
    const res = await fetch(apiUrl("/api/experiments"), {
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
    if (!confirm(`Delete experiment ${id}?`)) return;
    await fetch(apiUrl(`/api/experiments/${id}`), { method: "DELETE" });
    refresh();
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
                  <td className="px-4 py-3 text-[var(--muted)]">
                    {e.models.length}
                  </td>
                  <td className="px-4 py-3 text-[var(--muted)] font-mono text-xs">
                    {e.dataset || "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => remove(e.id)}
                      className="text-[var(--muted)] hover:text-[var(--danger)] text-xs"
                    >
                      Delete
                    </button>
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
