/* eslint-disable @typescript-eslint/no-explicit-any */
declare const process: any;

/**
 * Non-interactive subcommands. `sambawiz` with no arguments still starts the interactive menu (cli.ts);
 * `sambawiz <command> ...` lands here. Every command reuses the same shared generators/validators as the UI.
 *
 * Output: human text by default, `--json` for scripts. Failures print to stderr and set a non-zero exit code.
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { Command } from 'commander';
import type { CheckpointMappingV3, ModelProfilesCache, BatchingConfig } from '../app/types/bundle';
import {
  generateModelBundle,
  getDisplayName,
  getEffectiveBatchingConfig,
  getBatchingConfigUniverse,
  isSpecDecodingProfile,
  type ModelBundleSelection,
} from '../app/utils/bundle-yaml-generator';
import { formatModelRefLatest } from '../app/utils/bundle-yaml-generator';
import { floatPcmToWav, extractErrorMessage, parseSpeechStream } from '../app/utils/speech';
import { inferencePodNames } from '../app/utils/inference-pod-names';
import { validateResourceName, bundleNameLengthWarning } from '../app/utils/resource-names';
import {
  CONFIG_PATH,
  DATA_DIR,
  PROJECT_ROOT,
  toModelCR,
  getArchsWithProfiles,
  getProfilesForArch,
  buildModelDeploymentYaml,
  buildModelBasedDeploymentYaml,
  formatDroppedSelections,
  withCheckpointOverrides,
  readCheckpointOverrides,
  bundleValidationOutcome,
  printValidationErrors,
  printMemoryUtilization,
  generateCheckpointMapping,
  cacheSourceStatus,
  generatePefConfigs,
  getDeploymentStatus,
  deploymentStatuses,
  parsePodLine,
  getAppVersion,
  profileHasPromptCachingOnCluster,
  kubectlErrorDetail,
  maskApiKey,
  getOutdatedHelmChartWarning,
} from './cli';

class CliError extends Error {}
const fail = (msg: string): never => { throw new CliError(msg); };

/** Resource names reach `kubectl` via a shell, so every user-supplied name is checked against the RFC 1123 rule first. */
export function assertName(label: string, name: string): string {
  const err = validateResourceName(name);
  return err ? fail(`Invalid ${label} "${name}": ${err}`) : name;
}

/** Environment names become file names (kubeconfigs/<name>.yaml): no path separators or whitespace. */
export function assertEnvName(name: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : fail(`Invalid environment name "${name}": use letters, digits, ".", "_" and "-", starting with a letter or digit.`);
}

export function posInt(label: string, v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fail(`${label} must be a positive integer (got "${v}").`);
}

// ─── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** `<model>:<profile>[:<arch>]` → parts. Model display names contain no colons. */
export function parseModelSpec(spec: string): { model: string; profile: string; arch?: string } {
  const [model, profile, arch, ...rest] = spec.split(':');
  if (!model || !profile || rest.length) fail(`Invalid --model "${spec}". Expected <model>:<profile>[:<arch>].`);
  return { model, profile, arch: arch || undefined };
}

/** `<model>:<context>=<sizes>` (sizes comma-separated, or `*`) → parts. */
export function parseBatchSpec(spec: string): { model: string; tier: string; sizes: number[] | '*' } {
  const m = spec.match(/^([^:]+):([^=]+)=(.+)$/);
  if (!m) return fail(`Invalid --batch "${spec}". Expected <model>:<context>=<sizes>, e.g. Llama:32k=1,2,4`);
  const sizes = m[3].trim() === '*' ? '*' : m[3].split(',').map((s) => Number(s.trim()));
  if (sizes !== '*' && sizes.some((n) => !Number.isInteger(n) || n <= 0)) fail(`Invalid batch sizes in --batch "${spec}".`);
  return { model: m[1], tier: m[2], sizes: sizes as number[] | '*' };
}

/** Case-insensitive match on display name or profile metadata name. */
function findByName<T>(items: T[], names: (t: T) => string[], wanted: string): T | undefined {
  const w = wanted.toLowerCase();
  return items.find((i) => names(i).some((n) => n.toLowerCase() === w));
}

export interface BuildInput {
  models: string[];
  batch?: string[];
  nonSwappable?: string[];
  draft?: string[]; // "<target>=<draftModel>:<profile>[:<arch>]"
}

/**
 * Resolves CLI flags into the same ModelBundleSelection[] the interactive builder produces, applying the
 * same rules: a profile must exist for the arch, batching tiers must be in the profile's universe, a
 * prompt-caching profile is single-model only, and a draft is only valid for a spec-decoding target.
 */
export function buildSelections(
  input: BuildInput,
  mapping: CheckpointMappingV3,
  profiles: ModelProfilesCache
): ModelBundleSelection[] {
  const selections: ModelBundleSelection[] = [];
  const nonSwappable = new Set((input.nonSwappable ?? []).map((n) => n.toLowerCase()));
  const lc = (n: string) => n.toLowerCase();
  const chosen = new Set<string>();
  const batchByModel = new Map<string, Map<string, number[] | '*'>>();
  for (const b of (input.batch ?? []).map(parseBatchSpec)) {
    const k = b.model.toLowerCase();
    if (!batchByModel.has(k)) batchByModel.set(k, new Map());
    batchByModel.get(k)!.set(b.tier, b.sizes);
  }

  const resolve = (modelName: string, profileName: string, archName: string | undefined, isDraftFor?: string) => {
    const display = Object.keys(mapping).find((d) => d.toLowerCase() === modelName.toLowerCase());
    if (!display) return fail(`Unknown model "${modelName}". Run \`models list\`.`);
    const model = toModelCR(display, mapping[display]);
    const archs = getArchsWithProfiles(model.spec.checkpoints, profiles);
    if (archs.length === 0) fail(`No matching profile for ${display}; it cannot be added to a bundle.`);
    if (archArgNeeded(archs, archName)) fail(`${display} has several archs (${archs.join(', ')}); give one as <model>:<profile>:<arch>.`);
    const arch = archName ?? archs[0];
    if (!archs.includes(arch)) fail(`${display} has no profile for arch "${arch}" (available: ${archs.join(', ')}).`);
    const archProfiles = getProfilesForArch(arch, profiles);
    const profile = findByName(archProfiles, (p) => [p.metadata.name, getDisplayName(p, archProfiles)], profileName);
    if (!profile) return fail(`Unknown profile "${profileName}" for ${display}/${arch}. Available: ${archProfiles.map((p) => p.metadata.name).join(', ')}`);

    // --batch overrides: tiers must exist in the profile's universe; unspecified tiers keep the effective config.
    let batchingConfigOverride: BatchingConfig | undefined;
    const wanted = batchByModel.get(display.toLowerCase());
    if (wanted && !isDraftFor) {
      const universe = getBatchingConfigUniverse(profile);
      const effective = getEffectiveBatchingConfig(profile);
      batchingConfigOverride = { ...effective };
      for (const [tier, sizes] of wanted) {
        if (!universe[tier]) fail(`${display}: context "${tier}" not in this profile (available: ${Object.keys(universe).join(', ')}).`);
        const allowed = universe[tier].batch_sizes;
        if (sizes !== '*' && Array.isArray(allowed)) {
          const bad = sizes.filter((s) => !allowed.includes(s));
          if (bad.length) fail(`${display} ${tier}: batch size(s) ${bad.join(',')} not supported (allowed: ${allowed.join(',')}).`);
        }
        batchingConfigOverride[tier] = { batch_sizes: sizes };
      }
    }
    return {
      model, arch, profile, batchingConfigOverride,
      swappable: !nonSwappable.has(display.toLowerCase()),
      ...(isDraftFor ? { isDraftFor } : {}),
    } as ModelBundleSelection;
  };

  for (const spec of input.models.map(parseModelSpec)) {
    if (chosen.has(lc(spec.model))) fail(`Model "${spec.model}" is listed more than once.`);
    chosen.add(lc(spec.model));
    selections.push(resolve(spec.model, spec.profile, spec.arch));
  }
  if (selections.length === 0) fail('At least one --model is required.');
  for (const n of nonSwappable) if (!chosen.has(n)) fail(`--non-swappable "${n}" is not one of the --model entries.`);
  for (const k of batchByModel.keys()) if (!chosen.has(k)) fail(`--batch refers to "${k}", which is not one of the --model entries.`);

  const hasCaching = (s: ModelBundleSelection) => s.profile.spec.features?.includes('prompt_caching');
  if (selections.length > 1 && selections.some(hasCaching)) {
    fail('Prompt-caching profiles can only be deployed as a single-model bundle.');
  }

  for (const d of input.draft ?? []) {
    const [target, rest] = d.split('=');
    if (!target || !rest) fail(`Invalid --draft "${d}". Expected <target>=<draftModel>:<profile>[:<arch>].`);
    const t = selections.find((s) => s.model.spec.name.toLowerCase() === target.toLowerCase() && !s.isDraftFor);
    if (!t) fail(`--draft target "${target}" is not one of the --model entries.`);
    if (!isSpecDecodingProfile(t!.profile)) fail(`--draft: ${target}'s profile is not a speculative-decoding profile, so it cannot take a draft model.`);
    if (selections.some((x) => x.isDraftFor === t!.model.metadata.name)) fail(`--draft: ${target} already has a draft model.`);
    const spec = parseModelSpec(rest);
    if (chosen.has(lc(spec.model))) fail(`Draft model "${spec.model}" is already a --model entry.`);
    selections.push(resolve(spec.model, spec.profile, spec.arch, t!.model.metadata.name));
  }
  return selections;
}

function archArgNeeded(archs: string[], archName?: string): boolean {
  return archs.length > 1 && !archName;
}

// ─── Environment / output plumbing ───────────────────────────────────────────

interface Ctx { env: string; kubeconfig: string; namespace: string; json: boolean; ec?: any }

function loadAppConfig(): any {
  if (!existsSync(CONFIG_PATH)) fail('app-config.json not found. Run `sambawiz` once (interactive) to create it.');
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

/** Resolves the target env and points kubectl at its kubeconfig explicitly (never the ambient context). */
function resolveCtx(opts: any): Ctx {
  const cfg = loadAppConfig();
  const env = opts.env || cfg.currentKubeconfig;
  const ec = cfg.kubeconfigs?.[env];
  if (!ec) fail(`Environment "${env}" is not in app-config.json. Run \`env list\`.`);
  const kubeconfig = path.isAbsolute(ec.file) ? ec.file : path.join(PROJECT_ROOT, ec.file);
  if (!existsSync(kubeconfig)) fail(`Kubeconfig not found: ${kubeconfig}`);
  process.env.KUBECONFIG = kubeconfig;
  const namespace = assertName('namespace', opts.namespace || ec.namespace || 'default');
  return { env, kubeconfig, namespace, json: Boolean(opts.json), ec };
}

function print(ctx: { json: boolean }, data: unknown, human: () => void) {
  if (ctx.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else human();
}

const say = (s = '') => process.stdout.write(s + '\n');
const kubectl = (args: string, input?: string) =>
  execSync(`kubectl ${args}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...(input ? { input } : {}) });

/**
 * The cached model data must come from the cluster being targeted: building from another cluster's models, profiles
 * and checkpoint versions and applying it here would be wrong without any sign of it. A cache with no (or an outdated)
 * stamp — e.g. written by the web UI — can't be checked, so that only warns.
 */
function assertCacheMatches(ctx: Ctx): void {
  const r = cacheSourceStatus(ctx.kubeconfig, ctx.namespace);
  if (r.status === 'mismatch') {
    fail(`The cached model data was generated for ${r.from}, not for environment "${ctx.env}" (namespace ${ctx.namespace}). Run \`data refresh --env ${ctx.env}\` first.`);
  }
  if (r.status === 'unknown') {
    process.stderr.write(`warning: can't tell which cluster the cached model data came from; run \`data refresh --env ${ctx.env}\` if it may be for another environment.\n`);
  }
}

function readCache(): { mapping: CheckpointMappingV3; profiles: ModelProfilesCache } {
  const mp = path.join(DATA_DIR, 'checkpoint_mapping.json');
  const pp = path.join(DATA_DIR, 'model_profiles.json');
  if (!existsSync(mp) || !existsSync(pp)) fail('Model data not generated yet. Run `sambawiz data refresh`.');
  return { mapping: JSON.parse(readFileSync(mp, 'utf-8')), profiles: JSON.parse(readFileSync(pp, 'utf-8')) };
}

function applyYaml(ctx: Ctx, yamlText: string): string {
  try {
    return kubectl(`apply -n ${ctx.namespace} -f -`, yamlText).trim();
  } catch (e: any) {
    return fail(`kubectl apply failed: ${kubectlErrorDetail(e)}`);
  }
}

/** Same gate as the UI (which disables its pages): refuse cluster changes when the SambaStack chart is too old. */
function assertChartOk(ctx: Ctx): void {
  const warn = getOutdatedHelmChartWarning(ctx.kubeconfig, ctx.namespace);
  if (warn) fail(warn);
}

/** Polls a ModelBundle until its Valid condition resolves. Returns true if valid. */
/** kubectl says the resource doesn't exist (yet). Anything else is a real error. */
function isNotFound(e: any): boolean {
  return /NotFound|not found/i.test(String(e?.stderr ?? e?.message ?? ''));
}

async function waitForValidation(ctx: Ctx, name: string, timeoutSec: number): Promise<boolean> {
  assertName('bundle name', name);
  const start = Date.now();
  while ((Date.now() - start) / 1000 < timeoutSec) {
    let st: any = null;
    try {
      st = JSON.parse(kubectl(`get modelbundle.sambanova.ai ${name} -n ${ctx.namespace} -o json`));
    } catch (e: any) {
      // Only "not there yet" is worth retrying; a typo'd name's RBAC denial or an unreachable cluster fails right away with the real error.
      if (!isNotFound(e)) fail(`kubectl get modelbundle failed: ${kubectlErrorDetail(e)}`);
    }
    // `bundleValidationOutcome` ignores a verdict about an older generation of the bundle (a re-apply of an already-valid one).
    const outcome = st ? bundleValidationOutcome(st) : 'pending';
    if (outcome === 'succeeded') { if (!ctx.json) printMemoryUtilization(st.status?.legalizerInfo); return true; }
    if (outcome === 'failed') {
      if (!ctx.json) { printValidationErrors(st.status?.conditions || [], st.status?.legalizerInfo); printMemoryUtilization(st.status?.legalizerInfo); }
      else process.stderr.write(JSON.stringify({ validation: 'failed', conditions: st.status?.conditions, legalizerInfo: st.status?.legalizerInfo }) + '\n');
      return false;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return fail(`Timed out after ${timeoutSec}s waiting for bundle "${name}" validation.`);
}


/** Base URL for the OpenAI-compatible API, same normalisation as the Playground menu. */
export function apiBase(apiDomain: string): string {
  const b = apiDomain.replace(/\/v1\/chat\/completions\/?$/, '');
  return b.endsWith('/') ? b : b + '/';
}

const API_TIMEOUT_MS = 120_000;

/** fetch with a timeout and a readable message for network failures (instead of a bare "fetch failed"). */
async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  } catch (e: any) {
    const reason = e?.name === 'TimeoutError' ? `timed out after ${API_TIMEOUT_MS / 1000}s` : e?.cause?.message || e?.message || 'unknown error';
    return fail(`Cannot reach the API at ${url}: ${reason}`);
  }
}

async function apiCall(ctx: Ctx, route: string, body?: unknown): Promise<any> {
  if (!ctx.ec?.apiDomain || !ctx.ec?.apiKey) fail('apiDomain and apiKey must be configured for this environment in app-config.json.');
  const res = await safeFetch(`${apiBase(ctx.ec.apiDomain)}${route}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${ctx.ec.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      const k: string = ctx.ec.apiKey;
      fail(`API error ${res.status}: the server rejected the API key (${maskApiKey(k)}). Update it in app-config.json (\`env set-api-key\`). Note /v1/models is public, so \`api-models\` working does not prove the key is valid.`);
    }
    let detail = text.trim();
    try { const e = JSON.parse(text); detail = e.error?.message || e.detail || e.message || detail; } catch { /* raw body */ }
    fail(`API error ${res.status}: ${detail}`);
  }
  return JSON.parse(text);
}


const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
export function imageDataUrl(file: string): string {
  const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
  if (!type) fail(`Unsupported image type: ${file} (png, jpg, gif, webp).`);
  if (!existsSync(file)) fail(`Image not found: ${file}`);
  return `data:${type};base64,${readFileSync(file).toString('base64')}`;
}

// The transcription endpoint caps uploads at 25 MB (same as the UI route/Playground).
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const stripThink = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();


/** Same completion markers as the interactive installer: 1.x ends at configure_default_ingress, 2.x at create_keycloak_user. */
export function installComplete(lines: string[]): boolean {
  const last = lines[lines.length - 1] || '';
  return last.includes('configure_default_ingress') || lines.some((l) => l.includes('create_keycloak_user') && /already exists|created/i.test(l));
}

async function followInstallLogs(ctx: Ctx, timeoutSec: number): Promise<boolean> {
  const start = Date.now();
  let shown = '';
  while ((Date.now() - start) / 1000 < timeoutSec) {
    try {
      const logs = kubectl(`-n ${ctx.namespace} logs -l sambastack-installer=true --tail=20`).trim();
      if (logs !== shown) { say(logs); shown = logs; }
      if (installComplete(logs.split('\n'))) { say('SambaStack installation complete.'); return true; }
    } catch { /* installer pod not up yet */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  process.stderr.write(`Timed out after ${timeoutSec}s waiting for the installer.\n`);
  return false;
}

/** Reads a secret without echoing it: a hidden prompt on a terminal, otherwise everything piped on stdin. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return readFileSync(0, 'utf-8').trim();
  process.stderr.write(prompt);
  return new Promise((resolve, reject) => {
    let buf = '';
    const stdin = process.stdin;
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const done = (fn: () => void) => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stderr.write('\n'); fn(); };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(buf.trim()));
        if (ch === '\u0003') return done(() => reject(new CliError('Cancelled.')));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// ─── Command tree ────────────────────────────────────────────────────────────

export function buildProgram(): Command {
  const program = new Command('sambawiz')
    .description('SambaWiz CLI. Run with no arguments for the interactive menu.')
    .version(getAppVersion() || '0.0.0')
    .showHelpAfterError();
  const common = (c: Command) =>
    c.option('--env <name>', 'environment from app-config.json (default: current)')
      .option('-n, --namespace <ns>', 'override the environment\'s namespace')
      .option('--json', 'machine-readable output');

  // env
  const env = program.command('env').description('Manage environments (app-config.json)');
  env.command('list').description('List configured environments').option('--json', 'JSON output').action((o) => {
    const cfg = loadAppConfig();
    const rows = Object.entries<any>(cfg.kubeconfigs || {}).map(([name, e]) => ({
      name, current: name === cfg.currentKubeconfig, kubeconfig: e.file, namespace: e.namespace || 'default',
    }));
    print(o, rows, () => rows.forEach((r) => say(`${r.current ? '*' : ' '} ${r.name}  ns=${r.namespace}  ${r.kubeconfig}`)));
  });
  env.command('use <name>').description('Make an environment current').action((name) => {
    assertEnvName(name);
    const cfg = loadAppConfig();
    if (!cfg.kubeconfigs?.[name]) fail(`Environment "${name}" not found.`);
    cfg.currentKubeconfig = name;
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
    say(`Current environment: ${name}`);
  });

  // data
  const data = program.command('data').description('Cluster-derived model data');
  common(data.command('refresh').description('Regenerate checkpoint mapping, model profiles and PEF configs from the cluster'))
    .action(async (o) => {
      const ctx = resolveCtx(o);
      const ck = await generateCheckpointMapping(ctx.kubeconfig, ctx.namespace, !ctx.json, true);
      const pef = await generatePefConfigs(ctx.kubeconfig, ctx.namespace, !ctx.json);
      print(ctx, { models: ck.count, pefConfigs: pef.count }, () => say(`Done: ${ck.count} models, ${pef.count} PEF configs.`));
    });

  // models
  const models = program.command('models').description('Browse models and profiles (from `data refresh` cache)');
  models.command('list').description('List models with their archs').option('--json', 'JSON output').action((o) => {
    const { mapping, profiles } = readCache();
    const rows = Object.keys(mapping).sort().map((name) => {
      const archs = getArchsWithProfiles(mapping[name].checkpoints, profiles);
      return { model: name, archs, capabilities: mapping[name].capabilities, deployable: archs.length > 0 };
    });
    print(o, rows, () => rows.forEach((r) => say(`${r.model.padEnd(42)} ${r.deployable ? r.archs.join(',') : '(no matching profile)'}`)));
  });
  models.command('profiles <model>').description('List profiles and batching configs for a model')
    .option('--arch <arch>', 'checkpoint arch').option('--json', 'JSON output').action((name, o) => {
      const { mapping, profiles } = readCache();
      const display = Object.keys(mapping).find((d) => d.toLowerCase() === name.toLowerCase());
      if (!display) fail(`Unknown model "${name}".`);
      const archs = getArchsWithProfiles(mapping[display!].checkpoints, profiles).filter((a) => !o.arch || a === o.arch);
      const rows = archs.flatMap((arch) => {
        const ps = getProfilesForArch(arch, profiles);
        return ps.map((p) => ({
          arch, profile: p.metadata.name, label: getDisplayName(p, ps), features: p.spec.features,
          recommended: getEffectiveBatchingConfig(p), all: getBatchingConfigUniverse(p),
        }));
      });
      print(o, rows, () => rows.forEach((r) => {
        say(`${r.arch}  ${r.profile}  (${r.label})  features: ${r.features.join(',') || 'default'}`);
        Object.entries(r.all).forEach(([t, v]: any) => say(`    ${t}: ${JSON.stringify(v.batch_sizes)}`));
      }));
    });

  // bundle
  const bundle = program.command('bundle').description('ModelBundles');
  common(bundle.command('build').description('Generate (and optionally apply + validate) a ModelBundle')
    .requiredOption('--name <name>', 'bundle name')
    .requiredOption('--model <spec...>', '<model>:<profile>[:<arch>] (repeatable)')
    .option('--batch <spec...>', '<model>:<context>=<sizes|*> batching override (repeatable)')
    .option('--non-swappable <model...>', 'keep model resident (swappable: false)')
    .option('--draft <spec...>', '<target>=<draftModel>:<profile>[:<arch>] speculative-decoding draft')
    .option('-o, --out <file>', 'write the YAML to a file')
    .option('--apply', 'apply to the cluster and wait for validation')
    .option('--timeout <sec>', 'validation timeout', '300'))
    .action(async (o) => {
      const nameErr = validateResourceName(o.name);
      if (nameErr) fail(nameErr);
      const warn = bundleNameLengthWarning(o.name);
      if (warn) process.stderr.write(`warning: ${warn}\n`);
      const { mapping, profiles } = readCache();
      const applyCtx = o.apply ? resolveCtx(o) : null;
      if (applyCtx) assertCacheMatches(applyCtx);   // never build for one cluster from another cluster's data
      const sels = buildSelections({ models: o.model, batch: o.batch, nonSwappable: o.nonSwappable, draft: o.draft }, mapping, profiles);
      const overrides = (() => { try { return readCheckpointOverrides(); } catch { return {}; } })();
      const { yaml: text, dropped } = generateModelBundle(o.name, withCheckpointOverrides(sels, overrides));
      formatDroppedSelections(dropped).forEach((l) => process.stderr.write(`warning: ${l}\n`));
      // `dropped` can include draft models, so judge by the non-draft models that are still in the bundle.
      const droppedNames = new Set(dropped.map((d) => d.model));
      if (sels.filter((s) => !s.isDraftFor && !droppedNames.has(s.model.metadata.name)).length === 0) fail('Every selected model was dropped; nothing to build.');
      if (o.out) writeFileSync(o.out, text);
      const ctx = applyCtx ?? ({ json: Boolean(o.json) } as Ctx);
      let valid: boolean | undefined;
      if (o.apply) {
        assertChartOk(ctx);
        applyYaml(ctx, text);
        valid = await waitForValidation(ctx, o.name, posInt('--timeout', o.timeout));
        if (!valid) process.exitCode = 1;
      }
      print(ctx, { name: o.name, yaml: text, dropped, ...(valid === undefined ? {} : { valid }) }, () => {
        if (!o.out) say(text);
        else say(`Wrote ${o.out}`);
        if (valid !== undefined) say(valid ? `Bundle ${o.name} is valid.` : `Bundle ${o.name} failed validation.`);
      });
    });
  common(bundle.command('list').description('List ModelBundles and their validation state')).action((o) => {
    const ctx = resolveCtx(o);
    const items = JSON.parse(kubectl(`get modelbundle.sambanova.ai -n ${ctx.namespace} -o json`)).items || [];
    const rows = items.map((i: any) => ({ name: i.metadata.name, validation: bundleValidationOutcome(i) }));
    print(ctx, rows, () => rows.forEach((r: any) => say(`${r.name.padEnd(40)} ${r.validation}`)));
  });
  common(bundle.command('show <name>').description('Print a ModelBundle as YAML')).action((name, o) => {
    assertName('bundle name', name);
    const ctx = resolveCtx(o);
    say(kubectl(`get modelbundle.sambanova.ai ${name} -n ${ctx.namespace} -o yaml`));
  });
  common(bundle.command('apply').description('Apply a ModelBundle YAML file and wait for validation')
    .requiredOption('-f, --file <file>', 'YAML file').option('--timeout <sec>', 'validation timeout', '300')).action(async (o) => {
      const ctx = resolveCtx(o);
      const text = readFileSync(o.file, 'utf-8');
      const doc: any = (await import('js-yaml')).default.load(text);
      if (doc?.kind !== 'ModelBundle' || !doc?.metadata?.name) fail('File is not a ModelBundle.');
      const nameErr = validateResourceName(doc.metadata.name);
      if (nameErr) fail(nameErr);
      assertChartOk(ctx);
      applyYaml(ctx, text);
      const ok = await waitForValidation(ctx, doc.metadata.name, posInt('--timeout', o.timeout));
      if (!ok) process.exitCode = 1;
      print(ctx, { name: doc.metadata.name, valid: ok }, () => say(ok ? `Bundle ${doc.metadata.name} is valid.` : `Bundle ${doc.metadata.name} failed validation.`));
    });
  common(bundle.command('validate <name>').description('Wait for/print the validation result of an applied bundle')
    .option('--timeout <sec>', 'timeout', '300')).action(async (name, o) => {
      const ctx = resolveCtx(o);
      const ok = await waitForValidation(ctx, name, posInt('--timeout', o.timeout));
      if (!ok) process.exitCode = 1;
      print(ctx, { name, valid: ok }, () => say(ok ? `Bundle ${name} is valid.` : `Bundle ${name} failed validation.`));
    });
  common(bundle.command('delete <name>').description('Delete a ModelBundle').option('-y, --yes', 'skip the confirmation requirement'))
    .action((name, o) => {
      if (!o.yes) fail('Refusing to delete without --yes.');
      assertName('bundle name', name);
      const ctx = resolveCtx(o);
      say(kubectl(`delete modelbundle.sambanova.ai ${name} -n ${ctx.namespace}`).trim());
    });

  // deploy
  const deploy = program.command('deploy').description('ModelDeployments');
  common(deploy.command('create').description('Deploy a validated ModelBundle (--bundle) or a single model + profile (--model)')
    .option('--bundle <name>', 'validated ModelBundle name')
    .option('--model <spec>', 'quick deploy: <model>:<profile>[:<arch>] (inline spec.models, no bundle)')
    .option('--name <name>', 'deployment name (default md-<bundle> / md-<model>)')
    .option('--prompt-caching', 'enable prompt caching (single model whose profile has the prompt_caching feature)')
    .option('--ignore-eos', 'ignore the EOS token (benchmarking)')
    .option('--dry-run', 'print the YAML only')).action((o) => {
      if (!o.bundle === !o.model) fail('Give exactly one of --bundle or --model.');
      if (o.bundle) assertName('bundle name', o.bundle);
      const ctx = resolveCtx(o);
      let built: { yaml: string; deploymentName: string };
      let cachingProfile: string | undefined;
      if (o.bundle) {
        const b = JSON.parse(kubectl(`get modelbundle.sambanova.ai ${o.bundle} -n ${ctx.namespace} -o json`));
        if (bundleValidationOutcome(b) !== 'succeeded') fail(`Bundle "${o.bundle}" is not validated; run \`bundle validate ${o.bundle}\`.`);
        const mc = b.spec?.modelConfigs || [];
        cachingProfile = mc.length === 1 ? mc[0].profile : undefined;
        built = buildModelDeploymentYaml(o.bundle, { deploymentName: o.name, promptCaching: o.promptCaching, ignoreEos: o.ignoreEos });
      } else {
        const { mapping, profiles } = readCache();
        assertCacheMatches(ctx);
        const [sel] = buildSelections({ models: [o.model] }, mapping, profiles);
        const ref = formatModelRefLatest(sel.model, sel.arch, readCheckpointOverrides()[sel.model.spec.name]);
        cachingProfile = sel.profile.metadata.name;
        built = buildModelBasedDeploymentYaml(ref, sel.profile.metadata.name, { deploymentName: o.name, promptCaching: o.promptCaching, ignoreEos: o.ignoreEos });
      }
      const nameErr = validateResourceName(built.deploymentName);
      if (nameErr) fail(nameErr);
      if (o.promptCaching && !(cachingProfile && profileHasPromptCachingOnCluster(cachingProfile, ctx.namespace))) {
        fail('--prompt-caching needs a single model whose profile has the prompt_caching feature.');
      }
      if (o.dryRun) { say(built.yaml); return; }
      assertChartOk(ctx);
      const res = applyYaml(ctx, built.yaml);
      print(ctx, { deployment: built.deploymentName, result: res }, () => say(res));
    });
  common(deploy.command('apply').description('Apply a hand-edited ModelDeployment YAML (e.g. one with a `storage:` block for air-gapped clusters)')
    .requiredOption('-f, --file <file>', 'ModelDeployment YAML')).action(async (o) => {
      const ctx = resolveCtx(o);
      if (!existsSync(o.file)) fail(`File not found: ${o.file}`);
      const text = readFileSync(o.file, 'utf-8');
      const doc: any = (await import('js-yaml')).default.load(text);
      if (doc?.kind !== 'ModelDeployment' || !doc?.metadata?.name) fail('File is not a ModelDeployment with metadata.name.');
      const nameErr = validateResourceName(doc.metadata.name);
      if (nameErr) fail(nameErr);
      assertChartOk(ctx);
      const res = applyYaml(ctx, text);
      print(ctx, { deployment: doc.metadata.name, result: res }, () => say(res));
    });
  common(deploy.command('list').description('List ModelDeployments')).action((o) => {
    const ctx = resolveCtx(o);
    const items = JSON.parse(kubectl(`get modeldeployment.sambanova.ai -n ${ctx.namespace} -o json`)).items || [];
    const statuses = deploymentStatuses(ctx.namespace, items.map((i: any) => i.metadata.name));
    const mapping = existsSync(path.join(DATA_DIR, 'checkpoint_mapping.json')) ? readCache().mapping : {};
    const rows = items.map((i: any) => {
      const crname = String(i.spec?.models?.modelConfigs?.[0]?.model ?? '').split(':')[0];
      const model = crname ? Object.keys(mapping).find((d) => mapping[d].resource_name === crname) ?? crname : null;
      return { name: i.metadata.name, bundle: i.spec?.bundle || null, model };
    }).map((r: any) => ({ ...r, status: statuses[r.name] }));
    print(ctx, rows, () => rows.forEach((r: any) => say(`${r.name.padEnd(40)} ${(r.bundle ? `bundle:${r.bundle}` : `model:${r.model ?? ''}`).padEnd(40)} ${r.status}`)));
  });
  common(deploy.command('status <name>').description('Pod readiness of a deployment (exit 1 if not fully Deployed)')).action((name, o) => {
    assertName('deployment name', name);
    const ctx = resolveCtx(o);
    const { cache, default: def } = inferencePodNames(name);
    let cachePod = null, defPod = null;
    try {
      for (const line of kubectl(`-n ${ctx.namespace} get pods`).trim().split('\n')) {
        const p = parsePodLine(line);
        if (p?.name === cache) cachePod = p; else if (p?.name === def) defPod = p;
      }
    } catch (e: any) { fail(`kubectl get pods failed: ${kubectlErrorDetail(e)}`); }
    const status = getDeploymentStatus(cachePod, defPod);
    if (status !== 'Deployed') process.exitCode = 1;
    print(ctx, { name, status, cachePod, inferencePod: defPod }, () => {
      say(status);
      for (const [l, p] of [['cache', cachePod], ['inference', defPod]] as const) {
        say(`  ${l.padEnd(10)} ${p ? `${(p as any).ready}/${(p as any).total} ${(p as any).status}` : 'waiting for pod'}`);
      }
    });
  });
  common(deploy.command('logs <name>').description('Tail pod logs of a deployment')
    .option('--pod <which>', 'cache | inference', 'inference').option('--tail <n>', 'lines', '100')).action((name, o) => {
      assertName('deployment name', name);
      if (!['cache', 'inference'].includes(o.pod)) fail('--pod must be "cache" or "inference".');
      const ctx = resolveCtx(o);
      const { cache, default: def } = inferencePodNames(name);
      const pod = o.pod === 'cache' ? cache : def;
      const container = o.pod === 'cache' ? '' : ' -c inf';
      try { process.stdout.write(kubectl(`logs ${pod} -n ${ctx.namespace}${container} --tail=${posInt('--tail', o.tail)}`)); }
      catch (e: any) { fail(`kubectl logs failed: ${kubectlErrorDetail(e)}`); }
    });
  common(deploy.command('delete <name>').description('Delete a ModelDeployment').option('-y, --yes', 'skip the confirmation requirement'))
    .action((name, o) => {
      if (!o.yes) fail('Refusing to delete without --yes.');
      assertName('deployment name', name);
      const ctx = resolveCtx(o);
      say(kubectl(`delete modeldeployment.sambanova.ai ${name} -n ${ctx.namespace}`).trim());
    });


  // playground
  common(program.command('api-models').description('Models the API currently serves (/v1/models)')).action(async (o) => {
    const ctx = resolveCtx(o);
    const ids: string[] = ((await apiCall(ctx, 'v1/models')).data || []).map((m: any) => m.id);
    print(ctx, ids, () => ids.forEach((i) => say(i)));
  });
  common(program.command('chat <model> [message...]').description('Send a chat message (reads stdin if no message given)')
    .option('--system <text>', 'system prompt').option('--image <file...>', 'attach image(s) (vision models)')).action(async (model, message, o) => {
      const ctx = resolveCtx(o);
      const text = message.length ? message.join(' ') : process.stdin.isTTY ? '' : readFileSync(0, 'utf-8').trim();
      if (!text) fail('No message given (pass it as arguments or on stdin).');
      // Images go as OpenAI-style multimodal parts (text + image_url data URLs), like the Playground.
      const content = o.image?.length
        ? [{ type: 'text', text }, ...o.image.map((f: string) => ({ type: 'image_url', image_url: { url: imageDataUrl(f) } }))]
        : text;
      const messages = [...(o.system ? [{ role: 'system', content: o.system }] : []), { role: 'user', content }];
      const t0 = Date.now();
      const data = await apiCall(ctx, 'v1/chat/completions', { model, messages, stream: false });
      print(ctx, data, () => {
        say(stripThink(data.choices?.[0]?.message?.content || ''));
        const secs = (Date.now() - t0) / 1000;
        const tok = data.usage?.completion_tokens;
        if (tok) process.stderr.write(`${(tok / secs).toFixed(2)} t/s, ${secs.toFixed(2)}s total\n`);
      });
    });
  common(program.command('embed <model> <text...>').description('Create an embedding')).action(async (model, text, o) => {
    const ctx = resolveCtx(o);
    const data = await apiCall(ctx, 'v1/embeddings', { input: text.join(' '), model });
    const vec: number[] = data.data?.[0]?.embedding || data.embedding || [];
    print(ctx, data, () => say(`${vec.length}-dimensional embedding: [${vec.slice(0, 8).map((v) => v.toFixed(8)).join(', ')}${vec.length > 8 ? ', ...' : ''}]`));
  });

  // credentials / install / doctor
  common(env.command('credentials [name]').description('Show the Keycloak admin credentials for an environment')).action((name, o) => {
    const ctx = resolveCtx({ ...o, env: name || o.env });
    const out = kubectl(`-n ${ctx.namespace} get secret keycloak-initial-admin -o go-template='username: {{.data.username | base64decode}}{{"\\n"}}password: {{.data.password | base64decode}}{{"\\n"}}'`);
    const username = /username: (.*)/.exec(out)?.[1]?.trim();
    const password = /password: (.*)/.exec(out)?.[1]?.trim();
    if (!username || !password) fail('Could not parse credentials from kubectl output.');
    print(ctx, { username, password }, () => { say(`Username: ${username}`); say(`Password: ${password}`); });
  });

  const install = program.command('install').description('Install / upgrade SambaStack (helm installer ConfigMap)');
  common(install.command('apply').description('Apply the installer ConfigMap')
    .option('--chart-version <v>', 'Helm chart version to install, e.g. 0.5.48').option('-f, --file <file>', 'full ConfigMap YAML instead of --version')
    .option('--wait', 'stream installer logs until complete')).action(async (o) => {
      if (!o.chartVersion === !o.file) fail('Give exactly one of --chart-version or --file.');
      if (o.chartVersion && !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(o.chartVersion)) fail(`Invalid --chart-version "${o.chartVersion}".`);
      const ctx = resolveCtx(o);
      const text = o.file
        ? readFileSync(o.file, 'utf-8')
        : ['apiVersion: v1', 'kind: ConfigMap', 'metadata:', '  name: sambastack', '  labels:', '    sambastack-installer: "true"',
           'data:', '  sambastack.yaml: |', `    version: ${o.chartVersion}`].join('\n');
      say(applyYaml(ctx, text));
      if (o.wait && !(await followInstallLogs(ctx, 1800))) process.exitCode = 1;
    });
  common(install.command('logs').description('Show installer logs').option('--follow', 'poll until the install completes').option('--tail <n>', 'lines', '20'))
    .action(async (o) => {
      const ctx = resolveCtx(o);
      if (o.follow) { if (!(await followInstallLogs(ctx, 1800))) process.exitCode = 1; return; }
      try { say(kubectl(`-n ${ctx.namespace} logs -l sambastack-installer=true --tail=${posInt('--tail', o.tail)}`).trim()); }
      catch (e: any) { fail(`kubectl logs failed: ${kubectlErrorDetail(e)}`); }
    });

  common(program.command('doctor').description('Check prerequisites and connectivity (exit 1 if any check fails)')).action(async (o) => {
    const ctx = resolveCtx(o);
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    const run = (name: string, fn: () => string) => {
      try { checks.push({ name, ok: true, detail: fn() }); } catch (e: any) { checks.push({ name, ok: false, detail: kubectlErrorDetail(e) }); }
    };
    run('kubectl', () => kubectl('version --client').split('\n')[0]);
    run('helm', () => execSync('helm version --short', { encoding: 'utf-8' }).trim());
    run('kubernetes connection', () => { kubectl('cluster-info'); return 'ok'; });
    run(`namespace ${ctx.namespace}`, () => { kubectl(`get namespace ${ctx.namespace}`); return 'exists'; });
    const warn = getOutdatedHelmChartWarning(ctx.kubeconfig, ctx.namespace);
    checks.push({ name: 'SambaStack chart version', ok: !warn, detail: warn || 'ok' });
    try {
      const ids: string[] = ((await apiCall(ctx, 'v1/models')).data || []).map((m: any) => m.id);
      checks.push({ name: 'API reachable', ok: true, detail: `${ids.length} model(s)` });
    } catch (e: any) { checks.push({ name: 'API reachable', ok: false, detail: e.message }); }
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
    print(ctx, checks, () => checks.forEach((c) => say(`${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(28)} ${c.detail}`)));
  });

  common(program.command('transcribe <model> <file>').description('Transcribe an audio file with an ASR model')
    .option('--language <code>').option('--prompt <text>').option('--response-format <fmt>')).action(async (model, file, o) => {
      const ctx = resolveCtx(o);
      if (!existsSync(file)) fail(`Audio file not found: ${file}`);
      const bytes = readFileSync(file);
      if (bytes.length > MAX_AUDIO_BYTES) fail('Audio file exceeds the 25 MB limit.');
      const form = new FormData();
      form.append('file', new Blob([bytes]), path.basename(file));
      form.append('model', model);
      if (o.language) form.append('language', o.language);
      if (o.prompt) form.append('prompt', o.prompt);
      if (o.responseFormat) form.append('response_format', o.responseFormat);
      if (!ctx.ec?.apiDomain || !ctx.ec?.apiKey) fail('apiDomain and apiKey must be configured for this environment in app-config.json.');
      const res = await safeFetch(`${apiBase(ctx.ec.apiDomain)}v1/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${ctx.ec.apiKey}` }, body: form });
      const body = await res.text();
      if (!res.ok) fail(`API error ${res.status}: ${extractErrorMessage(body) || body}`);
      const text = (res.headers.get('content-type') || '').includes('application/json') ? JSON.parse(body).text ?? '' : body.trim();
      if (!text) fail('No transcription returned from the model.');
      print(ctx, { text }, () => say(text));
    });
  common(program.command('speak <text...>').description('Synthesize speech (TTS) to a WAV file')
    .option('--model <id>', 'TTS model id; an explicit value always wins, else the environment\'s / global `ttsModel` from app-config.json')
    .requiredOption('--voice <voice>', 'voice, e.g. serena').option('--language <lang>', 'e.g. english').requiredOption('-o, --out <file>', 'output .wav path'))
    .action(async (text, o) => {
      const ctx = resolveCtx(o);
      if (!ctx.ec?.apiDomain || !ctx.ec?.apiKey) fail('apiDomain and apiKey must be configured for this environment in app-config.json.');
      // The model you name wins; `ttsModel` (per-env, then global) only fills in when none is given. The UI route does the
      // opposite (config overrides the Playground's pick) because there the user can't always choose the speech model id.
      const speechModel: string = o.model || ctx.ec.ttsModel || loadAppConfig().ttsModel;
      if (!speechModel) fail('No TTS model: pass --model <id> or set `ttsModel` for this environment in app-config.json.');
      const res = await safeFetch(`${apiBase(ctx.ec.apiDomain)}v1/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.ec.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: speechModel, input: text.join(' '), voice: o.voice, ...(o.language ? { language: o.language } : {}) }),
      });
      if (!res.ok) { const b = await res.text(); fail(`API error ${res.status}: ${extractErrorMessage(b) || b}`); }
      const { pcmChunks, streamError } = parseSpeechStream(await res.text());
      if (pcmChunks.length === 0) fail(streamError || 'No audio returned from the model.');
      const wav = floatPcmToWav(Buffer.concat(pcmChunks), parseInt(res.headers.get('x-audio-sample-rate') || '24000', 10), parseInt(res.headers.get('x-audio-channels') || '1', 10));
      writeFileSync(o.out, wav);
      print(ctx, { file: o.out, bytes: wav.length }, () => say(`Wrote ${o.out} (${wav.length} bytes)`));
    });

  // environment management (same app-config.json writes as the UI / interactive menu)
  const saveConfig = (cfg: any) => writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  env.command('add <name>').description('Add an environment from a kubeconfig file or base64 string')
    .option('--kubeconfig-file <path>', 'path to a kubeconfig').option('--kubeconfig-b64 <string>', 'base64-encoded kubeconfig')
    .option('--namespace <ns>', 'namespace', 'default').option('--ui-domain <url>').option('--api-domain <url>').option('--api-key <key>')
    .option('--overwrite', 'replace the kubeconfig of an existing environment').action((name, o) => {
      assertEnvName(name);
      if (!o.kubeconfigFile === !o.kubeconfigB64) fail('Give exactly one of --kubeconfig-file or --kubeconfig-b64.');
      // like the UI's check-app-config, the first environment may be added before any app-config.json exists
      const cfg = existsSync(CONFIG_PATH) ? loadAppConfig() : { currentKubeconfig: null, kubeconfigs: {} };
      cfg.kubeconfigs = cfg.kubeconfigs || {};
      if (o.namespace) assertName('namespace', o.namespace);
      if (cfg.kubeconfigs[name] && !o.overwrite) fail(`Environment '${name}' already exists (use --overwrite to replace its kubeconfig).`);
      const text = o.kubeconfigFile
        ? (existsSync(o.kubeconfigFile) ? readFileSync(o.kubeconfigFile, 'utf-8') : fail(`File not found: ${o.kubeconfigFile}`))
        : Buffer.from(o.kubeconfigB64.trim(), 'base64').toString('utf-8');
      if (!text.includes('apiVersion') || !text.includes('clusters')) fail('Content does not look like a valid kubeconfig.');
      // Overwriting replaces the kubeconfig the environment actually points at (its `file`), not a guessed path.
      const existing = cfg.kubeconfigs[name];
      const rel: string = existing ? existing.file : `kubeconfigs/${name}.yaml`;
      const dest = path.isAbsolute(rel) ? rel : path.join(PROJECT_ROOT, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, text);
      if (!existing) {
        cfg.kubeconfigs[name] = { file: rel, namespace: o.namespace, uiDomain: o.uiDomain || '', apiDomain: o.apiDomain || '', apiKey: o.apiKey || '' };
        cfg.currentKubeconfig = name;
      }
      saveConfig(cfg);
      say(existing
        ? `Environment '${name}': kubeconfig overwritten (${rel}). Run \`data refresh --env ${name}\` next.`
        : `Environment '${name}' added and set current. Run \`data refresh --env ${name}\` next.`);
    });
  env.command('edit <name>').description('Edit an environment\'s namespace, domains or API key')
    .option('--namespace <ns>').option('--ui-domain <url>').option('--api-domain <url>').option('--api-key <key>').option('--tts-model <id>')
    .action(async (name, o) => {
      assertEnvName(name);
      if (o.namespace !== undefined) assertName('namespace', o.namespace);
      const cfg = loadAppConfig();
      const e = cfg.kubeconfigs?.[name];
      if (!e) fail(`Environment "${name}" not found.`);
      const before = { ...e };
      if (o.namespace !== undefined) e.namespace = o.namespace;
      if (o.uiDomain !== undefined) e.uiDomain = o.uiDomain;
      if (o.apiDomain !== undefined) e.apiDomain = o.apiDomain;
      if (o.apiKey !== undefined) e.apiKey = o.apiKey;
      if (o.ttsModel !== undefined) e.ttsModel = o.ttsModel;
      // pef_configs.json is ONE shared file for the current environment. Only the current environment's namespace change may
      // regenerate it; doing it for another environment would leave the current one running on that cluster's PEFs.
      const namespaceChanged = o.namespace !== undefined && o.namespace !== before.namespace;
      const isCurrent = name === cfg.currentKubeconfig;
      if (namespaceChanged && isCurrent) {
        // Like the UI's update-config: refresh PEF configs for the new namespace first and roll back on failure.
        const kp = path.isAbsolute(e.file) ? e.file : path.join(PROJECT_ROOT, e.file);
        try { await generatePefConfigs(kp, o.namespace, false); }
        catch (err: any) { return fail(`Could not refresh PEF configs for namespace "${o.namespace}"; nothing changed. ${err.message}`); }
      }
      saveConfig(cfg);
      say(namespaceChanged && !isCurrent
        ? `Environment '${name}' updated. It is not the current environment, so the cached PEF data was left alone; run \`env use ${name}\` and \`data refresh\` when you switch to it.`
        : `Environment '${name}' updated.`);
    });
  env.command('set-api-key [key]').description('Save the API key for the current (or --env) environment (omit KEY to be prompted, or pipe it on stdin)')
    .option('--env <name>').action(async (keyArg, o) => {
      const cfg = loadAppConfig();
      const name = o.env || cfg.currentKubeconfig;
      if (!cfg.kubeconfigs?.[name]) fail(`Environment "${name}" not found.`);
      if (keyArg) process.stderr.write('warning: a key passed as an argument stays in your shell history; omit it to be prompted, or pipe it on stdin.\n');
      const key = keyArg || await readSecret(`API key for '${name}' (input hidden): `);
      if (!key) fail('No API key given.');
      cfg.kubeconfigs[name].apiKey = key;
      saveConfig(cfg);
      say(`API key saved for '${name}'.`);
    });
  env.command('delete <name>').description('Remove an environment from app-config.json').option('-y, --yes', 'confirm').action((name, o) => {
    if (!o.yes) fail('Refusing to delete without --yes.');
    assertEnvName(name);
    const cfg = loadAppConfig();
    if (!cfg.kubeconfigs?.[name]) fail(`Environment "${name}" not found.`);
    delete cfg.kubeconfigs[name];
    if (cfg.currentKubeconfig === name) cfg.currentKubeconfig = Object.keys(cfg.kubeconfigs)[0] || null;
    saveConfig(cfg);
    say(`Environment '${name}' deleted.`);
  });

  return program;
}

export async function runCommands(argv: string[]): Promise<void> {
  try {
    await buildProgram().parseAsync(argv, { from: 'user' });
  } catch (e: any) {
    process.stderr.write(`error: ${e instanceof CliError ? e.message : kubectlErrorDetail(e)}\n`);
    process.exitCode = 1;
  }
}
