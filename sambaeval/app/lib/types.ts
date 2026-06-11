export interface Provider {
  name: string;
  api_url: string;
  api_key: string;
}

export interface ModelConfig {
  name: string;
  temperature: number;
  seed?: number;
  system_prompt: string;
  provider_name: string;
  // Arbitrary extra request kwargs forwarded to the provider (top_p, top_k,
  // max_tokens, stop, etc.). Values are stored already-parsed (numbers,
  // booleans, arrays — not raw strings).
  additional_kwargs?: Record<string, unknown>;
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
  temperature: number;
  judge_prompt: string;
  max_score: number;
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

export interface RunOptions {
  concurrency?: number;
}

export interface RunProgress {
  total: number;
  completed: number;
  current?: string;
}

export interface RunMeta {
  run_id: string;
  // "interrupted" = the executing process died (crash / restart) while the run
  // was still "running"; detected and finalized lazily by the backend.
  status: "running" | "completed" | "aborted" | "interrupted";
  started_at: string;
  finished_at: string | null;
  resumed_at: string[];
  total: number;
  completed: number;
  errors: number;
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
