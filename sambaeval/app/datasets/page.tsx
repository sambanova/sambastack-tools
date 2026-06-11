"use client";
import { apiUrl } from "@/app/lib/api";

import { useEffect, useRef, useState } from "react";
import InfoTooltip from "@/app/components/InfoTooltip";

type Mode = "choose" | "create" | "upload";

interface DatasetRow {
  prompt: string;
  expected_output: string;
  weight: string;
}

const PROMPT_TOOLTIP =
  'Plain text is saved as a "prompt" field. To provide a multi-turn conversation, paste a JSON array of {role, content} objects (e.g. [{"role":"user","content":"Hi"},{"role":"assistant","content":"Hello"}]) — it will be detected and saved as a "messages" field instead.';

const EXPECTED_OUTPUT_TOOLTIP =
  'Heuristic: by default, the scorer requires an exact match. Prefix the value with "contains:" (e.g. "contains:Paris") to score it as a substring match instead.\n\nLLM-as-a-judge: compares generated outputs with these expected outputs based on the judging prompt.';

const WEIGHT_TOOLTIP =
  "Score multiplier, defaults to 1. The heuristic scorer returns weight on a hit; the LLM judge multiplies its normalized score by weight.\n\nUse it to:\n\n(a) Stress the relative importance of examples in the final score — e.g. weight a critical regression case at 5.0 and trivia at 0.5.\n\n(b) Combine multiple contains: checks for a single logical example by splitting it across several rows with partial weights — e.g. two rows with weight 0.5 each, one asserting contains:Paris and one asserting contains:France, sum to a max of 1.0 only when both substrings appear.";

const DEFAULT_ROW_COUNT = 5;

const emptyRow = (): DatasetRow => ({
  prompt: "",
  expected_output: "",
  weight: "1",
});

function detectMessages(prompt: string): unknown[] | null {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const valid = parsed.every(
      (m) =>
        m !== null &&
        typeof m === "object" &&
        "role" in m &&
        "content" in m,
    );
    return valid ? parsed : null;
  } catch {
    return null;
  }
}

function rowIsComplete(r: DatasetRow): boolean {
  return r.prompt.trim() !== "" && r.expected_output.trim() !== "";
}

export default function DatasetsPage() {
  const [datasets, setDatasets] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>("choose");
  const [name, setName] = useState("");
  const [rows, setRows] = useState<DatasetRow[]>(() =>
    Array.from({ length: DEFAULT_ROW_COUNT }, emptyRow),
  );
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    setLoading(true);
    const res = await fetch(apiUrl("/api/datasets"));
    const data = await res.json();
    setDatasets(data.datasets ?? []);
    setLoading(false);
  };

  useEffect(() => {
    (async () => {
      const res = await fetch(apiUrl("/api/datasets"));
      const data = await res.json();
      setDatasets(data.datasets ?? []);
      setLoading(false);
    })();
  }, []);

  const updateRow = (
    i: number,
    field: keyof DatasetRow,
    value: string,
  ) => {
    setRows((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)),
    );
  };

  const addRow = () => setRows((prev) => [...prev, emptyRow()]);

  const removeRow = (i: number) =>
    setRows((prev) => prev.filter((_, idx) => idx !== i));

  const resetCreate = () => {
    setName("");
    setRows(Array.from({ length: DEFAULT_ROW_COUNT }, emptyRow));
  };

  const resolveName = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const lower = trimmed.toLowerCase();
    if (lower.endsWith(".jsonl")) return trimmed;
    const dotIdx = trimmed.lastIndexOf(".");
    if (dotIdx > 0 && dotIdx < trimmed.length - 1) {
      // Some other extension was supplied — reject.
      return null;
    }
    return `${trimmed}.jsonl`;
  };

  const saveCreated = async () => {
    const completed = rows.filter(rowIsComplete);
    if (completed.length === 0) return;
    const finalName = resolveName(name);
    if (!finalName) {
      alert("Dataset name must be non-empty and (if it has an extension) end in .jsonl");
      return;
    }
    const lines = completed.map((r, idx) => {
      const obj: Record<string, unknown> = { example_id: idx + 1 };
      const messages = detectMessages(r.prompt);
      if (messages) {
        obj.messages = messages;
      } else {
        obj.prompt = r.prompt;
      }
      obj.expected_output = r.expected_output;
      const raw = r.weight.trim();
      const w = raw === "" ? 1 : parseFloat(raw);
      if (!Number.isNaN(w)) obj.weight = w;
      return JSON.stringify(obj);
    });
    const content = lines.join("\n") + "\n";
    setSaving(true);
    await fetch(apiUrl("/api/datasets"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: finalName, content }),
    });
    setSaving(false);
    resetCreate();
    setMode("choose");
    refresh();
  };

  const uploadFile = async (file: File) => {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".csv") && !lower.endsWith(".jsonl")) {
      alert("File must end with .csv or .jsonl");
      return;
    }
    setSaving(true);
    const text = await file.text();
    await fetch(apiUrl("/api/datasets"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: file.name, content: text }),
    });
    setSaving(false);
    setMode("choose");
    refresh();
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const remove = async (n: string) => {
    if (!confirm(`Delete dataset ${n}?`)) return;
    await fetch(apiUrl(`/api/datasets?name=${encodeURIComponent(n)}`), {
      method: "DELETE",
    });
    refresh();
  };

  const hasCompleteRow = rows.some(rowIsComplete);
  const canSave = !saving && name.trim() !== "" && hasCompleteRow;

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Datasets</h1>

      {mode === "choose" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          <button
            onClick={() => setMode("create")}
            className="text-left bg-[var(--panel)] border border-[var(--border)] rounded-lg p-6 hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] transition-colors"
          >
            <h2 className="text-base font-semibold mb-1">Create new</h2>
            <p className="text-sm text-[var(--muted)]">
              Fill in a table of prompts and expected outputs; saves as a
              JSONL dataset.
            </p>
          </button>
          <button
            onClick={() => setMode("upload")}
            className="text-left bg-[var(--panel)] border border-[var(--border)] rounded-lg p-6 hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] transition-colors"
          >
            <h2 className="text-base font-semibold mb-1">Upload existing</h2>
            <p className="text-sm text-[var(--muted)]">
              Upload a .csv or .jsonl file from your computer.
            </p>
          </button>
        </div>
      )}

      {mode === "upload" && (
        <div className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-6 mb-6">
          <button
            onClick={() => setMode("choose")}
            className="text-[var(--muted)] text-sm hover:text-[var(--accent)] mb-4"
          >
            ← Back
          </button>
          <div className="flex flex-col items-center text-center py-6">
            <p className="text-sm text-[var(--muted)] mb-4">
              Select a .csv or .jsonl file from your computer to add it as a
              dataset. The file&apos;s name becomes the dataset name.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.jsonl"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadFile(f);
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={saving}
              className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md font-medium disabled:opacity-50"
            >
              {saving ? "Uploading..." : "Choose dataset file"}
            </button>
          </div>
        </div>
      )}

      {mode === "create" && (
        <div className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-4 mb-6">
          <button
            onClick={() => {
              resetCreate();
              setMode("choose");
            }}
            className="text-[var(--muted)] text-sm hover:text-[var(--accent)] mb-4"
          >
            ← Back
          </button>
          <div className="grid grid-cols-12 gap-3 mb-4">
            <div className="col-span-6">
              <label className="text-xs text-[var(--muted)] block mb-1">
                Dataset name (saved as .jsonl)
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my_eval"
              />
            </div>
          </div>

          <div className="overflow-x-auto border border-[var(--border)] rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[var(--panel-2)] text-left text-xs uppercase tracking-wider text-[var(--muted)]">
                  <th className="px-3 py-2 w-20 font-medium">Example ID</th>
                  <th className="px-3 py-2 font-medium">
                    Prompt
                    <InfoTooltip text={PROMPT_TOOLTIP} />
                  </th>
                  <th className="px-3 py-2 font-medium">
                    Expected Output
                    <InfoTooltip text={EXPECTED_OUTPUT_TOOLTIP} />
                  </th>
                  <th className="px-3 py-2 w-24 font-medium">
                    Weight
                    <InfoTooltip
                      align="right"
                      widthClass="w-[28rem]"
                      text={WEIGHT_TOOLTIP}
                    />
                  </th>
                  <th className="px-2 py-2 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={i}
                    className="border-t border-[var(--border)] align-top"
                  >
                    <td className="px-3 py-2 text-sm text-[var(--muted)] font-mono">
                      {i + 1}
                    </td>
                    <td className="p-1">
                      <textarea
                        value={r.prompt}
                        onChange={(e) =>
                          updateRow(i, "prompt", e.target.value)
                        }
                        rows={2}
                        placeholder="Prompt text or JSON messages array"
                      />
                    </td>
                    <td className="p-1">
                      <textarea
                        value={r.expected_output}
                        onChange={(e) =>
                          updateRow(i, "expected_output", e.target.value)
                        }
                        rows={2}
                        placeholder="Expected output"
                      />
                    </td>
                    <td className="p-1">
                      <input
                        value={r.weight}
                        onChange={(e) =>
                          updateRow(i, "weight", e.target.value)
                        }
                        inputMode="decimal"
                      />
                    </td>
                    <td className="px-2 py-2 text-center">
                      <button
                        onClick={() => removeRow(i)}
                        aria-label="Remove row"
                        title="Remove row"
                        className="text-[var(--muted)] hover:text-[var(--danger)] text-sm leading-none"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-3 py-6 text-center text-sm text-[var(--muted)]"
                    >
                      No rows. Click &quot;Add row&quot; to start.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center justify-between">
            <button
              onClick={addRow}
              className="bg-[var(--panel-2)] border border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent)] px-3 py-1.5 rounded-md text-sm"
            >
              + Add row
            </button>
            <button
              onClick={saveCreated}
              disabled={!canSave}
              className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-4 py-2 rounded-md font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : "Save Dataset"}
            </button>
          </div>
        </div>
      )}

      <h2 className="font-medium mb-3">Available datasets</h2>
      {loading ? (
        <div className="text-[var(--muted)]">Loading…</div>
      ) : datasets.length === 0 ? (
        <div className="text-[var(--muted)] text-sm">No datasets yet.</div>
      ) : (
        <ul className="bg-[var(--panel)] border border-[var(--border)] rounded-lg divide-y divide-[var(--border)]">
          {datasets.map((d) => (
            <li
              key={d}
              className="flex items-center justify-between px-4 py-3"
            >
              <span className="font-mono text-sm">{d}</span>
              <div className="flex items-center gap-4">
                <a
                  href={apiUrl(`/api/datasets?name=${encodeURIComponent(d)}`)}
                  className="text-[var(--accent)] hover:text-[var(--accent-hover)] text-xs"
                >
                  Download
                </a>
                <button
                  onClick={() => remove(d)}
                  className="text-[var(--muted)] hover:text-[var(--danger)] text-xs"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
