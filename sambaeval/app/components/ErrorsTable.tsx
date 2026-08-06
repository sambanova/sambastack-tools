"use client";

import { useMemo } from "react";
import type { RunErrors } from "../lib/types";

interface FlatError {
  exampleId: string;
  model: string; // "provider/model"
  phase: string;
  message: string;
}

// Flatten the nested errors.json (example_id → provider/model → {phase,
// message}) into one row per (example, model) error, sorted by example_id
// (numeric where possible) then model so the table reads predictably.
function flatten(errors: RunErrors): FlatError[] {
  const out: FlatError[] = [];
  for (const [exampleId, byModel] of Object.entries(errors)) {
    for (const [model, info] of Object.entries(byModel)) {
      out.push({
        exampleId,
        model,
        phase: info?.phase ?? "—",
        message: info?.message ?? "",
      });
    }
  }
  out.sort((a, b) => {
    const an = Number(a.exampleId);
    const bn = Number(b.exampleId);
    const byId =
      Number.isFinite(an) && Number.isFinite(bn)
        ? an - bn
        : a.exampleId.localeCompare(b.exampleId);
    return byId || a.model.localeCompare(b.model);
  });
  return out;
}

// Flattened, read-only view of a run's errors. The error-message column wraps
// so the full text is always visible (no truncation / clamping).
export default function ErrorsTable({ errors }: { errors: RunErrors }) {
  const rows = useMemo(() => flatten(errors), [errors]);
  if (rows.length === 0) return null;

  return (
    <div className="bg-[var(--panel)] border border-[var(--border)] rounded-lg overflow-auto">
      <table className="w-full text-sm">
        <thead className="bg-[var(--panel-2)]">
          <tr className="text-[var(--muted)]">
            <th className="text-left px-3 py-2 border-b border-[var(--border)] whitespace-nowrap">
              Example ID
            </th>
            <th className="text-left px-3 py-2 border-b border-[var(--border)] whitespace-nowrap">
              Model
            </th>
            <th className="text-left px-3 py-2 border-b border-[var(--border)] whitespace-nowrap">
              Phase
            </th>
            <th className="text-left px-3 py-2 border-b border-[var(--border)]">
              Error Message
            </th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map((r) => (
            <tr
              key={`${r.exampleId}|${r.model}`}
              className="border-b border-[var(--border)] align-top"
            >
              <td className="px-3 py-2 whitespace-nowrap">{r.exampleId}</td>
              <td className="px-3 py-2 whitespace-nowrap">{r.model}</td>
              <td className="px-3 py-2 whitespace-nowrap">{r.phase}</td>
              <td className="px-3 py-2 whitespace-pre-wrap break-words text-xs text-[var(--danger)]">
                {r.message}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
