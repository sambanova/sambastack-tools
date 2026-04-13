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
// ─── Inlined from cli-utils.ts ───────────────────────────────────────────────

interface BundleSelection {
  model:    string;
  ss:       string;
  bs:       string;
  pef:      string;
  version:  string;
  draftFor?: string;  // set when this selection is a draft model for another model
}

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

function generateCheckpointKey(modelName: string): string {
  return modelName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') + '_CKPT';
}

/** Mirrors UI's generateVisionEmbeddingCheckpointName — strips _INSTRUCT suffix, adds _VISION_EMBD_CKPT */
function generateVisionEmbeddingCkptKey(modelName: string): string {
  const base = modelName.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (base.endsWith('_INSTRUCT')) return base.replace(/_INSTRUCT$/, '') + '_VISION_EMBD_CKPT';
  return base + '_VISION_EMBD_CKPT';
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

interface BuildBundleYamlOptions {
  selections:        BundleSelection[];
  checkpointMapping: Record<string, { path: string; vision_embedding_checkpoint?: string }>;
  checkpointsDir:    string;
  bundleName:        string;
}

/** Format Kubernetes bundle validation errors the same way the UI does */
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

function buildBundleYaml(opts: BuildBundleYamlOptions): { yaml: string; templateName: string; bundleManifestName: string } {
  const { selections, checkpointMapping, checkpointsDir, bundleName } = opts;
  const templateName       = `bt-${bundleName}`;
  const bundleManifestName = `b-${bundleName}`;
  const tmpl: Record<string, string> = {};
  const bmod: Record<string, string> = {};
  const ckpt: Record<string, string> = {};

  // Build lookup: targetModel+ss+bs → draftModelName
  const draftLookup: Record<string, string> = {};
  for (const sel of selections) {
    if (sel.draftFor) {
      draftLookup[`${sel.draftFor}|${sel.ss}|${sel.bs}`] = sel.model;
    }
  }

  // Group non-draft selections by model → SS (mirrors UI bundle-yaml-generator.ts expert grouping)
  const modelSsGroups: Record<string, Record<string, BundleSelection[]>> = {};
  for (const sel of selections) {
    if (sel.draftFor) continue;
    if (!modelSsGroups[sel.model]) modelSsGroups[sel.model] = {};
    if (!modelSsGroups[sel.model][sel.ss]) modelSsGroups[sel.model][sel.ss] = [];
    modelSsGroups[sel.model][sel.ss].push(sel);
  }

  for (const [model, ssGroups] of Object.entries(modelSsGroups)) {
    const cd  = checkpointMapping[model];
    const ck  = generateCheckpointKey(model);
    const dir = checkpointsDir.endsWith('/') ? checkpointsDir : checkpointsDir + '/';
    let expertBlock = '      experts:\n';

    for (const [ss, configs] of Object.entries(ssGroups)) {
      // Split DYT PEFs (multi-BS, use dynamic_dims) from regular PEFs (single BS)
      const dytByPef: Record<string, { pef: string; version: string; bsValues: number[] }> = {};
      const regularConfigs: BundleSelection[] = [];
      for (const c of configs) {
        if (/-dyt-/.test(c.pef)) {
          if (!dytByPef[c.pef]) dytByPef[c.pef] = { pef: c.pef, version: c.version, bsValues: [] };
          dytByPef[c.pef].bsValues.push(parseInt(c.bs, 10));
        } else {
          regularConfigs.push(c);
        }
      }

      expertBlock += `        ${ss}:\n          configs:\n`;

      // DYT PEFs: one entry per PEF with dynamic_dims (matches UI bundle-yaml-generator.ts)
      for (const { pef, version, bsValues } of Object.values(dytByPef)) {
        expertBlock += `          - dynamic_dims:\n              batch_size:\n                values:\n`;
        bsValues.sort((a, b) => a - b).forEach(bs => { expertBlock += `                - ${bs}\n`; });
        expertBlock += `            pef: ${pef}:${version}\n`;
      }

      // Regular PEFs: use default_config_values when all have draft + multiple configs
      const allHaveDraft = regularConfigs.length > 0 && regularConfigs.every(c => !!draftLookup[`${c.model}|${c.ss}|${c.bs}`]);
      const hasMultiple  = regularConfigs.length > 1;
      const firstDraft   = regularConfigs.length > 0 ? draftLookup[`${regularConfigs[0].model}|${regularConfigs[0].ss}|${regularConfigs[0].bs}`] : undefined;

      if (allHaveDraft && hasMultiple && firstDraft) {
        for (const c of regularConfigs) {
          expertBlock += `          - pef: ${c.pef}:${c.version}\n`;
        }
        expertBlock += `          default_config_values:\n            spec_decoding:\n              draft_model: ${firstDraft}\n`;
      } else {
        for (const c of regularConfigs) {
          const cfgDraft = draftLookup[`${c.model}|${c.ss}|${c.bs}`];
          expertBlock += `          - pef: ${c.pef}:${c.version}\n`;
          if (cfgDraft) {
            expertBlock += `            spec_decoding:\n              draft_model: ${cfgDraft}\n`;
          }
        }
      }
    }

    tmpl[model] = expertBlock;
    ckpt[ck]    = `    ${ck}:\n      source: ${dir}${cd.path}\n      toolSupport: true\n`;
    // Vision embedding checkpoint (Llama-4-Maverick, gemma-3-12b-it, etc.)
    const vck = cd.vision_embedding_checkpoint ? generateVisionEmbeddingCkptKey(model) : null;
    if (vck && cd.vision_embedding_checkpoint) {
      ckpt[vck] = `    ${vck}:\n      source: ${dir}${cd.vision_embedding_checkpoint}\n      toolSupport: true\n`;
    }
    let modelEntry = `    ${model}:\n      checkpoint: ${ck}\n      template: ${model}\n`;
    if (vck) modelEntry += `      vision_embedding_checkpoint: ${vck}\n`;
    bmod[model] = modelEntry;
  }

  // Draft models also need their own template entries and checkpoints
  // Group by model → SS to avoid duplicate SS keys (same fix as non-draft loop above)
  const draftSsGroups: Record<string, Record<string, BundleSelection[]>> = {};
  for (const sel of selections) {
    if (!sel.draftFor) continue;
    if (!draftSsGroups[sel.model]) draftSsGroups[sel.model] = {};
    if (!draftSsGroups[sel.model][sel.ss]) draftSsGroups[sel.model][sel.ss] = [];
    draftSsGroups[sel.model][sel.ss].push(sel);
  }
  for (const [draftModel, ssGroups] of Object.entries(draftSsGroups)) {
    const cd  = checkpointMapping[draftModel];
    const ck  = generateCheckpointKey(draftModel);
    const dir = checkpointsDir.endsWith('/') ? checkpointsDir : checkpointsDir + '/';
    if (!cd) continue;
    let expertBlock = '      experts:\n';
    for (const [ss, configs] of Object.entries(ssGroups)) {
      expertBlock += `        ${ss}:\n          configs:\n`;
      for (const c of configs) {
        expertBlock += `          - pef: ${c.pef}:${c.version}\n`;
      }
    }
    if (!tmpl[draftModel]) tmpl[draftModel] = expertBlock;
    if (!bmod[draftModel]) bmod[draftModel] = `    ${draftModel}:\n      checkpoint: ${ck}\n      template: ${draftModel}\n`;
    ckpt[ck] = `    ${ck}:\n      source: ${dir}${cd.path}\n      toolSupport: true\n`;
  }

  const tModels = Object.keys(tmpl).map(m => `    ${m}:\n${tmpl[m]}`).join('');
  const bModels = Object.values(bmod).join('');
  const ckpts   = Object.values(ckpt).join('');

  const yaml = [
    'apiVersion: sambanova.ai/v1alpha1',
    'kind: BundleTemplate',
    'metadata:',
    `  name: ${templateName}`,
    'spec:',
    '  models:',
    tModels.trimEnd(),
    '  owner: no-reply@sambanova.ai',
    '  secretNames:',
    '  - sambanova-artifact-reader',
    '  usePefCRs: true',
    '---',
    'apiVersion: sambanova.ai/v1alpha1',
    'kind: Bundle',
    'metadata:',
    `  name: ${bundleManifestName}`,
    'spec:',
    '  checkpoints:',
    ckpts.trimEnd(),
    '  models:',
    bModels.trimEnd(),
    '  secretNames:',
    '  - sambanova-artifact-reader',
    `  template: ${templateName}`,
  ].join('\n') + '\n';

  return { yaml, templateName, bundleManifestName };
}

function buildDeploymentYaml(bundleName: string): { yaml: string; deploymentName: string } {
  const deploymentName = bundleName.replace(/^b-/, 'bd-');
  const yaml = [
    'apiVersion: sambanova.ai/v1alpha1',
    'kind: BundleDeployment',
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
  return { yaml, deploymentName };
}

// ─── Paths ───────────────────────────────────────────────────────────────────
// tsx sets __dirname to '.' — use process.cwd() which always points to the
// project root when launched via `npm run dev-cli` from sambawiz/

const PROJECT_ROOT = process.cwd();
const APP_DIR      = path.join(PROJECT_ROOT, 'app');
const DATA_DIR     = path.join(APP_DIR, 'data');

// ─── generateCheckpointMapping() ─────────────────────────────────────────────

function stripGcsPrefix(p: string): string {
  return p.replace(/^gs:\/\/[^/]+\//, '').replace(/\/$/, '');
}

function highestVersion(versions: Record<string, any>): string {
  const keys = Object.keys(versions);
  return keys.sort((a, b) => {
    const ap = a.split('.').map(Number);
    const bp = b.split('.').map(Number);
    for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
      const d = (ap[i] || 0) - (bp[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  })[keys.length - 1];
}

async function generateCheckpointMapping(kubeconfigPath: string, namespace: string, checkpointOverrides: Record<string, string> = {}): Promise<{ count: number }> {
  spinner.start('Generating checkpoint mapping from cluster...');
  await tick();

  const env = { ...process.env, KUBECONFIG: kubeconfigPath };
  let rawOutput: string;
  try {
    rawOutput = execSync(`kubectl -n ${namespace} get models -o json`, {
      env,
      encoding: 'utf-8',
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    const detail = e.stderr ? String(e.stderr).trim().split('\n')[0] : e.message.split('\n')[0];
    throw new Error(`kubectl get models failed: ${detail}`);
  }

  const modelsData = JSON.parse(rawOutput);
  const mapping: Record<string, any> = {};

  for (const item of modelsData.items || []) {
    const modelName    = item.spec?.name;
    const resourceName = item.metadata?.name;
    const checkpoints  = item.spec?.checkpoints;
    if (!modelName || !resourceName || !checkpoints) continue;

    const firstKey = Object.keys(checkpoints)[0];
    if (!firstKey) continue;

    const versions = checkpoints[firstKey].versions;
    if (!versions || Object.keys(versions).length === 0) continue;

    const override = checkpointOverrides[modelName];
    const selVer   = (override && versions[override]) ? override : highestVersion(versions);
    const verData  = versions[selVer];
    if (!verData?.source) continue;

    const entry: any = {
      path:          stripGcsPrefix(verData.source),
      resource_name: resourceName,
    };
    if (verData.vision_embedding_checkpoint) {
      entry.vision_embedding_checkpoint = stripGcsPrefix(verData.vision_embedding_checkpoint);
    }
    mapping[modelName] = entry;
  }

  const outputPath = path.join(DATA_DIR, 'checkpoint_mapping.json');
  writeFileSync(outputPath, JSON.stringify(mapping, null, 2) + '\n');
  spinner.succeed('Checkpoint mapping generated');
  return { count: Object.keys(mapping).length };
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
      process.stdout.write(`\r${chalk.cyan(this.frames[this.idx])}  ${chalk.reset(text)}   `);
      this.idx = (this.idx + 1) % this.frames.length;
    }, 80);
    return this;
  }

  succeed(text: string) { this._stop(); process.stdout.write(`  ${chalk.green('✔')}  ${chalk.green(text)}\n`); }
  fail(text: string)    { this._stop(); process.stdout.write(`  ${chalk.red('✖')}  ${chalk.red(text)}\n`); }
  warn(text: string)    { this._stop(); process.stdout.write(`  ${chalk.yellow('⚠')}  ${chalk.yellow(text)}\n`); }
  info(text: string)    { this._stop(); process.stdout.write(`  ${chalk.cyan('ℹ')}  ${text}\n`); }

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
  ensureKeypressEvents();

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
        if (choice.hint) lines.push(`     ${chalk.gray(choice.hint)}`);
      } else {
        const hint = choice.hint ? chalk.gray(`  ${choice.hint}`) : '';
        lines.push(`${cursor}${label}${hint}`);
      }
    });

    const remaining = choices.length - scrollOffset - maxVisible;
    if (remaining > 0) lines.push(chalk.reset(`   ↓ ${remaining} more below`));

    lastDrawnCount = lines.length;
    lines.forEach(l => process.stdout.write(`${l}\n`));
  };

  const clear = () => {
    readlineModule.moveCursor(process.stdout, 0, -lastDrawnCount);
    readlineModule.clearScreenDown(process.stdout);
  };

  draw();

  return new Promise((resolve) => {
    const onKey = (_str: any, key: any) => {
      if (!key) return;
      if (key.name === 'up')     { clear(); selectedIndex = (selectedIndex - 1 + choices.length) % choices.length; draw(); }
      else if (key.name === 'down') { clear(); selectedIndex = (selectedIndex + 1) % choices.length; draw(); }
      else if (key.name === 'return') {
        process.stdin.removeListener('keypress', onKey);
        process.stdin.setRawMode(isRaw);
        process.stdout.write('\n');
        resolve(choices[selectedIndex].value);
      } else if (key.name === 'q' || key.name === 'escape') {
        process.stdin.removeListener('keypress', onKey);
        process.stdin.setRawMode(isRaw);
        process.stdout.write('\n');
        resolve(null);
      } else if (key.ctrl && key.name === 'c') {
        process.stdin.removeListener('keypress', onKey);
        process.stdin.setRawMode(isRaw);
        resolve(null);
      }
    };
    process.stdin.on('keypress', onKey);
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
  // Regular choices shift by +1 if selectAll was inserted before them
  const checked = new Set<number>(preCheckedIndices ? Array.from(preCheckedIndices).map(i => i + 1) : []);

  // Indices (into workChoices) that are regular toggleable items
  const regularIndices = workChoices
    .map((_, i) => i)
    .filter(i => workChoices[i].value !== '__selectAll__' && workChoices[i].value !== 'back' && workChoices[i].value !== 'finish');

  let selectedIndex = 0;
  const isRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  ensureKeypressEvents();

  const maxVisible = Math.max(5, (process.stdout.rows || 24) - 6);
  let scrollOffset = 0;
  let lastDrawnCount = 0;

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
        process.stdin.removeListener('keypress', onKey);
        process.stdin.setRawMode(isRaw);
        process.stdout.write('\n');
        const sv = workChoices[selectedIndex].value;
        if (sv === 'back') resolve([sv]);
        else resolve(Array.from(checked).filter(i => workChoices[i]?.value !== '__selectAll__').map(i => workChoices[i].value));
      } else if (key.name === 'q' || key.name === 'escape') {
        process.stdin.removeListener('keypress', onKey);
        process.stdin.setRawMode(isRaw);
        process.stdout.write('\n');
        resolve([]);
      } else if (key.ctrl && key.name === 'c') {
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
const ESC = '\x1b';

async function input(_rl: any, message: string, defaultValue = ''): Promise<string> {
  const prompt = `\n  ${chalk.hex(BRAND).bold('›')} ${chalk.bold(message)}  ${chalk.gray('Esc cancel')}: `;
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
      return { name: isCurrent ? `${chalk.green('●')}  ${chalk.bold(e)}  ${chalk.cyan('← active')}` : `○  ${e}`, value: e };
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
    process.stdout.write(chalk.gray('\n  Paste the base64-encoded kubeconfig or enter a file path.\n  The file will be saved as kubeconfigs/kubeconfig-' + name + '.yaml\n\n'));
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
      file:      destRelative,
      namespace: ns || 'default',
      uiDomain:  uiDomain  || '',
      apiDomain: apiDomain || '',
      apiKey:    apiKey    || '',
    };
    appConfig.currentKubeconfig = name;

    writeFileSync(CONFIG_PATH, JSON.stringify(appConfig, null, 2) + '\n');
    successMsg(`Environment "${name}" added and set as active.`);
    infoRow('Kubeconfig', destRelative);
    if (uiDomain)  infoRow('UI Domain',  uiDomain);
    if (apiDomain) infoRow('API Domain', apiDomain);
    process.stdout.write('\n');

    // ── Auto-generate checkpoint mapping ──────────────────────────────────────
    try {
      const overrides: Record<string, string> = appConfig.checkpoint_overrides || {};
      await generateCheckpointMapping(destPath, ns || 'default', overrides);
    } catch (e: any) {
      spinner.fail(`Checkpoint mapping failed: ${e.message.split('\n')[0]}`);
      process.stdout.write(chalk.yellow(`\n  Bundle Builder will not work until checkpoint_mapping.json is generated.\n  Run Validate to diagnose cluster connectivity.\n\n`));
    }

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
        freshConfig.kubeconfigs[name] = { ...ec, file: file || ec.file, namespace: editNs || ec.namespace, uiDomain: uiD, apiDomain: apiD, apiKey: aKey };
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
    if (!isCurrent) actionChoices.push({ name: chalk.cyan('⚡  Activate'), value: 'activate' });
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
      const overrides: Record<string, string> = freshConfig.checkpoint_overrides || {};
      try {
        await generateCheckpointMapping(kPath, ns, overrides);
      } catch (e: any) {
        spinner.fail(`Checkpoint mapping failed: ${e.message.split('\n')[0]}`);
        process.stdout.write(chalk.yellow(`\n  Bundle Builder will not work until checkpoint_mapping.json is generated.\n  Run Validate to diagnose cluster connectivity.\n\n`));
      }
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

      freshConfig.kubeconfigs[envName] = {
        ...ec,
        file:      file      || ec.file,
        namespace: ns        || ec.namespace,
        uiDomain:  uiDomain,
        apiDomain: apiDomain,
        apiKey:    apiKey,
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
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });

  // ── Instance lock — only one CLI allowed at a time ───────────────────────────
  try {
    const result = execSync('pgrep -f "tsx bin/cli.ts"', { encoding: 'utf-8' }).trim();
    const pids = result.split('\n').map(Number).filter(p => p && p !== process.pid);
    if (pids.length > 0) {
      process.stdout.write(chalk.red(`\n  ✖  SambaWiz CLI is already running (PID ${pids[0]}).\n`));
      process.stdout.write(chalk.reset('     Only one instance is allowed at a time.\n'));
      process.stdout.write(chalk.reset('     Close the other session first, then try again.\n\n'));
      rl.close(); process.exit(1);
    }
  } catch { /* pgrep exits non-zero when no match — that's fine, means no other instance */ }

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

  let { appConfig: liveAppConfig, envConfig, namespace, currentEnv } = loaded;

  let exitLoop = false;
  while (!exitLoop) {
    const envBadge = chalk.hex(BRAND)(`[${currentEnv}]`);
    const action = await select(rl, `Main Menu  ${envBadge}`, [
      { name: `⚙️   Manage Environments`,               value: 'add_env',        hint: 'Add, activate, edit, delete and validate' },
      { name: `🧱  Bundle Builder`,                   value: 'bundle_builder', hint: 'Create and validate bundles' },
      { name: `🚀  Bundle Deployment`,                  value: 'bundle_deploy',  hint: 'Deploy or delete bundles' },
      { name: `📈  Check Deployment Progress`,         value: 'monitor_deploy', hint: 'Live pod status monitor' },
      { name: `🤖  Playground (Chat Console)`,         value: 'playground',     hint: 'Chat with deployed models' },
      { name: chalk.yellow('⏹️   Exit'),               value: 'exit' },
    ], true);

    if (!action) continue;

    switch (action) {
      case 'add_env':
        await addEnvironmentMenu(rl);
        // Reload config in case environment changed
        { const r = loadEnvConfig(); if (!r.error) ({ appConfig: liveAppConfig, envConfig, namespace, currentEnv } = r); }
        break;
      case 'bundle_builder':
        await bundleBuilderMenu(rl, liveAppConfig, namespace);
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
        spinner.succeed(`SambaStack  ${chalk.reset(chartVer)}${minVer ? chalk.gray(`  (min: ${minVer})`) : ''}`);
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
    // Regenerate checkpoint mapping now that cluster connectivity is confirmed
    try {
      const appConfig = requireJson(CONFIG_PATH);
      const overrides: Record<string, string> = appConfig.checkpoint_overrides || {};
      await generateCheckpointMapping(kPath, namespace, overrides);
    } catch (e: any) {
      spinner.fail(`Checkpoint mapping failed: ${e.message.split('\n')[0]}`);
      process.stdout.write(chalk.yellow(`\n  Bundle Builder will not work until checkpoint_mapping.json is generated.\n\n`));
    }
  } else {
    errorMsg('Some checks failed — review app-config.json');
  }
}

// tiny async tick so spinner renders at least once
function tick() { return new Promise(r => setTimeout(r, 120)); }

// ─── bundleBuilderMenu() ─────────────────────────────────────────────────────

async function bundleBuilderMenu(rl: any, appConfig: any, namespace: string) {
  sectionHeader('Bundle Builder', '🧱');

  const pefMapping        = requireJson(path.join(DATA_DIR, 'pef_mapping.json'));
  const checkpointMapping = requireJson(path.join(DATA_DIR, 'checkpoint_mapping.json'));
  const pefConfigsPath    = path.join(DATA_DIR, 'pef_configs.json');
  const pefConfigs        = requireJson(pefConfigsPath);

  const availableModels = Object.keys(pefMapping).filter(m => checkpointMapping[m]?.path);
  if (availableModels.length === 0) {
    errorMsg('No models available — check checkpoint_mapping.json');
    return;
  }

  const allSelections: any[] = [];
  let addingModels = true;

  // ── Load saved bundle shortcut ──────────────────────────────────────────────
  const artifactsDir  = path.join(PROJECT_ROOT, 'saved_artifacts');
  const savedArtifacts = existsSync(artifactsDir)
    ? readdirSync(artifactsDir)
        .filter(f => /\.(yaml|yml)$/i.test(f))
        .filter(f => {
          const c = readFileSync(path.join(artifactsDir, f), 'utf-8');
          return c.includes('kind: BundleTemplate') && c.includes('kind: Bundle');
        })
    : [];

  if (savedArtifacts.length > 0) {
    const loadChoice = await select(rl, 'Bundle Builder — start from:', [
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
      const mName       = loadedYaml.match(/kind:\s+Bundle\b[\s\S]*?name:\s+(\S+)/);
      const loadedBName = mName ? mName[1] : chosenFile.replace(/\.ya?ml$/i, '');
      yamlBox(`Loaded: ${chosenFile}`, loadedYaml);

      // Jump straight to the What-next menu with the loaded YAML
      let finalYaml    = loadedYaml;
      let activeBName  = loadedBName;
      let shouldApply  = false;
      const bundleName = loadedBName;

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
            execSync(`${editor} "${tmp}"`, { stdio: 'inherit' });
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
          const fname = await input(rl, 'Filename', path.join(saveDir, bundleName + '.yaml'));
          if (fname && fname !== ESC) {
            try { writeFileSync(fname, finalYaml); successMsg(`Saved to ${fname}`); } catch (e: any) { errorMsg(`Save failed: ${e.message}`); }
          }
        } else if (act === 'validate') {
          const m  = finalYaml.match(/kind:\s+Bundle\b[\s\S]*?name:\s+(\S+)/);
          activeBName = m ? m[1] : loadedBName;
          shouldApply = true;
          break;
        } else if (act === 'skip') {
          process.stdout.write('\n');
          process.stdout.write(chalk.reset(`  Bundle template is ready.\n`));
          process.stdout.write(chalk.hex(BRAND).bold(`  → Go to  🚀 Bundle Deployment  from the main menu to deploy it.\n\n`));
          return;
        }
      }

      if (shouldApply) {
        const tempPath = path.join(PROJECT_ROOT, `temp_bundle_${Date.now()}.yaml`);
        try {
          writeFileSync(tempPath, finalYaml);
          spinner.start('Applying bundle to cluster...');
          await tick();
          const applyOut1 = execSync(`kubectl apply -f ${tempPath} -n ${namespace}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
          spinner.succeed('Bundle applied — polling for validation status...');
          if (applyOut1?.trim()) {
            process.stdout.write(chalk.reset('\nkubectl apply output:\n'));
            applyOut1.trim().split('\n').forEach((line: string) => process.stdout.write(chalk.reset(`  ${line}\n`)));
            process.stdout.write('\n');
          }
          const maxAttempts = 120; const pollInterval = 5000; let validated = false;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await new Promise(r => setTimeout(r, pollInterval));
            try {
              const st   = JSON.parse(execSync(`kubectl get bundle.sambanova.ai ${activeBName} -n ${namespace} -o json`, { encoding: 'utf-8' }));
              const conds = st.status?.conditions || [];
              const phase = st.status?.phase || 'Pending';
              const elapsed = attempt * (pollInterval / 1000);
              process.stdout.write(`\r  ${chalk.cyan('◉')}  ${chalk.bold(phase)}  ${chalk.reset(`[${elapsed}s]`)}                    `);
              if (conds.length > 0) {
                const latest = conds[conds.length - 1];
                process.stdout.write(`\r  ${chalk.cyan('◉')}  ${chalk.bold(phase)}  ${chalk.reset(`${latest.reason}: ${latest.message}`)}  ${chalk.reset(`[${elapsed}s]`)}   `);
                if (latest.reason === 'ValidationSucceeded' || (latest.type === 'Validated' && latest.status === 'True')) {
                  process.stdout.write('\n'); successMsg('Bundle Validation Succeeded!');
                  validated = true; break;
                } else if (latest.reason === 'ValidationFailed' || latest.status === 'False') {
                  process.stdout.write('\n');
                  printValidationErrors(conds);
                  validated = true; break;
                }
              }
            } catch {
              process.stdout.write(`\r  ${chalk.yellow('⠋')}  Waiting for bundle resource...  ${chalk.reset(`[${attempt * pollInterval / 1000}s]`)}   `);
            }
          }
          if (!validated) { process.stdout.write('\n'); warnMsg(`Validation timeout — check: kubectl get bundle.sambanova.ai ${activeBName} -n ${namespace} -o yaml`); }
        } catch (e: any) { errorMsg(`Error applying bundle: ${e.message}`); }
        finally { try { execSync(`rm "${tempPath}"`); } catch {} }
        process.stdout.write('\n');
        process.stdout.write(chalk.reset(`  Bundle template is ready.\n`));
        process.stdout.write(chalk.hex(BRAND).bold(`  → Go to  🚀 Bundle Deployment  from the main menu to deploy it.\n\n`));
      }
      return;
    }
  }
  // ────────────────────────────────────────────────────────────────────────────

  builderLoop: while (true) {   // outer loop — allows "Go Back" from SD warning or validation failure to re-enter model selection
    addingModels = true;

  while (addingModels) {
    const choices: Choice[] = [
      { name: chalk.green.bold('✅  Finish and Create Bundle'), value: 'finish',
        hint: allSelections.length > 0 ? `${allSelections.length} model(s) selected` : '' },
      ...availableModels.map(m => ({ name: m, value: m })),
      { name: chalk.red('✕  Cancel'), value: 'cancel' },
    ];

    const selectedModel = await select(rl, `Bundle Builder  ${chalk.reset(`(${allSelections.length} added)`)}`, choices);

    if (!selectedModel || selectedModel === 'cancel') return;
    if (selectedModel === 'finish') {
      if (allSelections.length === 0) { warnMsg('Add at least one model first.'); continue; }
      addingModels = false;
      continue;
    }

    const modelPefs: string[] = pefMapping[selectedModel] || [];
    const modelConfigs: any[] = [];

    for (const pef of modelPefs) {
      const cd = pefConfigs[pef];
      if (cd) {
        if (Array.isArray(cd)) modelConfigs.push(...cd.map((c: any) => ({ ...c, ss: String(c.ss), bs: String(c.bs), pefName: pef })));
        else if (cd.ss) modelConfigs.push({ ...cd, ss: String(cd.ss), bs: String(cd.bs), pefName: pef });
      } else {
        const m = pef.match(/ss(\d+)-bs(\d+)/);
        if (m) {
          const ssNum = parseInt(m[1]);
          modelConfigs.push({ ss: ssNum >= 1024 ? ssNum / 1024 + 'k' : ssNum.toString(), bs: m[2], pefName: pef, latestVersion: '1' });
        }
      }
    }

    if (modelConfigs.length === 0) { warnMsg(`No PEF configs found for ${selectedModel}`); continue; }

    // Sort by SS ascending, then BS ascending
    const ssToNum = (ss: string) => ss.endsWith('k') ? parseFloat(ss) * 1024 : parseInt(ss, 10);
    modelConfigs.sort((a, b) => {
      const ssDiff = ssToNum(a.ss) - ssToNum(b.ss);
      return ssDiff !== 0 ? ssDiff : parseInt(a.bs, 10) - parseInt(b.bs, 10);
    });

    // Find any previously selected configs for this model (for pre-checking on re-edit)
    const prevSelForModel = allSelections.filter((s: BundleSelection) => s.model === selectedModel && !s.draftFor);

    const comboChoices: Choice[] = [
      { name: chalk.green('✅  Done - Confirm Selection'), value: 'finish' },
      ...modelConfigs.map(c => {
        const isSD   = /-sd\d+/.test(c.pefName);
        const sdBadge = isSD ? chalk.yellow(' ⚡SD') : '';
        const hint    = isSD ? 'requires draft model' : undefined;
        return {
          name:  `SS: ${String(c.ss).padEnd(6)} │ BS: ${String(c.bs).padEnd(3)} │ ${chalk.reset(c.pefName)}${sdBadge}`,
          value: c,
          hint,
        };
      }),
      { name: chalk.red('✕  Back'), value: 'back' },
    ];

    // Pre-check indices that match previously selected configs for this model
    const preChecked = new Set<number>();
    comboChoices.forEach((choice, idx) => {
      if (choice.value && choice.value !== 'finish' && choice.value !== 'back') {
        const c = choice.value;
        if (prevSelForModel.some((ps: BundleSelection) => ps.pef === c.pefName && ps.ss === c.ss && ps.bs === c.bs)) {
          preChecked.add(idx);
        }
      }
    });

    const selectedCombos = await multiSelect(rl, `Configurations for ${chalk.bold(selectedModel)}:`, comboChoices, preChecked);
    if (!selectedCombos || selectedCombos.length === 0 || selectedCombos.includes('back')) continue;

    // Remove existing entries for this model (and its draft) before adding new selection
    const keep = allSelections.filter((s: BundleSelection) => s.model !== selectedModel && s.draftFor !== selectedModel);
    allSelections.length = 0;
    allSelections.push(...keep);

    selectedCombos.forEach((c: any) => {
      allSelections.push({ model: selectedModel, ss: c.ss, bs: c.bs, pef: c.pefName, version: c.latestVersion || '1' });
    });
    successMsg(`Added ${selectedCombos.length} config(s) for ${selectedModel}`);

    // Draft model (speculative decoding)
    const supportsSD = modelPefs.length > 0 && modelPefs.some(p => p.split('-').some((s: string) => /^sd\d+$/.test(s)));
    if (supportsSD) {
      // Check if ALL PEFs for this model are SD PEFs — if so, draft model is mandatory
      const allPefsAreSD = modelPefs.length > 0 && modelPefs.every(p => /-sd\d+/.test(p));

      if (allPefsAreSD) {
        process.stdout.write(chalk.yellow(`\n  ⚡ ${selectedModel} uses ONLY speculative decoding PEFs.\n`));
        process.stdout.write(chalk.reset('     A draft model is REQUIRED — this model cannot run without one.\n'));
        process.stdout.write(chalk.reset('     Recommended: Meta-Llama-3.1-8B-Instruct\n\n'));
      } else {
        process.stdout.write(chalk.yellow(`\n  ⚡ ${selectedModel} supports speculative decoding.\n`));
        process.stdout.write(chalk.reset('     A smaller draft model can significantly improve throughput.\n'));
      }
      process.stdout.write(chalk.reset(`     Selected configs: ${selectedCombos.map((c: any) => `SS:${c.ss} BS:${c.bs}`).join(', ')}\n\n`));

      const draftChoices: Choice[] = [
        { name: chalk.cyan('↩  Skip (no draft model)'), value: 'skip' },
        ...availableModels.filter(m => m !== selectedModel).map(m => ({ name: m, value: m })),
        { name: chalk.reset('← Back'), value: 'back' },
      ];

      const draftModel = await select(rl, `${allPefsAreSD ? '⚠  Required' : 'Optional'}: Draft model for ${selectedModel}:`, draftChoices);
      if (draftModel && draftModel !== 'skip' && draftModel !== 'back') {
        if (!checkpointMapping[draftModel]?.path) {
          warnMsg(`Draft model "${draftModel}" has no checkpoint — skipping`);
        } else {
          const draftPefs: string[] = pefMapping[draftModel] || [];
          let draftAdded = 0;
          const matchedConfigs: string[] = [];
          selectedCombos.forEach((targetConfig: any) => {
            for (const dp of draftPefs) {
              const dcd = pefConfigs[dp];
              let entries: any[] = [];
              if (Array.isArray(dcd)) entries = dcd;
              else if (dcd?.ss) entries = [dcd];
              else {
                const dm = dp.match(/ss(\d+)-bs(\d+)/);
                if (dm) { const sn = parseInt(dm[1]); entries = [{ ss: sn >= 1024 ? sn/1024+'k' : sn.toString(), bs: dm[2], latestVersion: '1' }]; }
              }
              const match = entries.find(e => e.ss === targetConfig.ss && e.bs === targetConfig.bs);
              if (match) {
                allSelections.push({ model: draftModel, ss: match.ss, bs: match.bs, pef: dp, version: match.latestVersion || '1', draftFor: selectedModel });
                matchedConfigs.push(`SS:${match.ss} BS:${match.bs}`);
                draftAdded++;
                break;
              }
            }
          });
          if (draftAdded > 0) {
            successMsg(`Auto-added ${draftAdded} draft config(s) for ${draftModel}`);
            process.stdout.write(chalk.reset(`  Note: matched configs — ${matchedConfigs.join(', ')}\n\n`));
          } else {
            warnMsg(`No matching SS/BS found for draft model ${draftModel}`);
          }
        }
      }
    }
  }

  if (allSelections.length === 0) return;
  if (!appConfig.checkpointsDir) { errorMsg('checkpointsDir not set in app-config.json'); return; }

  // Warn if any SD PEFs selected without a matching draft model
  const sdWithoutDraft = allSelections.filter(s =>
    !s.draftFor &&
    /-sd\d+/.test(s.pef) &&
    !allSelections.some(d => d.draftFor === s.model && d.ss === s.ss && d.bs === s.bs)
  );
  if (sdWithoutDraft.length > 0) {
    process.stdout.write('\n');
    process.stdout.write(chalk.yellow('  ⚠  The following SD PEFs have no draft model assigned and will fail cluster validation:\n'));
    sdWithoutDraft.forEach(s => process.stdout.write(chalk.yellow(`     • ${s.pef}  (${s.model}  SS:${s.ss}  BS:${s.bs})\n`)));
    process.stdout.write(chalk.reset('     Either go back and assign a draft model, or the bundle will fail with ValidationFailed.\n\n'));
    const sdAction = await select(rl, 'How to proceed?', [
      { name: chalk.cyan('← Go back to Bundle Builder  (re-edit selections)'), value: 'back'     },
      { name: chalk.yellow('▶ Continue anyway  (bundle may fail validation)'),  value: 'continue' },
      { name: chalk.red('✕  Cancel'),                                           value: 'cancel'   },
    ]);
    if (!sdAction || sdAction === 'cancel') return;
    if (sdAction === 'back') continue;  // restart outer loop → re-enter model selection
  }

  // no SD issues, or user chose Continue — fall through to YAML generation

  // Summary
  sectionHeader('Bundle Summary', '📋');
  allSelections.forEach((sel: BundleSelection, i: number) => {
    const isSD     = /-sd\d+/.test(sel.pef);
    const hasDraft = sel.draftFor || allSelections.some((d: BundleSelection) => d.draftFor === sel.model && d.ss === sel.ss && d.bs === sel.bs);
    const warn     = (isSD && !hasDraft) ? chalk.yellow('  ⚠ no draft — will fail validation') : '';
    process.stdout.write(
      `  ${chalk.reset(`${i+1}.`)} ${chalk.reset.bold(sel.model.padEnd(38))} ` +
      `${chalk.cyan(`SS:${sel.ss}`)}  ${chalk.cyan(`BS:${sel.bs}`)}${warn}\n`
    );
  });
  process.stdout.write('\n');
  hr();

  // Build YAML preview with placeholder name
  const { yaml: previewYaml } = buildBundleYaml({
    selections: allSelections as BundleSelection[],
    checkpointMapping,
    checkpointsDir: appConfig.checkpointsDir,
    bundleName: 'BUNDLE_NAME',
  });

  yamlBox('YAML Preview  (BUNDLE_NAME = placeholder)', previewYaml);

  const proceed = await confirm(rl, 'Proceed with this bundle?');
  if (!proceed) return;

  const bundleName = await input(rl, 'Bundle name', `bundle-${Date.now().toString().slice(-4)}`);
  if (!bundleName || bundleName === ESC) return;
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(bundleName)) {
    errorMsg('Bundle name must be lowercase alphanumeric and hyphens only, 2–63 chars, start/end with a letter or digit.');
    return;
  }
  const { yaml: finalYamlBuilt, bundleManifestName: bName } = buildBundleYaml({
    selections: allSelections as BundleSelection[],
    checkpointMapping,
    checkpointsDir: appConfig.checkpointsDir,
    bundleName,
  });
  let finalYaml = finalYamlBuilt;

  yamlBox(`Final YAML  (${bundleName})`, finalYaml);

  let activeBName = bName;
  let shouldApply = false;

  while (true) {
    const act = await select(rl, 'What next?', [
      { name: '✅  Apply to cluster to validate',   value: 'validate' },
      { name: '✏️   Edit in editor',               value: 'edit' },
      { name: '💾  Save to file',                   value: 'save' },
      { name: chalk.reset('← Skip (deploy later)'), value: 'skip' },
      { name: chalk.red('✕  Cancel'),               value: 'cancel' },
    ]);

    if (!act || act === 'cancel') return;

    if (act === 'edit') {
      const tmp = path.join(PROJECT_ROOT, `.tmp_bundle_${Date.now()}.yaml`);
      writeFileSync(tmp, finalYaml);
      const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
      try {
        process.stdout.write(chalk.yellow(`\n  Opening ${editor}...\n`));
        execSync(`${editor} "${tmp}"`, { stdio: 'inherit' });
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
      const fname = await input(rl, 'Filename', path.join(saveDir, `${bundleName}.yaml`));
      if (fname && fname !== ESC) {
        try { writeFileSync(fname, finalYaml); successMsg(`Saved to ${fname}`); } catch (e: any) { errorMsg(`Save failed: ${e.message}`); }
      }
    } else if (act === 'validate') {
      // Re-derive bundle name in case user edited the YAML
      const m = finalYaml.match(/kind:\s+Bundle\b[\s\S]*?name:\s+(\S+)/);
      activeBName = m ? m[1] : bName;
      shouldApply = true;
      break;
    } else if (act === 'skip') {
      process.stdout.write('\n');
      process.stdout.write(chalk.reset(`  Bundle template is ready.\n`));
      process.stdout.write(chalk.hex(BRAND).bold(`  → Go to  🚀 Bundle Deployment  from the main menu to deploy it.\n\n`));
      return;
    }
  }

  if (!shouldApply) break builderLoop;

  const tempPath = path.join(PROJECT_ROOT, `temp_bundle_${Date.now()}.yaml`);
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

    // Derive BundleTemplate name: b-xxx → bt-xxx
    const activeBtName = activeBName.replace(/^b-/, 'bt-');

    process.stdout.write(chalk.reset('  Press q or Esc to stop watching (validation continues in background)\n\n'));

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

    while (!valUserExit) {
      await new Promise(r => setTimeout(r, 3000));
      if (valUserExit) break;

      const elapsed    = Math.round((Date.now() - startMs) / 1000);
      const elapsedMin = Math.floor(elapsed / 60);
      const elapsedSec = elapsed % 60;
      const elapsedStr = elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec}s` : `${elapsed}s`;
      const spin       = chalk.cyan(spinFrames[spinIdx++ % spinFrames.length]);

      try {
        const st    = JSON.parse(execSync(`kubectl get bundle.sambanova.ai ${activeBName} -n ${namespace} -o json`, { encoding: 'utf-8' }));
        const conds = st.status?.conditions || [];
        const phase = st.status?.phase || 'Pending';

        // BundleTemplate status while bundle is still pending
        let btLine = '';
        if (phase === 'Pending' || conds.length === 0) {
          try {
            const bt       = JSON.parse(execSync(`kubectl get bundletemplate.sambanova.ai ${activeBtName} -n ${namespace} -o json`, { encoding: 'utf-8' }));
            const btPhase  = bt.status?.phase || '';
            const btConds  = bt.status?.conditions || [];
            const btLatest = btConds[btConds.length - 1];
            const btMsg    = btLatest?.reason || btPhase || '…';
            btLine = `  │  BT: ${btMsg}`;
          } catch {}
        }

        // Progress bar (fills over 10 minutes max)
        const barWidth  = 20;
        const progress  = Math.min(elapsed / 600, 1);
        const filled    = Math.round(progress * barWidth);
        const bar       = chalk.cyan('█'.repeat(filled)) + chalk.reset('░'.repeat(barWidth - filled));

        if (conds.length > 0) {
          const latest = conds[conds.length - 1];
          process.stdout.write(`\r  ${spin}  ${chalk.bold(phase)}  [${bar}]  ${chalk.reset(elapsedStr)}  ${chalk.reset(latest.reason)}                    `);

          if (latest.reason === 'ValidationSucceeded' || (latest.type === 'Validated' && latest.status === 'True')) {
            process.stdout.write('\n');
            successMsg('Bundle Validation Succeeded!');
            validated = true; break;
          } else if (latest.reason === 'ValidationFailed' || latest.status === 'False') {
            process.stdout.write('\n');
            printValidationErrors(conds);
            validated = true; validationFailed = true; break;
          }
        } else {
          process.stdout.write(`\r  ${spin}  ${chalk.bold(phase)}  [${bar}]  ${chalk.reset(elapsedStr)}${chalk.reset(btLine)}                    `);
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
      process.stdout.write(chalk.reset(`  kubectl get bundle.sambanova.ai ${activeBName} -n ${namespace} -o yaml\n\n`));
    }

    // ── Recovery menu after ValidationFailed ──────────────────────────────────
    if (validationFailed) {
      process.stdout.write('\n');

      // Parse SD PEF names from the error message to offer auto-fix
      const allConds: any[] = [];
      try {
        const st = JSON.parse(execSync(`kubectl get bundle.sambanova.ai ${activeBName} -n ${namespace} -o json`, { encoding: 'utf-8' }));
        allConds.push(...(st.status?.conditions || []));
      } catch {}
      const errText    = allConds.map((c: any) => c.message || '').join('\n');
      const badPefMatches = [...errText.matchAll(/PEF ([\w-]+) is a spec decoding PEF/g)];
      const badPefs    = badPefMatches.map(m => m[1]);

      const fixChoices: Choice[] = [];
      if (badPefs.length > 0) {
        fixChoices.push({ name: `🔧  Remove ${badPefs.length} SD PEF(s) without draft model and re-apply`, value: 'autofix' });
      }
      fixChoices.push(
        { name: '✏️   Edit YAML in editor and re-apply',             value: 'edit'    },
        { name: chalk.cyan('← Go back to Bundle Builder  (re-edit selections)'), value: 'builder' },
        { name: `🗑️   Delete ${activeBName} from cluster`,           value: 'delete'  },
        { name: chalk.reset('← Back to main menu'),                  value: 'back'    },
      );

      const fix = await select(rl, 'What would you like to do?', fixChoices);

      if (fix === 'autofix') {
        // Remove the offending SD PEF config lines from the YAML
        let fixedYaml = finalYaml;
        for (const pef of badPefs) {
          // Remove the config block that references this PEF (the - pef: line and any following spec_decoding lines)
          fixedYaml = fixedYaml.replace(
            new RegExp(`\\s*- pef: ${pef.replace(/[-]/g, '\\-')}:[^\\n]*(?:\\n\\s+spec_decoding:[^\\n]*(?:\\n\\s+[^\\n]+)*)?`, 'g'),
            ''
          );
        }
        yamlBox('Fixed YAML (SD PEFs removed)', fixedYaml);
        const reApplyFixed = path.join(PROJECT_ROOT, `temp_bundle_${Date.now()}.yaml`);
        try {
          writeFileSync(reApplyFixed, fixedYaml);
          spinner.start('Re-applying fixed bundle...');
          await tick();
          execSync(`kubectl apply -f ${reApplyFixed} -n ${namespace}`, { stdio: ['pipe','pipe','pipe'] });
          spinner.succeed('Fixed bundle re-applied — use 📈 Check Deployment Progress to monitor validation');
        } catch (e: any) { spinner.fail(`Re-apply failed: ${e.message.split('\n')[0]}`); }
        finally { try { execSync(`rm "${reApplyFixed}"`); } catch {} }

      } else if (fix === 'edit') {
        const tmp    = path.join(PROJECT_ROOT, `.tmp_bundle_fix_${Date.now()}.yaml`);
        const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
        writeFileSync(tmp, finalYaml);
        try {
          process.stdout.write(chalk.yellow(`\n  Opening ${editor}...\n`));
          execSync(`${editor} "${tmp}"`, { stdio: 'inherit' });
          finalYaml = readFileSync(tmp, 'utf-8');
          try { execSync(`rm "${tmp}"`); } catch {}
        } catch (e: any) { errorMsg(`Editor error: ${e.message}`); try { execSync(`rm "${tmp}"`); } catch {} }

        // Re-derive bundle name from edited YAML
        const mFixed = finalYaml.match(/kind:\s+Bundle\b[\s\S]*?name:\s+(\S+)/);
        if (mFixed) activeBName = mFixed[1];

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
        // Delete the failed bundle from the cluster so the builder can create fresh
        try {
          execSync(`kubectl delete bundle.sambanova.ai ${activeBName} -n ${namespace}`, { stdio: ['pipe','pipe','pipe'] });
        } catch {}
        try {
          execSync(`kubectl delete bundletemplate.sambanova.ai ${activeBtName} -n ${namespace}`, { stdio: ['pipe','pipe','pipe'] });
        } catch {}
        // Clear selections and restart model selection with old selections preserved (pre-checked)
        continue builderLoop;

      } else if (fix === 'delete') {
        spinner.start(`Deleting ${activeBName} and ${activeBtName}...`);
        await tick();
        try {
          try { execSync(`kubectl delete bundle.sambanova.ai ${activeBName} -n ${namespace}`, { stdio: ['pipe','pipe','pipe'] }); } catch {}
          try { execSync(`kubectl delete bundletemplate.sambanova.ai ${activeBtName} -n ${namespace}`, { stdio: ['pipe','pipe','pipe'] }); } catch {}
          spinner.succeed(`Deleted ${activeBName} and ${activeBtName} from cluster`);
        } catch (e: any) { spinner.fail(`Delete failed: ${e.message.split('\n')[0]}`); }
      }
      return;  // don't show "bundle ready" hint after failure
    }
  } catch (e: any) {
    errorMsg(`Error applying bundle: ${e.message}`);
  } finally {
    try { execSync(`rm "${tempPath}"`); } catch {}
  }

  break builderLoop;
  }  // end builderLoop

  process.stdout.write('\n');
  process.stdout.write(chalk.reset(`  Bundle template is ready.\n`));
  process.stdout.write(chalk.hex(BRAND).bold(`  → Go to  🚀 Bundle Deployment  from the main menu to deploy it.\n\n`));
}

// ─── bundleDeploymentMenu() ──────────────────────────────────────────────────

async function bundleDeploymentMenu(rl: any, namespace: string) {
  let back = false;
  while (!back) {
    sectionHeader('Bundle Deployment', '🚀');

    // Show current deployments
    try {
      const list = JSON.parse(execSync(`kubectl get bundledeployment.sambanova.ai -n ${namespace} -o json`, { encoding: 'utf-8', stdio: ['pipe','pipe','pipe'] }));
      const items: any[] = list.items || [];
      if (items.length > 0) {
        process.stdout.write(chalk.reset.bold('  Current Deployments:\n'));
        items.forEach((i: any) => {
          const phase = i.status?.phase || '';
          const icon  = phase === 'Running' || phase === 'Deployed' ? chalk.green('●') : phase === 'Pending' ? chalk.yellow('◌') : chalk.red('○');
          process.stdout.write(`  ${icon}  ${chalk.reset(i.metadata.name)}${phase ? `  ${chalk.gray(phase)}` : ''}\n`);
        });
        process.stdout.write('\n');
      } else {
        process.stdout.write(chalk.gray('  No deployments found.\n\n'));
      }
    } catch {
      process.stdout.write(chalk.gray('  (Could not fetch deployments)\n\n'));
    }

    const action = await select(rl, 'Bundle Deployment:', [
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
    const list = JSON.parse(execSync(`kubectl get bundle.sambanova.ai -n ${namespace} -o json`, { encoding: 'utf-8' }));
    spinner.info(`Found ${list.items?.length || 0} bundle(s)`);

    if (!list.items?.length) { warnMsg('No bundles found in this namespace.'); return; }

    const bundles = list.items.map((i: any) => ({
      name:  i.metadata.name,
      valid: (i.status?.conditions || []).some((c: any) => c.reason === 'ValidationSucceeded'),
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

    const { yaml, deploymentName: depName } = buildDeploymentYaml(bundleToDeploy);

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
    { name: 'BundleDeployment',       value: 'deployment' },
    { name: 'Bundle',                 value: 'bundle' },
    { name: 'BundleTemplate',         value: 'template' },
    { name: chalk.reset('← Back'),    value: 'back' },
  ]);
  if (!deleteType || deleteType === 'back') return;

  const rm: Record<string, { kind: string; label: string }> = {
    deployment: { kind: 'bundledeployment.sambanova.ai', label: 'BundleDeployment' },
    bundle:     { kind: 'bundle.sambanova.ai',           label: 'Bundle' },
    template:   { kind: 'bundletemplate.sambanova.ai',   label: 'BundleTemplate' },
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
      if (deleteType === 'template') {
        const assocBundle = n.replace(/^bt-/, 'b-');
        process.stdout.write(chalk.red(`     ↳  ${assocBundle}  (associated Bundle)\n`));
      }
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

      // Cascade: when a BundleTemplate is deleted, also delete the associated Bundle
      if (deleteType === 'template') {
        const assocBundle = name.replace(/^bt-/, 'b-');
        spinner.start(`Deleting associated Bundle ${assocBundle}...`);
        await tick();
        try {
          execSync(`kubectl delete bundle.sambanova.ai ${assocBundle} -n ${namespace}`, { stdio: ['pipe','pipe','pipe'] });
          spinner.succeed(`Deleted associated Bundle ${assocBundle}`);
        } catch {
          spinner.info(`Bundle ${assocBundle} not found or already deleted — skipping`);
        }
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
    const list = JSON.parse(execSync(`kubectl get bundledeployment.sambanova.ai -n ${namespace} -o json`, { encoding: 'utf-8' }));
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
    const list = JSON.parse(execSync(`kubectl get bundledeployment.sambanova.ai -n ${namespace} -o json`, { encoding: 'utf-8' }));
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
          try {
            const bundle = JSON.parse(execSync(`kubectl get bundle.sambanova.ai ${bn} -n ${namespace} -o json`, { encoding: 'utf-8' }));
            const models = Object.keys(bundle.spec.models || {}).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

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

  const checkpointMapping = requireJson(path.join(DATA_DIR, 'checkpoint_mapping.json'));
  const isEmbedding       = checkpointMapping[modelName]?.model_type === 'embedding';

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
      const userInput = await input(rl, chalk.cyan.bold('Text to embed'));
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
    const userInput = await input(rl, chalk.cyan.bold('You'));
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
          process.stdout.write(`   ${chalk.gray('·')}   ${parts.join(chalk.gray('   ·   '))}`);
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
      execSync(`${editor} "${tmp}"`, { stdio: 'inherit' });
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
        logs.split('\n').forEach(l => process.stdout.write(chalk.reset(`  ${l}\n`)));
        if (logs.includes('configure_default_ingress')) {
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

startCli().catch(err => {
  console.error(chalk.red('\nFatal error:'), err);
});
