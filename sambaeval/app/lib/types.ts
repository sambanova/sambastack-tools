export interface Provider {
  name: string;
  api_url: string;
  api_key: string;
}

export interface ModelConfig {
  name: string;
  seed?: number;
  system_prompt: string;
  provider_name: string;
  // Arbitrary extra request kwargs forwarded to the provider (top_p, top_k,
  // max_tokens, stop, etc.). Values are stored already-parsed (numbers,
  // booleans, arrays — not raw strings).
  additional_kwargs?: Record<string, unknown>;
  // Token pricing in USD per 1,000,000 tokens. Display-only: used by the
  // Results cost UI, never sent to the provider. Defaults are pre-filled from
  // the provider's /models pricing when available.
  input_price?: number;
  output_price?: number;
}

export interface HeuristicScorer {
  type: "heuristic";
}

export interface LlmJudgeScorerRef {
  type: "llm";
  scorer_name: string;
}

export type Scorer = HeuristicScorer | LlmJudgeScorerRef;

export interface LlmJudgeScorerDef {
  name: string;
  provider_name: string;
  model: string;
  judge_prompt: string;
  max_score: number;
  // Extra request kwargs forwarded to the judge model (temperature, top_p,
  // max_tokens, …). Stored already-parsed (numbers, booleans, arrays).
  additional_kwargs?: Record<string, unknown>;
}

export interface Experiment {
  id: string;
  name: string;
  models: ModelConfig[];
  system_prompt: string;
  dataset: string;
  scorer?: Scorer;
  output_generator?: string;
  concurrency?: number;
  // Run only the first N examples of the dataset. Omitted → run the whole
  // dataset. Set by the "Run on first N examples" field in the UI when the
  // user lowers it below the dataset's size.
  example_count?: number;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  // Allow tool-use replay through dataset rows; the executor passes these
  // straight through to the OpenAI-compatible client.
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

export interface DatasetRow {
  example_id: number;
  messages: Message[];
  system_prompt?: string | null;
  expected_output: string;
  weight: number;
}

export interface ResultRow {
  result_id: number;
  status: "completed" | "error";
  provider: string;
  model: string;
  example_id: number;
  output: string;
  score: number;
  weight: number;
  score_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  ttft_ms: number | null;
  tps: number | null;
  num_llm_calls: number | null;
}

// One entry in a run's errors.json. `phase` is which stage failed
// ("generation" or "scoring"); `message` is the raw exception text.
export interface RunError {
  phase: string;
  message: string;
}

// A run's errors.json: example_id → "provider/model" → RunError. Keyed exactly
// as the backend writes it (example_id stringified, inner key is the
// provider/model pair so the same model under two providers never collides).
export type RunErrors = Record<string, Record<string, RunError>>;

export interface RunOptions {
  concurrency?: number;
}

export interface RunProgress {
  total: number;
  completed: number;
  current?: string;
}

// Per-(provider, model) token totals for one run, attached by the /runs
// endpoint so the UI can derive a per-run cost from the editable prices.
export interface RunTokenUsage {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export interface RunMeta {
  run_id: string;
  // "interrupted" = the executing process died (crash / restart) while the run
  // was still "running"; detected and finalized lazily by the backend.
  // "paused" = the user gracefully paused the run; it can be resumed later.
  status: "running" | "completed" | "aborted" | "interrupted" | "paused";
  started_at: string;
  finished_at: string | null;
  resumed_at: string[];
  total: number;
  completed: number;
  errors: number;
  // True once another run's results have been merged into this one; such a run
  // resumes/retries by rebuilding from its own rows (see backend RunMeta).
  merged?: boolean;
  token_usage?: RunTokenUsage[];
  // Stable identifier for the dataset this run used (filename, or a content
  // hash for inline datasets). Used to restrict "Merge Results" to runs over
  // the same dataset. Null when the run's snapshot is missing.
  dataset_key?: string | null;
}

// A model's input/output token prices in USD per 1,000,000 tokens, keyed by
// `${provider}|${model}`. Drives the cost columns in the Results tables.
export type PriceMap = Record<string, { input: number; output: number }>;

export function priceKey(provider: string, model: string): string {
  return `${provider}|${model}`;
}

// USD cost for a (input_tokens, output_tokens) pair given a price entry
// (prices are per 1,000,000 tokens). Returns null when no price is known.
export function computeCost(
  inputTokens: number | null,
  outputTokens: number | null,
  price: { input: number; output: number } | undefined,
): number | null {
  if (!price) return null;
  const inTok = inputTokens ?? 0;
  const outTok = outputTokens ?? 0;
  return (inTok / 1_000_000) * price.input + (outTok / 1_000_000) * price.output;
}

// Default judge-prompt template used to prefill a new LLM-judge scorer in the
// UI. The authoritative copy lives in the Python backend
// (backend/sambaeval/scoring.py:DEFAULT_JUDGE_PROMPT); keep them in sync.
export const DEFAULT_JUDGE_PROMPT = `You are an impartial evaluator. Given a user prompt, an expected reference answer, and a model-generated response, decide how well the model response answers the prompt and matches the expected reference.

User prompt:
{prompt}

Expected reference:
{expected_output}

Model response:
{output}

Give an INTEGER score from 0 to {max_score}, where:
- {max_score} = fully correct and aligned with the expected reference, OR functionally / semantically equivalent (trivial whitespace, formatting, or notation differences should not be penalized)
- 0 = completely wrong, unrelated, or refuses to answer
- values in between = graded partial credit

Respond with a single JSON object and NOTHING ELSE, of the form:
{"score": <integer 0..{max_score}>, "score_reason": "<one or two sentences explaining the score>"}`;
