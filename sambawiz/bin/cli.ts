#!/usr/bin/env bun
declare const process: any;

// Allow self-signed SSL certificates for internal APIs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import * as readlineModule from 'readline';
import readlinePromises from 'readline/promises';
// ─── Inlined from cli-utils.ts ───────────────────────────────────────────────

interface BundleSelection {
  model:   string;
  ss:      string;
  bs:      string;
  pef:     string;
  version: string;
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
  checkpointMapping: Record<string, { path: string }>;
  checkpointsDir:    string;
  bundleName:        string;
}

function buildBundleYaml(opts: BuildBundleYamlOptions): { yaml: string; templateName: string; bundleManifestName: string } {
  const { selections, checkpointMapping, checkpointsDir, bundleName } = opts;
  const templateName       = `bt-${bundleName}`;
  const bundleManifestName = `b-${bundleName}`;
  const tmpl: Record<string, string> = {};
  const bmod: Record<string, string> = {};
  const ckpt: Record<string, string> = {};

  for (const sel of selections) {
    const ck = generateCheckpointKey(sel.model);
    const cd = checkpointMapping[sel.model];
    const expert = `        ${sel.ss}:\n          configs:\n          - pef: ${sel.pef}:${sel.version}\n`;
    if (tmpl[sel.model]) tmpl[sel.model] += expert;
    else                 tmpl[sel.model] = `      experts:\n${expert}`;
    bmod[sel.model] = `    ${sel.model}:\n      checkpoint: ${ck}\n      template: ${sel.model}\n`;
    const dir = checkpointsDir.endsWith('/') ? checkpointsDir : checkpointsDir + '/';
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
  ].join('\n');
  return { yaml, deploymentName };
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const APP_DIR     = path.join(__dirname, '..', 'app');
const DATA_DIR    = path.join(APP_DIR, 'data');
const CONFIG_PATH = path.join(__dirname, '..', 'app-config.json');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireJson(p: string): any {
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf-8')); }
  catch (err: any) { process.stdout.write(chalk.red(`  Error parsing ${p}: ${err.message}\n`)); return {}; }
}

function getAppVersion(): string {
  const vp = path.join(__dirname, '..', 'VERSION');
  if (!existsSync(vp)) return requireJson(path.join(__dirname, '..', 'package.json')).version || '';
  for (const line of readFileSync(vp, 'utf-8').split('\n')) {
    if (line.trim().startsWith('app:')) return line.split(':')[1].trim();
  }
  return requireJson(path.join(__dirname, '..', 'package.json')).version || '';
}

function getMinHelmVersion(): string {
  const vp = path.join(__dirname, '..', 'VERSION');
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
  process.stdout.write(`\n${chalk.hex(BRAND).bold('  ›')} ${chalk.bold(message)}\n`);
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

async function multiSelect(_rl: any, message: string, choices: Choice[]): Promise<any[]> {
  process.stdout.write(`\n${chalk.hex(BRAND).bold('  ›')} ${chalk.bold(message)}\n`);
  process.stdout.write(chalk.reset('  Space toggle   Enter confirm   q / Esc to go back\n\n'));

  let selectedIndex = 0;
  const checked = new Set<number>();
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
      const active   = ri === selectedIndex;
      const isAction = choice.value === 'back' || choice.value === 'finish';
      const cursor   = active ? chalk.hex(BRAND).bold(' ❯ ') : '   ';
      let checkbox   = '';
      if (!isAction) checkbox = checked.has(ri) ? chalk.green(' ◉  ') : chalk.reset(' ○  ');
      const label = active ? chalk.hex(BRAND).bold(choice.name) : chalk.reset(choice.name);
      lines.push(`${cursor}${checkbox}${label}`);
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
      if (key.name === 'up')   { clear(); selectedIndex = (selectedIndex - 1 + choices.length) % choices.length; draw(); }
      else if (key.name === 'down')  { clear(); selectedIndex = (selectedIndex + 1) % choices.length; draw(); }
      else if (key.name === 'space') {
        const c = choices[selectedIndex];
        if (c.value === 'back' || c.value === 'finish') return;
        if (checked.has(selectedIndex)) checked.delete(selectedIndex); else checked.add(selectedIndex);
        clear(); draw();
      } else if (key.name === 'return') {
        process.stdin.removeListener('keypress', onKey);
        process.stdin.setRawMode(isRaw);
        process.stdout.write('\n');
        const sv = choices[selectedIndex].value;
        if (sv === 'back') resolve([sv]);
        else resolve(Array.from(checked).map(i => choices[i].value));
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
  const prompt = defaultValue
    ? `\n  ${chalk.hex(BRAND).bold('›')} ${chalk.bold(message)} ${chalk.reset(`(${defaultValue})`)}  ${chalk.gray('Esc cancel')}: `
    : `\n  ${chalk.hex(BRAND).bold('›')} ${chalk.bold(message)}  ${chalk.gray('Esc cancel')}: `;

  process.stdout.write(prompt);

  // Save and remove ALL existing stdin listeners so readline cannot double-echo
  const savedData     = process.stdin.rawListeners('data');
  const savedKeypress = process.stdin.rawListeners('keypress');
  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('keypress');

  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let buffer = '';

  const result: string = await new Promise((resolve) => {
    const cleanup = (val: string) => {
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      resolve(val);
    };

    const onData = (chunk: Buffer) => {
      const code = chunk[0];
      if (code === 0x1b && (chunk.length === 1 || (chunk.length === 2 && chunk[1] === 0x00))) {
        cleanup(ESC);                              // Esc (bare or with null byte)
      } else if (code === 0x1b) {                  // Escape sequence (arrow keys etc) — ignore
        // do nothing
      } else if (code === 0x03) {                  // Ctrl+C
        cleanup(ESC);
      } else if (code === 0x0d || code === 0x0a) { // Enter
        cleanup(buffer.trim() || defaultValue);
      } else if (code === 0x7f || code === 0x08) { // Backspace
        if (buffer.length > 0) { buffer = buffer.slice(0, -1); process.stdout.write('\b \b'); }
      } else if (code >= 0x20) {                   // Printable
        const ch = chunk.toString('utf8');
        buffer += ch;
        process.stdout.write(ch);
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
  if (answer === ESC || !answer.trim()) return defaultTrue;
  return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
}

// ─── addEnvironmentMenu() ────────────────────────────────────────────────────

async function addEnvironmentMenu(rl: any) {
  sectionHeader('Add / Edit Environment', '➕');

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
    const name = await input(rl, 'Environment name');
    if (!name || name === ESC) return;
    const file      = await input(rl, 'Kubeconfig file path (relative to project root)');
    if (!file || file === ESC) return;
    const ns        = await input(rl, 'Namespace', 'default');
    if (ns === ESC) return;
    const apiDomain = await input(rl, 'API Domain (optional)');
    if (apiDomain === ESC) return;
    const apiKey    = await input(rl, 'API Key (optional)');
    if (apiKey === ESC) return;

    appConfig.kubeconfigs = appConfig.kubeconfigs || {};
    appConfig.kubeconfigs[name] = { file, namespace: ns || 'default' };
    if (apiDomain) appConfig.kubeconfigs[name].apiDomain = apiDomain;
    if (apiKey)    appConfig.kubeconfigs[name].apiKey    = apiKey;
    if (!appConfig.currentKubeconfig) appConfig.currentKubeconfig = name;

    writeFileSync(CONFIG_PATH, JSON.stringify(appConfig, null, 2) + '\n');
    successMsg(`Environment "${name}" added.`);
    return;
  }

  // Step 2: action on selected env
  const envName = selected;
  const action  = await select(rl, `${envName}:`, [
    { name: '✏️   Edit',           value: 'edit' },
    { name: chalk.red('🗑️   Delete'), value: 'delete' },
    { name: chalk.reset('← Back'), value: 'back' },
  ]);
  if (!action || action === 'back') return;

  if (action === 'edit') {
    const ec = appConfig.kubeconfigs[envName] || {};
    process.stdout.write(chalk.reset(`\n  Editing: ${chalk.bold(envName)}  (Enter to keep current value)\n\n`));

    const file      = await input(rl, 'Kubeconfig file',   ec.file      || '');
    if (file === ESC) return;
    const ns        = await input(rl, 'Namespace',         ec.namespace || 'default');
    if (ns === ESC) return;
    const apiDomain = await input(rl, 'API Domain',        ec.apiDomain || '');
    if (apiDomain === ESC) return;
    const apiKey    = await input(rl, 'API Key',           ec.apiKey    || '');
    if (apiKey === ESC) return;

    appConfig.kubeconfigs[envName] = {
      ...ec,
      file:      file      || ec.file,
      namespace: ns        || ec.namespace,
      apiDomain: apiDomain || ec.apiDomain,
      apiKey:    apiKey    || ec.apiKey,
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(appConfig, null, 2) + '\n');
    successMsg(`Environment "${envName}" updated.`);

  } else if (action === 'delete') {
    const ok = await confirm(rl, chalk.red(`Delete environment "${envName}"?`), false);
    if (!ok) { process.stdout.write(chalk.reset('  Cancelled.\n\n')); return; }

    delete appConfig.kubeconfigs[envName];
    if (appConfig.currentKubeconfig === envName) {
      const remaining = Object.keys(appConfig.kubeconfigs);
      appConfig.currentKubeconfig = remaining[0] || null;
    }
    writeFileSync(CONFIG_PATH, JSON.stringify(appConfig, null, 2) + '\n');
    successMsg(`Environment "${envName}" deleted.`);
  }
}

// ─── startCli() ──────────────────────────────────────────────────────────────

async function startCli() {
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });

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
    const kPath   = path.join(__dirname, '..', envConf.file);
    if (!existsSync(kPath)) {
      return { appConfig: config, envConfig: envConf, namespace: ns, currentEnv: env, error: `Kubeconfig file not found: ${envConf.file}` };
    }
    process.env.KUBECONFIG = kPath;
    return { appConfig: config, envConfig: envConf, namespace: ns, currentEnv: env, error: null };
  }

  function checkKubeconfigExists(config: any, envName: string) {
    const ec = config.kubeconfigs[envName];
    if (!ec?.file) return false;
    return existsSync(path.join(__dirname, '..', ec.file));
  }

  let loaded = loadEnvConfig();

  if (loaded.error) {
    warnMsg(loaded.error);
    const allEnvs   = Object.keys(loaded.appConfig.kubeconfigs || {});
    const validEnvs = allEnvs.filter(e => checkKubeconfigExists(loaded.appConfig, e));

    if (validEnvs.length === 0) {
      errorMsg('No environments with valid kubeconfig files. Please fix app-config.json.');
      rl.close(); process.exit(1);
    }

    const envChoices: Choice[] = [
      ...validEnvs.map(e => ({ name: e, value: e })),
      { name: chalk.red('❌  Exit'), value: 'exit' },
    ];

    const chosen = await select(rl, 'Select a valid environment to continue:', envChoices);
    if (!chosen || chosen === 'exit') { rl.close(); process.exit(0); }

    loaded.appConfig.currentKubeconfig = chosen;
    writeFileSync(CONFIG_PATH, JSON.stringify(loaded.appConfig, null, 2) + '\n');
    loaded = loadEnvConfig();
    if (loaded.error) { errorMsg(loaded.error); rl.close(); process.exit(1); }
    successMsg(`Switched to: ${loaded.currentEnv}  (namespace: ${loaded.namespace})`);
  }

  let { appConfig: liveAppConfig, envConfig, namespace, currentEnv } = loaded;

  let exitLoop = false;
  while (!exitLoop) {
    const envBadge = chalk.hex(BRAND)(`[${currentEnv}]`);
    const action = await select(rl, `Main Menu  ${envBadge}`, [
      { name: `➕  Add / Edit Environment`,           value: 'add_env',        hint: 'Manage kubeconfig environments' },
      { name: `🧭  Validate Setup & Environment`,     value: 'validate_env',   hint: 'Check kubeconfig, helm, API key' },
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
      case 'validate_env': {
        let switchedEnv = await validateEnvironment(rl, envConfig, namespace);
        while (switchedEnv) {
          liveAppConfig.currentKubeconfig = switchedEnv;
          writeFileSync(CONFIG_PATH, JSON.stringify(liveAppConfig, null, 2) + '\n');
          const r = loadEnvConfig();
          if (r.error) { errorMsg(r.error); break; }
          ({ appConfig: liveAppConfig, envConfig, namespace, currentEnv } = r);
          successMsg(`Switched to: ${currentEnv}  (namespace: ${namespace})`);
          switchedEnv = await validateEnvironment(rl, envConfig, namespace);
        }
        break;
      }
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

// ─── validateEnvironment() ───────────────────────────────────────────────────

async function validateEnvironment(rl: any, envConfig: any, namespace: string): Promise<string | null> {
  const appConfig  = requireJson(CONFIG_PATH);
  const currentEnv = appConfig.currentKubeconfig;

  sectionHeader('Validate Setup & Environment', '🧭');

  const allEnvs = Object.keys(appConfig.kubeconfigs || {});
  const envChoices: Choice[] = allEnvs.map(env => {
    const isCurrent = env === currentEnv;
    const ec = appConfig.kubeconfigs[env];
    const ns = ec.namespace || 'default';
    const hasKube = ec.file && existsSync(path.join(__dirname, '..', ec.file));
    let name: string;
    if (isCurrent)    name = `${chalk.green('●')} ${chalk.green.bold(env)} ${chalk.reset(`ns:${ns}`)} ${chalk.cyan('← active')}`;
    else if (!hasKube) name = `${chalk.red('●')} ${env} ${chalk.reset(`ns:${ns}`)} ${chalk.yellow('kubeconfig missing')}`;
    else               name = `${chalk.reset('○')} ${env} ${chalk.reset(`ns:${ns}`)}`;
    return { name, value: env };
  });
  envChoices.push({ name: chalk.reset('← Back'), value: 'back' });

  const selectedEnv = await select(rl, 'Select environment to validate:', envChoices);
  if (!selectedEnv || selectedEnv === 'back') return null;

  if (selectedEnv !== currentEnv) {
    const kFile = appConfig.kubeconfigs[selectedEnv]?.file;
    if (!kFile || !existsSync(path.join(__dirname, '..', kFile))) {
      errorMsg(`Kubeconfig missing for "${selectedEnv}": ${kFile || '(not set)'}`);
      return null;
    }
    return selectedEnv;
  }

  process.stdout.write('\n');
  infoRow('Environment', currentEnv);
  infoRow('Namespace',   namespace);
  process.stdout.write('\n');
  hr();
  process.stdout.write('\n');

  let allPassed = true;

  // 1. Kubeconfig
  spinner.start('Checking kubeconfig...');
  await tick();
  const kFile = envConfig.file;
  const kPath = path.join(__dirname, '..', kFile);
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
    const raw     = execSync('helm list -n sambastack -o json', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 });
    const releases: any[] = JSON.parse(raw);
    const release = releases.find((r: any) => typeof r.chart === 'string' && r.chart.toLowerCase().startsWith('sambastack'));
    if (!release) {
      spinner.warn('SambaStack release not found in namespace "sambastack"');
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
      } else {
        spinner.warn(`/v1/models → ${code}`);
      }
    } catch (e: any) {
      spinner.fail(`Cannot reach API: ${e.message.split('\n')[0]}`);
      allPassed = false;
    }

    spinner.start('Validating API key...');
    try {
      const testModel   = availableModels[0] || 'test';
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
        spinner.fail('API key invalid or expired — update in app-config.json');
        allPassed = false;
      } else if (code === 404 || code === 400) {
        spinner.succeed(`API key valid  ${chalk.reset('(auth passed)')}`);
      } else {
        spinner.warn(`Chat endpoint → ${code}`);
      }
    } catch (e: any) {
      spinner.fail(`Chat endpoint unreachable: ${e.message.split('\n')[0]}`);
      allPassed = false;
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
      if (code >= 200 && code < 400) spinner.succeed('UI Domain reachable');
      else spinner.warn(`UI Domain → ${code}`);
    } catch (e: any) {
      spinner.fail(`UI Domain unreachable: ${e.message.split('\n')[0]}`);
      allPassed = false;
    }
  }

  process.stdout.write('\n');
  hr();
  if (allPassed) successMsg('All checks passed!');
  else errorMsg('Some checks failed — review app-config.json');

  return null;
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

    const comboChoices: Choice[] = [
      { name: chalk.green('✅  Done - Confirm Selection'), value: 'finish' },
      ...modelConfigs.map(c => ({
        name:  `SS: ${String(c.ss).padEnd(6)} │ BS: ${String(c.bs).padEnd(3)} │ ${chalk.reset(c.pefName)}`,
        value: c,
      })),
      { name: chalk.red('✕  Back'), value: 'back' },
    ];

    const selectedCombos = await multiSelect(rl, `Configurations for ${chalk.bold(selectedModel)}:`, comboChoices);
    if (!selectedCombos || selectedCombos.length === 0 || selectedCombos.includes('back')) continue;

    selectedCombos.forEach((c: any) => {
      allSelections.push({ model: selectedModel, ss: c.ss, bs: c.bs, pef: c.pefName, version: c.latestVersion || '1' });
    });
    successMsg(`Added ${selectedCombos.length} config(s) for ${selectedModel}`);

    // Draft model (speculative decoding)
    const supportsSD = modelPefs.length > 0 && modelPefs.every(p => p.split('-').some((s: string) => /^sd\d+$/.test(s)));
    if (supportsSD) {
      process.stdout.write(chalk.yellow(`\n  ⚡ ${selectedModel} supports speculative decoding.\n`));
      process.stdout.write(chalk.reset('     A smaller draft model can significantly improve throughput.\n'));
      process.stdout.write(chalk.reset(`     Selected configs: ${selectedCombos.map((c: any) => `SS:${c.ss} BS:${c.bs}`).join(', ')}\n\n`));

      const draftChoices: Choice[] = [
        { name: chalk.cyan('↩  Skip (no draft model)'), value: 'skip' },
        ...availableModels.filter(m => m !== selectedModel).map(m => ({ name: m, value: m })),
        { name: chalk.reset('← Back'), value: 'back' },
      ];

      const draftModel = await select(rl, `Draft model for ${selectedModel}:`, draftChoices);
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
                allSelections.push({ model: draftModel, ss: match.ss, bs: match.bs, pef: dp, version: match.latestVersion || '1' });
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

  // Summary
  sectionHeader('Bundle Summary', '📋');
  allSelections.forEach((sel, i) => {
    process.stdout.write(
      `  ${chalk.reset(`${i+1}.`)} ${chalk.reset.bold(sel.model.padEnd(38))} ` +
      `${chalk.cyan(`SS:${sel.ss}`)}  ${chalk.cyan(`BS:${sel.bs}`)}\n`
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

  const bundleName = await input(rl, 'Bundle name', `my-bundle-${Date.now().toString().slice(-4)}`);
  if (bundleName === ESC) return;
  const { yaml: finalYamlBuilt, bundleManifestName: bName } = buildBundleYaml({
    selections: allSelections as BundleSelection[],
    checkpointMapping,
    checkpointsDir: appConfig.checkpointsDir,
    bundleName,
  });
  let finalYaml = finalYamlBuilt;

  yamlBox(`Final YAML  (${bundleName})`, finalYaml);

  let yamlDone = false;
  while (!yamlDone) {
    const act = await select(rl, 'What next?', [
      { name: '✏️   Edit in editor',          value: 'edit' },
      { name: '💾  Save to file',              value: 'save' },
      { name: '⏭️   Continue to deploy',        value: 'skip' },
      { name: chalk.red('✕  Cancel'),           value: 'cancel' },
    ]);

    if (!act || act === 'cancel') return;

    if (act === 'edit') {
      const tmp = path.join(__dirname, '..', `.tmp_bundle_${Date.now()}.yaml`);
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
      const fname = await input(rl, 'Filename', `${bundleName}.yaml`);
      if (fname === ESC) { yamlDone = true; break; }
      try { writeFileSync(fname, finalYaml); successMsg(`Saved to ${fname}`); } catch (e: any) { errorMsg(`Save failed: ${e.message}`); }
      yamlDone = true;
    } else if (act === 'skip') {
      yamlDone = true;
    }
  }

  const shouldApply = await confirm(rl, 'Apply to cluster to validate?');
  if (!shouldApply) return;

  const tempPath = path.join(__dirname, '..', `temp_bundle_${Date.now()}.yaml`);
  try {
    writeFileSync(tempPath, finalYaml);
    spinner.start('Applying bundle to cluster...');
    await tick();
    execSync(`kubectl apply -f ${tempPath} -n ${namespace}`, { stdio: 'inherit' });
    spinner.succeed('Bundle applied — polling for validation status...');

    const maxAttempts = 30;
    const pollInterval = 3000;
    let validated = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise(r => setTimeout(r, pollInterval));
      try {
        const st  = JSON.parse(execSync(`kubectl get bundle.sambanova.ai ${bName} -n ${namespace} -o json`, { encoding: 'utf-8' }));
        const conds = st.status?.conditions || [];
        const phase = st.status?.phase || 'Pending';
        const elapsed = attempt * (pollInterval / 1000);
        process.stdout.write(`\r  ${chalk.cyan('◉')}  ${chalk.bold(phase)}  ${chalk.reset(`[${elapsed}s]`)}                    `);

        if (conds.length > 0) {
          const latest = conds[conds.length - 1];
          process.stdout.write(`\r  ${chalk.cyan('◉')}  ${chalk.bold(phase)}  ${chalk.reset(`${latest.reason}: ${latest.message}`)}  ${chalk.reset(`[${elapsed}s]`)}   `);
          if (latest.reason === 'ValidationSucceeded' || (latest.type === 'Validated' && latest.status === 'True')) {
            process.stdout.write('\n');
            successMsg('Bundle Validation Succeeded!');
            conds.forEach((c: any) => process.stdout.write(`  ${chalk.reset(`${c.type}: ${c.reason} — ${c.message}`)}\n`));
            validated = true; break;
          } else if (latest.reason === 'ValidationFailed' || latest.status === 'False') {
            process.stdout.write('\n');
            errorMsg('Bundle Validation Failed');
            conds.forEach((c: any) => process.stdout.write(`  ${chalk.red(`${c.type}: ${c.reason} — ${c.message}`)}\n`));
            validated = true; break;
          }
        }
      } catch {
        process.stdout.write(`\r  ${chalk.yellow('⠋')}  Waiting for bundle resource...  ${chalk.reset(`[${attempt * pollInterval / 1000}s]`)}   `);
      }
    }

    if (!validated) {
      process.stdout.write('\n');
      warnMsg('Validation timeout — check manually:');
      process.stdout.write(chalk.reset(`  kubectl get bundle.sambanova.ai ${bName} -n ${namespace} -o yaml\n\n`));
    }
  } catch (e: any) {
    errorMsg(`Error applying bundle: ${e.message}`);
  } finally {
    try { execSync(`rm "${tempPath}"`); } catch {}
  }
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

    const tempPath = path.join(__dirname, '..', `temp_dep_${Date.now()}.yaml`);
    try {
      writeFileSync(tempPath, yaml);
      spinner.start('Deploying...');
      await tick();
      execSync(`kubectl apply -f ${tempPath} -n ${namespace}`, { stdio: 'inherit' });
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
    selected.forEach((n: string) => process.stdout.write(chalk.red(`  ·  ${n}\n`)));
    process.stdout.write('\n');

    if (!await confirm(rl, chalk.red.bold('Confirm deletion? This cannot be undone'), false)) {
      process.stdout.write(chalk.reset('  Cancelled.\n\n')); return;
    }

    for (const name of selected) {
      spinner.start(`Deleting ${name}...`);
      await tick();
      try {
        execSync(`kubectl delete ${res.kind} ${name} -n ${namespace}`, { stdio: 'inherit' });
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
    const list = JSON.parse(execSync(`kubectl get bundledeployment.sambanova.ai -n ${namespace} -o json`, { encoding: 'utf-8' }));
    spinner.info(`Found ${list.items?.length || 0} deployment(s)`);

    if (!list.items?.length) { warnMsg('No deployments found.'); return; }

    const choices: Choice[] = list.items.map((i: any) => {
      const phase = i.status?.phase || '';
      const icon  = phase === 'Running' || phase === 'Deployed' ? chalk.green('●') : chalk.yellow('●');
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

  let finished  = false;
  let pollCount = 0;
  let userExit  = false;

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
      pollCount++;
      const elapsed = pollCount * 5;
      let cachePod: any   = null;
      let defaultPod: any = null;

      try {
        const po = execSync(`kubectl -n ${namespace} get pods 2>/dev/null | grep ${depName}`, { encoding: 'utf-8' });
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

  if (!envConfig.apiDomain || !envConfig.apiKey) {
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
          const po = execSync(`kubectl -n ${namespace} get pods 2>/dev/null | grep ${dn}`, { encoding: 'utf-8' });
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

  // ── Chat loop ──
  const cols      = Math.min(68, (process.stdout.columns || 80) - 4);
  const chatTitle = `🤖  Chatting with ${modelName}`;
  const chatPad   = Math.max(0, cols - chatTitle.length - 1); // -1 extra for emoji double-width
  process.stdout.write('\n');
  process.stdout.write(chalk.hex(BRAND)(`  ╭${'─'.repeat(cols)}╮\n`));
  process.stdout.write(chalk.hex(BRAND)('  │ ') + chalk.reset.bold(chatTitle) + ' '.repeat(chatPad) + chalk.hex(BRAND)('│\n'));
  process.stdout.write(chalk.hex(BRAND)('  │ ') + chalk.reset(`q / Esc  or type 'exit' to return to menu`.padEnd(cols - 1)) + chalk.hex(BRAND)('│\n'));
  process.stdout.write(chalk.hex(BRAND)(`  ╰${'─'.repeat(cols)}╯\n\n`));

  const messages: any[] = [];
  let exitChat = false;

  while (!exitChat) {
    const userInput = await input(rl, chalk.cyan.bold('You'));
    if (userInput === ESC || ['exit', 'quit', '/back', 'q'].includes(userInput.toLowerCase())) {
      process.stdout.write(chalk.reset('\n  Returning to menu...\n\n'));
      exitChat = true;
      continue;
    }
    if (!userInput.trim()) continue;

    messages.push({ role: 'user', content: userInput });

    const tmpPayload = path.join(__dirname, '..', `.tmp_chat_${Date.now()}.json`);
    try {
      let base = envConfig.apiDomain.replace(/\/v1\/chat\/completions\/?$/, '');
      if (!base.endsWith('/')) base += '/';
      const apiUrl  = `${base}v1/chat/completions`;
      const payload = JSON.stringify({ model: modelName, messages, stream: false });

      writeFileSync(tmpPayload, payload);

      process.stdout.write(chalk.reset('\n  ◌  Thinking...\r'));

      const res = execSync(
        `curl -sk -w "\\n%{http_code}" -X POST "${apiUrl}" ` +
        `-H "Content-Type: application/json" -H "Authorization: Bearer ${envConfig.apiKey}" ` +
        `-d @"${tmpPayload}"`,
        { encoding: 'utf-8', timeout: 120000 }
      );
      const parts    = res.trimEnd().split('\n');
      const httpCode = safeParseInt(parts.pop());
      const body     = parts.join('\n');

      process.stdout.write('\r\x1b[K');

      if (httpCode >= 200 && httpCode < 300) {
        const data   = JSON.parse(body);
        const rawMsg = data.choices?.[0]?.message?.content || '';
        const msg    = rawMsg.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        const ts     = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        process.stdout.write(`\n  ${chalk.hex(BRAND).bold('◈  Assistant')}  ${chalk.reset(ts)}\n`);
        hr();
        process.stdout.write(`  ${msg}\n`);
        hr();
        process.stdout.write('\n');
        messages.push({ role: 'assistant', content: msg });
      } else {
        process.stdout.write('\r\x1b[K');
        errorMsg(`API Error ${httpCode}`);
        try {
          const errData = JSON.parse(body);
          const detail  = errData.error?.message || errData.detail || errData.message || body;
          process.stdout.write(chalk.reset(`  ${detail}\n\n`));
        } catch { if (body.trim()) process.stdout.write(chalk.reset(`  ${body.trim()}\n\n`)); }
        if (httpCode === 401 || httpCode === 403) {
          warnMsg('API key may be expired — update in app-config.json');
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

// ─── Entry ───────────────────────────────────────────────────────────────────

startCli().catch(err => {
  console.error(chalk.red('\nFatal error:'), err);
});
