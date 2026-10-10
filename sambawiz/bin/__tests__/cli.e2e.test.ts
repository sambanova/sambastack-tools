/**
 * @jest-environment node
 *
 * End-to-end tests for the non-interactive commands (bin/commands.ts). Each case spawns the real CLI
 * (`tsx bin/cli.ts <args>`) inside a throwaway sandbox directory (its own app-config.json, kubeconfigs/ and
 * app/data/) with a fake `kubectl` / `helm` on PATH and a local fake API server, so nothing touches a real
 * cluster or the real app-config.json.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { spawn, spawnSync } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, realpathSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

jest.setTimeout(60_000);

const ROOT = path.resolve(__dirname, '../..');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');
const CLI = path.join(ROOT, 'bin/cli.ts');

// ─── fixtures ────────────────────────────────────────────────────────────────

const MAPPING = {
  Llama: { resource_name: 'llama', capabilities: [], checkpoints: { a1: { versions: { '1': { source: 's' } } } } },
  Draftee: { resource_name: 'draftee', capabilities: [], checkpoints: { a1: { versions: { '1': { source: 's' } } } } },
  Target: { resource_name: 'target', capabilities: [], checkpoints: { a3: { versions: { '2': { source: 's' } } } } },
  Multi: { resource_name: 'multi', capabilities: [], checkpoints: { a1: { versions: { '1': { source: 's' } } }, a2: { versions: { '1': { source: 's' } } } } },
  NoProfile: { resource_name: 'noprofile', capabilities: [], checkpoints: { zz: { versions: { '1': { source: 's' } } } } },
  DraftEmpty: { resource_name: 'draftempty', capabilities: [], checkpoints: { a4: { versions: { '1': { source: 's' } } } } },
  Embedder: { resource_name: 'embedder', capabilities: ['embeddings'], checkpoints: { e1: { versions: { '1': { source: 's' } } } } },
};
const PROFILES = {
  p1: { model_arch: 'a1', features: [], batchingConfig: {}, pefs: ['x:1'], batchingConfigs: { all: { '32k': { batch_sizes: [1, 2, 4] }, '8k': { batch_sizes: [1, 2] } }, recommended: { '32k': { batch_sizes: [1] }, '8k': { batch_sizes: [1] } } } },
  cache: { model_arch: 'a2', features: ['prompt_caching'], batchingConfig: {}, pefs: ['x:1'], batchingConfigs: { all: { '8k': { batch_sizes: [1] } } } },
  sdp: { model_arch: 'a3', features: [], batchingConfig: {}, pefs: ['m-sd-x:1'], batchingConfigs: { all: { '8k': { batch_sizes: [1, 2] } } } },
  // every tier lists no batch sizes -> a model using it is dropped from the bundle
  emptyb: { model_arch: 'a4', features: [], batchingConfig: {}, pefs: ['x:1'], batchingConfigs: { all: { '8k': { batch_sizes: [] } } } },
  emb: { model_arch: 'e1', features: [], batchingConfig: {}, pefs: ['e:1'], batchingConfigs: { all: { '512': { batch_sizes: [1, 2] } } } },
};

const FAKE_KUBECTL = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const j = a.join(' ');
const stateFile = process.env.FAKE_STATE;
const st = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(st));
const fi = a.indexOf('-f'); const stdin = fi >= 0 ? (a[fi + 1] === '-' ? fs.readFileSync(0, 'utf-8') : fs.readFileSync(a[fi + 1], 'utf-8')) : '';
fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ args: j, stdin, kubeconfig: process.env.KUBECONFIG }) + '\\n');
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
if (st.kubectlDown) die('Unable to connect to the server: dial tcp 127.0.0.1:6443: connect: connection refused');
const out = (o) => process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o));
const nm = (re) => (j.match(re) || [])[1];
if (/^version --client/.test(j)) out('Client Version: v1.30.0\\n');
else if (/^cluster-info/.test(j)) out('Kubernetes control plane is running\\n');
else if (/^get namespace/.test(j)) { if (st.noNamespace) die('Error from server (NotFound): namespaces not found'); out('ok'); }
else if (/get models -o json/.test(j)) out({ items: st.models || [] });
else if (/get modelprofiles -o json/.test(j)) out({ items: st.modelprofiles || [] });
else if (/get pef -o json/.test(j)) out({ items: [] });
else if (st.profileForbidden && /get modelprofile/.test(j)) die('Error from server (Forbidden): modelprofiles.sambanova.ai is forbidden: User "u" cannot get resource "modelprofiles"');
else if (/get modelprofile\\.sambanova\\.ai (\\S+)/.test(j)) { const p = nm(/get modelprofile\\.sambanova\\.ai (\\S+)/); if (!st.profileFeatures?.[p]) die('Error from server (NotFound): modelprofiles "' + p + '" not found'); out({ spec: { features: st.profileFeatures[p] } }); }
else if (/get modelbundle\\.sambanova\\.ai -n \\S+ -o json/.test(j)) out({ items: Object.values(st.bundles || {}) });
else if (st.forbidden && /get modelbundle/.test(j)) die('Error from server (Forbidden): modelbundles.sambanova.ai "x" is forbidden: User "u" cannot get resource "modelbundles"');
else if (/get modelbundle\\.sambanova\\.ai (\\S+) -n \\S+ -o (json|yaml)/.test(j)) {
  const n = nm(/get modelbundle\\.sambanova\\.ai (\\S+)/); const b = (st.bundles || {})[n];
  if (!b) die('Error from server (NotFound): modelbundles.sambanova.ai "' + n + '" not found');
  out(/-o yaml/.test(j) ? 'kind: ModelBundle\\nmetadata:\\n  name: ' + n + '\\n' : b);
}
else if (/get modeldeployment\\.sambanova\\.ai -n \\S+ -o json/.test(j)) out({ items: Object.values(st.deployments || {}) });
else if (/get pods/.test(j)) out(st.pods || 'NAME READY STATUS RESTARTS AGE\\n');
else if (/get secret keycloak-initial-admin/.test(j)) { if (st.noKeycloak) die('Error from server (NotFound): secrets not found'); out('username: admin\\npassword: s3cret\\n'); }
else if (/ logs /.test(' ' + j + ' ')) { if (st.noLogs) die('Error from server (NotFound): pods not found'); out(st.logs || 'log line\\n'); }
else if (/^apply /.test(j)) {
  if (st.applyFail) die('error: the server rejected the request');
  const kind = (stdin.match(/^kind: (\\S+)/m) || [])[1]; const name = (stdin.match(/^  name: (\\S+)/m) || [])[1];
  if (kind === 'ModelBundle') {
    const bad = /bad/.test(name);
    st.bundles = st.bundles || {};
    st.bundles[name] = { metadata: { name }, spec: { modelConfigs: [{ profile: 'p1' }] }, status: { conditions: [{ type: 'Valid', status: bad ? 'False' : 'True', reason: bad ? 'ValidationFailed' : 'Valid', message: bad ? 'generic failure' : 'ok' }], legalizerInfo: bad ? { errors: ['legalizer: not enough memory'] } : { utilization: { ddr: '0.5' } } } };
  } else if (kind === 'ModelDeployment') { st.deployments = st.deployments || {}; st.deployments[name] = { metadata: { name }, spec: {}, status: {} }; }
  save(); out(kind.toLowerCase() + '.sambanova.ai/' + name + ' created\\n');
}
else if (/^delete (\\S+) (\\S+)/.test(j)) {
  const m = j.match(/^delete (\\S+) (\\S+)/); const bag = /bundle/.test(m[1]) ? 'bundles' : 'deployments';
  if (!(st[bag] || {})[m[2]]) die('Error from server (NotFound): ' + m[2] + ' not found');
  delete st[bag][m[2]]; save(); out(m[1] + ' "' + m[2] + '" deleted\\n');
}
else die('fake kubectl: unhandled: ' + j);
`;

const FAKE_HELM = `#!/usr/bin/env node
const st = JSON.parse(require('fs').readFileSync(process.env.FAKE_STATE, 'utf-8'));
const j = process.argv.slice(2).join(' ');
if (/^version/.test(j)) process.stdout.write('v3.14.0\\n');
else if (/^list/.test(j)) process.stdout.write(JSON.stringify(st.helmOutdated ? [{ name: 'sambastack', chart: 'sambastack-0.0.1', namespace: 'ns1' }] : []));
else process.exit(1);
`;

// ─── fake API server ─────────────────────────────────────────────────────────

let server: Server;
let port = 0;
const apiHits: { url: string; auth?: string; body: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      apiHits.push({ url: req.url || '', auth: req.headers.authorization, body });
      if (req.headers.authorization !== 'Bearer good') { res.statusCode = 401; return res.end('{}'); }
      const json = (code: number, o: unknown) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (req.url === '/v1/models') return json(200, { data: [{ id: 'm1' }, { id: 'm2' }] });
      if (req.url === '/v1/chat/completions') {
        const parsed = JSON.parse(body);
        if (parsed.model === 'boom') return json(500, { error: { message: 'internal boom' } });
        if (parsed.model === 'missing') return json(404, { error: { message: 'model not found' } });
        if (parsed.model === 'html') { res.statusCode = 200; return res.end('<html>not json</html>'); }
        const last = parsed.messages.at(-1);
        const parts = Array.isArray(last.content) ? last.content.map((c: any) => c.type).join(',') : 'text';
        return json(200, { choices: [{ message: { content: `<think>x</think>reply:${parts}:${parsed.messages[0].role}` } }], usage: { completion_tokens: 3 } });
      }
      if (req.url === '/v1/embeddings') return json(200, { data: [{ embedding: [0.25, 0.5] }] });
      if (req.url === '/v1/audio/transcriptions') {
        if (body.includes('name="model"\r\n\r\nempty')) return json(200, { text: '' });
        if (body.includes('name="model"\r\n\r\nbad')) return json(400, { error: 'bad audio' });
        return json(200, { text: 'hello audio' });
      }
      if (req.url === '/v1/audio/speech') {
        const parsed = JSON.parse(body);
        if (parsed.model === 'errstream') { res.end('data: {"error":{"message":"tts blew up"}}\n'); return; }
        if (parsed.model === 'silent') { res.end('data: [DONE]\n'); return; }
        const f = Buffer.alloc(8); f.writeFloatLE(0.5, 0); f.writeFloatLE(-0.5, 4);
        res.setHeader('x-audio-sample-rate', '16000');
        return res.end('data: ' + JSON.stringify({ audio_b64: f.toString('base64'), model: parsed.model, voice: parsed.voice }) + '\n\ndata: [DONE]\n');
      }
      json(404, { error: { message: 'no route' } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as any).port;
});
afterAll(() => { server.close(); });

// ─── sandbox + runner ────────────────────────────────────────────────────────

let sandbox = '';
const stateFile = () => path.join(sandbox, 'state.json');
const callsFile = () => path.join(sandbox, 'calls.log');
const KUBECONFIG_TEXT = 'apiVersion: v1\nclusters: []\n';

function writeConfig(extra: any = {}) {
  writeFileSync(path.join(sandbox, 'app-config.json'), JSON.stringify({
    currentKubeconfig: 'lab',
    kubeconfigs: {
      lab: { file: 'kubeconfigs/lab.yaml', namespace: 'ns1', apiDomain: `http://127.0.0.1:${port}`, apiKey: 'good', uiDomain: 'http://ui' },
      other: { file: 'kubeconfigs/other.yaml', namespace: 'ns2', apiDomain: '', apiKey: '' },
    },
    ...extra,
  }, null, 2));
}

function resetSandbox(state: any = {}, opts: { cache?: boolean; config?: boolean } = {}) {
  rmSync(path.join(sandbox, 'app'), { recursive: true, force: true });
  rmSync(path.join(sandbox, 'kubeconfigs'), { recursive: true, force: true });
  mkdirSync(path.join(sandbox, 'kubeconfigs'), { recursive: true });
  writeFileSync(path.join(sandbox, 'kubeconfigs/lab.yaml'), KUBECONFIG_TEXT);
  writeFileSync(path.join(sandbox, 'kubeconfigs/other.yaml'), KUBECONFIG_TEXT);
  if (opts.cache !== false) {
    mkdirSync(path.join(sandbox, 'app/data'), { recursive: true });
    writeFileSync(path.join(sandbox, 'app/data/checkpoint_mapping.json'), JSON.stringify(MAPPING));
    writeFileSync(path.join(sandbox, 'app/data/model_profiles.json'), JSON.stringify(PROFILES));
  }
  if (opts.config !== false) writeConfig();
  else rmSync(path.join(sandbox, 'app-config.json'), { force: true });
  writeFileSync(stateFile(), JSON.stringify(state));
  writeFileSync(callsFile(), '');
}

const readState = () => JSON.parse(readFileSync(stateFile(), 'utf-8'));
const readConfig = () => JSON.parse(readFileSync(path.join(sandbox, 'app-config.json'), 'utf-8'));
const calls = () => readFileSync(callsFile(), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

interface Result { code: number; out: string; err: string }
function run(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<Result> {
  return new Promise((resolve) => {
    const p = spawn(TSX, [CLI, ...args], {
      cwd: sandbox,
      env: { ...process.env, PATH: `${path.join(sandbox, 'bin')}:${process.env.PATH}`, FAKE_STATE: stateFile(), FAKE_CALLS: callsFile(), NO_COLOR: '1', ...opts.env },
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    p.stdin.end(opts.stdin ?? '');
  });
}

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'sambawiz-e2e-')));
  mkdirSync(path.join(sandbox, 'bin'));
  for (const [n, body] of [['kubectl', FAKE_KUBECTL], ['helm', FAKE_HELM]]) {
    writeFileSync(path.join(sandbox, 'bin', n), body);
    chmodSync(path.join(sandbox, 'bin', n), 0o755);
  }
  // the CLI resolves relative imports from its own location, but reads VERSION/package.json from cwd
  writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  writeFileSync(path.join(sandbox, 'VERSION'), 'app: 9.9.9\nminimum-sambastack-helm: 2.0.0\n');
});
afterAll(() => { rmSync(sandbox, { recursive: true, force: true }); });

const ok = (r: Result) => { expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: expect.any(String) }); return r; };
const failed = (r: Result, re: RegExp) => { expect(r.code).toBe(1); expect(r.err).toMatch(re); return r; };

// ─── meta ────────────────────────────────────────────────────────────────────

describe('meta', () => {
  beforeEach(() => resetSandbox());
  it('--help lists every command group', async () => {
    const r = ok(await run(['--help']));
    for (const c of ['env', 'data', 'models', 'bundle', 'deploy', 'chat', 'embed', 'api-models', 'transcribe', 'speak', 'install', 'doctor']) expect(r.out).toContain(c);
  });
  it.each([['env'], ['data'], ['models'], ['bundle'], ['deploy'], ['install']])('%s --help works', async (g) => {
    expect(ok(await run([g, '--help'])).out).toContain('Usage: sambawiz');
  });
  it('unknown command and missing required options exit 1', async () => {
    expect((await run(['nope'])).code).toBe(1);
    expect((await run(['bundle', 'build'])).code).toBe(1);
    expect((await run(['chat'])).code).toBe(1);
  });
});

describe('review #40.5: a fatal error exits non-zero', () => {
  beforeEach(() => resetSandbox());
  it('an unloadable dependency (commander missing) prints "Fatal error" and exits 1, not 0', async () => {
    // simulate `commander` not being installed
    writeFileSync(path.join(sandbox, 'block-commander.js'),
      "const M = require('module'); const o = M._resolveFilename; M._resolveFilename = function (r, ...a) { if (r === 'commander') { const e = new Error(\"Cannot find module 'commander'\"); e.code = 'MODULE_NOT_FOUND'; throw e; } return o.call(this, r, ...a); };");
    const r = await run(['env', 'list'], { env: { NODE_OPTIONS: `--require ${path.join(sandbox, 'block-commander.js')}` } });
    expect(r.err).toMatch(/Fatal error/);
    expect(r.err).toMatch(/commander/);
    expect(r.code).toBe(1);
  });
});

// ─── env ─────────────────────────────────────────────────────────────────────

describe('env', () => {
  beforeEach(() => resetSandbox());
  it('list (human + json) marks the current environment', async () => {
    expect(ok(await run(['env', 'list'])).out).toMatch(/\* lab\s+ns=ns1/);
    const rows = JSON.parse(ok(await run(['env', 'list', '--json'])).out);
    expect(rows.find((r: any) => r.name === 'lab').current).toBe(true);
    expect(rows).toHaveLength(2);
  });
  it('use switches, and rejects unknown / unsafe names', async () => {
    ok(await run(['env', 'use', 'other']));
    expect(readConfig().currentKubeconfig).toBe('other');
    failed(await run(['env', 'use', 'ghost']), /not found/);
    failed(await run(['env', 'use', '../etc']), /Invalid environment name/);
  });
  it('add: from file, from base64, duplicate, overwrite, invalid content, bad source flags, traversal name', async () => {
    const kf = path.join(sandbox, 'k.yaml'); writeFileSync(kf, KUBECONFIG_TEXT);
    ok(await run(['env', 'add', 'fromfile', '--kubeconfig-file', kf, '--namespace', 'nsx', '--api-key', 'k1']));
    expect(readConfig().kubeconfigs.fromfile).toMatchObject({ file: 'kubeconfigs/fromfile.yaml', namespace: 'nsx', apiKey: 'k1' });
    expect(readConfig().currentKubeconfig).toBe('fromfile');
    expect(existsSync(path.join(sandbox, 'kubeconfigs/fromfile.yaml'))).toBe(true);
    ok(await run(['env', 'add', 'fromb64', '--kubeconfig-b64', Buffer.from(KUBECONFIG_TEXT).toString('base64')]));
    failed(await run(['env', 'add', 'fromb64', '--kubeconfig-file', kf]), /already exists/);
    ok(await run(['env', 'add', 'fromb64', '--kubeconfig-file', kf, '--overwrite']));
    failed(await run(['env', 'add', 'junk', '--kubeconfig-b64', 'aGk=']), /does not look like a valid kubeconfig/);
    failed(await run(['env', 'add', 'x']), /exactly one of/);
    failed(await run(['env', 'add', 'x', '--kubeconfig-file', kf, '--kubeconfig-b64', 'aGk=']), /exactly one of/);
    failed(await run(['env', 'add', '../evil', '--kubeconfig-file', kf]), /Invalid environment name/);
    failed(await run(['env', 'add', 'sp ace', '--kubeconfig-file', kf]), /Invalid environment name/);
    failed(await run(['env', 'add', 'y', '--kubeconfig-file', '/no/such/file']), /File not found/);
    failed(await run(['env', 'add', 'y', '--kubeconfig-file', kf, '--namespace', 'Bad_NS']), /Invalid namespace/);
    expect(existsSync(path.join(sandbox, '..', 'evil.yaml'))).toBe(false);
  });
  it('add --overwrite replaces the kubeconfig the env actually points at, and does not claim it was added/made current', async () => {
    const cfg = readConfig();
    cfg.kubeconfigs.custom = { file: 'kubeconfigs/somewhere-else.yaml', namespace: 'ns3' };
    writeFileSync(path.join(sandbox, 'app-config.json'), JSON.stringify(cfg));
    writeFileSync(path.join(sandbox, 'kubeconfigs/somewhere-else.yaml'), 'apiVersion: v1\nclusters: []\n# OLD\n');
    const fresh = path.join(sandbox, 'fresh.yaml'); writeFileSync(fresh, 'apiVersion: v1\nclusters: []\n# FRESH\n');
    const r = ok(await run(['env', 'add', 'custom', '--kubeconfig-file', fresh, '--overwrite']));
    expect(readFileSync(path.join(sandbox, 'kubeconfigs/somewhere-else.yaml'), 'utf-8')).toContain('# FRESH');
    expect(existsSync(path.join(sandbox, 'kubeconfigs/custom.yaml'))).toBe(false);
    expect(readConfig().kubeconfigs.custom).toMatchObject({ file: 'kubeconfigs/somewhere-else.yaml', namespace: 'ns3' });
    expect(readConfig().currentKubeconfig).toBe('lab'); // overwrite never switches the current env
    expect(r.out).toMatch(/kubeconfig overwritten \(kubeconfigs\/somewhere-else\.yaml\)/);
    expect(r.out).not.toMatch(/added and set current/);
    // overwriting the env that IS current must not be reported as "added"
    const cur = ok(await run(['env', 'add', 'lab', '--kubeconfig-file', fresh, '--overwrite']));
    expect(cur.out).toMatch(/kubeconfig overwritten/);
    expect(readFileSync(path.join(sandbox, 'kubeconfigs/lab.yaml'), 'utf-8')).toContain('# FRESH');
  });
  it('add creates app-config.json when none exists', async () => {
    resetSandbox({}, { config: false });
    const kf = path.join(sandbox, 'k.yaml'); writeFileSync(kf, KUBECONFIG_TEXT);
    ok(await run(['env', 'add', 'first', '--kubeconfig-file', kf]));
    expect(readConfig().currentKubeconfig).toBe('first');
  });
  it('commands that need app-config.json explain how to create it', async () => {
    resetSandbox({}, { config: false });
    failed(await run(['env', 'list']), /app-config.json not found/);
  });
  it('edit updates fields; namespace change refreshes PEF configs and rolls back on failure', async () => {
    ok(await run(['env', 'edit', 'lab', '--ui-domain', 'http://new-ui', '--api-key', 'zzz', '--tts-model', 'tts9']));
    expect(readConfig().kubeconfigs.lab).toMatchObject({ uiDomain: 'http://new-ui', apiKey: 'zzz', ttsModel: 'tts9' });
    ok(await run(['env', 'edit', 'lab', '--namespace', 'ns9']));
    expect(readConfig().kubeconfigs.lab.namespace).toBe('ns9');
    expect(calls().some((c) => c.args.includes('-n ns9 get pef'))).toBe(true);
    writeFileSync(stateFile(), JSON.stringify({ kubectlDown: true }));
    failed(await run(['env', 'edit', 'lab', '--namespace', 'ns10']), /nothing changed/);
    expect(readConfig().kubeconfigs.lab.namespace).toBe('ns9');
    failed(await run(['env', 'edit', 'ghost', '--ui-domain', 'x']), /not found/);
    failed(await run(['env', 'edit', 'lab', '--namespace', 'Bad_NS']), /Invalid namespace/);
  });
  it('proactive: --api-key on env add / env edit warns that the key lands in shell history', async () => {
    const kf = path.join(sandbox, 'kk.yaml'); writeFileSync(kf, KUBECONFIG_TEXT);
    expect(ok(await run(['env', 'add', 'withkey', '--kubeconfig-file', kf, '--api-key', 'k-1'])).err).toMatch(/shell history.*env set-api-key/);
    expect(ok(await run(['env', 'edit', 'withkey', '--api-key', 'k-2'])).err).toMatch(/shell history/);
    expect(ok(await run(['env', 'edit', 'withkey', '--ui-domain', 'http://u'])).err).not.toMatch(/shell history/);
  });
  it('proactive: the files the CLI writes with secrets (app-config.json, kubeconfigs) are owner-only', async () => {
    const mode = (f: string) => statSync(f).mode & 0o777;
    chmodSync(path.join(sandbox, 'app-config.json'), 0o644);
    chmodSync(path.join(sandbox, 'kubeconfigs/lab.yaml'), 0o777);
    ok(await run(['env', 'set-api-key'], { stdin: 'k-secret\n' }));
    expect(mode(path.join(sandbox, 'app-config.json'))).toBe(0o600);
    const kf = path.join(sandbox, 'k.yaml'); writeFileSync(kf, KUBECONFIG_TEXT);
    ok(await run(['env', 'add', 'priv', '--kubeconfig-file', kf]));
    expect(mode(path.join(sandbox, 'kubeconfigs/priv.yaml'))).toBe(0o600);
    ok(await run(['env', 'add', 'lab', '--kubeconfig-file', kf, '--overwrite']));      // an existing 777 kubeconfig is tightened
    expect(mode(path.join(sandbox, 'kubeconfigs/lab.yaml'))).toBe(0o600);
  });
  it('review #40.3: editing ANOTHER environment\'s namespace does not regenerate the current environment\'s PEF data', async () => {
    const r = ok(await run(['env', 'edit', 'other', '--namespace', 'ns9']));
    expect(readConfig().kubeconfigs.other.namespace).toBe('ns9');          // the edit itself is applied
    expect(calls().some((c) => /get pef/.test(c.args))).toBe(false);        // but pef_configs.json is untouched
    expect(r.out).toMatch(/not the current environment/);
    // the current environment still refreshes, as before
    ok(await run(['env', 'edit', 'lab', '--namespace', 'ns8']));
    expect(calls().some((c) => /-n ns8 get pef/.test(c.args))).toBe(true);
    // a non-namespace edit of another environment never touches PEFs either
    const before = calls().length;
    ok(await run(['env', 'edit', 'other', '--ui-domain', 'http://x']));
    expect(calls().slice(before).some((c) => /get pef/.test(c.args))).toBe(false);
  });
  it('set-api-key: key from stdin (no argv), argument still works with a history warning, rejects unknown env / empty key', async () => {
    ok(await run(['env', 'set-api-key'], { stdin: 'k-from-stdin\n' }));
    expect(readConfig().kubeconfigs.lab.apiKey).toBe('k-from-stdin');
    ok(await run(['env', 'set-api-key', '--env', 'other'], { stdin: 'k-other\n' }));
    expect(readConfig().kubeconfigs.other.apiKey).toBe('k-other');
    const viaArg = ok(await run(['env', 'set-api-key', 'k-current']));
    expect(readConfig().kubeconfigs.lab.apiKey).toBe('k-current');
    expect(viaArg.err).toMatch(/shell history/);
    failed(await run(['env', 'set-api-key', '--env', 'ghost'], { stdin: 'k\n' }), /not found/);
    failed(await run(['env', 'set-api-key'], { stdin: '\n' }), /No API key given/);
    expect(readConfig().kubeconfigs.lab.apiKey).toBe('k-current');
  });
  it('delete needs --yes, removes, and moves "current" when deleting it', async () => {
    failed(await run(['env', 'delete', 'other']), /without --yes/);
    failed(await run(['env', 'delete', 'ghost', '--yes']), /not found/);
    ok(await run(['env', 'delete', 'lab', '--yes']));
    expect(readConfig().currentKubeconfig).toBe('other');
    ok(await run(['env', 'delete', 'other', '--yes']));
    expect(readConfig().currentKubeconfig).toBeNull();
  });
  it('credentials prints the Keycloak admin login, and fails clearly when absent', async () => {
    expect(ok(await run(['env', 'credentials'])).out).toContain('Password: s3cret');
    expect(JSON.parse(ok(await run(['env', 'credentials', '--json'])).out)).toEqual({ username: 'admin', password: 's3cret' });
    writeFileSync(stateFile(), JSON.stringify({ noKeycloak: true }));
    failed(await run(['env', 'credentials']), /NotFound|not found/);
  });
  it('uses the selected env kubeconfig and namespace explicitly (never the ambient context)', async () => {
    ok(await run(['bundle', 'list', '--env', 'other']));
    const c = calls().at(-1);
    expect(c.kubeconfig).toBe(path.join(sandbox, 'kubeconfigs/other.yaml'));
    expect(c.args).toContain('-n ns2');
    ok(await run(['bundle', 'list', '-n', 'override']));
    expect(calls().at(-1).args).toContain('-n override');
    failed(await run(['bundle', 'list', '--env', 'ghost']), /not in app-config/);
    failed(await run(['bundle', 'list', '-n', 'x; rm -rf /']), /Invalid namespace/);
  });
});

// ─── data / models ───────────────────────────────────────────────────────────

describe('data + models', () => {
  const MODEL_CR = { metadata: { name: 'llama' }, spec: { name: 'Llama', metadata: { capabilities: ['x'] }, checkpoints: { a1: { versions: { '3': { source: 'gs://b/x', checkpoint_status: 'ok' } } } } } };
  const PROFILE_CR = { metadata: { name: 'p1' }, spec: { model_arch: 'a1', features: [], batchingConfigs: { all: { '8k': { batch_sizes: [1] } } } } };
  it('data refresh regenerates the cache from the cluster (human + json)', async () => {
    resetSandbox({ models: [MODEL_CR], modelprofiles: [PROFILE_CR] }, { cache: false });
    const r = ok(await run(['data', 'refresh', '--json']));
    expect(JSON.parse(r.out.trim().split('\n').at(-1)!.length ? r.out.slice(r.out.indexOf('{')) : '{}')).toMatchObject({ models: 1 });
    const mapping = JSON.parse(readFileSync(path.join(sandbox, 'app/data/checkpoint_mapping.json'), 'utf-8'));
    expect(mapping.Llama.resource_name).toBe('llama');
    expect(mapping.Llama.checkpoints.a1.versions['3'].source).toBe('x'); // gs://<bucket>/ stripped to the path
    expect(existsSync(path.join(sandbox, 'app/data/model_profiles.json'))).toBe(true);
  });
  it('data refresh fails clearly when the cluster is unreachable', async () => {
    resetSandbox({ kubectlDown: true }, { cache: false });
    failed(await run(['data', 'refresh']), /connection refused|get models failed/);
  });
  it('models list: human, json, flags models without a profile', async () => {
    resetSandbox();
    expect(ok(await run(['models', 'list'])).out).toMatch(/NoProfile\s+\(no matching profile\)/);
    const rows = JSON.parse(ok(await run(['models', 'list', '--json'])).out);
    expect(rows.find((r: any) => r.model === 'Llama')).toMatchObject({ archs: ['a1'], deployable: true });
    expect(rows.find((r: any) => r.model === 'NoProfile').deployable).toBe(false);
  });
  it('models profiles: lists batching, filters by --arch, rejects unknown model', async () => {
    resetSandbox();
    const rows = JSON.parse(ok(await run(['models', 'profiles', 'multi', '--json'])).out);
    expect(rows.map((r: any) => r.arch).sort()).toEqual(['a1', 'a2']);
    expect(JSON.parse(ok(await run(['models', 'profiles', 'Multi', '--arch', 'a2', '--json'])).out)).toHaveLength(1);
    expect(ok(await run(['models', 'profiles', 'Llama'])).out).toContain('32k: [1,2,4]');
    failed(await run(['models', 'profiles', 'Nope']), /Unknown model/);
  });
  it('models commands fail clearly before data refresh', async () => {
    resetSandbox({}, { cache: false });
    failed(await run(['models', 'list']), /data refresh/);
  });
});

// ─── bundle ──────────────────────────────────────────────────────────────────

describe('bundle build', () => {
  beforeEach(() => resetSandbox());
  const build = (...a: string[]) => run(['bundle', 'build', ...a]);
  it('prints valid ModelBundle YAML with the recommended batching by default', async () => {
    const r = ok(await build('--name', 'b1', '--model', 'Llama:p1'));
    expect(r.out).toContain('kind: ModelBundle');
    expect(r.out).toContain('model: llama:1');
    expect(r.out).toContain('profile: p1');
  });
  it('--batch overrides, validates against the profile universe, and collapses a full set to *', async () => {
    expect(ok(await build('--name', 'b1', '--model', 'Llama:p1', '--batch', 'Llama:32k=1,2')).out).toMatch(/32k:\s+batch_sizes: \[1, 2\]/);
    expect(ok(await build('--name', 'b1', '--model', 'Llama:p1', '--batch', 'Llama:32k=1,2,4')).out).toMatch(/32k:\s+batch_sizes: '\*'/);
    failed(await build('--name', 'b1', '--model', 'Llama:p1', '--batch', 'Llama:32k=8'), /not supported/);
    failed(await build('--name', 'b1', '--model', 'Llama:p1', '--batch', 'Llama:64k=1'), /not in this profile/);
    failed(await build('--name', 'b1', '--model', 'Llama:p1', '--batch', 'Llama:32k=0'), /Invalid batch sizes/);
    failed(await build('--name', 'b1', '--model', 'Llama:p1', '--batch', 'Llama'), /Invalid --batch/);
    failed(await build('--name', 'b1', '--model', 'Llama:p1', '--batch', 'Other:32k=1'), /not one of the --model entries/);
  });
  it('rejects bad names, models, profiles, archs and malformed specs', async () => {
    failed(await build('--name', 'Bad_Name', '--model', 'Llama:p1'), /Name cannot contain/);
    failed(await build('--name', '', '--model', 'Llama:p1'), /Name is required/);
    failed(await build('--name', 'b1', '--model', 'Nope:p1'), /Unknown model/);
    failed(await build('--name', 'b1', '--model', 'Llama:zzz'), /Unknown profile/);
    failed(await build('--name', 'b1', '--model', 'Llama'), /Invalid --model/);
    failed(await build('--name', 'b1', '--model', 'Llama:p1:a1:x'), /Invalid --model/);
    failed(await build('--name', 'b1', '--model', 'NoProfile:p1'), /No matching profile/);
    failed(await build('--name', 'b1', '--model', 'Multi:p1'), /several archs/);
    failed(await build('--name', 'b1', '--model', 'Multi:p1:a9'), /no profile for arch/);
    failed(await build('--name', 'b1', '--model', 'Llama:p1', '--model', 'llama:p1'), /more than once/);
  });
  it('warns (stderr) when the name makes pod names hash, and still builds', async () => {
    const r = ok(await build('--name', 'x'.repeat(40), '--model', 'Llama:p1'));
    expect(r.err).toMatch(/truncate and hash/);
  });
  it('prompt-caching profile is single-model only', async () => {
    expect(ok(await build('--name', 'b1', '--model', 'Multi:cache:a2')).out).toContain('profile: cache');
    failed(await build('--name', 'b1', '--model', 'Multi:cache:a2', '--model', 'Llama:p1'), /single-model/);
  });
  it('--non-swappable and --draft are validated and emitted', async () => {
    expect(ok(await build('--name', 'b1', '--model', 'Llama:p1', '--non-swappable', 'Llama')).out).toContain('swappable: false');
    failed(await build('--name', 'b1', '--model', 'Llama:p1', '--non-swappable', 'Other'), /not one of the --model entries/);
    failed(await build('--name', 'b1', '--model', 'Llama:p1', '--draft', 'Llama=Draftee:p1'), /not a speculative-decoding profile/);
    failed(await build('--name', 'b1', '--model', 'Target:sdp', '--draft', 'Nope=Draftee:p1'), /not one of the --model entries/);
    failed(await build('--name', 'b1', '--model', 'Target:sdp', '--draft', 'Target'), /Invalid --draft/);
    failed(await build('--name', 'b1', '--model', 'Target:sdp', '--model', 'Draftee:p1', '--draft', 'Target=Draftee:p1'), /already a --model entry/);
    failed(await build('--name', 'b1', '--model', 'Target:sdp', '--draft', 'Target=Draftee:p1', '--draft', 'Target=Draftee:p1'), /already has a draft/);
    const r = ok(await build('--name', 'b1', '--model', 'Target:sdp', '--draft', 'Target=Draftee:p1'));
    expect(r.out).toContain('specDecodingPairs');
    expect(r.out).toContain('routable: false');
  });
  it('a dropped DRAFT does not trigger the "every model was dropped" error; a dropped sole model does', async () => {
    const r = ok(await build('--name', 'b1', '--model', 'Target:sdp', '--draft', 'Target=DraftEmpty:emptyb'));
    expect(r.err).toMatch(/1 selected model left this bundle/);
    expect(r.out).toContain('profile: sdp');
    expect(r.out).not.toContain('draftempty');
    failed(await build('--name', 'b1', '--model', 'DraftEmpty:emptyb'), /Every selected model was dropped/);
  });
  it('writes -o file; --json carries yaml + dropped', async () => {
    const out = path.join(sandbox, 'out.yaml');
    ok(await build('--name', 'b1', '--model', 'Llama:p1', '-o', out));
    expect(readFileSync(out, 'utf-8')).toContain('kind: ModelBundle');
    const j = JSON.parse(ok(await build('--name', 'b1', '--model', 'Llama:p1', '--json')).out);
    expect(j).toMatchObject({ name: 'b1', dropped: [] });
    expect(j.yaml).toContain('ModelBundle');
  });
  it('applies checkpoint_overrides from app-config.json', async () => {
    writeConfig({ checkpoint_overrides: { Llama: '7' } });
    expect(ok(await build('--name', 'b1', '--model', 'Llama:p1')).out).toContain('model: llama:7');
  });
  it('--apply applies, waits for validation and exits 0 on success', async () => {
    const r = ok(await build('--name', 'good', '--model', 'Llama:p1', '--apply', '--timeout', '30'));
    expect(r.out).toContain('Bundle good is valid');
    expect(calls().some((c) => c.args.startsWith('apply') && c.stdin.includes('name: good'))).toBe(true);
  });
  it('--apply on a failing bundle prints legalizer errors first and exits 1', async () => {
    const r = await build('--name', 'bad', '--model', 'Llama:p1', '--apply', '--timeout', '30');
    expect(r.code).toBe(1);
    expect(r.out).toContain('legalizer: not enough memory');
    expect(r.out).not.toContain('generic failure');
  });
  it('--apply surfaces kubectl failures and rejects a non-numeric timeout', async () => {
    writeFileSync(stateFile(), JSON.stringify({ applyFail: true }));
    failed(await build('--name', 'good', '--model', 'Llama:p1', '--apply'), /kubectl apply failed/);
    resetSandbox();
    failed(await build('--name', 'good', '--model', 'Llama:p1', '--apply', '--timeout', 'abc'), /positive integer/);
    failed(await build('--name', 'good', '--model', 'Llama:p1', '--apply', '--timeout', '0'), /positive integer/);
  });
  it('--apply is refused on an outdated SambaStack chart (like the UI)', async () => {
    writeFileSync(stateFile(), JSON.stringify({ helmOutdated: true }));
    failed(await build('--name', 'good', '--model', 'Llama:p1', '--apply'), /older than the minimum|outdated|SambaStack/i);
    expect(calls().some((c) => c.args.startsWith('apply'))).toBe(false);
  });
});

describe('review #40.2: model data must come from the targeted cluster', () => {
  beforeEach(() => resetSandbox());
  const stamp = (kubeconfig: string, namespace: string, drift = 0, server?: string) => writeFileSync(path.join(sandbox, 'app/data/cache_source.json'), JSON.stringify({
    kubeconfig, namespace, ...(server ? { server } : {}),
    mapping: statSync(path.join(sandbox, 'app/data/checkpoint_mapping.json')).mtimeMs + drift,
    profiles: statSync(path.join(sandbox, 'app/data/model_profiles.json')).mtimeMs + drift,
  }));
  const labConfig = () => path.join(sandbox, 'kubeconfigs/lab.yaml');

  it('refuses `bundle build --apply` when the cache was generated for another environment, and applies nothing', async () => {
    stamp(path.join(sandbox, 'kubeconfigs/other.yaml'), 'ns2');
    failed(await run(['bundle', 'build', '--name', 'b1', '--model', 'Llama:p1', '--apply']), /generated for other\.yaml \/ ns2, not for environment "lab".*data refresh --env lab/);
    expect(calls().some((c) => c.args.startsWith('apply'))).toBe(false);
  });
  it('refuses `deploy create --model` the same way, and a different namespace of the same kubeconfig also counts', async () => {
    stamp(path.join(sandbox, 'kubeconfigs/other.yaml'), 'ns2');
    failed(await run(['deploy', 'create', '--model', 'Llama:p1']), /generated for other\.yaml/);
    stamp(labConfig(), 'another-namespace');
    failed(await run(['deploy', 'create', '--model', 'Llama:p1', '--dry-run']), /another-namespace/);
  });
  it('--env targets are checked, not just the current environment', async () => {
    stamp(labConfig(), 'ns1');                                       // cache is for lab/ns1
    expect(ok(await run(['deploy', 'create', '--model', 'Llama:p1', '--dry-run'])).out).toContain('md-llama'); // matches current env
    failed(await run(['deploy', 'create', '--model', 'Llama:p1', '--env', 'other']), /not for environment "other"/);
  });
  it('same kubeconfig path and namespace but a DIFFERENT API server (kubeconfig replaced) is a mismatch', async () => {
    writeFileSync(labConfig(), 'apiVersion: v1\nclusters:\n- cluster:\n    server: https://new-cluster:6443\n  name: c\n');
    stamp(labConfig(), 'ns1', 0, 'https://old-cluster:6443');
    failed(await run(['deploy', 'create', '--model', 'Llama:p1', '--dry-run']), /generated for https:\/\/old-cluster:6443 \/ ns1/);
    stamp(labConfig(), 'ns1', 0, 'https://new-cluster:6443');
    ok(await run(['deploy', 'create', '--model', 'Llama:p1', '--dry-run']));
  });
  it('read-only commands only warn when the cache is for another environment', async () => {
    stamp(path.join(sandbox, 'kubeconfigs/other.yaml'), 'ns2');
    const r = ok(await run(['models', 'list']));
    expect(r.err).toMatch(/generated for other\.yaml \/ ns2, not for the current environment "lab"/);
    expect(r.out).toContain('Llama');                                                    // still shows the models
    expect(ok(await run(['bundle', 'build', '--name', 'b1', '--model', 'Llama:p1'])).err).toMatch(/not for the current environment/);
    stamp(labConfig(), 'ns1');
    expect(ok(await run(['models', 'list'])).err).not.toMatch(/generated for/);
  });
  it('a matching stamp works silently; no stamp (or one made stale by a rewritten cache) only warns', async () => {
    stamp(labConfig(), 'ns1');
    const matching = ok(await run(['deploy', 'create', '--model', 'Llama:p1', '--dry-run']));
    expect(matching.err).not.toMatch(/can't tell which cluster/);
    rmSync(path.join(sandbox, 'app/data/cache_source.json'));
    expect(ok(await run(['deploy', 'create', '--model', 'Llama:p1', '--dry-run'])).err).toMatch(/can't tell which cluster/);
    stamp(path.join(sandbox, 'kubeconfigs/other.yaml'), 'ns2', 5000);   // stamp for another env, but the cache files changed since
    expect(ok(await run(['deploy', 'create', '--model', 'Llama:p1', '--dry-run'])).err).toMatch(/can't tell which cluster/);
  });
  it('`data refresh` stamps the cache for the refreshed environment', async () => {
    writeFileSync(stateFile(), JSON.stringify({ models: [], modelprofiles: [] }));
    ok(await run(['data', 'refresh']));
    const st = JSON.parse(readFileSync(path.join(sandbox, 'app/data/cache_source.json'), 'utf-8'));
    expect(st).toMatchObject({ kubeconfig: labConfig(), namespace: 'ns1' });
  });
});

describe('bundle list/show/apply/validate/delete', () => {
  const GOOD = { metadata: { name: 'bg' }, spec: { modelConfigs: [{ profile: 'p1' }] }, status: { conditions: [{ type: 'Valid', status: 'True' }] } };
  const PEND = { metadata: { name: 'bp' }, spec: {}, status: { conditions: [] } };
  beforeEach(() => resetSandbox({ bundles: { bg: GOOD, bp: PEND } }));
  it('list shows validation state (human + json)', async () => {
    expect(ok(await run(['bundle', 'list'])).out).toMatch(/bg\s+succeeded[\s\S]*bp\s+pending/);
    expect(JSON.parse(ok(await run(['bundle', 'list', '--json'])).out)).toEqual([{ name: 'bg', validation: 'succeeded' }, { name: 'bp', validation: 'pending' }]);
  });
  it('show prints YAML; unknown or unsafe names fail', async () => {
    expect(ok(await run(['bundle', 'show', 'bg'])).out).toContain('name: bg');
    failed(await run(['bundle', 'show', 'ghost']), /NotFound|not found/);
    failed(await run(['bundle', 'show', 'a;b']), /Invalid bundle name/);
  });
  it('apply -f validates the file kind/name and waits for validation', async () => {
    const f = path.join(sandbox, 'b.yaml');
    writeFileSync(f, 'apiVersion: sambanova.ai/v1alpha1\nkind: ModelBundle\nmetadata:\n  name: fromfile\nspec: {}\n');
    expect(ok(await run(['bundle', 'apply', '-f', f, '--timeout', '30'])).out).toContain('fromfile is valid');
    writeFileSync(f, 'apiVersion: sambanova.ai/v1alpha1\nkind: ModelBundle\nmetadata:\n  name: bad-one\nspec: {}\n');
    expect((await run(['bundle', 'apply', '-f', f, '--timeout', '30'])).code).toBe(1);
    writeFileSync(f, 'kind: Pod\nmetadata:\n  name: x\n');
    failed(await run(['bundle', 'apply', '-f', f]), /not a ModelBundle/);
    writeFileSync(f, 'kind: ModelBundle\nmetadata:\n  name: Bad_Name\n');
    failed(await run(['bundle', 'apply', '-f', f]), /Name cannot contain/);
    writeFileSync(f, 'key: [unclosed');
    expect((await run(['bundle', 'apply', '-f', f])).code).toBe(1);
    failed(await run(['bundle', 'apply', '-f', '/no/file.yaml']), /ENOENT|no such file/);
  });
  it('review #40.1: a Valid=True from an OLDER generation is not reported as valid (re-apply of an already-valid bundle)', async () => {
    const stale = { metadata: { name: 'bs', generation: 2 }, spec: {}, status: { observedGeneration: 1, conditions: [{ type: 'Valid', status: 'True', observedGeneration: 1 }] } };
    const fresh = { metadata: { name: 'bf', generation: 2 }, spec: {}, status: { observedGeneration: 2, conditions: [{ type: 'Valid', status: 'True', observedGeneration: 2 }] } };
    writeFileSync(stateFile(), JSON.stringify({ ...readState(), bundles: { ...readState().bundles, bs: stale, bf: fresh } }));
    failed(await run(['bundle', 'validate', 'bs', '--timeout', '1']), /Timed out/);          // not "valid"
    expect(ok(await run(['bundle', 'validate', 'bf', '--timeout', '5'])).out).toContain('bf is valid');
    expect(JSON.parse(ok(await run(['bundle', 'list', '--json'])).out).find((r: any) => r.name === 'bs').validation).toBe('pending');
    failed(await run(['deploy', 'create', '--bundle', 'bs', '--dry-run']), /not validated/);  // deploy can't roll out the stale one
  });
  it('review #40.4: a real kubectl error fails immediately with that error instead of waiting out the timeout', async () => {
    writeFileSync(stateFile(), JSON.stringify({ forbidden: true }));
    let t0 = Date.now();
    failed(await run(['bundle', 'validate', 'anything', '--timeout', '60']), /Forbidden/);
    expect(Date.now() - t0).toBeLessThan(15_000);
    writeFileSync(stateFile(), JSON.stringify({ kubectlDown: true }));
    t0 = Date.now();
    failed(await run(['bundle', 'validate', 'anything', '--timeout', '60']), /connection refused/);
    expect(Date.now() - t0).toBeLessThan(15_000);
    // a bundle that simply isn't there yet is still retried until the timeout
    writeFileSync(stateFile(), JSON.stringify({}));
    failed(await run(['bundle', 'validate', 'not-yet', '--timeout', '1']), /Timed out/);
  });
  it('validate reports success / failure / unknown bundle by timeout', async () => {
    expect(ok(await run(['bundle', 'validate', 'bg', '--timeout', '5'])).out).toContain('bg is valid');
    const pend = await run(['bundle', 'validate', 'bp', '--timeout', '1']);
    failed(pend, /Timed out/);
    failed(await run(['bundle', 'validate', 'ghost', '--timeout', '1']), /Timed out/);
  });
  it('proactive: a bundle that a deployment still uses is not deleted without --force', async () => {
    writeFileSync(stateFile(), JSON.stringify({ ...readState(), deployments: { md1: { metadata: { name: 'md1' }, spec: { bundle: 'bg' }, status: {} } } }));
    failed(await run(['bundle', 'delete', 'bg', '--yes']), /still used by deployment\(s\): md1/);
    expect(readState().bundles.bg).toBeDefined();
    ok(await run(['bundle', 'delete', 'bp', '--yes']));                  // not referenced -> deleted
    expect(readState().bundles.bp).toBeUndefined();
    ok(await run(['bundle', 'delete', 'bg', '--yes', '--force']));       // explicit override
    expect(readState().bundles.bg).toBeUndefined();
  });
  it('delete needs --yes, removes, and reports a missing bundle', async () => {
    failed(await run(['bundle', 'delete', 'bg']), /without --yes/);
    ok(await run(['bundle', 'delete', 'bg', '--yes']));
    expect(readState().bundles.bg).toBeUndefined();
    failed(await run(['bundle', 'delete', 'bg', '--yes']), /NotFound|not found/);
    failed(await run(['bundle', 'delete', '$(id)', '--yes']), /Invalid bundle name/);
  });
});

// ─── deploy ──────────────────────────────────────────────────────────────────

describe('deploy', () => {
  const GOOD = { metadata: { name: 'bg' }, spec: { modelConfigs: [{ profile: 'p1' }] }, status: { conditions: [{ type: 'Valid', status: 'True' }] } };
  const MULTI = { metadata: { name: 'bm' }, spec: { modelConfigs: [{ profile: 'cache' }, { profile: 'p1' }] }, status: { conditions: [{ type: 'Valid', status: 'True' }] } };
  const CACHE = { metadata: { name: 'bc' }, spec: { modelConfigs: [{ profile: 'cache' }] }, status: { conditions: [{ type: 'Valid', status: 'True' }] } };
  const PEND = { metadata: { name: 'bp' }, spec: {}, status: { conditions: [] } };
  beforeEach(() => resetSandbox({ bundles: { bg: GOOD, bm: MULTI, bc: CACHE, bp: PEND }, profileFeatures: { cache: ['prompt_caching'], p1: [] } }));
  const applied = () => calls().filter((c) => c.args.startsWith('apply')).map((c) => c.stdin);

  it('create --bundle: dry-run prints YAML, default name md-<bundle>, applies for real', async () => {
    const dry = ok(await run(['deploy', 'create', '--bundle', 'bg', '--dry-run']));
    expect(dry.out).toContain('name: md-bg');
    expect(dry.out).toContain('bundle: bg');
    expect(applied()).toHaveLength(0);
    ok(await run(['deploy', 'create', '--bundle', 'bg']));
    expect(applied()[0]).toContain('kind: ModelDeployment');
    expect(readState().deployments['md-bg']).toBeDefined();
  });
  it('create applies env vars, custom names and the b- naming rule is NOT applied to explicit names', async () => {
    const r = ok(await run(['deploy', 'create', '--bundle', 'bc', '--prompt-caching', '--ignore-eos', '--name', 'my-dep', '--dry-run']));
    for (const v of ['ENABLE_KV_CACHE_MANAGER', 'KV_CACHE_INCLUDE_STATS_IN_RESPONSE', 'ENABLE_IGNORE_EOS']) expect(r.out).toContain(`${v}: "true"`);
    expect(r.out).toContain('name: my-dep');
  });
  it('create enforces the UI rules: validated bundles only, caching only for a single caching model, valid names', async () => {
    failed(await run(['deploy', 'create', '--bundle', 'bp']), /not validated/);
    failed(await run(['deploy', 'create', '--bundle', 'ghost']), /NotFound|not found/);
    failed(await run(['deploy', 'create', '--bundle', 'bg', '--prompt-caching']), /prompt_caching feature/);
    failed(await run(['deploy', 'create', '--bundle', 'bm', '--prompt-caching']), /prompt_caching feature/);
    failed(await run(['deploy', 'create', '--bundle', 'bg', '--name', 'Bad_Name']), /Name cannot contain/);
    failed(await run(['deploy', 'create']), /exactly one of/);
    failed(await run(['deploy', 'create', '--bundle', 'bg', '--model', 'Llama:p1']), /exactly one of/);
    failed(await run(['deploy', 'create', '--bundle', '$(id)']), /Invalid bundle name/);
  });
  it('a profile name coming from the cluster is never interpreted by a shell', async () => {
    const evil = 'p;touch pwned-by-profile';
    writeFileSync(stateFile(), JSON.stringify({ ...readState(), bundles: { ...readState().bundles,
      bx: { metadata: { name: 'bx' }, spec: { modelConfigs: [{ profile: evil }] }, status: { conditions: [{ type: 'Valid', status: 'True' }] } } } }));
    failed(await run(['deploy', 'create', '--bundle', 'bx', '--prompt-caching', '--dry-run']), /prompt_caching feature/);
    expect(existsSync(path.join(sandbox, 'pwned-by-profile'))).toBe(false);
    // kubectl received the name as ONE literal argument
    expect(calls().some((c) => c.args.includes(`get modelprofile.sambanova.ai ${evil} -n ns1`))).toBe(true);
  });
  it('create --model (quick deploy) inlines spec.models with the latest-version ref', async () => {
    const r = ok(await run(['deploy', 'create', '--model', 'Llama:p1', '--dry-run']));
    expect(r.out).toContain('name: md-llama');
    expect(r.out).toContain('- model: llama');
    expect(r.out).not.toContain('- model: llama:1');
    expect(r.out).not.toContain('bundle:');
    expect(ok(await run(['deploy', 'create', '--model', 'Multi:p1:a1', '--dry-run'])).out).toContain('- model: multi:a1');
    writeConfig({ checkpoint_overrides: { Llama: '1' } });
    expect(ok(await run(['deploy', 'create', '--model', 'Llama:p1', '--dry-run'])).out).toContain('- model: llama:1');
    failed(await run(['deploy', 'create', '--model', 'Llama:zzz']), /Unknown profile/);
  });
  it('create --model --prompt-caching works only for a caching profile', async () => {
    ok(await run(['deploy', 'create', '--model', 'Multi:cache:a2', '--prompt-caching', '--dry-run']));
    failed(await run(['deploy', 'create', '--model', 'Llama:p1', '--prompt-caching']), /prompt_caching feature/);
  });
  it('create is refused on an outdated chart and surfaces apply failures', async () => {
    writeFileSync(stateFile(), JSON.stringify({ ...readState(), helmOutdated: true }));
    expect((await run(['deploy', 'create', '--bundle', 'bg'])).code).toBe(1);
    writeFileSync(stateFile(), JSON.stringify({ ...readState(), helmOutdated: false, applyFail: true }));
    failed(await run(['deploy', 'create', '--bundle', 'bg']), /kubectl apply failed/);
  });
  it('proactive: real kubectl failures surface instead of looking like a normal answer', async () => {
    // `deploy list` used to show every deployment as "Not Deployed" when the pods could not be read
    writeFileSync(stateFile(), JSON.stringify({ kubectlDown: true }));
    failed(await run(['deploy', 'list']), /connection refused|Unable to connect/);
    // `--prompt-caching` used to say "needs the prompt_caching feature" when the profile lookup was merely denied
    writeFileSync(stateFile(), JSON.stringify({ bundles: { bc: { metadata: { name: 'bc' }, spec: { modelConfigs: [{ profile: 'cache' }] }, status: { conditions: [{ type: 'Valid', status: 'True' }] } } }, profileForbidden: true }));
    failed(await run(['deploy', 'create', '--bundle', 'bc', '--prompt-caching', '--dry-run']), /modelprofile cache failed: .*Forbidden/);
  });
  it('apply -f applies a hand-edited ModelDeployment (e.g. with storage:) and validates the file', async () => {
    const f = path.join(sandbox, 'md.yaml');
    writeFileSync(f, 'apiVersion: sambanova.ai/v1alpha1\nkind: ModelDeployment\nmetadata:\n  name: md-edit\nspec:\n  storage:\n    x: y\n');
    ok(await run(['deploy', 'apply', '-f', f]));
    expect(applied().at(-1)).toContain('storage:');
    writeFileSync(f, 'kind: ModelBundle\nmetadata:\n  name: x\n');
    failed(await run(['deploy', 'apply', '-f', f]), /not a ModelDeployment/);
    failed(await run(['deploy', 'apply', '-f', '/no/file']), /File not found/);
  });
  it('list shows bundle- and model-based deployments with pod-based status (CRs have no status.phase)', async () => {
    const { inferencePodNames } = await import('../../app/utils/inference-pod-names');
    const n = inferencePodNames('a');
    writeFileSync(stateFile(), JSON.stringify({ ...readState(),
      pods: `NAME READY STATUS RESTARTS AGE\n${n.cache} 1/1 Running 0 5m\n${n.default} 2/2 Running 0 5m\n`,
      deployments: {
        a: { metadata: { name: 'a' }, spec: { bundle: 'bg' }, status: {} },
        b: { metadata: { name: 'b' }, spec: { models: { modelConfigs: [{ model: 'llama:a1' }] } }, status: {} },
      } }));
    const rows = JSON.parse(ok(await run(['deploy', 'list', '--json'])).out);
    expect(rows).toEqual([
      { name: 'a', bundle: 'bg', model: null, status: 'Deployed' },
      { name: 'b', bundle: null, model: 'Llama', status: 'Not Deployed' },
    ]);
    expect(ok(await run(['deploy', 'list'])).out).toMatch(/model:Llama\s+Not Deployed/);
  });
  it('status: exit 0 only when fully Deployed; shows pod states; surfaces kubectl failure', async () => {
    const pods = (c: string, d: string) => `NAME READY STATUS RESTARTS AGE\n${c}\n${d}\n`;
    writeFileSync(stateFile(), JSON.stringify({ pods: pods('md-x-cache-0 1/1 Running 0 5m', 'md-x-q-default-n-0 1/1 Running 0 5m') }));
    // pod names are hashed/derived by inferencePodNames — ask the helper for the real ones
    const { inferencePodNames } = await import('../../app/utils/inference-pod-names');
    const n = inferencePodNames('md-x');
    writeFileSync(stateFile(), JSON.stringify({ pods: pods(`${n.cache} 1/1 Running 0 5m`, `${n.default} 1/1 Running 0 5m`) }));
    expect(ok(await run(['deploy', 'status', 'md-x'])).out).toMatch(/^Deployed/);
    writeFileSync(stateFile(), JSON.stringify({ pods: pods(`${n.cache} 1/1 Running 0 5m`, `${n.default} 0/1 CrashLoopBackOff 3 5m`) }));
    const dep = await run(['deploy', 'status', 'md-x']);
    expect(dep.code).toBe(1);
    expect(dep.out).toMatch(/Deploying[\s\S]*CrashLoopBackOff/);
    writeFileSync(stateFile(), JSON.stringify({}));
    const none = await run(['deploy', 'status', 'md-x', '--json']);
    expect(none.code).toBe(1);
    expect(JSON.parse(none.out).status).toBe('Not Deployed');
    writeFileSync(stateFile(), JSON.stringify({ kubectlDown: true }));
    failed(await run(['deploy', 'status', 'md-x']), /get pods failed/);
    failed(await run(['deploy', 'status', 'Bad_Name']), /Invalid deployment name/);
  });
  it('logs: picks the right pod/container, validates flags, surfaces errors', async () => {
    ok(await run(['deploy', 'logs', 'md-x', '--tail', '7']));
    expect(calls().at(-1).args).toMatch(/logs \S+ -n ns1 -c inf --tail=7/);
    ok(await run(['deploy', 'logs', 'md-x', '--pod', 'cache']));
    expect(calls().at(-1).args).not.toContain('-c inf');
    failed(await run(['deploy', 'logs', 'md-x', '--pod', 'nope']), /--pod must be/);
    failed(await run(['deploy', 'logs', 'md-x', '--tail', '-1']), /positive integer/);
    failed(await run(['deploy', 'logs', 'md-x', '--tail', 'x']), /positive integer/);
    writeFileSync(stateFile(), JSON.stringify({ noLogs: true }));
    failed(await run(['deploy', 'logs', 'md-x']), /logs failed/);
  });
  it('delete needs --yes, removes, reports missing, rejects unsafe names', async () => {
    writeFileSync(stateFile(), JSON.stringify({ deployments: { d1: { metadata: { name: 'd1' } } } }));
    failed(await run(['deploy', 'delete', 'd1']), /without --yes/);
    ok(await run(['deploy', 'delete', 'd1', '--yes']));
    expect(readState().deployments.d1).toBeUndefined();
    failed(await run(['deploy', 'delete', 'd1', '--yes']), /NotFound|not found/);
    failed(await run(['deploy', 'delete', 'x y', '--yes']), /Invalid deployment name/);
  });
});

// ─── playground ──────────────────────────────────────────────────────────────

describe('playground (API)', () => {
  beforeEach(() => { resetSandbox(); apiHits.length = 0; });
  it('api-models lists routable models (human + json)', async () => {
    expect(ok(await run(['api-models'])).out).toBe('m1\nm2\n');
    expect(JSON.parse(ok(await run(['api-models', '--json'])).out)).toEqual(['m1', 'm2']);
  });
  it('chat: args, stdin, system prompt, think-stripping, token stats on stderr, --json', async () => {
    expect(ok(await run(['chat', 'm1', 'hello', 'world'])).out.trim()).toBe('reply:text:user');
    expect(ok(await run(['chat', 'm1'], { stdin: 'from stdin\n' })).out.trim()).toBe('reply:text:user');
    expect(ok(await run(['chat', 'm1', 'hi', '--system', 'be brief'])).out.trim()).toBe('reply:text:system');
    const r = ok(await run(['chat', 'm1', 'hi']));
    expect(r.err).toMatch(/t\/s/);
    expect(JSON.parse(ok(await run(['chat', 'm1', 'hi', '--json'])).out).choices).toHaveLength(1);
    expect(JSON.parse(apiHits.find((h) => h.url === '/v1/chat/completions')!.body).stream).toBe(false);
  });
  it('chat without any message fails instead of hanging', async () => {
    failed(await run(['chat', 'm1'], { stdin: '' }), /No message given/);
  });
  it('chat --image sends multimodal parts; rejects bad/missing images', async () => {
    const png = path.join(sandbox, 'i.png'); writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(ok(await run(['chat', 'm1', 'look', '--image', png])).out.trim()).toBe('reply:text,image_url:user');
    const sent = JSON.parse(apiHits.at(-1)!.body).messages.at(-1).content;
    expect(sent[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    failed(await run(['chat', 'm1', 'look', '--image', path.join(sandbox, 'x.bmp')]), /Unsupported image type/);
    failed(await run(['chat', 'm1', 'look', '--image', path.join(sandbox, 'missing.png')]), /Image not found/);
  });
  it('proactive: an oversized image is refused before it is read into the request', async () => {
    const big = path.join(sandbox, 'big.png'); writeFileSync(big, Buffer.alloc(21 * 1024 * 1024));
    failed(await run(['chat', 'm1', 'look', '--image', big]), /Image too large.*20 MB/);
    expect(apiHits.length).toBe(0);
  });
  it('maps API failures to clear errors and exit 1: 401, 404, 500, non-JSON, unreachable, unconfigured', async () => {
    failed(await run(['chat', 'boom', 'hi']), /API error 500: internal boom/);
    failed(await run(['chat', 'missing', 'hi']), /API error 404: model not found/);
    failed(await run(['chat', 'html', 'hi']), /./);
    writeConfig(); writeFileSync(path.join(sandbox, 'app-config.json'), JSON.stringify({ currentKubeconfig: 'lab', kubeconfigs: { lab: { file: 'kubeconfigs/lab.yaml', namespace: 'ns1', apiDomain: `http://127.0.0.1:${port}`, apiKey: 'wrong' } } }));
    failed(await run(['chat', 'm1', 'hi']), /401|rejected the API key/);
    failed(await run(['api-models']), /rejected the API key/);
    const short = await run(['chat', 'm1', 'hi']);
    expect(short.err).not.toContain('wrong'); // a short key is never echoed back, not even partly
    expect(short.err).toContain('••••');
    writeFileSync(path.join(sandbox, 'app-config.json'), JSON.stringify({ currentKubeconfig: 'lab', kubeconfigs: { lab: { file: 'kubeconfigs/lab.yaml', namespace: 'ns1', apiDomain: 'http://127.0.0.1:1', apiKey: 'good' } } }));
    failed(await run(['chat', 'm1', 'hi']), /Cannot reach the API/);
    writeFileSync(path.join(sandbox, 'app-config.json'), JSON.stringify({ currentKubeconfig: 'lab', kubeconfigs: { lab: { file: 'kubeconfigs/lab.yaml', namespace: 'ns1' } } }));
    failed(await run(['chat', 'm1', 'hi']), /apiDomain and apiKey must be configured/);
    failed(await run(['embed', 'm1', 'x']), /apiDomain and apiKey must be configured/);
  });
  it('embed prints the dimension and a preview', async () => {
    expect(ok(await run(['embed', 'm1', 'some', 'text'])).out).toContain('2-dimensional embedding: [0.25000000, 0.50000000]');
    expect(JSON.parse(ok(await run(['embed', 'm1', 'x', '--json'])).out).data).toHaveLength(1);
  });
  it('transcribe sends multipart audio; handles empty result, API errors, missing and oversized files', async () => {
    const wav = path.join(sandbox, 'a.wav'); writeFileSync(wav, 'RIFFxxxx');
    expect(ok(await run(['transcribe', 'whisper', wav, '--language', 'en'])).out.trim()).toBe('hello audio');
    expect(apiHits.at(-1)!.body).toContain('filename="a.wav"');
    expect(apiHits.at(-1)!.body).toContain('name="language"');
    expect(JSON.parse(ok(await run(['transcribe', 'whisper', wav, '--json'])).out)).toEqual({ text: 'hello audio' });
    failed(await run(['transcribe', 'empty', wav]), /No transcription returned/);
    failed(await run(['transcribe', 'bad', wav]), /API error 400/);
    failed(await run(['transcribe', 'whisper', path.join(sandbox, 'none.wav')]), /Audio file not found/);
    const big = path.join(sandbox, 'big.wav'); writeFileSync(big, Buffer.alloc(25 * 1024 * 1024 + 1));
    failed(await run(['transcribe', 'whisper', big]), /25 MB/);
  });
  it('speak writes a WAV; the explicit --model wins over ttsModel, which only fills in when no model is given', async () => {
    const out = path.join(sandbox, 'o.wav');
    ok(await run(['speak', 'hi', 'there', '--model', 'qwen', '--voice', 'serena', '--language', 'english', '-o', out]));
    const wav = readFileSync(out);
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(16000); // sample rate taken from the response header
    expect(JSON.parse(apiHits.at(-1)!.body)).toMatchObject({ model: 'qwen', voice: 'serena', input: 'hi there', language: 'english' });
    // no --model and no ttsModel anywhere -> clear error
    failed(await run(['speak', 'hi', '--voice', 'v', '-o', out]), /No TTS model/);
    // per-env ttsModel is the fallback ...
    ok(await run(['env', 'edit', 'lab', '--tts-model', 'env-tts']));
    ok(await run(['speak', 'hi', '--voice', 'v', '-o', out]));
    expect(JSON.parse(apiHits.at(-1)!.body).model).toBe('env-tts');
    // ... but never overrides an explicit --model
    ok(await run(['speak', 'hi', '--model', 'explicit', '--voice', 'v', '-o', out]));
    expect(JSON.parse(apiHits.at(-1)!.body).model).toBe('explicit');
    // global ttsModel is used when the env has none
    writeConfig({ ttsModel: 'global-tts' });
    ok(await run(['speak', 'hi', '--voice', 'v', '-o', out]));
    expect(JSON.parse(apiHits.at(-1)!.body).model).toBe('global-tts');
    writeConfig();
    failed(await run(['speak', 'errstream', '--model', 'errstream', '--voice', 'v', '-o', out]), /tts blew up/);
    failed(await run(['speak', 'silent', '--model', 'silent', '--voice', 'v', '-o', out]), /No audio returned/);
    failed(await run(['speak', 'hi', '--model', 'qwen', '-o', out]), /--voice/);
    failed(await run(['speak', 'hi', '--model', 'qwen', '--voice', 'v']), /--out/);
  });
});

// ─── install / doctor ────────────────────────────────────────────────────────

describe('install', () => {
  beforeEach(() => resetSandbox());
  it('apply --version builds the installer ConfigMap', async () => {
    ok(await run(['install', 'apply', '--chart-version', '0.5.48']));
    const stdin = calls().find((c) => c.args.startsWith('apply'))!.stdin;
    expect(stdin).toContain('sambastack-installer: "true"');
    expect(stdin).toContain('version: 0.5.48');
  });
  it('apply validates flags and rejects YAML-injection in --version', async () => {
    failed(await run(['install', 'apply']), /exactly one of/);
    failed(await run(['install', 'apply', '--chart-version', '1', '-f', 'x']), /exactly one of/);
    failed(await run(['install', 'apply', '--chart-version', '1\nmalicious: true']), /Invalid --chart-version/);
    failed(await run(['install', 'apply', '--chart-version', '1 2']), /Invalid --chart-version/);
    writeFileSync(stateFile(), JSON.stringify({ applyFail: true }));
    failed(await run(['install', 'apply', '--chart-version', '1.0']), /kubectl apply failed/);
  });
  it('apply -f passes a custom ConfigMap through', async () => {
    const f = path.join(sandbox, 'cm.yaml'); writeFileSync(f, 'kind: ConfigMap\nmetadata:\n  name: custom\n');
    ok(await run(['install', 'apply', '-f', f]));
    expect(calls().find((c) => c.args.startsWith('apply'))!.stdin).toContain('name: custom');
  });
  it('proactive: install apply -f only accepts the installer ConfigMap, not an arbitrary manifest', async () => {
    const f = path.join(sandbox, 'not-cm.yaml');
    writeFileSync(f, 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: oops\n');
    failed(await run(['install', 'apply', '-f', f]), /not a ConfigMap/);
    writeFileSync(f, 'key: [unclosed');
    failed(await run(['install', 'apply', '-f', f]), /Invalid YAML|not a ConfigMap/);
    failed(await run(['install', 'apply', '-f', path.join(sandbox, 'missing.yaml')]), /File not found/);
    expect(calls().some((c) => c.args.startsWith('apply'))).toBe(false);
  });
  it('--wait exits 0 once the installer log shows a completion marker (1.x and 2.x)', async () => {
    writeFileSync(stateFile(), JSON.stringify({ logs: 'step\nconfigure_default_ingress\n' }));
    expect(ok(await run(['install', 'apply', '--chart-version', '1.0', '--wait'])).out).toContain('installation complete');
    writeFileSync(stateFile(), JSON.stringify({ logs: 'create_keycloak_user: user already exists\nmore\n' }));
    expect(ok(await run(['install', 'apply', '--chart-version', '1.0', '--wait'])).out).toContain('installation complete');
  });
  it('logs: tail, follow until complete, and error when no installer pod', async () => {
    writeFileSync(stateFile(), JSON.stringify({ logs: 'hello\n' }));
    expect(ok(await run(['install', 'logs', '--tail', '5'])).out).toContain('hello');
    expect(calls().at(-1).args).toContain('--tail=5');
    failed(await run(['install', 'logs', '--tail', '0']), /positive integer/);
    writeFileSync(stateFile(), JSON.stringify({ logs: 'configure_default_ingress\n' }));
    ok(await run(['install', 'logs', '--follow']));
    writeFileSync(stateFile(), JSON.stringify({ noLogs: true }));
    failed(await run(['install', 'logs']), /logs failed/);
  });
});

describe('doctor', () => {
  beforeEach(() => { resetSandbox(); apiHits.length = 0; });
  it('passes when everything is reachable', async () => {
    const r = ok(await run(['doctor']));
    expect(r.out).toMatch(/ok\s+kubectl/);
    expect(r.out).toMatch(/ok\s+API reachable\s+2 model/);
    expect(JSON.parse(ok(await run(['doctor', '--json'])).out).every((c: any) => c.ok)).toBe(true);
  });
  it('exits 1 and names the failing checks: cluster down, missing namespace, bad key, outdated chart', async () => {
    writeFileSync(stateFile(), JSON.stringify({ kubectlDown: true }));
    const down = await run(['doctor']);
    expect(down.code).toBe(1);
    expect(down.out).toMatch(/FAIL\s+kubernetes connection/);
    writeFileSync(stateFile(), JSON.stringify({ noNamespace: true }));
    expect((await run(['doctor'])).out).toMatch(/FAIL\s+namespace ns1/);
    writeFileSync(stateFile(), JSON.stringify({ helmOutdated: true }));
    expect((await run(['doctor'])).out).toMatch(/FAIL\s+SambaStack chart version/);
    writeFileSync(stateFile(), JSON.stringify({}));
    writeConfig(); writeFileSync(path.join(sandbox, 'app-config.json'), JSON.stringify({ currentKubeconfig: 'lab', kubeconfigs: { lab: { file: 'kubeconfigs/lab.yaml', namespace: 'ns1', apiDomain: `http://127.0.0.1:${port}`, apiKey: 'wrong' } } }));
    const badKey = await run(['doctor']);
    expect(badKey.code).toBe(1);
    expect(badKey.out).toMatch(/FAIL\s+API reachable/);
  });
});

// ─── security / robustness ───────────────────────────────────────────────────

describe('shell-injection and path safety', () => {
  beforeEach(() => resetSandbox({ bundles: {}, deployments: {} }));
  it.each([
    [['bundle', 'show', '$(touch pwned)']],
    [['bundle', 'validate', 'a`touch pwned`', '--timeout', '1']],
    [['bundle', 'delete', 'a;touch pwned', '--yes']],
    [['deploy', 'status', 'a&&touch pwned']],
    [['deploy', 'logs', 'a|touch pwned']],
    [['deploy', 'delete', 'a$IFS', '--yes']],
    [['deploy', 'create', '--bundle', 'x;touch pwned']],
    [['bundle', 'list', '-n', 'x;touch pwned']],
    [['install', 'apply', '--chart-version', 'x;touch pwned']],
  ])('%j is rejected before reaching a shell', async (args) => {
    const r = await run(args as string[]);
    expect(r.code).toBe(1);
    expect(existsSync(path.join(sandbox, 'pwned'))).toBe(false);
    expect(calls().some((c) => c.args.includes('touch'))).toBe(false);
  });
});

// ─── interactive bundle builder (drives the real menus through a pseudo-terminal) ─────────────────

const PTY_DRIVER = `
import os, pty, re, select, sys, time, signal
ANSI = re.compile(r'\\x1b\\[[0-9;?]*[a-zA-Z]|\\x1b\\][^\\x07]*\\x07')
cwd, tsx, cli, scenario = sys.argv[1:5]
env = dict(os.environ, NO_COLOR='1', FAKE_STATE=cwd+'/state.json', FAKE_CALLS=cwd+'/calls.log', PATH=cwd+'/bin:'+os.environ['PATH'])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd); os.execvpe(tsx, ['tsx', cli], env)
buf = ''; allout = ''
def pump(t=0.3):
    global buf, allout
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try: d = os.read(fd, 65536).decode('utf8', 'replace')
            except OSError: return False
            if not d: return False
            d = ANSI.sub('', d); buf += d; allout += d
    return True
def expect(text, timeout=60):
    global buf
    end = time.time() + timeout
    while time.time() < end:
        if text in buf:
            buf = buf[buf.index(text) + len(text):]; return
        if not pump(0.2) and text not in buf: break
    raise TimeoutError('waiting for ' + repr(text) + '; tail: ' + allout[-800:])
def send(s, wait=0.4): os.write(fd, s.encode()); pump(wait)
def down(n=1):
    for _ in range(n): send('\\x1b[B', 0.25)
def build_to_name():
    down(1); send('\\r', 1.5); expect('Model Selection', 40); pump(0.5)
    down(1); send('\\r', 1.5); pump(1.5)                 # first model; its single profile is auto-selected
    expect('Override this profile', 20); send('\\r', 1.0)  # batching override? default No
    pump(1.0); send('\\r', 1.5)                          # Finish and Create Bundle
    expect('Advanced options', 20); send('\\r', 1.5)     # default No
    expect('Review the bundle and enter a name', 30)
def report(name, ok): print('RESULT ' + name + ' ' + ('PASS' if ok else 'FAIL'))
try:
    expect('Main Menu', 90); pump(1.0)
    if scenario == 'validated':
        build_to_name(); send('\\r', 1.5)
        expect('What next?', 30); send('\\r', 1.0)
        expect('Bundle Validation Succeeded', 60); pump(1.5)
        report('session_file_removed', not os.path.exists(cwd + '/temp/cli-selection-state.json'))
        expect('Main Menu', 30); pump(0.5); buf = ''
        down(1); send('\\r', 2.0); pump(1.5)
        report('no_restore_prompt', 'Restore this session?' not in buf)
    elif scenario == 'goback':
        build_to_name()
        for _ in range(12): send('\\x7f', 0.05)
        send('bad-x', 0.3); send('\\r', 1.5)
        expect('What next?', 30); send('\\r', 1.0)
        expect('What would you like to do?', 60); pump(0.5); buf = ''
        down(1); send('\\r', 2.0); pump(1.5)
        report('selections_kept', 'model(s) selected' in buf and '\\u2714 Llama' in buf)
    elif scenario == 'esc_name':
        build_to_name(); send('\\x1b', 2.0); pump(1.5)       # Esc at the bundle-name prompt
        report('esc_keeps_selection', 'model(s) selected' in buf and '\\u2714 Llama' in buf)
    elif scenario == 'remove_model':
        down(1); send('\\r', 1.5); expect('Model Selection', 40); pump(0.5)
        down(1); send('\\r', 1.5); pump(1.5)                  # add Llama
        expect('Override this profile', 20); send('\\r', 1.0); pump(1.5)
        down(1); send('\\r', 1.5); pump(1.0)                  # re-select Llama -> removes it
        report('removed_message', 'Removed Llama' in allout)
        send('\\x1b', 1.5); pump(1.5)                         # leave Model Selection
        expect('Main Menu', 30); pump(0.5); buf = ''
        down(1); send('\\r', 2.0); pump(1.5)                  # re-enter
        report('removed_model_not_restored', 'Restore this session?' not in buf)
    elif scenario == 'edited_name':
        down(1); send('\\r', 1.5); expect('start from', 40); pump(0.5)
        down(1); send('\\r', 1.5); expect('Select saved bundle', 20); send('\\r', 1.5)   # Load from saved_artifacts/ -> my-bundle.yaml
        expect('What next?', 30); down(1); send('\\r', 1.5)  # Edit in editor -> the fake editor renames the bundle to a shell payload
        expect('What next?', 30); send('\\r', 1.0)           # Apply -> the CLI polls / deletes using the edited name
        pump(8.0)
        report('no_command_injection', not os.path.exists(cwd + '/PWN'))
    elif scenario == 'save_clears':
        build_to_name(); send('\\r', 1.5)
        expect('What next?', 30); down(1); send('\\r', 1.5)             # Save to file
        expect('Filename', 20); send('\\r', 1.5); expect('Saved to', 20); pump(1.0)
        report('saved_file_exists', os.path.exists(cwd + '/saved_artifacts/my-bundle.yaml'))
        report('session_cleared_after_save', not os.path.exists(cwd + '/temp/cli-selection-state.json'))
    elif scenario == 'skip_clears':
        build_to_name(); send('\\r', 1.5)
        expect('What next?', 30); down(2); send('\\r', 1.5); expect('ModelBundle is ready', 20); pump(1.0)   # Skip
        report('session_cleared_after_skip', not os.path.exists(cwd + '/temp/cli-selection-state.json'))
    elif scenario == 'cancel_keeps':
        build_to_name(); send('\\r', 1.5)
        expect('What next?', 30); down(3); send('\\r', 1.5); pump(1.5)   # Cancel
        report('session_kept_after_cancel', os.path.exists(cwd + '/temp/cli-selection-state.json'))
    elif scenario == 'add_env_bad_name':
        send('\\r', 1.5); expect('Select environment:', 30); send('\\r', 1.5)        # Manage Environments -> Add new environment
        expect('Environment name', 20); send('../evil', 0.4); send('\\r', 1.5)
        expect('Invalid environment name', 20); pump(1.0)
        report('bad_name_refused', True)
        report('nothing_written_outside', not os.path.exists(os.path.dirname(cwd) + '/kubeconfig-evil.yaml') and not os.path.exists(cwd + '/kubeconfigs/kubeconfig-../evil.yaml'))
    elif scenario == 'add_env_bad_ns':
        open(cwd + '/k.yaml', 'w').write('apiVersion: v1\\nclusters: []\\n')
        send('\\r', 1.5); expect('Select environment:', 30); send('\\r', 1.5)
        expect('Environment name', 20); send('good-env', 0.4); send('\\r', 1.0)
        expect('Kubeconfig (base64 or file path)', 20); send(cwd + '/k.yaml', 0.4); send('\\r', 1.0)
        expect('Namespace', 20)
        for _ in range(10): send('\\x7f', 0.05)                                        # clear the pre-filled "default"
        send('a;touch\${IFS}PWN', 0.4); send('\\r', 1.5)
        expect('Please try again', 20); pump(1.0)
        send('\\x1b', 1.5); pump(1.0)                                                  # Esc abandons the add
        cfg = open(cwd + '/app-config.json').read()
        report('bad_namespace_refused', True)
        report('no_command_run', not os.path.exists(cwd + '/PWN'))
        report('env_not_added', 'good-env' not in cfg)
    elif scenario == 'advanced_no':
        down(1); send('\\r', 1.5); expect('Model Selection', 40); pump(0.5)
        down(1); send('\\r', 1.5); pump(1.5)
        expect('Override this profile', 20); send('\\r', 1.0); pump(1.0); send('\\r', 1.5)
        expect('Advanced options', 20); send('\\r', 1.5)
        expect('Review the bundle and enter a name', 30); pump(0.5)
        report('no_per_model_swappable_prompt', 'Swappable' not in allout)
        report('default_is_swappable', 'swappable: false' not in allout)
    elif scenario == 'advanced_yes':
        down(1); send('\\r', 1.5); expect('Model Selection', 40); pump(0.5)
        down(1); send('\\r', 1.5); pump(1.5)
        expect('Override this profile', 20); send('\\r', 1.0); pump(1.0); send('\\r', 1.5)
        expect('Advanced options', 20); send('y', 0.3); send('\\r', 1.5)
        expect('Keep resident', 20); down(1); send(' ', 0.3); send('\\r', 1.5)
        expect('Review the bundle and enter a name', 30); pump(0.5)
        report('non_swappable_emitted', 'swappable: false' in allout)
finally:
    try: os.kill(pid, signal.SIGKILL)
    except Exception: pass
`;

const HAS_PYTHON = spawnSync('python3', ['--version']).status === 0;
const describePty = HAS_PYTHON ? describe : describe.skip;

describePty('interactive bundle builder (pseudo-terminal)', () => {
  const STATE = {
    models: [{ metadata: { name: 'llama' }, spec: { name: 'Llama', metadata: { capabilities: [] }, checkpoints: { a1: { versions: { '1': { source: 'gs://b/x' } } } } } }],
    modelprofiles: [{ metadata: { name: 'p1' }, spec: { model_arch: 'a1', features: [], pefs: ['x:1'], batchingConfigs: { all: { '8k': { batch_sizes: [1, 2] } }, recommended: { '8k': { batch_sizes: [1] } } } } }],
  };
  const drive = (scenario: string): Promise<Record<string, string>> => new Promise((resolve, reject) => {
    writeFileSync(path.join(sandbox, 'pty_driver.py'), PTY_DRIVER);
    const p = spawn('python3', [path.join(sandbox, 'pty_driver.py'), sandbox, TSX, CLI, scenario]);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      const res: Record<string, string> = {};
      for (const m of out.matchAll(/RESULT (\S+) (PASS|FAIL)/g)) res[m[1]] = m[2];
      if (Object.keys(res).length === 0) return reject(new Error(`no result from pty driver\n${out}\n${err}`));
      resolve(res);
    });
  });
  beforeEach(() => { resetSandbox(STATE, { cache: false }); rmSync(path.join(sandbox, 'temp'), { recursive: true, force: true }); });

  jest.setTimeout(120_000);
  it('review #4: the saved session is deleted once a bundle validates, so the next visit offers no restore', async () => {
    expect(await drive('validated')).toEqual({ session_file_removed: 'PASS', no_restore_prompt: 'PASS' });
  });
  it('review #4: "Go back" after a failed validation returns to the model list with the selections still in place', async () => {
    expect(await drive('goback')).toEqual({ selections_kept: 'PASS' });
  });
  it('review #39.3: Esc at the bundle-name prompt keeps the selections', async () => {
    expect(await drive('esc_name')).toEqual({ esc_keeps_selection: 'PASS' });
  });
  it('review #39.5: removing a model updates the saved session, so it is not restored on the next visit', async () => {
    expect(await drive('remove_model')).toEqual({ removed_message: 'PASS', removed_model_not_restored: 'PASS' });
  });
  it('shell hardening: a bundle name edited in the editor is never interpreted by a shell', async () => {
    mkdirSync(path.join(sandbox, 'saved_artifacts'), { recursive: true });
    writeFileSync(path.join(sandbox, 'saved_artifacts/my-bundle.yaml'),
      'apiVersion: sambanova.ai/v1alpha1\nkind: ModelBundle\nmetadata:\n  name: my-bundle\nspec:\n  modelConfigs:\n    - model: llama:1\n      profile: p1\n');
    writeFileSync(path.join(sandbox, 'evil-editor.sh'), '#!/bin/sh\nsed -i.bak \'s/name: my-bundle/name: x;touch${IFS}PWN/\' "$1"\n');
    chmodSync(path.join(sandbox, 'evil-editor.sh'), 0o755);
    const prev = process.env.EDITOR;
    process.env.EDITOR = path.join(sandbox, 'evil-editor.sh');
    try { expect(await drive('edited_name')).toEqual({ no_command_injection: 'PASS' }); }
    finally { if (prev === undefined) delete process.env.EDITOR; else process.env.EDITOR = prev; }
    expect(existsSync(path.join(sandbox, 'PWN'))).toBe(false);
    rmSync(path.join(sandbox, 'saved_artifacts'), { recursive: true, force: true });
  });
  it('session: saving the bundle to a file clears the saved selection (it is on disk now)', async () => {
    rmSync(path.join(sandbox, 'saved_artifacts'), { recursive: true, force: true });
    expect(await drive('save_clears')).toEqual({ saved_file_exists: 'PASS', session_cleared_after_save: 'PASS' });
    rmSync(path.join(sandbox, 'saved_artifacts'), { recursive: true, force: true });
  });
  it('session: choosing Skip clears the saved selection', async () => {
    expect(await drive('skip_clears')).toEqual({ session_cleared_after_skip: 'PASS' });
  });
  it('session: Cancel keeps the saved selection so it can be resumed', async () => {
    expect(await drive('cancel_keeps')).toEqual({ session_kept_after_cancel: 'PASS' });
  });
  it('proactive: the add-environment menu refuses a path-traversal name and nothing is written outside kubeconfigs/', async () => {
    expect(await drive('add_env_bad_name')).toEqual({ bad_name_refused: 'PASS', nothing_written_outside: 'PASS' });
  });
  it('proactive: the add-environment menu refuses a shell-payload namespace (and does not run it or add the env)', async () => {
    expect(await drive('add_env_bad_ns')).toEqual({ bad_namespace_refused: 'PASS', no_command_run: 'PASS', env_not_added: 'PASS' });
  });
  it('review #7: no per-model Swappable prompt; models stay swappable by default', async () => {
    expect(await drive('advanced_no')).toEqual({ no_per_model_swappable_prompt: 'PASS', default_is_swappable: 'PASS' });
  });
  it('review #7: answering yes to the single "Advanced options" step marks the chosen model swappable: false', async () => {
    expect(await drive('advanced_yes')).toEqual({ non_swappable_emitted: 'PASS' });
  });
});
