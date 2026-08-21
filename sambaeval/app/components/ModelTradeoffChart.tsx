"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { PriceMap, ResultRow } from "../lib/types";
import { computeCost, priceKey } from "../lib/types";
import { summarize } from "./ResultsTable";

// Categorical palette for model bubbles. Picked to stay distinguishable on the
// light theme; the first entry matches the app accent.
const PALETTE = [
  "#622b86",
  "#2563eb",
  "#15803d",
  "#b45309",
  "#0891b2",
  "#be185d",
  "#4d7c0f",
  "#7c3aed",
  "#0f766e",
  "#9d174d",
];

interface Point {
  key: string;
  provider: string;
  model: string;
  score: number; // 0–100 (%)
  costCents: number; // cents per query
  latencyMs: number | null; // median, may be null
  n: number;
  color: string;
  onFrontier: boolean;
}

// A point is dominated if another point is at least as good on every metric we
// can compare (score ↑, cost ↓, latency ↓) and strictly better on one. Latency
// only counts when both points have it. Points that are dominated by nobody
// form the Pareto frontier — the set worth choosing between.
function markFrontier(points: Point[]): void {
  for (const b of points) {
    b.onFrontier = !points.some((a) => {
      if (a === b) return false;
      const scoreOk = a.score >= b.score;
      const costOk = a.costCents <= b.costCents;
      const haveLat = a.latencyMs !== null && b.latencyMs !== null;
      const latOk = !haveLat || a.latencyMs! <= b.latencyMs!;
      if (!scoreOk || !costOk || !latOk) return false;
      // strictly better on at least one comparable dimension
      const strict =
        a.score > b.score ||
        a.costCents < b.costCents ||
        (haveLat && a.latencyMs! < b.latencyMs!);
      return strict;
    });
  }
}

// Doubling ticks spanning [min, max]: each successive tick is 2× the previous,
// so one gridline step always means "twice the cost". Anchored to a power of
// ten so the values stay round (…, 0.04, 0.08, 0.16, 0.32, …).
function doublingTicks(min: number, max: number): number[] {
  if (!(min > 0) || !(max > 0) || !Number.isFinite(min) || !Number.isFinite(max)) {
    return [];
  }
  let v = Math.pow(10, Math.floor(Math.log10(min)));
  while (v > min) v /= 2;
  const ticks: number[] = [];
  // A cap, not a real limit: min/max are floored to stay well-behaved before
  // this is called, but this backstops any future zero/degenerate input from
  // looping until the array allocation itself throws.
  for (; v <= max * 1.6 && ticks.length < 200; v *= 2) {
    if (v >= min / 1.6) ticks.push(parseFloat(v.toPrecision(3)));
  }
  return ticks;
}

// Cost is carried in cents. Trim trailing zeros so ticks read 0.04¢, 0.08¢, …
function fmtCentTick(v: number): string {
  return `${parseFloat(v.toFixed(3))}¢`;
}

function fmtCentFull(v: number): string {
  return `${parseFloat(v.toFixed(4))}¢`;
}

function TradeoffTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: Point }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-xs shadow-xl">
      <div className="font-semibold" style={{ color: p.color }}>
        {p.model}
      </div>
      <div className="text-[var(--muted)] mb-1">{p.provider}</div>
      <div className="font-mono space-y-0.5">
        <div>score: {p.score.toFixed(1)}%</div>
        <div>cost/query: {fmtCentFull(p.costCents)}</div>
        <div>
          median latency:{" "}
          {p.latencyMs === null ? "—" : `${Math.round(p.latencyMs)} ms`}
        </div>
        <div className="text-[var(--muted)]"># examples: {p.n}</div>
      </div>
      {p.onFrontier && (
        <div className="mt-1 text-[var(--success)]">● on Pareto frontier</div>
      )}
    </div>
  );
}

// Cost / score / latency trade-off scatter for the per-(provider, model)
// aggregates of a run. X = cost per query (log), Y = score (linear, zoomed by
// default), bubble area = median latency. Renders only when at least two priced
// models exist — a trade-off needs something to trade off against.
export function ModelTradeoffChart({
  rows,
  prices = {},
}: {
  rows: ResultRow[];
  prices?: PriceMap;
}) {
  const [fullScale, setFullScale] = useState(false);

  const points = useMemo<Point[]>(() => {
    const pts = summarize(rows)
      .map((s) => {
        const price = prices[priceKey(s.provider, s.model)];
        const totalCost = computeCost(s.inputTokens, s.outputTokens, price);
        if (totalCost === null || s.n === 0) return null;
        return {
          key: `${s.provider} ${s.model}`,
          provider: s.provider,
          model: s.model,
          score: s.totalWeight > 0 ? (s.totalScore * 100) / s.totalWeight : 0,
          costCents: (totalCost / s.n) * 100,
          latencyMs: s.latencyMs,
          n: s.n,
          color: "",
          onFrontier: false,
        } as Point;
      })
      .filter((p): p is Point => p !== null);
    pts.forEach((p, i) => (p.color = PALETTE[i % PALETTE.length]));
    markFrontier(pts);
    return pts;
  }, [rows, prices]);

  // Need at least two priced models for a meaningful trade-off view.
  if (points.length < 2) return null;

  const costs = points.map((p) => p.costCents);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);
  // A $0 cost (e.g. a model whose configured price is {input: 0, output: 0})
  // can't sit on a log scale — floor it to a small fraction of the largest
  // cost so the axis domain and doubling ticks stay well-defined.
  const maxCostSafe = maxCost > 0 ? maxCost : 1;
  const minCostSafe = minCost > 0 ? minCost : maxCostSafe / 1024;
  const costDomain: [number, number] = [minCostSafe / 1.6, maxCostSafe * 1.6];
  const costTicks = doublingTicks(minCostSafe, maxCostSafe);

  const scores = points.map((p) => p.score);
  const yDomain: [number, number] = fullScale
    ? [0, 100]
    : [
        Math.max(0, Math.floor((Math.min(...scores) - 4) / 5) * 5),
        Math.min(100, Math.ceil((Math.max(...scores) + 4) / 5) * 5),
      ];

  const lats = points
    .map((p) => p.latencyMs)
    .filter((v): v is number => v !== null);
  const hasLatency = lats.length > 0;
  // ZAxis maps the latency value linearly to bubble *area* (px²). Points with no
  // latency fall back to the smallest size.
  const zDomain: [number, number] = hasLatency
    ? [Math.min(...lats), Math.max(...lats)]
    : [0, 1];

  // One Scatter per model so each gets its own colour and legend entry; the
  // shared ZAxis sizes every bubble by latency. A final invisible series with
  // `line` draws the frontier curve through the cost-sorted frontier points.
  const frontierLine = [...points]
    .filter((p) => p.onFrontier)
    .sort((a, b) => a.costCents - b.costCents);

  return (
    <div className="bg-[var(--panel)] border border-[var(--border)] rounded-lg p-4">
      <div className="flex items-center justify-between mb-2 gap-4 flex-wrap">
        <p className="text-xs text-[var(--muted)]">
          Bubble size: median latency{hasLatency ? "" : " (n/a)"}. Solid line +
          filled bubbles ={" "}
          <span className="text-[var(--success)]">Pareto frontier</span>; faded
          bubbles are dominated.
        </p>
        <label className="flex items-center gap-1.5 text-xs text-[var(--muted)] whitespace-nowrap cursor-pointer">
          <input
            type="checkbox"
            checked={fullScale}
            onChange={(e) => setFullScale(e.target.checked)}
            className="w-3 h-3"
          />
          Full 0–100% score axis
        </label>
      </div>

      <ResponsiveContainer width="100%" height={380}>
        <ScatterChart margin={{ top: 28, right: 40, bottom: 36, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            type="number"
            dataKey="costCents"
            name="cost/query"
            scale="log"
            domain={costDomain}
            ticks={costTicks}
            tickFormatter={fmtCentTick}
            allowDataOverflow
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            stroke="var(--border)"
            label={{
              value: "cost / query (¢, log₂ scale)",
              position: "bottom",
              offset: 16,
              fill: "var(--muted)",
              fontSize: 12,
            }}
          />
          <YAxis
            type="number"
            dataKey="score"
            name="score"
            domain={yDomain}
            tickFormatter={(v: number) => `${v}%`}
            tick={{ fontSize: 11, fill: "var(--muted)" }}
            stroke="var(--border)"
            label={{
              value: "score",
              angle: -90,
              position: "insideLeft",
              fill: "var(--muted)",
              fontSize: 12,
            }}
          />
          <ZAxis
            type="number"
            dataKey="latencyMs"
            range={[90, 700]}
            domain={zDomain}
            name="median latency"
          />
          <Tooltip
            content={<TradeoffTooltip />}
            cursor={{ strokeDasharray: "3 3", stroke: "var(--border)" }}
          />
          {frontierLine.length > 1 && (
            <Scatter
              data={frontierLine}
              line={{ stroke: "var(--success)", strokeWidth: 1.5 }}
              lineType="joint"
              shape={() => <></>}
              legendType="none"
              isAnimationActive={false}
            />
          )}
          {points.map((p) => (
            <Scatter
              key={p.key}
              name={p.model}
              data={[p]}
              fill={p.color}
              fillOpacity={p.onFrontier ? 0.85 : 0.22}
              stroke={p.color}
              strokeWidth={p.onFrontier ? 1.5 : 1}
              isAnimationActive={false}
            >
              <LabelList
                dataKey="model"
                position="top"
                offset={10}
                fontSize={11}
                fill={p.onFrontier ? p.color : "var(--muted)"}
              />
            </Scatter>
          ))}
        </ScatterChart>
      </ResponsiveContainer>

      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
        {points.map((p) => (
          <span key={p.key} className="flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{
                background: p.color,
                opacity: p.onFrontier ? 0.85 : 0.3,
              }}
            />
            <span className={p.onFrontier ? "" : "text-[var(--muted)]"}>
              {p.model}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
