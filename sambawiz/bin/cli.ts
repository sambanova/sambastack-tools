#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const process: any;

// Allow self-signed SSL certificates for internal APIs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import * as readlineModule from 'readline';
import readlinePromises from 'readline/promises';
import type {
  Model,
  ModelProfile,
  BatchingConfig,
  CheckpointMappingV3,
  ModelProfilesCache,
} from '../app/types/bundle';
import {
  getHighestVersion,
  getEffectiveBatchingConfig,
  getDisplayName,
  isSpecDecodingProfile,
  generateModelBundleYaml,
  type ModelBundleSelection,
} from '../app/utils/bundle-yaml-generator';
import { parseModelBundleYamlContent } from '../app/utils/parse-bundle-yaml';

// ─── V3 CLI data model ───────────────────────────────────────────────────────
// V3 replaces the old model→PEF (SS/BS) selection model with a
// model→arch→profile join (see v3plan.md, "V3 SambaWiz UX & implementation
// plan"). The CLI sources its Model/ModelProfile lists from the same caches
// the web UI's Home "Apply" flow produces (app/data/checkpoint_mapping.json —
// CheckpointMappingV3 shape — and app/data/model_profiles.json —
// ModelProfilesCache shape) and reuses the shared, framework-agnostic
// generator/parser (bundle-yaml-generator.ts / parse-bundle-yaml.ts) so the
// CLI and the GUI emit byte-identical ModelBundle YAML for the same
// selections.

interface PodInfo {
  name:     string;
  ready:    number;
  total:    number;
  status:   string;
  restarts: string;
  age:      string;
}

type DeploymentStatus = 'Deployed' | 'Deploying' | 'Not Deployed';

function safeParseInt(val: string | undefined): number {
  const n = parseInt(val ?? '0', 10);
  return isNaN(n) ? 0 : n;
}

function normalizeApiUrl(apiDomain: string): string {
  let base = apiDomain.replace(/\/v1\/chat\/completions\/?$/, '');
  if (!base.endsWith('/')) base += '/';
  return base;
}

function getDeploymentStatus(cachePod: PodInfo | null, defaultPod: PodInfo | null): DeploymentStatus {
  if (!cachePod && !defaultPod) return 'Not Deployed';
  const cacheReady   = cachePod   ? cachePod.ready   === cachePod.total   : false;
  const defaultReady = defaultPod ? defaultPod.ready === defaultPod.total : false;
  return cacheReady && defaultReady ? 'Deployed' : 'Deploying';
}

function parsePodLine(line: string): PodInfo | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const [ready, total] = parts[1].split('/').map(Number);
  return {
    name:     parts[0],
    ready:    isNaN(ready) ? 0 : ready,
    total:    isNaN(total) ? 0 : total,
    status:   parts[2],
    restarts: parts[3] || '0',
    age:      parts[4] || '',
  };
}

function classifyPod(podName: string): 'cache' | 'default' | 'other' {
  if (podName.includes('-cache-'))       return 'cache';
  if (podName.includes('-q-default-n-')) return 'default';
  return 'other';
}

/** Format Kubernetes validation/legalizer errors the same way for ModelBundle as the UI does. */
function printValidationErrors(conds: any[]): void {
  const errCond = conds.find((c: any) => c.reason === 'ValidationFailed' || (c.status === 'False' && c.message));
  const msg = errCond?.message || conds.map((c: any) => c.message).filter(Boolean).join('\n');

  process.stdout.write(chalk.red.bold('Validation failed with the following errors:\n'));

  if (msg) {
    const lines = msg.split('\n').map((l: string) => l.trim()).filter((l: string) => l.length > 0);
    lines.forEach((line: string) => {
      process.stdout.write(chalk.red(`${line}\n`));
    });
  } else {
    conds.forEach((c: any) => process.stdout.write(chalk.red(`${c.type}: ${c.reason} — ${c.message}\n`)));
  }
  process.stdout.write('\n');
}

/**
 * Reads the `Valid` condition off a ModelBundle's `status.conditions`
 * (confirmed shape, v3plan.md Q5: `{ type: Valid, status, reason, message }`
 * — identical to the V2 `Bundle` status).
 */
export type ValidationOutcome = 'succeeded' | 'failed' | 'pending';
export function readValidCondition(conditions: Array<{ type?: string; status?: string }>): ValidationOutcome {
  const cond = conditions.find((c) => c.type === 'Valid');
  if (!cond) return 'pending';
  if (cond.status === 'True') return 'succeeded';
  if (cond.status === 'False') return 'failed';
  return 'pending';
}

// ─── V3 cache → CR adapters ──────────────────────────────────────────────────
// Converts cache entries (CheckpointMappingV3 / ModelProfilesCache — plain
// JSON caches, see v3plan.md "Data fetching & caching for V3") into the
// Model / ModelProfile CR shapes the shared generator functions expect.

/** Converts a CheckpointMappingV3 entry (+ its display name) into a `Model` CR object. */
export function toModelCR(displayName: string, entry: CheckpointMappingV3[string]): Model {
  return {
    metadata: { name: entry.resource_name },
    spec: {
      name: displayName,
      checkpoints: entry.checkpoints,
      metadata: { capabilities: entry.capabilities },
    },
  };
}

/** Converts a ModelProfilesCache entry (+ its name) into a `ModelProfile` CR object. */
export function toModelProfileCR(name: string, entry: ModelProfilesCache[string]): ModelProfile {
  return {
    metadata: { name },
    spec: {
      model_arch: entry.model_arch,
      features: entry.features,
      defaultBatchingConfig: entry.batchingConfig,
      pefs: entry.pefs,
    },
  };
}

/**
 * Checkpoint archs (keys of `checkpoints`) that have at least one matching
 * `ModelProfile` in the cache (join on `model_arch`) — empty means the
 * no-matching-profile guard (Q4) should block this model from the bundle.
 */
export function getArchsWithProfiles(
  checkpoints: CheckpointMappingV3[string]['checkpoints'],
  modelProfiles: ModelProfilesCache
): string[] {
  const profiledArchs = new Set(Object.values(modelProfiles).map((p) => p.model_arch));
  return Object.keys(checkpoints).filter((a) => profiledArchs.has(a));
}

/** `ModelProfile` CR objects whose `model_arch` matches `arch`, sourced from the cache. */
export function getProfilesForArch(arch: string, modelProfiles: ModelProfilesCache): ModelProfile[] {
  return Object.entries(modelProfiles)
    .filter(([, entry]) => entry.model_arch === arch)
    .map(([name, entry]) => toModelProfileCR(name, entry));
}

/** Parses a user-entered batch-sizes override: `'*'` (all) or a comma-separated number list. */
export function parseBatchSizesInput(input: string): number[] | '*' {
  const trimmed = input.trim();
  if (trimmed === '*') return '*';
  return trimmed
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
}

/** Reverse-looks-up a `Model` CR name (crname) back to its display name in the checkpoint mapping cache. */
export function crNameToDisplayName(checkpointMapping: CheckpointMappingV3, crname: string): string | undefined {
  const found = Object.entries(checkpointMapping).find(([, entry]) => entry.resource_name === crname);
  return found?.[0];
}

/** Extracts a ModelBundle's `metadata.name` from YAML text via the shared V3 parser (returns '' on parse failure). */
export function extractBundleName(yamlContent: string): string {
  const parsed = parseModelBundleYamlContent(yamlContent);
  return 'error' in parsed ? '' : parsed.bundleName;
}

/**
 * Builds the `ModelDeployment` YAML referencing a `ModelBundle` by name
 * (Q6 — always `spec.bundle`, never inline `spec.models`). All other
 * deployment knobs (`groups`, `owner`, `secretNames`, `engineConfig`, etc.)
 * are carried over verbatim from the old `BundleDeployment` builder (Step 5,
 * "Keep all other deployment parameters unchanged").
 */
export function buildModelDeploymentYaml(bundleName: string): { yaml: string; deploymentName: string } {
  const deploymentName = `md-${bundleName}`;
  const yamlText = [
    'apiVersion: sambanova.ai/v1alpha1',
    'kind: ModelDeployment',
    'metadata:',
    `  name: ${deploymentName}`,
    'spec:',
    `  bundle: ${bundleName}`,
    '  groups:',
    '  - minReplicas: 1',
    '    name: default',
    '    qosList:',
    '    - free',
    '  owner: no-reply@sambanova.ai',
    '  secretNames:',
    '  - sambanova-artifact-reader',
    '  engineConfig:',
    '    startupTimeout: 7200',
  ].join('\n');
  return { yaml: yamlText, deploymentName };
}

// ─── Paths ───────────────────────────────────────────────────────────────────
// tsx sets __dirname to '.' — use process.cwd() which always points to the
// project root when launched via `npm run dev-cli` from sambawiz/

const PROJECT_ROOT = process.cwd();
const APP_DIR      = path.join(PROJECT_ROOT, 'app');
const DATA_DIR     = path.join(APP_DIR, 'data');

// ─── V3 cache generation ──────────────────────────────────────────────────────
// Mirrors app/api/generate-checkpoint-mapping/route.ts and
// app/api/generate-model-profiles/route.ts (kept inline here so the CLI
// works standalone, without the Next.js server — see README-CLI.md). Unlike
// the V2 CLI, this captures ALL checkpoint archs + versions per model (not
// just the first) and no longer pre-selects a version or writes
// `checkpointsDir`-prefixed source paths — checkpoints are resolved by the
// operator from the Model CR at reconcile time (Q11).

function stripGcsPrefix(p: string): string {
  return p.replace(/^gs:\/\/[^/]+\//, '').replace(/\/$/, '');
}

const ckLog  = (msg: string, verbose = true) => { if (verbose) process.stdout.write(chalk.reset(`[Checkpoint] ${msg}\n`)); };
const mpLog  = (msg: string, verbose = true) => { if (verbose) process.stdout.write(chalk.reset(`[Model Profiles] ${msg}\n`)); };
const pefLog = (msg: string, verbose = true) => { if (verbose) process.stdout.write(chalk.reset(`[PEF Generator] ${msg}\n`)); };

function kubectlErrorDetail(e: any): string {
  const raw = e.stderr ? String(e.stderr).trim() : e.message;
  const errField = raw.match(/err="([^"]+)"/);
  const connMsg  = raw.match(/(dial tcp[^\n]+|connection refused[^\n]+|i\/o timeout[^\n]*)/i);
  return errField ? errField[1] : connMsg ? connMsg[0] : raw.split('\n')[0];
}

async function generateCheckpointMapping(kubeconfigPath: string, namespace: string, verbose = true, chain = true): Promise<{ count: number }> {
  ckLog('Running kubectl get models -o json...', verbose);

  const env = { ...process.env, KUBECONFIG: kubeconfigPath };
  let rawOutput: string;
  try {
    rawOutput = execSync(`kubectl -n ${namespace} get models -o json`, {
      env,
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    throw new Error(`kubectl get models failed: ${kubectlErrorDetail(e)}`);
  }

  const modelsData = JSON.parse(rawOutput);
  const mapping: CheckpointMappingV3 = {};

  for (const item of modelsData.items || []) {
    const displayName  = item.spec?.name;
    const resourceName = item.metadata?.name;
    const checkpoints  = item.spec?.checkpoints;
    if (!displayName || !resourceName || !checkpoints) continue;

    const archs: CheckpointMappingV3[string]['checkpoints'] = {};

    // Capture ALL checkpoint archs (not just the first) so the arch dropdown
    // and `crname:arch:version` refs work for multi-arch models (v3plan.md).
    for (const [arch, checkpointEntry] of Object.entries(checkpoints) as [string, any][]) {
      const versions = checkpointEntry?.versions;
      if (!versions || Object.keys(versions).length === 0) continue;

      const archVersions: NonNullable<CheckpointMappingV3[string]['checkpoints'][string]>['versions'] = {};
      for (const [version, versionData] of Object.entries(versions) as [string, any][]) {
        if (!versionData?.source) continue;
        archVersions[version] = {
          source: stripGcsPrefix(versionData.source),
          ...(versionData.checkpoint_status ? { checkpoint_status: versionData.checkpoint_status } : {}),
          ...(versionData.tool_support !== undefined ? { tool_support: versionData.tool_support } : {}),
          ...(versionData.vision_embedding_checkpoint
            ? { vision_embedding_checkpoint: stripGcsPrefix(versionData.vision_embedding_checkpoint) }
            : {}),
        };
      }
      if (Object.keys(archVersions).length > 0) archs[arch] = { versions: archVersions };
    }

    if (Object.keys(archs).length === 0) continue;

    mapping[displayName] = {
      resource_name: resourceName,
      checkpoints: archs,
      capabilities: item.spec?.metadata?.capabilities ?? [],
    };
  }

  const count = Object.keys(mapping).length;
  writeFileSync(path.join(DATA_DIR, 'checkpoint_mapping.json'), JSON.stringify(mapping, null, 2) + '\n');
  ckLog(`✓ Generated checkpoint_mapping.json with ${count} models (multi-arch)`, verbose);

  if (chain) {
    try {
      await generateModelProfiles(kubeconfigPath, namespace, verbose);
    } catch (e: any) {
      if (verbose) process.stdout.write(chalk.yellow(`  Model profiles generation skipped: ${e.message.split('\n')[0]}\n`));
    }
    try {
      await generatePefConfigs(kubeconfigPath, namespace, verbose);
    } catch (e: any) {
      if (verbose) process.stdout.write(chalk.yellow(`  PEF config generation skipped: ${e.message.split('\n')[0]}\n`));
    }
  }

  return { count };
}

// ─── generateModelProfiles() ──────────────────────────────────────────────────
// New V3 cache (v3plan.md, "New" file inventory): caches `ModelProfile` CRs
// keyed by `metadata.name`, joined to Models by `model_arch`.

async function generateModelProfiles(kubeconfigPath: string, namespace: string, verbose = true): Promise<{ count: number }> {
  mpLog('Running kubectl get modelprofiles -o json...', verbose);

  const env = { ...process.env, KUBECONFIG: kubeconfigPath };
  let rawOutput: string;
  try {
    rawOutput = execSync(`kubectl -n ${namespace} get modelprofiles -o json`, {
      env,
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    throw new Error(`kubectl get modelprofiles failed: ${kubectlErrorDetail(e)}`);
  }

  const data = JSON.parse(rawOutput);
  const cache: ModelProfilesCache = {};

  for (const item of data.items || []) {
    const name      = item.metadata?.name;
    const modelArch = item.spec?.model_arch;
    if (!name || !modelArch) continue;

    cache[name] = {
      model_arch: modelArch,
      features: item.spec?.features ?? [],
      batchingConfig: item.spec?.defaultBatchingConfig ?? item.status?.batchingConfig ?? {},
      pefs: item.spec?.pefs ?? [],
    };
  }

  const count = Object.keys(cache).length;
  writeFileSync(path.join(DATA_DIR, 'model_profiles.json'), JSON.stringify(cache, null, 2) + '\n');
  mpLog(`✓ Generated model_profiles.json with ${count} profiles`, verbose);
  return { count };
}

// ─── generatePefConfigs() ─────────────────────────────────────────────────────
// Retained as the PEF cache (still useful for validating batch sizes /
// `sd`/DYT hints, per v3plan.md), but trimmed: the old DYT-precedence pruning
// and `model_type` back-fill both read the now-obsolete `pef_mapping.json`
// (SS/BS explosion is gone in V3 — batching is declarative via the profile,
// and embedding detection comes from the Model CR's `capabilities`, Q10).

function parsePefName(pefName: string): { ss: number; bs: number } | null {
  const ssMatch = pefName.match(/ss(\d+)/);
  const bsMatch = pefName.match(/bs(\d+)/);
  if (!ssMatch || !bsMatch) return null;
  return { ss: parseInt(ssMatch[1], 10), bs: parseInt(bsMatch[1], 10) };
}

function formatSsValue(ss: number): string {
  if (ss < 1024) return ss.toString();
  return `${ss / 1024}k`;
}

function getLatestVersionFromVersions(versions: Record<string, unknown> | undefined): string {
  if (!versions || typeof versions !== 'object') return '1';
  const nums = Object.keys(versions).map(v => parseInt(v, 10)).filter(v => !isNaN(v));
  return nums.length === 0 ? '1' : Math.max(...nums).toString();
}

function selectDytSsValues(ssMin: number, ssMax: number, ssStep: number): number[] {
  const valid = new Set<number>();
  for (let ss = ssMin; ss <= ssMax; ss += ssStep) valid.add(ss);
  const selected: number[] = [];
  let cur = ssMax;
  while (cur >= ssMin) {
    if (valid.has(cur)) selected.push(cur);
    cur = Math.floor(cur / 2);
  }
  return selected.filter(ss => ss >= 32768);
}

async function generatePefConfigs(kubeconfigPath: string, namespace: string, verbose = true): Promise<{ count: number }> {
  pefLog('Running kubectl get pef -o json...', verbose);

  const env = { ...process.env, KUBECONFIG: kubeconfigPath };

  let rawPef: string;
  try {
    rawPef = execSync(`kubectl -n ${namespace} get pef -o json`, {
      env, encoding: 'utf-8', timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    throw new Error(`kubectl get pef failed: ${kubectlErrorDetail(e)}`);
  }

  const pefData = JSON.parse(rawPef);
  const items: any[] = pefData.items || [];

  pefLog(`Found ${items.length} PEFs`, verbose);
  pefLog('Processing PEFs...', verbose);

  const configs: Record<string, any> = {};
  let processedCount = 0;

  for (const item of items) {
    const pefName: string = item.metadata?.name;
    if (!pefName) continue;

    const versions = item.spec?.versions;
    const latestVersion = getLatestVersionFromVersions(versions);
    const isDyt = pefName.includes('dyt');

    if (isDyt) {
      try {
        const indOut = execSync(`kubectl -n ${namespace} get pef ${pefName} -o json`, {
          env, encoding: 'utf-8', timeout: 15000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const ind: any = JSON.parse(indOut);
        const pefMeta    = ind.spec?.metadata;
        const dynDims    = pefMeta?.dynamic_dims;
        const bsValues: number[] = dynDims?.batch_size?.values;
        const topLevelBs: number | undefined = pefMeta?.batch_size;
        const ssMax: number | undefined = dynDims?.decode_seq?.max;
        const ssMin: number | undefined = dynDims?.decode_seq?.min;
        const ssStep: number | undefined = dynDims?.decode_seq?.step;
        const dytVer = getLatestVersionFromVersions(ind.spec?.versions);

        if (bsValues?.length > 0 && ssMax !== undefined) {
          const selectedSs = (ssMin !== undefined && ssStep !== undefined)
            ? selectDytSsValues(ssMin, ssMax, ssStep)
            : [ssMax];
          if (selectedSs.length > 0) {
            configs[pefName] = selectedSs.flatMap((ss: number) =>
              bsValues.map((bs: number) => ({ ss: formatSsValue(ss), bs: bs.toString(), latestVersion: dytVer }))
            );
            processedCount++;
          }
        } else if (topLevelBs !== undefined && ssMax !== undefined) {
          configs[pefName] = { ss: formatSsValue(ssMax), bs: topLevelBs.toString(), latestVersion: dytVer };
          processedCount++;
        }
      } catch { /* skip individual DYT PEF on error */ }
    } else {
      const parsed = parsePefName(pefName);
      if (parsed) {
        configs[pefName] = { ss: formatSsValue(parsed.ss), bs: parsed.bs.toString(), latestVersion };
        processedCount++;
      }
    }
  }

  pefLog(`✓ Processed ${processedCount}/${items.length} PEFs`, verbose);

  const pefConfigsPath = path.join(DATA_DIR, 'pef_configs.json');
  writeFileSync(pefConfigsPath, JSON.stringify(configs, null, 2) + '\n');

  pefLog(`✓ Generated pef_configs.json with ${processedCount} entries`, verbose);
  return { count: processedCount };
}

// ─── runDataFileStepTracker() ─────────────────────────────────────────────────
// Shared step-tracker UI used at startup, activate, and add-env.
// Shows [1/3] / [2/3] / [3/3] animated lines with spinner + timing.

async function runDataFileStepTracker(
  kPath: string,
  namespace: string,
  label?: string,
): Promise<void> {
  const LABEL_W = 26;
  const DOTS    = '  ........  ';
  const FRAMES  = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];

  if (label) {
    process.stdout.write('\n');
    process.stdout.write(chalk.hex(BRAND).bold('  Initializing') + chalk.reset(`  [${label}]\n\n`));
  }

  // Step 1 — checkpoint_mapping.json
  const lbl1 = 'checkpoint_mapping.json'.padEnd(LABEL_W);
  let fr1 = 0;
  const s1 = Date.now();
  process.stdout.write(`  [1/3]  ${lbl1}${DOTS}${chalk.cyan(FRAMES[0])}  `);
  const tick1 = setInterval(() => {
    fr1++;
    process.stdout.write(`\r  [1/3]  ${lbl1}${DOTS}${chalk.cyan(FRAMES[fr1 % FRAMES.length])}  `);
  }, 80);

  let ckCount = 0; let ckOk = false;
  try {
    const r = await generateCheckpointMapping(kPath, namespace, false, false);
    ckCount = r.count; ckOk = true;
  } catch { /* handled below */ }
  clearInterval(tick1);
  const t1 = ((Date.now() - s1) / 1000).toFixed(1) + 's';

  if (ckOk) {
    process.stdout.write(`\r  [1/3]  ${lbl1}${DOTS}${chalk.green('✓')}  ${`${ckCount} models`.padEnd(12)}  ${chalk.reset(`(${t1})`)}\n`);
  } else {
    const cached = existsSync(path.join(DATA_DIR, 'checkpoint_mapping.json'));
    process.stdout.write(`\r  [1/3]  ${lbl1}${DOTS}${cached ? chalk.yellow('⚠') : chalk.red('✖')}  ${chalk.reset(cached ? 'cached' : 'failed').padEnd(12)}\n`);
    if (!cached) {
      process.stdout.write(chalk.yellow(`\n  Model Selection unavailable until cluster reachable.\n`));
    }
  }

  // Step 2 — model_profiles.json
  const lbl2 = 'model_profiles.json'.padEnd(LABEL_W);
  let fr2 = 0;
  const s2 = Date.now();
  process.stdout.write(`  [2/3]  ${lbl2}${DOTS}${chalk.cyan(FRAMES[0])}  `);
  const tick2 = setInterval(() => {
    fr2++;
    process.stdout.write(`\r  [2/3]  ${lbl2}${DOTS}${chalk.cyan(FRAMES[fr2 % FRAMES.length])}  `);
  }, 80);

  let mpCount = 0; let mpOk = false;
  try {
    const r = await generateModelProfiles(kPath, namespace, false);
    mpCount = r.count; mpOk = true;
  } catch { /* handled below */ }
  clearInterval(tick2);
  const t2 = ((Date.now() - s2) / 1000).toFixed(1) + 's';

  if (mpOk) {
    process.stdout.write(`\r  [2/3]  ${lbl2}${DOTS}${chalk.green('✓')}  ${`${mpCount} profiles`.padEnd(12)}  ${chalk.reset(`(${t2})`)}\n`);
  } else {
    const cached = existsSync(path.join(DATA_DIR, 'model_profiles.json'));
    process.stdout.write(`\r  [2/3]  ${lbl2}${DOTS}${cached ? chalk.yellow('⚠') : chalk.red('✖')}  ${chalk.reset(cached ? 'cached' : 'failed').padEnd(12)}\n`);
  }

  // Step 3 — pef_configs.json
  const lbl3 = 'pef_configs.json'.padEnd(LABEL_W);
  let fr3 = 0;
  const s3 = Date.now();
  process.stdout.write(`  [3/3]  ${lbl3}${DOTS}${chalk.cyan(FRAMES[0])}  `);
  const tick3 = setInterval(() => {
    fr3++;
    process.stdout.write(`\r  [3/3]  ${lbl3}${DOTS}${chalk.cyan(FRAMES[fr3 % FRAMES.length])}  `);
  }, 80);

  let pefCount = 0; let pefOk = false;
  try {
    const r = await generatePefConfigs(kPath, namespace, false);
    pefCount = r.count; pefOk = true;
  } catch {
    if (existsSync(path.join(DATA_DIR, 'pef_configs.json'))) {
      pefCount = Object.keys(JSON.parse(readFileSync(path.join(DATA_DIR, 'pef_configs.json'), 'utf-8'))).length;
    }
  }
  clearInterval(tick3);
  const t3 = ((Date.now() - s3) / 1000).toFixed(1) + 's';

  if (pefOk) {
    process.stdout.write(`\r  [3/3]  ${lbl3}${DOTS}${chalk.green('✓')}  ${`${pefCount} PEFs`.padEnd(12)}  ${chalk.reset(`(${t3})`)}\n`);
  } else {
    const cached = existsSync(path.join(DATA_DIR, 'pef_configs.json'));
    process.stdout.write(`\r  [3/3]  ${lbl3}${DOTS}${cached ? chalk.yellow('⚠') : chalk.red('✖')}  ${chalk.reset(cached ? `cached (${pefCount} PEFs)` : 'failed').padEnd(12)}\n`);
  }

  process.stdout.write('\n');
}

const CONFIG_PATH = path.join(PROJECT_ROOT, 'app-config.json');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireJson(p: string): any {
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf-8')); }
  catch (err: any) { process.stdout.write(chalk.red(`  Error parsing ${p}: ${err.message}\n`)); return {}; }
}

function getAppVersion(): string {
  const vp = path.join(PROJECT_ROOT, 'VERSION');
  if (!existsSync(vp)) return requireJson(path.join(PROJECT_ROOT, 'package.json')).version || '';
  for (const line of readFileSync(vp, 'utf-8').split('\n')) {
    if (line.trim().startsWith('app:')) return line.split(':')[1].trim();
  }
  return requireJson(path.join(PROJECT_ROOT, 'package.json')).version || '';
}

function getMinHelmVersion(): string {
  const vp = path.join(PROJECT_ROOT, 'VERSION');
  if (!existsSync(vp)) return '';
  for (const line of readFileSync(vp, 'utf-8').split('\n')) {
    if (line.trim().startsWith('minimum-sambastack-helm:')) return line.split(':')[1].trim();
  }
  return '';
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ─── Spinner ─────────────────────────────────────────────────────────────────

class Spinner {
  private frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  private idx = 0;
  private timer: any = null;

  start(text: string) {
    this.idx = 0;
    this.timer = setInterval(() => {
      process.stdout.write(`\r${chalk.magenta(this.frames[this.idx])}  ${chalk.reset(text)}   `);
      this.idx = (this.idx + 1) % this.frames.length;
    }, 80);
    return this;
  }

  succeed(text: string) { this._stop(); process.stdout.write(`  ${chalk.green('✔')}  ${chalk.green(text)}\n`); }
  fail(text: string)    { this._stop(); process.stdout.write(`  ${chalk.red('✖')}  ${chalk.red(text)}\n`); }
  warn(text: string)    { this._stop(); process.stdout.write(`  ${chalk.yellow('⚠')}  ${chalk.yellow(text)}\n`); }
  info(text: string)    { this._stop(); process.stdout.write(`  ${chalk.magenta('ℹ')}  ${text}\n`); }

  private _stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    process.stdout.write('\r\x1b[K');
  }
}

const spinner = new Spinner();

// ─── UI primitives ───────────────────────────────────────────────────────────

const BRAND = '#412AA0';

function sectionHeader(title: string, icon = '◈') {
  const cols = Math.min(58, (process.stdout.columns || 80) - 4);
  const inner = ` ${icon}  ${title} `;
  const pad = Math.max(0, cols - inner.length);
  process.stdout.write('\n');
  process.stdout.write(chalk.hex(BRAND)(`  ╭${'─'.repeat(cols)}╮\n`));
  process.stdout.write(chalk.hex(BRAND)(`  │`) + chalk.hex(BRAND).bold(inner) + chalk.hex(BRAND)(`${' '.repeat(pad)}│\n`));
  process.stdout.write(chalk.hex(BRAND)(`  ╰${'─'.repeat(cols)}╯\n\n`));
}

function hr() {
  const cols = Math.min(58, (process.stdout.columns || 80) - 4);
  process.stdout.write(chalk.reset('  ' + '─'.repeat(cols)) + '\n');
}

function checkRow(icon: string, label: string, value = '') {
  const lbl = label.padEnd(34);
  process.stdout.write(`  ${icon}  ${chalk.reset(lbl)}${chalk.reset(value)}\n`);
}

function infoRow(label: string, value: string) {
  process.stdout.write(`  ${chalk.reset(label.padEnd(18))}${chalk.reset(value)}\n`);
}

function successMsg(text: string) { process.stdout.write(`\n  ${chalk.green('✅')} ${chalk.green.bold(text)}\n\n`); }
function errorMsg(text: string)   { process.stdout.write(`\n  ${chalk.red('❌')} ${chalk.red.bold(text)}\n\n`); }
function warnMsg(text: string)    { process.stdout.write(`  ${chalk.yellow('⚠')} ${chalk.yellow(text)}\n`); }

function yamlBox(title: string, content: string) {
  process.stdout.write(chalk.reset.bold(`\n  ${title}:\n`));
  process.stdout.write(chalk.reset('  ' + '─'.repeat(40)) + '\n');
  content.split('\n').forEach(line => {
    if (line.trim()) process.stdout.write(chalk.reset(`  ${line}\n`));
  });
  process.stdout.write(chalk.reset('  ' + '─'.repeat(40)) + '\n\n');
}

function menuHint() {
  process.stdout.write(chalk.reset('  ↑↓ navigate   Enter select   q / Esc to go back\n\n'));
}

// ─── Keypress ────────────────────────────────────────────────────────────────

let keypressEventsInitialized = false;
function ensureKeypressEvents() {
  if (!keypressEventsInitialized) {
    readlineModule.emitKeypressEvents(process.stdin);
    keypressEventsInitialized = true;
  }
}

// ─── select() ────────────────────────────────────────────────────────────────

interface Choice {
  name: string;
  value: any;
  bundle?: string;
  hint?: string;
}

async function select(_rl: any, message: string, choices: Choice[], big = false): Promise<any> {
  const [mainLabel, ...extraLines] = message.split('\n');
  process.stdout.write(`\n${chalk.hex(BRAND).bold('  ›')} ${chalk.bold(mainLabel)}\n`);
  extraLines.forEach(l => process.stdout.write(`${l}\n`));
  menuHint();

  let selectedIndex = 0;

  const isRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const maxVisible = Math.max(5, (process.stdout.rows || 24) - 6);
  let scrollOffset = 0;
  let lastDrawnCount = 0;

  const draw = () => {
    if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
    else if (selectedIndex >= scrollOffset + maxVisible) scrollOffset = selectedIndex - maxVisible + 1;

    const visible = choices.slice(scrollOffset, scrollOffset + maxVisible);
    const lines: string[] = [];

    if (scrollOffset > 0) lines.push(chalk.reset(`   ↑ ${scrollOffset} more above`));

    visible.forEach((choice, i) => {
      const ri = scrollOffset + i;
      const active = ri === selectedIndex;
      const cursor = active ? chalk.hex(BRAND).bold(' ▶  ') : '    ';
      const label  = active ? chalk.hex(BRAND).bold(choice.name) : (big ? chalk.reset.bold(choice.name) : chalk.reset(choice.name));
      if (big) {
        lines.push('');
        lines.push(`${cursor}${label}`);
        if (choice.hint) lines.push(`     ${chalk.reset(choice.hint)}`);
      } else {
        const hint = choice.hint ? chalk.reset(`  ${choice.hint}`) : '';
        lines.push(`${cursor}${label}${hint}`);
      }
    });

    const remaining = choices.length - scrollOffset - maxVisible;
    if (remaining > 0) lines.push(chalk.reset(`   ↓ ${remaining} more below`));

    lastDrawnCount = lines.length;
    lines.forEach(l => process.stdout.write(`${l}\n`));
  };

  const headerLines = 4 + extraLines.length; // blank + header + hint + blank

  const clear = () => {
    readlineModule.moveCursor(process.stdout, 0, -lastDrawnCount);
    readlineModule.clearScreenDown(process.stdout);
  };

  const clearAll = () => {
    readlineModule.moveCursor(process.stdout, 0, -(lastDrawnCount + headerLines));
    readlineModule.clearScreenDown(process.stdout);
  };

  draw();

  return new Promise((resolve) => {
    const cleanup = (val: any, selectedName?: string) => {
      clearAll();
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(isRaw);
      if (selectedName !== undefined) {
        process.stdout.write(`\n  ${chalk.hex(BRAND).bold('›')} ${chalk.bold(mainLabel)}: ${chalk.reset(selectedName)}\n`);
      } else {
        process.stdout.write('\n');
      }
      resolve(val);
    };

    const onData = (chunk: Buffer) => {
      const code = chunk[0];

      // Arrow keys (ESC [ A/B)
      if (code === 0x1b && chunk[1] === 0x5b) {
        if (chunk[2] === 0x41) {       // up arrow
          clear(); selectedIndex = (selectedIndex - 1 + choices.length) % choices.length; draw();
        } else if (chunk[2] === 0x42) { // down arrow
          clear(); selectedIndex = (selectedIndex + 1) % choices.length; draw();
        }
        return;
      }

      // Bare ESC or ESC+null → go back
      if (code === 0x1b && (chunk.length === 1 || (chunk.length === 2 && chunk[1] === 0x00))) {
        cleanup(null); return;
      }

      // Enter
      if (code === 0x0d || code === 0x0a) {
        cleanup(choices[selectedIndex].value, choices[selectedIndex].name); return;
      }

      // q → go back
      if (code === 0x71) { cleanup(null); return; }

      // Ctrl+C
      if (code === 0x03) { cleanup(null); return; }
    };

    process.stdin.prependListener('data', onData);
  });
}

// ─── multiSelect() ───────────────────────────────────────────────────────────

async function multiSelect(_rl: any, message: string, choices: Choice[], preCheckedIndices?: Set<number>): Promise<any[]> {
  process.stdout.write(`\n${chalk.hex(BRAND).bold('  ›')} ${chalk.bold(message)}\n`);
  process.stdout.write(chalk.reset('  Space toggle   a select all   Enter confirm   q / Esc to go back\n\n'));

  // Insert "Select All" after the first 'finish' action item (so Done comes first, then Select All)
  const selectAllItem: Choice = { name: chalk.bold('Select All / Deselect All'), value: '__selectAll__' };
  const finishIdx = choices.findIndex(c => c.value === 'finish');
  const insertAt  = finishIdx >= 0 ? finishIdx + 1 : 0;
  const workChoices: Choice[] = [
    ...choices.slice(0, insertAt),
    selectAllItem,
    ...choices.slice(insertAt),
  ];
  // Shift pre-checked indices: only items at or after the insertion point move by +1
  const checked = new Set<number>(preCheckedIndices ? Array.from(preCheckedIndices).map(i => i >= insertAt ? i + 1 : i) : []);

  // Indices (into workChoices) that are regular toggleable items
  const regularIndices = workChoices
    .map((_, i) => i)
    .filter(i => workChoices[i].value !== '__selectAll__' && workChoices[i].value !== 'back' && workChoices[i].value !== 'finish');

  let selectedIndex = 0;
  const isRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  ensureKeypressEvents();

  const maxVisible = Math.max(5, (process.stdout.rows || 24) - 6);
  let scrollOffset = 0;
  let lastDrawnCount = 0;
  const msHeaderLines = 4; // \n + header + hint + \n

  const msMainLabel = message.split('\n')[0];

  const clearAll = () => {
    readlineModule.moveCursor(process.stdout, 0, -(lastDrawnCount + msHeaderLines));
    readlineModule.clearScreenDown(process.stdout);
  };

  const draw = () => {
    if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
    else if (selectedIndex >= scrollOffset + maxVisible) scrollOffset = selectedIndex - maxVisible + 1;

    const visible = workChoices.slice(scrollOffset, scrollOffset + maxVisible);
    const lines: string[] = [];

    if (scrollOffset > 0) lines.push(chalk.reset(`   ↑ ${scrollOffset} more above`));

    visible.forEach((choice, i) => {
      const ri = scrollOffset + i;
      const active      = ri === selectedIndex;
      const isAction    = choice.value === 'back' || choice.value === 'finish';
      const isSelectAll = choice.value === '__selectAll__';
      const cursor      = active ? chalk.hex(BRAND).bold(' ❯ ') : '   ';
      let checkbox      = '';
      if (isSelectAll) {
        const allChecked = regularIndices.length > 0 && regularIndices.every(j => checked.has(j));
        checkbox = allChecked ? chalk.green(' ◉  ') : chalk.reset(' ○  ');
      } else if (!isAction) {
        checkbox = checked.has(ri) ? chalk.green(' ◉  ') : chalk.reset(' ○  ');
      }
      const label = active ? chalk.hex(BRAND).bold(choice.name) : chalk.reset(choice.name);
      lines.push(`${cursor}${checkbox}${label}`);
    });

    const remaining = workChoices.length - scrollOffset - maxVisible;
    if (remaining > 0) lines.push(chalk.reset(`   ↓ ${remaining} more below`));

    lastDrawnCount = lines.length;
    lines.forEach(l => process.stdout.write(`${l}\n`));
  };

  const clear = () => {
    readlineModule.moveCursor(process.stdout, 0, -lastDrawnCount);
    readlineModule.clearScreenDown(process.stdout);
  };

  const toggleAll = () => {
    const allChecked = regularIndices.every(i => checked.has(i));
    if (allChecked) regularIndices.forEach(i => checked.delete(i));
    else regularIndices.forEach(i => checked.add(i));
    clear(); draw();
  };

  draw();

  return new Promise((resolve) => {
    const onKey = (_str: any, key: any) => {
      if (!key) return;
      if (key.name === 'up')   { clear(); selectedIndex = (selectedIndex - 1 + workChoices.length) % workChoices.length; draw(); }
      else if (key.name === 'down')  { clear(); selectedIndex = (selectedIndex + 1) % workChoices.length; draw(); }
      else if (key.name === 'a') { toggleAll(); }
      else if (key.name === 'space') {
        const c = workChoices[selectedIndex];
        if (c.value === '__selectAll__') { toggleAll(); return; }
        if (c.value === 'back' || c.value === 'finish') return;
        if (checked.has(selectedIndex)) checked.delete(selectedIndex); else checked.add(selectedIndex);
        clear(); draw();
      } else if (key.name === 'return') {
        clearAll();
        process.stdin.removeListener('keypress', onKey);
        process.stdin.setRawMode(isRaw);
        const sv = workChoices[selectedIndex].value;
        if (sv === 'back') {
          process.stdout.write('\n');
          resolve([sv]);
        } else {
          const result = Array.from(checked).filter(i => workChoices[i]?.value !== '__selectAll__').map(i => workChoices[i].value);
          process.stdout.write(`\n  ${chalk.hex(BRAND).bold('›')} ${chalk.bold(msMainLabel)} ${chalk.reset(`${result.length} selected`)}\n`);
          resolve(result);
        }
      } else if (key.name === 'q' || key.name === 'escape') {
        clearAll();
        process.stdin.removeListener('keypress', onKey);
        process.stdin.setRawMode(isRaw);
        process.stdout.write('\n');
        resolve([]);
      } else if (key.ctrl && key.name === 'c') {
        clearAll();
        process.stdin.removeListener('keypress', onKey);
        process.stdin.setRawMode(isRaw);
        resolve([]);
      }
    };
    process.stdin.on('keypress', onKey);
  });
}

// ─── input() / confirm() ─────────────────────────────────────────────────────

// Sentinel returned when user presses Esc during an input() prompt
const ESC  = '\x1b';
const EDIT = '\x01EDIT\x01';  // sentinel returned by input() hotkey for 'e'

async function input(_rl: any, message: string, defaultValue = '', hint = 'Esc cancel', hotkeys?: Record<string, string>): Promise<string> {
  const hintStr = hint ? `  ${chalk.reset(hint)}` : '';
  const prompt = `\n  ${chalk.hex(BRAND).bold('›')} ${chalk.bold(message)}${hintStr}: `;
  process.stdout.write(prompt);

  // Save and remove ALL existing stdin listeners so readline cannot double-echo
  const savedData     = process.stdin.rawListeners('data');
  const savedKeypress = process.stdin.rawListeners('keypress');
  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('keypress');

  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // Pre-populate buffer with defaultValue so user can edit it directly
  let buffer  = defaultValue;
  let cursor  = defaultValue.length;
  if (defaultValue) process.stdout.write(chalk.reset(defaultValue));

  // Redraw from cursor: erase to end, rewrite tail, move cursor back
  const redraw = (fromCursor: number) => {
    const tail = buffer.slice(fromCursor);
    process.stdout.write('\x1b[K' + tail);                  // erase to EOL, write tail
    if (tail.length > 0) process.stdout.write(`\x1b[${tail.length}D`); // move cursor back
  };

  const result: string = await new Promise((resolve) => {
    const cleanup = (val: string) => {
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(val);
    };

    const onData = (chunk: Buffer) => {
      const code = chunk[0];

      // Esc (bare or with null byte)
      if (code === 0x1b && (chunk.length === 1 || (chunk.length === 2 && chunk[1] === 0x00))) {
        cleanup(ESC);

      // Escape sequences
      } else if (code === 0x1b && chunk[1] === 0x5b) {
        const arrow = chunk[2];
        if (arrow === 0x43) {                              // right arrow
          if (cursor < buffer.length) { cursor++; process.stdout.write('\x1b[C'); }
        } else if (arrow === 0x44) {                       // left arrow
          if (cursor > 0) { cursor--; process.stdout.write('\x1b[D'); }
        } else if (arrow === 0x48 || chunk[2] === 0x31) {  // Home
          if (cursor > 0) { process.stdout.write(`\x1b[${cursor}D`); cursor = 0; }
        } else if (arrow === 0x46 || chunk[2] === 0x34) {  // End
          if (cursor < buffer.length) { process.stdout.write(`\x1b[${buffer.length - cursor}C`); cursor = buffer.length; }
        }

      } else if (code === 0x03) {                          // Ctrl+C
        cleanup(ESC);

      } else if (code === 0x01) {                          // Ctrl+A — go to start
        if (cursor > 0) { process.stdout.write(`\x1b[${cursor}D`); cursor = 0; }

      } else if (code === 0x05) {                          // Ctrl+E — go to end
        if (cursor < buffer.length) { process.stdout.write(`\x1b[${buffer.length - cursor}C`); cursor = buffer.length; }

      } else if (code === 0x0d || code === 0x0a) {         // Enter
        cleanup(buffer.trim());

      } else if (code === 0x7f || code === 0x08) {         // Backspace
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor--;
          process.stdout.write('\x1b[D');                  // move left
          redraw(cursor);
        }

      } else if (code >= 0x20) {                           // Printable character
        const ch = chunk.toString('utf8');
        // Hotkey: intercept single char when buffer is untouched (no echo, returns sentinel)
        if (hotkeys && buffer === defaultValue && hotkeys[ch] !== undefined) {
          cleanup(hotkeys[ch]);
          return;
        }
        buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
        cursor += ch.length;
        process.stdout.write(ch);
        redraw(cursor);
      }
    };

    process.stdin.on('data', onData);
  });

  // Restore all saved listeners
  process.stdin.setRawMode(wasRaw);
  savedData.forEach((l: any)     => process.stdin.on('data',     l));
  savedKeypress.forEach((l: any) => process.stdin.on('keypress', l));

  return result;
}

async function confirm(rl: any, message: string, defaultTrue = true): Promise<boolean> {
  const hint = defaultTrue ? 'Y/n' : 'y/N';
  const answer = await input(rl, `${message} [${hint}]`);
  if (answer === ESC) return false;            // Esc always cancels
  if (!answer.trim()) return defaultTrue;      // Enter keeps default
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

// ─── addEnvironmentMenu() ────────────────────────────────────────────────────

async function addEnvironmentMenu(rl: any) {
  sectionHeader('Manage Environments', '⚙️');

  const appConfig = requireJson(CONFIG_PATH);
  const allEnvs   = Object.keys(appConfig.kubeconfigs || {});

  // Step 1: pick action or environment
  const choices: Choice[] = [
    { name: chalk.green('➕  Add new environment'), value: 'add' },
    ...allEnvs.map(e => {
      const isCurrent = e === appConfig.currentKubeconfig;
      return { name: isCurrent ? `${chalk.green('●')}  ${chalk.bold(e)}  ${chalk.green('← active')}` : `○  ${e}`, value: e };
    }),
    { name: chalk.reset('← Back'), value: 'back' },
  ];

  const selected = await select(rl, 'Select environment:', choices);
  if (!selected || selected === 'back') return;

  if (selected === 'add') {
    // ── Step 1: Environment name ──────────────────────────────────────────────
    const name = await input(rl, '1/6  Environment name');
    if (!name || name === ESC) return;
    if (/\s/.test(name)) { errorMsg('Environment name cannot contain spaces.'); return; }
    if (appConfig.kubeconfigs?.[name]) { errorMsg(`Environment "${name}" already exists. Use Edit to modify it.`); return; }

    // ── Step 2: Kubeconfig ────────────────────────────────────────────────────
    process.stdout.write(chalk.reset('\n  Paste the base64-encoded kubeconfig or enter a file path.\n  The file will be saved as kubeconfigs/kubeconfig-' + name + '.yaml\n\n'));
    const kubeconfigInput = await input(rl, '2/6  Kubeconfig (base64 or file path)');
    if (!kubeconfigInput || kubeconfigInput === ESC) return;

    // ── Step 3: Namespace ─────────────────────────────────────────────────────
    const ns = await input(rl, '3/6  Namespace', 'default');
    if (ns === ESC) return;

    // ── Step 4: UI Domain ─────────────────────────────────────────────────────
    const uiDomain = await input(rl, '4/6  UI Domain (optional)');
    if (uiDomain === ESC) return;

    // ── Step 5: API Domain ────────────────────────────────────────────────────
    const apiDomain = await input(rl, '5/6  API Domain (optional)');
    if (apiDomain === ESC) return;

    // ── Step 6: API Key ───────────────────────────────────────────────────────
    const apiKey = await input(rl, '6/6  API Key (optional)');
    if (apiKey === ESC) return;

    // ── Save kubeconfig file ──────────────────────────────────────────────────
    const kubeconfigsDir = path.join(PROJECT_ROOT, 'kubeconfigs');
    if (!existsSync(kubeconfigsDir)) {
      try { execSync(`mkdir -p "${kubeconfigsDir}"`); } catch {}
    }
    const destRelative = `kubeconfigs/kubeconfig-${name}.yaml`;
    const destPath     = path.join(PROJECT_ROOT, destRelative);

    const looksLikePath = kubeconfigInput.includes('/') || kubeconfigInput.includes('\\') ||
                          kubeconfigInput.startsWith('~') || /\.(yaml|yml)$/i.test(kubeconfigInput);

    if (looksLikePath) {
      const srcPath = path.isAbsolute(kubeconfigInput)
        ? kubeconfigInput
        : kubeconfigInput.startsWith('~')
          ? kubeconfigInput.replace(/^~/, process.env.HOME || '')
          : path.join(process.cwd(), kubeconfigInput);
      if (!existsSync(srcPath)) { errorMsg(`File not found: ${srcPath}`); return; }
      try { writeFileSync(destPath, readFileSync(srcPath, 'utf-8')); }
      catch (e: any) { errorMsg(`Failed to copy kubeconfig: ${e.message}`); return; }
    } else {
      try {
        const decoded = Buffer.from(kubeconfigInput.trim(), 'base64').toString('utf-8');
        if (!decoded.includes('apiVersion') && !decoded.includes('clusters')) {
          errorMsg('Decoded content does not look like a valid kubeconfig. Check your base64 string.'); return;
        }
        writeFileSync(destPath, decoded);
      } catch (e: any) { errorMsg(`Failed to decode base64: ${e.message}`); return; }
    }

    // ── Write app-config.json ─────────────────────────────────────────────────
    appConfig.kubeconfigs = appConfig.kubeconfigs || {};
    appConfig.kubeconfigs[name] = {
      file:          destRelative,
      namespace:     ns || 'default',
      uiDomain:      uiDomain  || '',
      apiDomain:     apiDomain || '',
      apiKey:        apiKey    || '',
      enableUpdates: true,
    };
    appConfig.currentKubeconfig = name;

    writeFileSync(CONFIG_PATH, JSON.stringify(appConfig, null, 2) + '\n');
    successMsg(`Environment "${name}" added and set as active.`);
    infoRow('Kubeconfig', destRelative);
    if (uiDomain)  infoRow('UI Domain',  uiDomain);
    if (apiDomain) infoRow('API Domain', apiDomain);
    process.stdout.write('\n');

    // ── Auto-generate checkpoint mapping + model profiles + PEF configs ──────
    await runDataFileStepTracker(destPath, ns || 'default');

    // ── Stay in sub-menu for the new environment ───────────────────────────────
    process.stdout.write('\n');
    while (true) {
      const freshConfig  = requireJson(CONFIG_PATH);
      const actionChoices: Choice[] = [
        { name: '🔍  Validate',         value: 'validate' },
        { name: '✏️   Edit',             value: 'edit' },
        { name: chalk.red('🗑️   Delete'), value: 'delete' },
        { name: chalk.reset('← Back'),   value: 'back' },
      ];
      const action = await select(rl, `${name}:`, actionChoices);
      if (!action || action === 'back') break;

      if (action === 'validate') {
        const ec    = freshConfig.kubeconfigs[name];
        if (!ec) { errorMsg(`Environment "${name}" not found.`); continue; }
        const envNs = ec.namespace || 'default';
        const kPath = path.join(PROJECT_ROOT, ec.file || '');
        if (ec.file && existsSync(kPath)) process.env.KUBECONFIG = kPath;
        await runValidationChecks(name, ec, envNs);
      } else if (action === 'edit') {
        const ec = freshConfig.kubeconfigs[name] || {};
        process.stdout.write(chalk.reset(`\n  Editing: ${chalk.bold(name)}  (Enter to keep current value)\n\n`));
        const file      = await input(rl, 'Kubeconfig file', ec.file      || '');
        if (file === ESC) continue;
        const editNs    = await input(rl, 'Namespace',        ec.namespace || 'default');
        if (editNs === ESC) continue;
        const uiD       = await input(rl, 'UI Domain',        ec.uiDomain  || '');
        if (uiD === ESC) continue;
        const apiD      = await input(rl, 'API Domain',       ec.apiDomain || '');
        if (apiD === ESC) continue;
        const aKey      = await input(rl, 'API Key',          ec.apiKey    || '');
        if (aKey === ESC) continue;
        const enableUpdStr = await input(rl, 'Enable Updates (y/n)', ec.enableUpdates === false ? 'n' : 'y');
        if (enableUpdStr === ESC) continue;
        freshConfig.kubeconfigs[name] = {
          ...ec,
          file:          file    || ec.file,
          namespace:     editNs  || ec.namespace,
          uiDomain:      uiD,
          apiDomain:     apiD,
          apiKey:        aKey,
          enableUpdates: enableUpdStr.toLowerCase() !== 'n',
        };
        writeFileSync(CONFIG_PATH, JSON.stringify(freshConfig, null, 2) + '\n');
        successMsg(`Environment "${name}" updated.`);
      } else if (action === 'delete') {
        const ok = await confirm(rl, chalk.red(`Delete environment "${name}"?`), false);
        if (!ok) { process.stdout.write(chalk.reset('  Cancelled.\n\n')); continue; }
        delete freshConfig.kubeconfigs[name];
        if (freshConfig.currentKubeconfig === name) {
          const remaining = Object.keys(freshConfig.kubeconfigs);
          freshConfig.currentKubeconfig = remaining[0] || null;
        }
        writeFileSync(CONFIG_PATH, JSON.stringify(freshConfig, null, 2) + '\n');
        successMsg(`Environment "${name}" deleted.`);
        break;
      }
    }
    return;
  }

  // Step 2: action loop — stays in sub-menu until Back/Activate/Delete
  const envName = selected;
  while (true) {
    const freshConfig = requireJson(CONFIG_PATH);
    const isCurrent   = envName === freshConfig.currentKubeconfig;
    const actionChoices: Choice[] = [];
    if (!isCurrent) actionChoices.push({ name: chalk.yellow('⚡  Activate'), value: 'activate' });
    actionChoices.push({ name: '🔍  Validate',         value: 'validate' });
    actionChoices.push({ name: '✏️   Edit',             value: 'edit' });
    actionChoices.push({ name: chalk.red('🗑️   Delete'), value: 'delete' });
    actionChoices.push({ name: chalk.reset('← Back'),   value: 'back' });

    const action = await select(rl, `${envName}:`, actionChoices);
    if (!action || action === 'back') break;

    if (action === 'activate') {
      const ec    = freshConfig.kubeconfigs[envName];
      const kFile = ec?.file;
      if (!kFile || !existsSync(path.join(PROJECT_ROOT, kFile))) {
        errorMsg(`Kubeconfig file not found for "${envName}": ${kFile || '(not set)'}`);
        continue;
      }
      freshConfig.currentKubeconfig = envName;
      writeFileSync(CONFIG_PATH, JSON.stringify(freshConfig, null, 2) + '\n');
      successMsg(`"${envName}" is now the active environment.`);
      const kPath  = path.join(PROJECT_ROOT, kFile);
      const ns     = ec.namespace || 'default';
      await runDataFileStepTracker(kPath, ns);
      break; // leave sub-menu after activate

    } else if (action === 'validate') {
      const ec    = freshConfig.kubeconfigs[envName];
      if (!ec) { errorMsg(`Environment "${envName}" not found.`); continue; }
      const ns    = ec.namespace || 'default';
      const kPath = path.join(PROJECT_ROOT, ec.file || '');
      if (ec.file && existsSync(kPath)) process.env.KUBECONFIG = kPath;
      await runValidationChecks(envName, ec, ns);
      // stay in sub-menu after validate

    } else if (action === 'edit') {
      const ec = freshConfig.kubeconfigs[envName] || {};
      process.stdout.write(chalk.reset(`\n  Editing: ${chalk.bold(envName)}  (Enter to keep current value)\n\n`));

      const file      = await input(rl, 'Kubeconfig file', ec.file      || '');
      if (file === ESC) continue;
      const ns        = await input(rl, 'Namespace',        ec.namespace || 'default');
      if (ns === ESC) continue;
      const uiDomain  = await input(rl, 'UI Domain',        ec.uiDomain  || '');
      if (uiDomain === ESC) continue;
      const apiDomain = await input(rl, 'API Domain',       ec.apiDomain || '');
      if (apiDomain === ESC) continue;
      const apiKey    = await input(rl, 'API Key',          ec.apiKey    || '');
      if (apiKey === ESC) continue;
      const enableUpdStr2 = await input(rl, 'Enable Updates (y/n)', ec.enableUpdates === false ? 'n' : 'y');
      if (enableUpdStr2 === ESC) continue;

      freshConfig.kubeconfigs[envName] = {
        ...ec,
        file:          file      || ec.file,
        namespace:     ns        || ec.namespace,
        uiDomain:      uiDomain,
        apiDomain:     apiDomain,
        apiKey:        apiKey,
        enableUpdates: enableUpdStr2.toLowerCase() !== 'n',
      };
      writeFileSync(CONFIG_PATH, JSON.stringify(freshConfig, null, 2) + '\n');
      successMsg(`Environment "${envName}" updated.`);
      // stay in sub-menu after edit

    } else if (action === 'delete') {
      const ok = await confirm(rl, chalk.red(`Delete environment "${envName}"?`), false);
      if (!ok) { process.stdout.write(chalk.reset('  Cancelled.\n\n')); continue; }

      delete freshConfig.kubeconfigs[envName];
      if (freshConfig.currentKubeconfig === envName) {
        const remaining = Object.keys(freshConfig.kubeconfigs);
        freshConfig.currentKubeconfig = remaining[0] || null;
      }
      writeFileSync(CONFIG_PATH, JSON.stringify(freshConfig, null, 2) + '\n');
      successMsg(`Environment "${envName}" deleted.`);
      break; // leave sub-menu after delete
    }
  }
}

// ─── startCli() ──────────────────────────────────────────────────────────────

async function startCli() {
  // terminal:false disables readline's built-in echo/line-editing so it doesn't
  // interfere with our raw-mode input() / select() handlers
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  const version = getAppVersion();

  const banner = [
    ' ____                  _        __        ___     ',
    '/ ___|  __ _ _ __ ___ | |__   __ \\ \\      / (_)____',
    '\\___ \\ / _` | \'_ ` _ \\| \'_ \\ / _` \\ \\ /\\ / /| |_  /',
    ' ___) | (_| | | | | | | |_) | (_| |\\ V  V / | |/ / ',
    '|____/ \\__,_|_| |_| |_|_.__/ \\__,_| \\_/\\_/  |_/___|',
  ];

  process.stdout.write('\n');
  banner.forEach(l => process.stdout.write(chalk.hex(BRAND).bold('  ' + l) + '\n'));
  process.stdout.write('\n');
  process.stdout.write(
    chalk.hex(BRAND)('  ') +
    chalk.hex(BRAND).bold('SambaWiz') +
    chalk.reset(' CLI') +
    (version ? chalk.reset(`  v${version}`) : '') +
    '\n'
  );
  process.stdout.write(chalk.reset('  SambaStack Bundle Management\n\n'));
  hr();

  process.stdout.write(chalk.reset.bold('\n  Prerequisites:\n'));
  process.stdout.write(chalk.reset('  • kubectl installed and on PATH\n'));
  process.stdout.write(chalk.reset('  • helm installed and on PATH\n'));
  process.stdout.write(chalk.reset('  • app-config.json configured with valid kubeconfig paths\n'));
  process.stdout.write(chalk.reset('  • API domain and key set in app-config.json\n\n'));

  if (!existsSync(CONFIG_PATH)) {
    errorMsg(`app-config.json not found at ${CONFIG_PATH}`);
    rl.close(); process.exit(1);
  }

  function loadEnvConfig() {
    const config = requireJson(CONFIG_PATH);
    const env = config.currentKubeconfig;
    if (!env || !config.kubeconfigs?.[env]) {
      return { appConfig: config, envConfig: null, namespace: 'default', currentEnv: env, error: 'Environment not configured in app-config.json.' };
    }
    const envConf = config.kubeconfigs[env];
    const ns      = envConf.namespace || 'default';
    const kPath   = path.join(PROJECT_ROOT, envConf.file);
    if (!existsSync(kPath)) {
      return { appConfig: config, envConfig: envConf, namespace: ns, currentEnv: env, error: `Kubeconfig file not found: ${envConf.file}` };
    }
    process.env.KUBECONFIG = kPath;
    return { appConfig: config, envConfig: envConf, namespace: ns, currentEnv: env, error: null };
  }

  function checkKubeconfigExists(config: any, envName: string) {
    const ec = config.kubeconfigs[envName];
    if (!ec?.file) return false;
    return existsSync(path.join(PROJECT_ROOT, ec.file));
  }

  let loaded = loadEnvConfig();

  if (loaded.error) {
    warnMsg(loaded.error);
    const allEnvs   = Object.keys(loaded.appConfig.kubeconfigs || {});
    const validEnvs = allEnvs.filter(e => checkKubeconfigExists(loaded.appConfig, e));

    if (validEnvs.length > 0) {
      const envChoices: Choice[] = [
        ...validEnvs.map(e => ({ name: e, value: e })),
        { name: chalk.reset('← Skip (fix later via Manage Environments)'), value: 'skip' },
      ];

      const chosen = await select(rl, 'Select a valid environment to continue:', envChoices);
      if (chosen && chosen !== 'skip') {
        loaded.appConfig.currentKubeconfig = chosen;
        writeFileSync(CONFIG_PATH, JSON.stringify(loaded.appConfig, null, 2) + '\n');
        loaded = loadEnvConfig();
        if (!loaded.error) {
          successMsg(`Switched to: ${loaded.currentEnv}  (namespace: ${loaded.namespace})`);
        }
      }
    } else {
      warnMsg('No kubeconfig files found — use Manage Environments → Add to set one up.');
    }
  }

  let { envConfig, namespace, currentEnv } = loaded;

  // ── Startup: step tracker ────────────────────────────────────────────────────
  if (envConfig) {
    const kPath = path.join(PROJECT_ROOT, envConfig.file);
    if (existsSync(kPath)) {
      await runDataFileStepTracker(kPath, namespace, `${currentEnv} / ${namespace}`);
    }
  }

  let exitLoop = false;
  while (!exitLoop) {
    const envBadge = chalk.hex(BRAND)(`[${currentEnv}]`);
    const action = await select(rl, `Main Menu  ${envBadge}`, [
      { name: `⚙️   Manage Environments`,               value: 'add_env',        hint: 'Add, activate, edit, delete and validate' },
      { name: `🧱  Model Selection`,                   value: 'bundle_builder', hint: 'Create and validate ModelBundles' },
      { name: `🚀  Model Deployment`,                  value: 'bundle_deploy',  hint: 'Deploy or delete ModelDeployments' },
      { name: `📈  Check Deployment Progress`,         value: 'monitor_deploy', hint: 'Live pod status monitor' },
      { name: `🤖  Playground (Chat Console)`,         value: 'playground',     hint: 'Chat with deployed models' },
      { name: chalk.yellow('⏹️   Exit'),               value: 'exit' },
    ], true);

    if (!action) continue;

    switch (action) {
      case 'add_env':
        await addEnvironmentMenu(rl);
        // Reload config in case environment changed
        { const r = loadEnvConfig(); if (!r.error) ({ envConfig, namespace, currentEnv } = r); }
        break;
      case 'bundle_builder':
        await bundleBuilderMenu(rl, namespace);
        break;
      case 'bundle_deploy':
        await bundleDeploymentMenu(rl, namespace);
        break;
      case 'monitor_deploy':
        await monitorMenu(rl, namespace);
        break;
      case 'playground':
        await playgroundMenu(rl, envConfig, namespace);
        break;
      case 'exit':
        exitLoop = true;
        break;
    }
  }

  process.stdout.write('\n' + chalk.hex(BRAND).bold('  Goodbye! 👋') + '\n\n');
  rl.close();
}

// ─── runValidationChecks() ───────────────────────────────────────────────────

async function runValidationChecks(envName: string, envConfig: any, namespace: string) {
  sectionHeader('Validate Setup & Environment', '🧭');

  process.stdout.write('\n');
  infoRow('Environment', envName);
  infoRow('Namespace',   namespace);
  process.stdout.write('\n');
  hr();
  process.stdout.write('\n');

  let allPassed = true;

  // 1. Kubeconfig
  spinner.start('Checking kubeconfig...');
  await tick();
  const kFile = envConfig.file;
  const kPath = path.join(PROJECT_ROOT, kFile);
  if (kFile && existsSync(kPath)) {
    spinner.succeed(`Kubeconfig  ${chalk.reset(kFile)}`);
  } else {
    spinner.fail(`Kubeconfig not found: ${kFile || '(not set)'}`);
    allPassed = false;
  }

  // 2. Helm
  spinner.start('Checking Helm...');
  await tick();
  try {
    const helmVer = execSync('helm version --short', { encoding: 'utf-8' }).trim();
    spinner.succeed(`Helm  ${chalk.reset(helmVer)}`);
  } catch {
    spinner.fail('Helm not found — please install Helm');
    allPassed = false;
  }

  // 2b. SambaStack Helm chart version
  spinner.start('Checking SambaStack chart version...');
  await tick();
  try {
    const minVer  = getMinHelmVersion();
    const kPath   = path.join(PROJECT_ROOT, kFile);
    const helmEnv = { ...process.env, KUBECONFIG: kPath };
    // Try all namespaces first; fall back to common sambastack namespaces if cluster-wide list is denied
    let raw: string = '';
    try {
      raw = execSync('helm list -A -o json', { env: helmEnv, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
    } catch {
      // -A may be forbidden — try known namespaces directly
      const tryNs = [namespace, 'sambastack', 'default'].filter(Boolean);
      let found = false;
      for (const ns of tryNs) {
        try {
          raw = execSync(`helm list -n ${ns} -o json`, { env: helmEnv, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
          found = true; break;
        } catch { /* try next */ }
      }
      if (!found) throw new Error('helm list failed in all tried namespaces');
    }
    const releases: any[] = JSON.parse(raw);
    const release = releases.find((r: any) => typeof r.chart === 'string' && r.chart.toLowerCase().startsWith('sambastack'));
    if (!release) {
      spinner.warn('SambaStack release not found in any namespace');
    } else {
      const chartVer = release.chart.replace(/^sambastack-/i, '');
      if (minVer && compareVersions(chartVer, minVer) < 0) {
        spinner.fail(`SambaStack ${chartVer}  (minimum: ${minVer})`);
        process.stdout.write(chalk.red(`\n  The installed SambaStack Helm chart version (${chartVer}) is older than the minimum required version (${minVer}).\n  Please upgrade your SambaStack installation.\n\n`));
        allPassed = false;
      } else {
        spinner.succeed(`SambaStack  ${chalk.reset(chartVer)}${minVer ? chalk.reset(`  (min: ${minVer})`) : ''}`);
      }
    }
  } catch (e: any) {
    spinner.warn(`SambaStack version check skipped: ${e.message.split('\n')[0]}`);
  }

  // 3. Kubernetes
  spinner.start('Checking Kubernetes connection...');
  await tick();
  try {
    execSync(`kubectl cluster-info`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000 });
    spinner.succeed('Kubernetes connection OK');
  } catch (err: any) {
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    const detail = stderr || err.message || 'Unknown error';
    spinner.fail('Kubernetes connection failed');
    process.stdout.write(chalk.red(`\n  ${detail}\n\n`));
    allPassed = false;
  }

  // 4. Namespace
  spinner.start(`Checking namespace "${namespace}"...`);
  await tick();
  if (namespace && namespace !== 'default') {
    try {
      execSync(`kubectl get namespace ${namespace}`, { encoding: 'utf-8', stdio: ['pipe','pipe','pipe'] });
      spinner.succeed(`Namespace "${namespace}" exists`);
    } catch {
      spinner.fail(`Namespace "${namespace}" not found on cluster`);
      allPassed = false;
    }
  } else {
    spinner.warn('Using default namespace');
  }

  // 5. API
  process.stdout.write('\n');
  if (!envConfig.apiDomain) {
    checkRow(chalk.red('✖'), 'API Domain', 'not configured');
    allPassed = false;
  } else {
    infoRow('API Domain', envConfig.apiDomain);
  }

  if (!envConfig.apiKey) {
    checkRow(chalk.red('✖'), 'API Key', 'not configured');
    allPassed = false;
  } else {
    const masked = envConfig.apiKey.slice(0, 4) + '••••••••' + envConfig.apiKey.slice(-4);
    infoRow('API Key', masked);
  }

  if (envConfig.apiDomain && envConfig.apiKey) {
    const baseUrl = normalizeApiUrl(envConfig.apiDomain);

    spinner.start('Testing /v1/models...');
    let availableModels: string[] = [];
    try {
      const res   = execSync(`curl -sk -w "\\n%{http_code}" "${baseUrl}v1/models" -H "Authorization: Bearer ${envConfig.apiKey}"`, { encoding: 'utf-8', timeout: 15000 });
      const parts = res.trimEnd().split('\n');
      const code  = safeParseInt(parts.pop());
      const body  = parts.join('\n');

      if (code >= 200 && code < 300) {
        try {
          const md = JSON.parse(body);
          availableModels = (md.data || md.models || []).map((m: any) => m.id || m.name || m).filter(Boolean);
        } catch {}
        spinner.succeed(`API reachable  ${availableModels.length > 0 ? chalk.reset(`(${availableModels.length} models)`) : ''}`);
        if (availableModels.length > 0) {
          process.stdout.write(chalk.reset(`     ${availableModels.slice(0, 3).join(', ')}${availableModels.length > 3 ? ` +${availableModels.length - 3} more` : ''}\n`));
        }
      } else if (code === 401 || code === 403) {
        spinner.fail(`/v1/models → ${code}  API key may be invalid`);
        allPassed = false;
      } else if (code === 404) {
        spinner.succeed('API reachable  (no model list endpoint)');
      } else {
        spinner.warn(`/v1/models → ${code}`);
      }
    } catch (e: any) {
      spinner.fail(`Cannot reach API: ${e.message.split('\n')[0]}`);
      allPassed = false;
    }

    // Only run chat test if /v1/models didn't already confirm auth (no models deployed yet = normal)
    if (availableModels.length > 0) {
      spinner.start('Validating API key via chat endpoint...');
      try {
        const testModel   = availableModels[0];
        const chatPayload = JSON.stringify({ model: testModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false });
        const res = execSync(
          `curl -sk -w "\\n%{http_code}" -X POST "${baseUrl}v1/chat/completions" ` +
          `-H "Content-Type: application/json" -H "Authorization: Bearer ${envConfig.apiKey}" ` +
          `-d '${chatPayload.replace(/'/g, "'\\''")}'`,
          { encoding: 'utf-8', timeout: 30000 }
        );
        const parts = res.trimEnd().split('\n');
        const code  = safeParseInt(parts.pop());

        if (code >= 200 && code < 300) {
          spinner.succeed(`API key valid  ${chalk.reset(`(tested with ${testModel})`)}`);
        } else if (code === 401 || code === 403) {
          // Only fail if /v1/models also didn't confirm auth — here it did, so just warn
          spinner.warn(`Chat endpoint → ${code}  (model may not be deployed yet)`);
        } else if (code === 404 || code === 400 || code === 422 || code === 503) {
          spinner.succeed(`API key valid  ${chalk.reset('(auth passed, model not deployed)')}`);
        } else {
          spinner.warn(`Chat endpoint → ${code}`);
        }
      } catch (e: any) {
        spinner.warn(`Chat endpoint unreachable: ${e.message.split('\n')[0]}`);
      }
    }
  }

  // 6. UI Domain
  if (envConfig.uiDomain) {
    process.stdout.write('\n');
    infoRow('UI Domain', envConfig.uiDomain);
    spinner.start('Checking UI Domain...');
    try {
      const code = safeParseInt(execSync(
        `curl -sk -o /dev/null -w "%{http_code}" --head "${envConfig.uiDomain}"`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim());
      if (code === 0) {
        spinner.fail('UI Domain unreachable — no response');
        allPassed = false;
      } else {
        spinner.succeed('UI Domain reachable');
      }
    } catch (e: any) {
      spinner.fail(`UI Domain unreachable: ${e.message.split('\n')[0]}`);
      allPassed = false;
    }
  }

  process.stdout.write('\n');
  hr();
  if (allPassed) {
    successMsg('All checks passed!');
    // Regenerate checkpoint mapping, model profiles and PEF configs now that
    // cluster connectivity is confirmed.
    try {
      await generateCheckpointMapping(kPath, namespace);
    } catch (e: any) {
      spinner.fail(`Checkpoint mapping failed: ${e.message.split('\n')[0]}`);
      process.stdout.write(chalk.yellow(`\n  Model Selection will not work until checkpoint_mapping.json is generated.\n\n`));
    }
  } else {
    errorMsg('Some checks failed — review app-config.json');
  }
}

// tiny async tick so spinner renders at least once
function tick() { return new Promise(r => setTimeout(r, 120)); }

// ─── bundleBuilderMenu() ─────────────────────────────────────────────────────
// Implements the v3plan.md "V3 SambaWiz UX & implementation plan" Steps 1–4:
// select model(s) → pick arch (if multi-arch) → pick exactly one ModelProfile
// per model (+ optional draft model for spec decoding) → override the
// profile's batching config → emit a single ModelBundle.

/** Prints a profile "card" (display name, per-tier batch sizes, features). */
function printProfileCard(profile: ModelProfile, siblings: ModelProfile[]) {
  const label = getDisplayName(profile, siblings);
  const cfg = getEffectiveBatchingConfig(profile);
  process.stdout.write(chalk.reset.bold(`\n  ${label}\n`));
  Object.entries(cfg).forEach(([tier, v]) => {
    const bs = Array.isArray(v.batch_sizes) ? `[${v.batch_sizes.join(', ')}]` : v.batch_sizes;
    process.stdout.write(chalk.reset(`    ${tier}: batch_sizes=${bs}\n`));
  });
  const features = profile.spec.features.length > 0 ? profile.spec.features.join(', ') : 'default';
  process.stdout.write(chalk.reset(`    Features: ${features}\n\n`));
}

/**
 * Step 2 (+ arch dropdown): resolves exactly one `{ arch, profile }` pair for
 * a model. Returns `null` when the model has no matching profile (Q4 guard)
 * or the user backs out.
 */
async function selectArchAndProfile(
  rl: any,
  displayName: string,
  model: Model,
  modelProfiles: ModelProfilesCache,
): Promise<{ arch: string; profile: ModelProfile } | null> {
  const archsWithProfiles = getArchsWithProfiles(model.spec.checkpoints, modelProfiles);
  if (archsWithProfiles.length === 0) {
    warnMsg(`No matching model profile was found for ${displayName} — it cannot be added to the bundle.`);
    return null;
  }

  let arch: string;
  if (archsWithProfiles.length === 1) {
    arch = archsWithProfiles[0];
  } else {
    const archChoices: Choice[] = archsWithProfiles.map((a) => {
      const hv = getHighestVersion(model, a);
      const status = model.spec.checkpoints[a].versions[hv]?.checkpoint_status;
      return { name: `${a}${status ? `  (${status})` : ''}`, value: a };
    });
    archChoices.push({ name: chalk.reset('← Back'), value: 'back' });
    const chosen = await select(rl, `Select checkpoint arch for ${displayName}:`, archChoices);
    if (!chosen || chosen === 'back') return null;
    arch = chosen;
  }

  const profiles = getProfilesForArch(arch, modelProfiles);
  let profile: ModelProfile;
  if (profiles.length === 1) {
    profile = profiles[0];
    process.stdout.write(chalk.reset(`  Auto-selected profile: ${chalk.bold(getDisplayName(profile, profiles))}\n`));
  } else {
    const choices: Choice[] = profiles.map((p) => {
      const label = getDisplayName(p, profiles);
      const cfg = getEffectiveBatchingConfig(p);
      const tiers = Object.entries(cfg)
        .map(([t, v]) => `${t}:[${Array.isArray(v.batch_sizes) ? v.batch_sizes.join(',') : v.batch_sizes}]`)
        .join(' ');
      const features = p.spec.features.length > 0 ? p.spec.features.join(', ') : 'default';
      return { name: label, value: p, hint: `${tiers}   Features: ${features}` };
    });
    choices.push({ name: chalk.reset('← Back'), value: 'back' });
    const chosen = await select(rl, `Select a profile for ${displayName}:`, choices);
    if (!chosen || chosen === 'back') return null;
    profile = chosen;
  }

  printProfileCard(profile, profiles);
  return { arch, profile };
}

/** Step 3: optional bundle-level batching-config override, seeded from the profile's effective default. */
async function promptBatchingOverride(rl: any, profile: ModelProfile): Promise<BatchingConfig | undefined> {
  const effective = getEffectiveBatchingConfig(profile);
  const tiers = Object.keys(effective);
  if (tiers.length === 0) return undefined;

  const wantsOverride = await confirm(rl, "Override this profile's batching config for the bundle?", false);
  if (!wantsOverride) return undefined;

  const override: BatchingConfig = {};
  for (const tier of tiers) {
    const current = effective[tier].batch_sizes;
    const defaultStr = Array.isArray(current) ? current.join(',') : current;
    const raw = await input(rl, `Batch sizes for tier ${tier} (comma-separated, or * for all)`, String(defaultStr));
    const effectiveRaw = raw === ESC ? String(defaultStr) : (raw || String(defaultStr));
    override[tier] = { batch_sizes: parseBatchSizesInput(effectiveRaw) };
  }
  return override;
}

/** Steps 1–3 combined: interactively builds the full `ModelBundleSelection[]` list, including spec-decoding drafts. */
async function collectModelSelections(
  rl: any,
  checkpointMapping: CheckpointMappingV3,
  modelProfiles: ModelProfilesCache
): Promise<ModelBundleSelection[]> {
  const selections: ModelBundleSelection[] = [];
  const displayNames = Object.keys(checkpointMapping).sort();

  let adding = true;
  while (adding) {
    const addedCrnames = new Set(selections.map((s) => s.model.metadata.name));
    const choices: Choice[] = [
      { name: chalk.green.bold('✅  Finish and Create Bundle'), value: 'finish',
        hint: selections.length > 0 ? `${selections.length} model(s) selected` : '' },
      ...displayNames.map((name) => {
        const entry = checkpointMapping[name];
        const already = addedCrnames.has(entry.resource_name);
        const hasProfile = getArchsWithProfiles(entry.checkpoints, modelProfiles).length > 0;
        const label = `${already ? chalk.green('✔ ') : ''}${name}${hasProfile ? '' : chalk.reset('  (no matching profile)')}`;
        return { name: label, value: name };
      }),
      { name: chalk.red('✕  Cancel'), value: 'cancel' },
    ];

    const chosenName = await select(rl, `Model Selection  (${selections.length} added)`, choices);
    if (!chosenName || chosenName === 'cancel') return [];
    if (chosenName === 'finish') {
      if (selections.length === 0) { warnMsg('Add at least one model first.'); continue; }
      adding = false;
      continue;
    }

    const entry = checkpointMapping[chosenName];
    const model = toModelCR(chosenName, entry);

    // Re-selecting an already-added model removes it (and its draft, if any)
    // so the user can redo the flow — mirrors the old "edit by re-selecting" UX.
    const existingIdx = selections.findIndex((s) => s.model.metadata.name === entry.resource_name && !s.isDraftFor);
    if (existingIdx >= 0) {
      const removedCrname = selections[existingIdx].model.metadata.name;
      for (let i = selections.length - 1; i >= 0; i--) {
        if (selections[i].model.metadata.name === removedCrname || selections[i].isDraftFor === removedCrname) {
          selections.splice(i, 1);
        }
      }
      successMsg(`Removed ${chosenName} — re-select to add it back`);
      continue;
    }

    const picked = await selectArchAndProfile(rl, chosenName, model, modelProfiles);
    if (!picked) continue;
    const { arch, profile } = picked;

    const batchingConfigOverride = await promptBatchingOverride(rl, profile);

    selections.push({ model, arch, profile, batchingConfigOverride });
    successMsg(`Added ${chosenName}  (${getDisplayName(profile, getProfilesForArch(arch, modelProfiles))})`);

    // Spec-decoding draft model (Q12: experts always omitted; drives specDecodingPairs)
    if (isSpecDecodingProfile(profile)) {
      process.stdout.write(chalk.yellow(`\n  ⚡ ${chosenName}'s profile uses speculative-decoding PEFs.\n`));
      process.stdout.write(chalk.reset('     A smaller draft model can significantly improve throughput.\n\n'));

      const draftChoices: Choice[] = [
        { name: chalk.reset('↩  Skip (no draft model)'), value: 'skip' },
        ...displayNames.filter((n) => n !== chosenName).map((n) => ({ name: n, value: n })),
        { name: chalk.reset('← Back'), value: 'back' },
      ];
      const draftName = await select(rl, `Draft model for ${chosenName}:`, draftChoices);
      if (draftName && draftName !== 'skip' && draftName !== 'back') {
        const draftEntry = checkpointMapping[draftName];
        const draftModel = toModelCR(draftName, draftEntry);
        const draftPicked = await selectArchAndProfile(rl, draftName, draftModel, modelProfiles);
        if (draftPicked) {
          const draftOverride = await promptBatchingOverride(rl, draftPicked.profile);
          selections.push({
            model: draftModel,
            arch: draftPicked.arch,
            profile: draftPicked.profile,
            batchingConfigOverride: draftOverride,
            isDraftFor: entry.resource_name,
          });
          successMsg(`Auto-added draft model ${draftName} for ${chosenName}`);
        } else {
          warnMsg(`Draft model ${draftName} has no matching profile — skipped`);
        }
      }
    }
  }

  return selections;
}

async function bundleBuilderMenu(rl: any, namespace: string) {
  sectionHeader('Model Selection', '🧱');

  const checkpointMapping: CheckpointMappingV3 = requireJson(path.join(DATA_DIR, 'checkpoint_mapping.json'));
  const modelProfiles: ModelProfilesCache = requireJson(path.join(DATA_DIR, 'model_profiles.json'));

  if (Object.keys(checkpointMapping).length === 0) {
    errorMsg('No models available — check app/data/checkpoint_mapping.json (regenerate via Manage Environments → Validate)');
    return;
  }
  if (Object.keys(modelProfiles).length === 0) {
    errorMsg('No model profiles available — check app/data/model_profiles.json (regenerate via Manage Environments → Validate)');
    return;
  }

  // ── Load saved bundle shortcut ──────────────────────────────────────────────
  const artifactsDir  = path.join(PROJECT_ROOT, 'saved_artifacts');
  const savedArtifacts = existsSync(artifactsDir)
    ? readdirSync(artifactsDir)
        .filter(f => /\.(yaml|yml)$/i.test(f))
        .filter(f => readFileSync(path.join(artifactsDir, f), 'utf-8').includes('kind: ModelBundle'))
    : [];

  if (savedArtifacts.length > 0) {
    const loadChoice = await select(rl, 'Model Selection — start from:', [
      { name: chalk.green.bold('🆕  Build new bundle'),       value: 'new'  },
      { name: '📂  Load from saved_artifacts/',               value: 'load' },
      { name: chalk.red('✕  Cancel'),                         value: 'cancel' },
    ]);
    if (!loadChoice || loadChoice === 'cancel') return;

    if (loadChoice === 'load') {
      const fileChoices: Choice[] = [
        ...savedArtifacts.map(f => ({ name: f, value: f })),
        { name: chalk.reset('← Back'), value: 'back' },
      ];
      const chosenFile = await select(rl, 'Select saved bundle:', fileChoices);
      if (!chosenFile || chosenFile === 'back') return;

      const loadedYaml  = readFileSync(path.join(artifactsDir, chosenFile), 'utf-8');
      const loadedBName = extractBundleName(loadedYaml) || chosenFile.replace(/\.ya?ml$/i, '');
      yamlBox(`Loaded: ${chosenFile}`, loadedYaml);

      let finalYaml    = loadedYaml;
      let activeBundleName  = loadedBName;
      let shouldApply  = false;

      while (true) {
        const act = await select(rl, 'What next?', [
          { name: '✅  Apply to cluster to validate',   value: 'validate' },
          { name: '✏️   Edit in editor',               value: 'edit'     },
          { name: '💾  Save to file',                   value: 'save'     },
          { name: chalk.reset('← Skip (deploy later)'), value: 'skip'     },
          { name: chalk.red('✕  Cancel'),               value: 'cancel'   },
        ]);
        if (!act || act === 'cancel') return;

        if (act === 'edit') {
          const tmp = path.join(PROJECT_ROOT, `.tmp_bundle_${Date.now()}.yaml`);
          writeFileSync(tmp, finalYaml);
          const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
          try {
            process.stdout.write(chalk.yellow(`\n  Opening ${editor}...\n`));
            try { execSync('stty sane', { stdio: 'inherit' }); } catch {}
            execSync(`${editor} "${tmp}"`, { stdio: 'inherit' });
            try { execSync('stty sane', { stdio: 'inherit' }); } catch {}
            finalYaml = readFileSync(tmp, 'utf-8');
            try { execSync(`rm "${tmp}"`); } catch {}
            yamlBox('Updated YAML', finalYaml);
          } catch (e: any) {
            errorMsg(`Editor error: ${e.message}`);
            try { execSync(`rm "${tmp}"`); } catch {}
          }
        } else if (act === 'save') {
          const saveDir = path.join(PROJECT_ROOT, 'saved_artifacts');
          if (!existsSync(saveDir)) mkdirSync(saveDir, { recursive: true });
          const shortDefault = `saved_artifacts/${activeBundleName}.yaml`;
          const fnameInput = await input(rl, 'Filename', shortDefault);
          if (fnameInput && fnameInput !== ESC) {
            const fname = path.isAbsolute(fnameInput) ? fnameInput : path.join(PROJECT_ROOT, fnameInput);
            try { writeFileSync(fname, finalYaml); successMsg(`Saved to ${fnameInput}`); } catch (e: any) { errorMsg(`Save failed: ${e.message}`); }
          }
        } else if (act === 'validate') {
          activeBundleName = extractBundleName(finalYaml) || loadedBName;
          shouldApply = true;
          break;
        } else if (act === 'skip') {
          process.stdout.write('\n');
          process.stdout.write(chalk.reset(`  ModelBundle is ready.\n`));
          process.stdout.write(chalk.hex(BRAND).bold(`  → Go to  🚀 Model Deployment  from the main menu to deploy it.\n\n`));
          return;
        }
      }

      if (shouldApply) {
        await applyModelBundle(rl, namespace, finalYaml, activeBundleName);
      }
      return;
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  builderLoop: while (true) {   // outer loop — allows "Go Back" after validation failure to re-enter model selection
    const selections = await collectModelSelections(rl, checkpointMapping, modelProfiles);
    if (selections.length === 0) return;

    // Summary
    sectionHeader('Bundle Summary', '📋');
    selections.forEach((sel, i) => {
      const label = getDisplayName(sel.profile, getProfilesForArch(sel.arch, modelProfiles));
      const draftTag = sel.isDraftFor ? chalk.yellow('  (draft)') : '';
      process.stdout.write(
        `  ${chalk.reset(`${i + 1}.`)} ${chalk.reset.bold(sel.model.spec.name.padEnd(38))} ${chalk.reset(label)}${draftTag}\n`
      );
    });
    process.stdout.write('\n');
    hr();

    const previewYaml = generateModelBundleYaml('my-bundle', selections);
    let workingYaml = previewYaml;
    yamlBox('YAML Preview  (my-bundle = placeholder)', workingYaml);

    // Name prompt:
    //   • pre-populated with the placeholder name (updates if user edits YAML via 'e')
    //   • e    → open YAML in editor; name auto-updates from saved YAML
    //   • Esc  → back to Model Selection (selections preserved)
    //   • invalid name → re-prompt
    let bundleName = '';
    let suggestedName = 'my-bundle';
    while (true) {
      const nameInput = await input(rl, chalk.yellow.bold('Review the bundle and enter a name to continue, or press e to edit  Esc to previous menu'), suggestedName, '', { e: EDIT });

      if (!nameInput || nameInput === ESC) continue builderLoop;

      if (nameInput === EDIT) {
        const tmp    = path.join(PROJECT_ROOT, `.tmp_bundle_${Date.now()}.yaml`);
        const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
        writeFileSync(tmp, workingYaml);
        try {
          process.stdout.write(chalk.yellow(`\n  Opening ${editor}...\n`));
          try { execSync('stty sane', { stdio: 'inherit' }); } catch {}
          execSync(`${editor} "${tmp}"`, { stdio: 'inherit' });
          try { execSync('stty sane', { stdio: 'inherit' }); } catch {}
          workingYaml = readFileSync(tmp, 'utf-8');
          try { execSync(`rm "${tmp}"`); } catch {}
          suggestedName = extractBundleName(workingYaml) || suggestedName;
          yamlBox('Updated YAML', workingYaml);
        } catch (e: any) {
          errorMsg(`Editor error: ${e.message}`);
          try { execSync(`rm "${tmp}"`); } catch {}
        }
        continue;
      }

      if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(nameInput)) {
        errorMsg('Name must be lowercase letters, numbers and hyphens only, 2–63 chars, and start/end with a letter or digit. Please try again.');
        continue;
      }
      bundleName = nameInput;
      break;
    }

    // Build final YAML — if user edited the preview, substitute the placeholder name; otherwise rebuild cleanly
    let finalYaml = '';
    if (workingYaml !== previewYaml) {
      finalYaml = workingYaml.replace(/my-bundle/g, bundleName);
    } else {
      finalYaml = generateModelBundleYaml(bundleName, selections);
    }

    yamlBox(`Final YAML  (${bundleName})`, finalYaml);

    let shouldApply = false;
    let activeBundleName = bundleName;

    while (true) {
      const act = await select(rl, 'What next?', [
        { name: '✅  Apply to cluster to validate',   value: 'validate' },
        { name: '💾  Save to file',                   value: 'save' },
        { name: chalk.reset('← Skip (deploy later)'), value: 'skip' },
        { name: chalk.red('✕  Cancel'),               value: 'cancel' },
      ]);

      if (!act || act === 'cancel') return;

      if (act === 'save') {
        const saveDir = path.join(PROJECT_ROOT, 'saved_artifacts');
        if (!existsSync(saveDir)) mkdirSync(saveDir, { recursive: true });
        const shortDefault = `saved_artifacts/${bundleName}.yaml`;
        const fnameInput = await input(rl, 'Filename', shortDefault);
        if (fnameInput && fnameInput !== ESC) {
          const fname = path.isAbsolute(fnameInput) ? fnameInput : path.join(PROJECT_ROOT, fnameInput);
          try { writeFileSync(fname, finalYaml); successMsg(`Saved to ${fnameInput}`); } catch (e: any) { errorMsg(`Save failed: ${e.message}`); }
        }
      } else if (act === 'validate') {
        activeBundleName = extractBundleName(finalYaml) || bundleName;
        shouldApply = true;
        break;
      } else if (act === 'skip') {
        process.stdout.write('\n');
        process.stdout.write(chalk.reset(`  ModelBundle is ready.\n`));
        process.stdout.write(chalk.hex(BRAND).bold(`  → Go to  🚀 Model Deployment  from the main menu to deploy it.\n\n`));
        return;
      }
    }

    if (!shouldApply) break builderLoop;

    const result = await applyModelBundle(rl, namespace, finalYaml, activeBundleName);
    if (result === 'restart') continue builderLoop;
    break builderLoop;
  }  // end builderLoop

  process.stdout.write('\n');
  process.stdout.write(chalk.reset(`  ModelBundle is ready.\n`));
  process.stdout.write(chalk.hex(BRAND).bold(`  → Go to  🚀 Model Deployment  from the main menu to deploy it.\n\n`));
}

/**
 * Applies a `ModelBundle` YAML document to the cluster and polls
 * `status.conditions` (Q5 — `{ type: Valid, status, reason, message }`) until
 * it resolves. Returns `'restart'` when the user chooses to go back to
 * Model Selection after a validation failure (so the caller can re-loop).
 */
async function applyModelBundle(rl: any, namespace: string, finalYaml: string, bundleName: string): Promise<'done' | 'restart'> {
  const tempPath = path.join(PROJECT_ROOT, `temp_bundle_${Date.now()}.yaml`);
  let activeBundleName = bundleName;
  try {
    writeFileSync(tempPath, finalYaml);
    spinner.start('Applying bundle to cluster...');
    await tick();
    const applyOut = execSync(`kubectl apply -f ${tempPath} -n ${namespace}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    spinner.succeed('Bundle applied — polling for validation status...');
    if (applyOut?.trim()) {
      process.stdout.write(chalk.reset('\nkubectl apply output:\n'));
      applyOut.trim().split('\n').forEach((line: string) => process.stdout.write(chalk.reset(`  ${line}\n`)));
      process.stdout.write('\n');
    }

    // Enable keypress so user can cancel
    const valIsRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    ensureKeypressEvents();
    let valUserExit = false;
    const valOnKey  = (_s: any, key: any) => {
      if (!key) return;
      if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) valUserExit = true;
    };
    process.stdin.on('keypress', valOnKey);

    const spinFrames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    let   spinIdx    = 0;
    let   validated       = false;
    let   validationFailed = false;
    const startMs          = Date.now();
    let   elapsedStr       = '0s';

    while (!valUserExit) {
      await new Promise(r => setTimeout(r, 3000));
      if (valUserExit) break;

      const elapsed    = Math.round((Date.now() - startMs) / 1000);
      const elapsedMin = Math.floor(elapsed / 60);
      const elapsedSec = elapsed % 60;
      elapsedStr = elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec}s` : `${elapsed}s`;
      const spin       = chalk.magenta(spinFrames[spinIdx++ % spinFrames.length]);

      try {
        const st    = JSON.parse(execSync(`kubectl get modelbundle.sambanova.ai ${activeBundleName} -n ${namespace} -o json`, { encoding: 'utf-8' }));
        const conds = st.status?.conditions || [];
        const phase = st.status?.phase || 'Pending';
        const outcome = readValidCondition(conds);

        if (conds.length > 0) {
          const latest = conds[conds.length - 1];
          process.stdout.write(`\r  ${spin}  ${chalk.bold(phase)}  ${chalk.reset(elapsedStr)}  ${chalk.reset(latest.reason || latest.type)}                    `);

          if (outcome === 'succeeded') {
            process.stdout.write('\n');
            successMsg('Bundle Validation Succeeded!');
            validated = true; break;
          } else if (outcome === 'failed') {
            process.stdout.write('\n');
            printValidationErrors(conds);
            validated = true; validationFailed = true; break;
          }
        } else {
          process.stdout.write(`\r  ${spin}  ${chalk.bold(phase)}  ${chalk.reset(elapsedStr)}                    `);
        }
      } catch {
        process.stdout.write(`\r  ${spin}  Waiting for bundle resource...  ${chalk.reset(elapsedStr)}                    `);
      }
    }

    process.stdin.removeListener('keypress', valOnKey);
    process.stdin.setRawMode(valIsRaw);

    if (!validated) {
      process.stdout.write('\n');
      warnMsg('Still validating — check status with:');
      process.stdout.write(chalk.reset(`  kubectl get modelbundle.sambanova.ai ${activeBundleName} -n ${namespace} -o yaml\n\n`));
    }

    // ── Recovery menu after validation failure ────────────────────────────────
    if (validationFailed) {
      process.stdout.write('\n');
      const fix = await select(rl, 'What would you like to do?', [
        { name: '✏️   Edit YAML in editor and re-apply',                             value: 'edit'    },
        { name: chalk.reset('← Go back to Model Selection  (re-edit selections)'),    value: 'builder' },
        { name: `🗑️   Delete ${activeBundleName} from cluster`,                       value: 'delete'  },
        { name: chalk.reset('← Back to main menu'),                                  value: 'back'    },
      ]);

      if (fix === 'edit') {
        const tmp    = path.join(PROJECT_ROOT, `.tmp_bundle_fix_${Date.now()}.yaml`);
        const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
        writeFileSync(tmp, finalYaml);
        try {
          process.stdout.write(chalk.yellow(`\n  Opening ${editor}...\n`));
          try { execSync('stty sane', { stdio: 'inherit' }); } catch {}
          execSync(`${editor} "${tmp}"`, { stdio: 'inherit' });
          try { execSync('stty sane', { stdio: 'inherit' }); } catch {}
          finalYaml = readFileSync(tmp, 'utf-8');
          try { execSync(`rm "${tmp}"`); } catch {}
        } catch (e: any) { errorMsg(`Editor error: ${e.message}`); try { execSync(`rm "${tmp}"`); } catch {} }

        activeBundleName = extractBundleName(finalYaml) || activeBundleName;

        const reApplyPath = path.join(PROJECT_ROOT, `temp_bundle_${Date.now()}.yaml`);
        try {
          writeFileSync(reApplyPath, finalYaml);
          spinner.start('Re-applying bundle...');
          await tick();
          execSync(`kubectl apply -f ${reApplyPath} -n ${namespace}`, { stdio: ['pipe','pipe','pipe'] });
          spinner.succeed('Bundle re-applied — check 📈 Check Deployment Progress for status');
        } catch (e: any) { spinner.fail(`Re-apply failed: ${e.message.split('\n')[0]}`); }
        finally { try { execSync(`rm "${reApplyPath}"`); } catch {} }

      } else if (fix === 'builder') {
        try { execSync(`kubectl delete modelbundle.sambanova.ai ${activeBundleName} -n ${namespace}`, { stdio: ['pipe','pipe','pipe'] }); } catch {}
        return 'restart';

      } else if (fix === 'delete') {
        spinner.start(`Deleting ${activeBundleName}...`);
        await tick();
        try {
          execSync(`kubectl delete modelbundle.sambanova.ai ${activeBundleName} -n ${namespace}`, { stdio: ['pipe','pipe','pipe'] });
          spinner.succeed(`Deleted ${activeBundleName} from cluster`);
        } catch (e: any) { spinner.fail(`Delete failed: ${e.message.split('\n')[0]}`); }
      }
      return 'done';
    }
  } catch (e: any) {
    errorMsg(`Error applying bundle: ${e.message}`);
  } finally {
    try { execSync(`rm "${tempPath}"`); } catch {}
  }

  return 'done';
}

// ─── bundleDeploymentMenu() ──────────────────────────────────────────────────

async function bundleDeploymentMenu(rl: any, namespace: string) {
  let back = false;
  while (!back) {
    sectionHeader('Model Deployment', '🚀');

    // Show current deployments
    try {
      const list = JSON.parse(execSync(`kubectl get modeldeployment.sambanova.ai -n ${namespace} -o json`, { encoding: 'utf-8', stdio: ['pipe','pipe','pipe'] }));
      const items: any[] = list.items || [];
      if (items.length > 0) {
        process.stdout.write(chalk.reset.bold('  Current Deployments:\n'));
        items.forEach((i: any) => {
          const phase = i.status?.phase || '';
          const icon  = phase === 'Running' || phase === 'Deployed' ? chalk.green('●') : phase === 'Pending' ? chalk.yellow('◌') : chalk.red('○');
          process.stdout.write(`  ${icon}  ${chalk.reset(i.metadata.name)}${phase ? `  ${chalk.reset(phase)}` : ''}\n`);
        });
        process.stdout.write('\n');
      } else {
        process.stdout.write(chalk.reset('  No deployments found.\n\n'));
      }
    } catch {
      process.stdout.write(chalk.reset('  (Could not fetch deployments)\n\n'));
    }

    const action = await select(rl, 'Model Deployment:', [
      { name: `${chalk.green('▶')}  Deploy a Bundle`,              value: 'deploy' },
      { name: `${chalk.red('✕')}  Delete a Bundle / Deployment`, value: 'delete' },
      { name: chalk.reset('← Back'),                               value: 'back' },
    ]);
    if (!action || action === 'back') back = true;
    else if (action === 'deploy') await bundleDeployAction(rl, namespace);
    else if (action === 'delete') await bundleDeleteAction(rl, namespace);
  }
}

async function bundleDeployAction(rl: any, namespace: string) {
  spinner.start('Fetching bundles from cluster...');
  await tick();
  try {
    const list = JSON.parse(execSync(`kubectl get modelbundle.sambanova.ai -n ${namespace} -o json`, { encoding: 'utf-8' }));
    spinner.info(`Found ${list.items?.length || 0} bundle(s)`);

    if (!list.items?.length) { warnMsg('No bundles found in this namespace.'); return; }

    const bundles = list.items.map((i: any) => ({
      name:  i.metadata.name,
      valid: readValidCondition(i.status?.conditions || []) === 'succeeded',
    }));

    process.stdout.write('\n');
    bundles.forEach((b: any) => {
      const badge = b.valid ? chalk.green('✔ valid') : chalk.yellow('⚠ unvalidated');
      process.stdout.write(`  ${chalk.reset('·')} ${chalk.reset(b.name)}  ${badge}\n`);
    });
    process.stdout.write('\n');

    const choices: Choice[] = [
      ...bundles.map((b: any) => ({
        name: `${b.valid ? chalk.green('●') : chalk.yellow('○')} ${b.name}`,
        value: b.name,
        hint: b.valid ? 'validated' : 'unvalidated',
      })),
      { name: chalk.reset('← Back'), value: 'back' },
    ];

    const bundleToDeploy = await select(rl, 'Select bundle to deploy:', choices);
    if (!bundleToDeploy || bundleToDeploy === 'back') return;

    const { yaml, deploymentName: depName } = buildModelDeploymentYaml(bundleToDeploy);

    yamlBox('Deployment YAML', yaml);

    if (!await confirm(rl, `Deploy ${chalk.bold(depName)}?`)) return;

    const tempPath = path.join(PROJECT_ROOT, `temp_dep_${Date.now()}.yaml`);
    try {
      writeFileSync(tempPath, yaml);
      spinner.start('Deploying...');
      await tick();
      execSync(`kubectl apply -f ${tempPath} -n ${namespace}`, { stdio: ['pipe','pipe','pipe'] });
      spinner.succeed(`Deployment ${depName} initiated`);
    } finally {
      try { execSync(`rm "${tempPath}"`); } catch {}
    }

    if (await confirm(rl, 'Monitor progress now?')) await monitorDeployment(rl, namespace, depName);
  } catch (e: any) {
    spinner.fail(`Error: ${e.message.split('\n')[0]}`);
  }
}

async function bundleDeleteAction(rl: any, namespace: string) {
  const deleteType = await select(rl, 'What to delete?', [
    { name: 'ModelDeployment',       value: 'deployment' },
    { name: 'ModelBundle',           value: 'bundle' },
    { name: chalk.reset('← Back'),   value: 'back' },
  ]);
  if (!deleteType || deleteType === 'back') return;

  const rm: Record<string, { kind: string; label: string }> = {
    deployment: { kind: 'modeldeployment.sambanova.ai', label: 'ModelDeployment' },
    bundle:     { kind: 'modelbundle.sambanova.ai',      label: 'ModelBundle' },
  };
  const res = rm[deleteType];

  spinner.start(`Fetching ${res.label} resources...`);
  await tick();
  try {
    const list = JSON.parse(execSync(`kubectl get ${res.kind} -n ${namespace} -o json`, { encoding: 'utf-8' }));
    spinner.info(`Found ${list.items?.length || 0} resource(s)`);

    if (!list.items?.length) { warnMsg(`No ${res.label} resources found.`); return; }

    const items: Choice[] = list.items.map((i: any) => {
      const phase = i.status?.phase || i.status?.conditions?.[0]?.reason || '';
      return { name: `${i.metadata.name}`, value: i.metadata.name, hint: phase || undefined };
    });
    items.push({ name: chalk.reset('← Back'), value: 'back' });

    const selected = await multiSelect(rl, `Select ${res.label}(s) to delete:`, items);
    if (!selected || selected.includes('back') || selected.length === 0) return;

    process.stdout.write('\n');
    process.stdout.write(chalk.red.bold(`  ⚠  The following will be permanently deleted:\n\n`));
    selected.forEach((n: string) => {
      process.stdout.write(chalk.red(`  ·  ${n}\n`));
    });
    process.stdout.write('\n');

    if (!await confirm(rl, chalk.red.bold('Confirm deletion? This cannot be undone'), false)) {
      process.stdout.write(chalk.reset('  Cancelled.\n\n')); return;
    }

    for (const name of selected) {
      spinner.start(`Deleting ${name}...`);
      await tick();
      try {
        execSync(`kubectl delete ${res.kind} ${name} -n ${namespace}`, { stdio: ['pipe','pipe','pipe'] });
        spinner.succeed(`Deleted ${name}`);
      } catch (e: any) {
        spinner.fail(`Failed to delete ${name}: ${e.message.split('\n')[0]}`);
      }
    }
  } catch (e: any) {
    spinner.fail(`Error: ${e.message.split('\n')[0]}`);
  }
}

// ─── monitorMenu() / monitorDeployment() ─────────────────────────────────────

async function monitorMenu(rl: any, namespace: string) {
  spinner.start('Fetching deployments...');
  await tick();
  try {
    const list = JSON.parse(execSync(`kubectl get modeldeployment.sambanova.ai -n ${namespace} -o json`, { encoding: 'utf-8' }));
    spinner.info(`Found ${list.items?.length || 0} deployment(s)`);

    if (!list.items?.length) { warnMsg('No deployments found.'); return; }

    const choices: Choice[] = list.items.map((i: any) => {
      const phase = i.status?.phase || '';
      const icon  = phase === 'Running' || phase === 'Deployed' ? chalk.green('●') : phase ? chalk.yellow('◌') : chalk.red('○');
      return { name: `${icon} ${i.metadata.name}`, value: i.metadata.name, hint: phase || undefined };
    });
    choices.push({ name: chalk.reset('← Back'), value: 'back' });

    const dep = await select(rl, 'Select deployment to monitor:', choices);
    if (!dep || dep === 'back') return;
    await monitorDeployment(rl, namespace, dep);
  } catch (e: any) {
    spinner.fail(`Error: ${e.message.split('\n')[0]}`);
  }
}

async function monitorDeployment(_rl: any, namespace: string, depName: string) {
  sectionHeader(`Monitoring: ${depName}`, '📈');
  process.stdout.write(chalk.reset('  Press q or Esc to stop monitoring\n\n'));

  let finished = false;
  let userExit = false;
  const startTime = Date.now();

  const isRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  ensureKeypressEvents();

  const onKey = (_s: any, key: any) => {
    if (!key) return;
    if (key.name === 'q' || key.name === 'escape') userExit = true;
    else if (key.ctrl && key.name === 'c') userExit = true;
  };
  process.stdin.on('keypress', onKey);

  let drawnLines = 0;
  const clr   = () => { if (drawnLines > 0) { readlineModule.moveCursor(process.stdout, 0, -drawnLines); readlineModule.clearScreenDown(process.stdout); drawnLines = 0; } };
  const wline = (t: string) => { process.stdout.write(t + '\n'); drawnLines++; };

  while (!finished) {
    if (userExit) {
      clr();
      process.stdout.write(chalk.reset('  Stopped monitoring. Returning to menu...\n'));
      finished = true;
      break;
    }

    try {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      let cachePod: any   = null;
      let defaultPod: any = null;

      try {
        const po = execSync(`kubectl -n ${namespace} get pods 2>/dev/null | grep "^inf-${depName}-"`, { encoding: 'utf-8' });
        for (const line of po.trim().split('\n').filter((l: string) => l.trim())) {
          const pod = parsePodLine(line);
          if (!pod) continue;
          const kind = classifyPod(pod.name);
          if (kind === 'cache')        cachePod   = pod;
          else if (kind === 'default') defaultPod = pod;
        }
      } catch {}

      const deployStatus = getDeploymentStatus(cachePod, defaultPod);
      const statusColor  = deployStatus === 'Deployed' ? chalk.green : deployStatus === 'Deploying' ? chalk.yellow : chalk.red;
      const statusIcon   = deployStatus === 'Deployed' ? '●' : deployStatus === 'Deploying' ? '◌' : '○';

      clr();

      wline(statusColor.bold(`  ${statusIcon}  ${deployStatus}`) + chalk.reset(`    elapsed: ${elapsed}s`));
      wline(chalk.reset('  ' + '─'.repeat(40)));

      const podRow = (label: string, pod: any) => {
        if (pod) {
          const ic = pod.ready === pod.total ? chalk.green('✔') : chalk.yellow('…');
          wline(chalk.reset(`  ${label.padEnd(16)}`) + ` ${ic} ` + chalk.reset(`${pod.ready}/${pod.total}`) + `  ` + chalk.reset(pod.status.padEnd(12)) + `  ` + chalk.reset(`age: ${pod.age}`));
        } else {
          wline(chalk.reset(`  ${label.padEnd(16)}`) + chalk.yellow(' ⏳ waiting for pod...'));
        }
      };

      podRow('Cache pod',     cachePod);
      podRow('Inference pod', defaultPod);
      wline('');

      // ── Container logs panel ──────────────────────────────────────
      const logSection = (_label: string, pod: PodInfo | null, container?: string) => {
        if (!pod) return;
        const containerSuffix = container ? ` (container: ${container})` : '';
        wline(chalk.reset(`  Monitoring: ${pod.name}${containerSuffix}`));
        let lines: string[] = [];
        try {
          const cFlag = container ? ` -c ${container}` : '';
          const raw = execSync(
            `kubectl logs ${pod.name} -n ${namespace}${cFlag} --tail=5 2>/dev/null`,
            { encoding: 'utf-8', timeout: 5000 }
          ).trim();
          lines = raw ? raw.split('\n') : [];
        } catch {}
        if (lines.length === 0) {
          wline(chalk.reset('  (no logs yet)'));
        } else {
          for (const l of lines) {
            wline(chalk.reset('  ') + chalk.reset(l.slice(0, 110)));
          }
        }
        wline('');
      };

      // Only show logs for pods that are not yet fully ready
      if (cachePod   && cachePod.ready   < cachePod.total)   logSection('Cache pod',     cachePod);
      if (defaultPod && defaultPod.ready < defaultPod.total) logSection('Inference pod', defaultPod, 'inf');

      if (deployStatus === 'Deployed') {
        wline(chalk.green.bold('  ✅  Deployment is fully ready!'));
        finished = true;
      } else {
        wline(chalk.reset('  Refreshing every 5s...  (q / Esc to stop)'));
      }

      if (!finished) await new Promise(r => setTimeout(r, 5000));
    } catch (e: any) {
      clr();
      errorMsg(`Error fetching status: ${e.message}`);
      finished = true;
    }
  }

  process.stdin.removeListener('keypress', onKey);
  process.stdin.setRawMode(isRaw);
}

// ─── playgroundMenu() ────────────────────────────────────────────────────────

async function playgroundMenu(rl: any, envConfig: any, namespace: string) {
  sectionHeader('Playground · Chat Console', '🤖');

  if (!envConfig || !envConfig.apiDomain || !envConfig.apiKey) {
    errorMsg('apiDomain and apiKey must be configured in app-config.json');
    return;
  }

  spinner.start('Fetching deployments from cluster...');
  await tick();
  let modelName = '';

  try {
    const list = JSON.parse(execSync(`kubectl get modeldeployment.sambanova.ai -n ${namespace} -o json`, { encoding: 'utf-8' }));
    spinner.info(`Found ${list.items?.length || 0} deployment(s)`);

    if (!list.items?.length) {
      warnMsg('No deployments found — deploy a bundle first or enter a model name manually.');
      modelName = await input(rl, 'Model name (leave empty to go back)');
      if (modelName === ESC) return;
    } else {
      const allDeps: any[] = [];
      for (const item of list.items) {
        const dn = item.metadata.name;
        const bn = item.spec.bundle;
        let status = 'Not Deployed';
        try {
          const po = execSync(`kubectl -n ${namespace} get pods 2>/dev/null | grep "^inf-${dn}-"`, { encoding: 'utf-8' });
          let cache: PodInfo | null = null, dflt: PodInfo | null = null;
          for (const line of po.trim().split('\n').filter((l: string) => l.trim())) {
            const pod = parsePodLine(line);
            if (!pod) continue;
            const kind = classifyPod(pod.name);
            if (kind === 'cache')        cache = pod;
            else if (kind === 'default') dflt  = pod;
          }
          status = getDeploymentStatus(cache, dflt);
        } catch { status = 'Not Deployed'; }
        allDeps.push({ name: dn, bundle: bn, status });
      }

      const deployed = allDeps.filter(d => d.status === 'Deployed');

      if (!deployed.length) {
        warnMsg('No fully deployed bundles ready.');
        process.stdout.write(chalk.reset('  Current status:\n'));
        allDeps.forEach(d => {
          const ic = d.status === 'Deployed' ? chalk.green('●') : d.status === 'Deploying' ? chalk.yellow('◌') : chalk.red('○');
          process.stdout.write(`  ${ic}  ${d.name}  ${chalk.reset(d.status)}\n`);
        });
        process.stdout.write('\n');
        modelName = await input(rl, 'Model name manually (leave empty to go back)');
        if (modelName === ESC) return;
      } else {
        const depChoices: Choice[] = [
          ...deployed.map(d => ({ name: `${chalk.green('●')}  ${d.name}`, value: d.name, bundle: d.bundle })),
          { name: chalk.reset('✏️  Enter model name manually'), value: 'manual' },
          { name: chalk.reset('← Back'), value: 'back' },
        ];

        const selDep = await select(rl, 'Select deployed bundle to chat with:', depChoices);
        if (!selDep || selDep === 'back') return;

        if (selDep === 'manual') {
          modelName = await input(rl, 'Model name');
          if (!modelName || modelName === ESC) return;
        } else {
          const depItem = depChoices.find(d => d.value === selDep);
          const bn = depItem?.bundle ?? '';
          const checkpointMapping: CheckpointMappingV3 = requireJson(path.join(DATA_DIR, 'checkpoint_mapping.json'));
          try {
            const bundle = JSON.parse(execSync(`kubectl get modelbundle.sambanova.ai ${bn} -n ${namespace} -o json`, { encoding: 'utf-8' }));
            const modelConfigs: any[] = bundle.spec?.modelConfigs || [];
            const models = Array.from(new Set(
              modelConfigs
                .map((mc) => (typeof mc.model === 'string' ? mc.model.split(':')[0] : null))
                .filter((crname): crname is string => !!crname)
                .map((crname) => crNameToDisplayName(checkpointMapping, crname) ?? crname)
            )).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

            if (!models.length) {
              warnMsg('No models found in bundle.');
              modelName = await input(rl, 'Model name manually');
              if (!modelName || modelName === ESC) return;
            } else if (models.length === 1) {
              modelName = models[0];
              process.stdout.write(`\n  ${chalk.green('●')}  Using model: ${chalk.reset.bold(modelName)}\n\n`);
            } else {
              const mc: Choice[] = [
                ...models.map(m => ({ name: m, value: m })),
                { name: chalk.reset('← Back'), value: 'back' },
              ];
              const sm = await select(rl, `Select model from ${selDep}:`, mc);
              if (!sm || sm === 'back') return;
              modelName = sm;
            }
          } catch (e: any) {
            warnMsg(`Could not fetch bundle "${bn}": ${e.message}`);
            modelName = await input(rl, 'Model name manually');
            if (!modelName || modelName === ESC) return;
          }
        }
      }
    }
  } catch (e: any) {
    spinner.fail(`Error: ${e.message.split('\n')[0]}`);
    modelName = await input(rl, 'Model name manually (leave empty to go back)');
    if (modelName === ESC) return;
  }

  if (!modelName || modelName === ESC) return;

  const checkpointMapping: CheckpointMappingV3 = requireJson(path.join(DATA_DIR, 'checkpoint_mapping.json'));
  const isEmbedding       = checkpointMapping[modelName]?.capabilities?.includes('embeddings') ?? false;

  let base = envConfig.apiDomain.replace(/\/v1\/chat\/completions\/?$/, '');
  if (!base.endsWith('/')) base += '/';

  // ── Embedding loop ──────────────────────────────────────────────────────────
  if (isEmbedding) {
    const cols  = Math.min(68, (process.stdout.columns || 80) - 4);
    const title = `🔢  Embedding test — ${modelName}`;
    const pad   = Math.max(0, cols - title.length - 1);
    process.stdout.write('\n');
    process.stdout.write(chalk.hex(BRAND)(`  ╭${'─'.repeat(cols)}╮\n`));
    process.stdout.write(chalk.hex(BRAND)('  │ ') + chalk.reset.bold(title) + ' '.repeat(pad) + chalk.hex(BRAND)('│\n'));
    process.stdout.write(chalk.hex(BRAND)('  │ ') + chalk.reset(`q / Esc or type 'exit' to return to menu`.padEnd(cols - 1)) + chalk.hex(BRAND)('│\n'));
    process.stdout.write(chalk.hex(BRAND)(`  ╰${'─'.repeat(cols)}╯\n\n`));

    let exitEmbed = false;
    while (!exitEmbed) {
      const userInput = await input(rl, chalk.reset.bold('Text to embed'));
      if (userInput === ESC || ['exit', 'quit', '/back', 'q'].includes(userInput.toLowerCase())) {
        process.stdout.write(chalk.reset('\n  Returning to menu...\n\n'));
        exitEmbed = true;
        continue;
      }
      if (!userInput.trim()) continue;

      const tmpPayload = path.join(PROJECT_ROOT, `.tmp_embed_${Date.now()}.json`);
      try {
        const payload = JSON.stringify({ input: userInput, model: modelName });
        writeFileSync(tmpPayload, payload);
        process.stdout.write(chalk.reset('\n  ◌  Generating embedding...\r'));
        const res = execSync(
          `curl -sk -w "\\n%{http_code}" -X POST "${base}v1/embeddings" ` +
          `-H "Content-Type: application/json" -H "Authorization: Bearer ${envConfig.apiKey}" ` +
          `-d @"${tmpPayload}"`,
          { encoding: 'utf-8', timeout: 30000 }
        );
        process.stdout.write('\r\x1b[K');
        const resParts   = res.trimEnd().split('\n');
        const httpCode   = safeParseInt(resParts.pop());
        const body       = resParts.join('\n');
        if (httpCode >= 200 && httpCode < 300) {
          const data      = JSON.parse(body);
          const vector: number[] = data.data?.[0]?.embedding || data.embedding || [];
          const dims      = vector.length;
          const preview   = vector.slice(0, 8).map((v: number) => v.toFixed(8)).join(', ');
          process.stdout.write(`\n  ${chalk.hex(BRAND).bold('◈  Embedding')}\n`);
          hr();
          process.stdout.write(`  ${chalk.green.bold(`${dims}-dimensional embedding`)}\n`);
          process.stdout.write(`  [${preview}${dims > 8 ? ', ...' : ''}]\n`);
          if (data.usage) process.stdout.write(chalk.reset(`  tokens: ${data.usage.prompt_tokens ?? '—'}\n`));
          hr();
          process.stdout.write('\n');
        } else {
          errorMsg(`API Error ${httpCode}`);
          try { const e = JSON.parse(body); process.stdout.write(chalk.reset(`  ${e.error?.message || body}\n\n`)); } catch {}
        }
      } catch (e: any) {
        process.stdout.write('\r\x1b[K');
        errorMsg(`Connection error: ${e.message.split('\n')[0]}`);
      } finally {
        try { execSync(`rm "${tmpPayload}"`); } catch {}
      }
    }
    return;
  }

  // ── Chat loop ──────────────────────────────────────────────────────────────
  const cols      = Math.min(68, (process.stdout.columns || 80) - 4);
  const chatTitle = `🤖  Chatting with ${modelName}`;
  const chatPad   = Math.max(0, cols - chatTitle.length - 1); // -1 extra for emoji double-width
  process.stdout.write('\n');
  process.stdout.write(chalk.hex(BRAND)(`  ╭${'─'.repeat(cols)}╮\n`));
  process.stdout.write(chalk.hex(BRAND)('  │ ') + chalk.reset.bold(chatTitle) + ' '.repeat(chatPad) + chalk.hex(BRAND)('│\n'));
  process.stdout.write(chalk.hex(BRAND)('  │ ') + chalk.reset(`q / Esc  or type 'exit' to return to menu`.padEnd(cols - 1)) + chalk.hex(BRAND)('│\n'));
  process.stdout.write(chalk.hex(BRAND)(`  ╰${'─'.repeat(cols)}╯\n\n`));

  const messages: any[] = [];
  let exitChat          = false;
  let shownCodeExamples = false;

  while (!exitChat) {
    const userInput = await input(rl, chalk.green.bold('You'));
    if (userInput === ESC || ['exit', 'quit', '/back', 'q'].includes(userInput.toLowerCase())) {
      process.stdout.write(chalk.reset('\n  Returning to menu...\n\n'));
      exitChat = true;
      continue;
    }
    if (!userInput.trim()) continue;

    messages.push({ role: 'user', content: userInput });

    const tmpPayload = path.join(PROJECT_ROOT, `.tmp_chat_${Date.now()}.json`);
    try {
      const apiUrl  = `${base}v1/chat/completions`;
      const payload = JSON.stringify({ model: modelName, messages, stream: false });

      writeFileSync(tmpPayload, payload);

      process.stdout.write(chalk.reset('\n  ◌  Thinking...\r'));

      const t0  = Date.now();
      const res = execSync(
        `curl -sk -w "\\n%{http_code}" -X POST "${apiUrl}" ` +
        `-H "Content-Type: application/json" -H "Authorization: Bearer ${envConfig.apiKey}" ` +
        `-d @"${tmpPayload}"`,
        { encoding: 'utf-8', timeout: 120000 }
      );
      const totalMs = Date.now() - t0;

      const parts    = res.trimEnd().split('\n');
      const httpCode = safeParseInt(parts.pop());
      const body     = parts.join('\n');

      process.stdout.write('\r\x1b[K');

      if (httpCode >= 200 && httpCode < 300) {
        const data   = JSON.parse(body);
        const rawMsg = data.choices?.[0]?.message?.content || '';
        const msg    = rawMsg.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        const ts     = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        // ── Performance metrics ──
        const usage        = data.usage || {};
        const completionTokens: number = usage.completion_tokens || 0;
        const totalSec     = totalMs / 1000;
        const ttft: number = data.time_info?.time_to_first_token ?? data.ttft ?? 0;
        const tps          = completionTokens > 0 && totalSec > 0
          ? (completionTokens / totalSec).toFixed(2)
          : null;

        process.stdout.write(`\n  ${chalk.hex(BRAND).bold('◈  Assistant')}  ${chalk.reset(ts)}`);

        if (tps || ttft || totalSec) {
          const parts: string[] = [];
          if (tps)      parts.push(chalk.green.bold(`${tps} t/s`));
          if (totalSec) parts.push(chalk.reset(`${totalSec.toFixed(2)}s total`));
          if (ttft)     parts.push(chalk.reset(`${ttft.toFixed(2)}s to first token`));
          process.stdout.write(`   ${chalk.reset('·')}   ${parts.join(chalk.reset('   ·   '))}`);
        }
        process.stdout.write('\n');

        hr();
        process.stdout.write(`  ${msg}\n`);
        hr();
        process.stdout.write('\n');
        messages.push({ role: 'assistant', content: msg });

        // ── Code examples (once per session) ──
        if (!shownCodeExamples) {
          shownCodeExamples = true;
          const showCode = await confirm(rl, 'View API code examples?', false);
          if (showCode) {
            const maskedKey = envConfig.apiKey.slice(0, 4) + '••••••••' + envConfig.apiKey.slice(-4);
            process.stdout.write('\n');
            process.stdout.write(chalk.reset.bold('  cURL\n'));
            process.stdout.write(chalk.reset('  ' + '─'.repeat(40)) + '\n');
            process.stdout.write(chalk.reset(
              `  curl -X POST ${base}v1/chat/completions \\\n` +
              `    -H "Authorization: Bearer ${maskedKey}" \\\n` +
              `    -H "Content-Type: application/json" \\\n` +
              `    -d '{"model": "${modelName}", "messages": [{"role": "user", "content": "Hello"}], "stream": false}'\n`
            ));
            process.stdout.write('\n');
            process.stdout.write(chalk.reset.bold('  Python\n'));
            process.stdout.write(chalk.reset('  ' + '─'.repeat(40)) + '\n');
            process.stdout.write(chalk.reset(
              `  from sambanova import SambaNova\n` +
              `  client = SambaNova(api_key="${maskedKey}", base_url="${base}v1")\n` +
              `  response = client.chat.completions.create(\n` +
              `      model="${modelName}",\n` +
              `      messages=[{"role": "user", "content": "Hello"}]\n` +
              `  )\n` +
              `  print(response.choices[0].message.content)\n`
            ));
            process.stdout.write('\n');
          }
        }
      } else {
        process.stdout.write('\r\x1b[K');
        errorMsg(`API Error ${httpCode}`);
        if (httpCode === 401 || httpCode === 403) {
          // Don't print the server body — it may reference cloud.sambanova.ai which is irrelevant
          const apiBase = envConfig.uiDomain || envConfig.apiDomain || '';
          warnMsg(`API key invalid or expired — update in app-config.json`);
          if (apiBase) process.stdout.write(chalk.reset(`  Get a new key from: ${apiBase}\n\n`));
        } else {
          try {
            const errData = JSON.parse(body);
            const detail  = errData.error?.message || errData.detail || errData.message || body;
            process.stdout.write(chalk.reset(`  ${detail}\n\n`));
          } catch { if (body.trim()) process.stdout.write(chalk.reset(`  ${body.trim()}\n\n`)); }
        }
        messages.pop();
      }
    } catch (e: any) {
      process.stdout.write('\r\x1b[K');
      errorMsg(`Connection error: ${e.message.split('\n')[0]}`);
      messages.pop();
    } finally {
      try { execSync(`rm "${tmpPayload}"`); } catch {}
    }
  }
}

// ─── installSambaStackMenu() ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function installSambaStackMenu(rl: any, namespace: string) {
  sectionHeader('Install SambaStack', '🔧');

  const defaultYaml = [
    'apiVersion: v1',
    'kind: ConfigMap',
    'metadata:',
    '  name: sambastack',
    '  labels:',
    '    sambastack-installer: "true"',
    'data:',
    '  sambastack.yaml: |',
    '    version: <VERSION>   # [CHANGE ME] Helm version to install, e.g. 0.5.48',
  ].join('\n');

  yamlBox('Install ConfigMap (edit before applying)', defaultYaml);

  let installYaml = defaultYaml;

  // Let user edit before applying
  const editFirst = await confirm(rl, 'Edit in editor before applying?', false);
  if (editFirst) {
    const tmp    = path.join(PROJECT_ROOT, `.tmp_install_${Date.now()}.yaml`);
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    writeFileSync(tmp, installYaml);
    try {
      process.stdout.write(chalk.yellow(`\n  Opening ${editor}...\n`));
      try { execSync('stty sane', { stdio: 'inherit' }); } catch {}
      execSync(`${editor} "${tmp}"`, { stdio: 'inherit' });
      try { execSync('stty sane', { stdio: 'inherit' }); } catch {}
      installYaml = readFileSync(tmp, 'utf-8');
      try { execSync(`rm "${tmp}"`); } catch {}
      yamlBox('Updated YAML', installYaml);
    } catch (e: any) {
      errorMsg(`Editor error: ${e.message}`);
      try { execSync(`rm "${tmp}"`); } catch {}
      return;
    }
  }

  if (!await confirm(rl, 'Apply this YAML to cluster?')) return;

  const tempPath = path.join(PROJECT_ROOT, `temp_install_${Date.now()}.yaml`);
  try {
    mkdirSync(path.join(PROJECT_ROOT, 'temp'), { recursive: true });
    writeFileSync(tempPath, installYaml);
    spinner.start('Applying installation ConfigMap...');
    await tick();
    execSync(`kubectl apply -f ${tempPath} -n ${namespace}`, { stdio: ['pipe','pipe','pipe'] });
    spinner.succeed('Installation ConfigMap applied — streaming logs...');
    process.stdout.write(chalk.reset('  Press q or Esc to stop watching logs\n\n'));
  } catch (e: any) {
    spinner.fail(`Apply failed: ${e.message.split('\n')[0]}`);
    try { execSync(`rm "${tempPath}"`); } catch {}
    return;
  }
  try { execSync(`rm "${tempPath}"`); } catch {}

  // ── Stream installer logs ──
  let done     = false;
  let userExit = false;
  const isRaw  = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  ensureKeypressEvents();

  const onKey = (_s: any, key: any) => {
    if (!key) return;
    if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) userExit = true;
  };
  process.stdin.on('keypress', onKey);

  while (!done) {
    if (userExit) {
      process.stdout.write(chalk.reset('\n  Stopped watching. Installation continues in background.\n\n'));
      done = true;
      break;
    }
    try {
      const logs = execSync(
        `kubectl -n ${namespace} logs -l sambastack-installer=true --tail=20 2>/dev/null`,
        { encoding: 'utf-8', timeout: 10000 }
      ).trim();

      process.stdout.write('\r\x1b[K');
      if (logs) {
        const logLines = logs.split('\n');
        logLines.forEach(l => process.stdout.write(chalk.reset(`  ${l}\n`)));
        // Completion markers differ between SambaStack helm versions:
        // - 1.x: the final step is `configure_default_ingress` (last line).
        // - 2.x: the installer continues with a `create_keycloak_user` step,
        //   which finishes once the service user is created or already exists.
        const lastLine = logLines[logLines.length - 1] || '';
        const oneXComplete = lastLine.includes('configure_default_ingress');
        const twoXComplete = logLines.some(
          l => l.includes('create_keycloak_user') && /already exists|created/i.test(l)
        );
        if (oneXComplete || twoXComplete) {
          successMsg('SambaStack installation complete!');
          done = true;
          break;
        }
      }
      process.stdout.write(chalk.reset('  Refreshing logs every 3s...  (q / Esc to stop)\n'));
    } catch {
      process.stdout.write(chalk.reset('  Waiting for installer pod...\n'));
    }
    if (!done) await new Promise(r => setTimeout(r, 3000));
  }

  process.stdin.removeListener('keypress', onKey);
  process.stdin.setRawMode(isRaw);
}

// ─── Entry ───────────────────────────────────────────────────────────────────
// Guard the interactive entry point so importing this module for its
// exported pure functions (e.g. from bin/__tests__/cli.test.ts, or a
// ts-node/tsx scratch script) doesn't also launch the interactive CLI and
// hang waiting on stdin. Only auto-starts when this file is the process's
// actual entry script (`tsx bin/cli.ts`, `node dist/cli.js`, ...).
const isMainModule = /(^|[\\/])cli\.(ts|js)$/.test(process.argv[1] || '');
if (isMainModule) {
  startCli().catch(err => {
    console.error(chalk.red('\nFatal error:'), err);
  });
}
