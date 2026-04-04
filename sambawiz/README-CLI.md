<div align="center">

<a href="https://sambanova.ai/">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/light-logo.png" height="80">
  <img alt="SambaNova logo" src="../images/dark-logo.png" height="80">
</picture>
</a>

# ⌨️ SambaWiz CLI

### Interactive terminal interface for SambaStack bundle management — no browser needed

![CLI](https://img.shields.io/badge/interface-CLI-6C3FC4?style=for-the-badge)
![Version](https://img.shields.io/badge/version-1.4.0-412AA0?style=for-the-badge)
![Node](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)

<br/>

[**Quick Start**](#quick-start) · [**Menus**](#menus) · [**Configuration**](#configuration-reference) · [**Troubleshooting**](#troubleshooting)

<br/>

← Back to [Web UI docs (README.md)](README.md)

</div>

---

## Contents

- [Overview](#overview)
- [Navigation](#navigation)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Menus](#menus)
  - [Main Menu](#main-menu)
  - [Manage Environments](#manage-environments)
    - [Add New Environment](#add-new-environment)
    - [Activate an Environment](#activate-an-environment)
    - [Validate an Environment](#validate-an-environment)
    - [Edit an Environment](#edit-an-environment)
    - [Delete an Environment](#delete-an-environment)
  - [Bundle Builder](#bundle-builder)
  - [Bundle Deployment](#bundle-deployment)
  - [Check Deployment Progress](#check-deployment-progress)
  - [Playground — Chat Console](#playground--chat-console)
- [Configuration Reference](#configuration-reference)
- [npm Scripts](#npm-scripts)
- [Troubleshooting](#troubleshooting)

---

## Overview

The SambaWiz CLI is a fully interactive terminal application. It covers every workflow available in the web UI — environment management, bundle building, deployment, live monitoring, and model chat — all from the command line.

```
 ____                  _        __        ___
/ ___|  __ _ _ __ ___ | |__   __\ \      / (_)____
\___ \ / _` | '_ ` _ \| '_ \ / _`\ \ /\ / /| |_  /
 ___) | (_| | | | | | | |_) | (_| |\ V  V / | |/ /
|____/ \__,_|_| |_| |_|_.__/ \__,_| \_/\_/  |_/___|

  SambaWiz CLI  v1.4.0
  SambaStack Bundle Management
```

---

## Navigation

### Menu navigation

| Key | Action |
|---|---|
| `↑` `↓` | Move cursor up / down |
| `Enter` | Select / confirm |
| `Space` | Toggle checkbox *(multi-select menus only)* |
| `q` or `Esc` | Go back / cancel |
| `Ctrl+C` | Force exit |

### Text input fields

| Key | Action |
|---|---|
| `←` `→` | Move cursor within text |
| `Backspace` | Delete character before cursor |
| `Ctrl+A` | Jump to start of line |
| `Ctrl+E` | Jump to end of line |
| `Home` / `End` | Jump to start / end of line |
| `Enter` | Confirm input |
| `Esc` | Cancel without saving |

> Default values are pre-populated and fully editable — use arrow keys to position, type to change.

---

## Prerequisites

| Requirement | Details |
|---|---|
| Node.js | 18+ |
| `kubectl` | Installed and on `PATH` |
| `helm` | Installed and on `PATH` |
| Kubernetes cluster | SambaStack installed, Helm chart ≥ `0.5.6` |
| `app-config.json` | Configured with at least one valid environment |

---

## Quick Start

### Step 1 — Install dependencies

```bash
cd sambawiz
npm install
```

### Step 2 — Create your config file

```bash
cp app-config.example.json app-config.json
```

Edit `app-config.json` with your `checkpointsDir` at minimum:

```json
{
  "checkpointsDir": "gs://your-bucket/path/to/checkpoints/",
  "currentKubeconfig": "",
  "kubeconfigs": {}
}
```

> `app-config.json` is gitignored. Never commit it — it contains cluster credentials.

### Step 3 — Launch the CLI

```bash
npm run dev-cli
```

Add your first environment from the **Manage Environments** menu. You can paste a base64-encoded kubeconfig directly — no manual file copying needed.

---

## Menus

### Main Menu

Shown after launch. The active environment name appears in brackets.

```
  › Main Menu  [my-env]
  ↑↓ navigate   Enter select   q / Esc to go back

  ▶  ⚙️   Manage Environments
       Add, activate, edit, delete and validate

     🧱  Bundle Builder
       Create and validate bundles

     🚀  Bundle Deployment
       Deploy or delete bundles

     📈  Check Deployment Progress
       Live pod status monitor

     🤖  Playground (Chat Console)
       Chat with deployed models

     ⏹️   Exit
```

---

### ⚙️ Manage Environments

All environment management is in one place. Select an environment to see available actions.

```
  ╭──────────────────────────────────────────────────────────╮
  │ ⚙️  Manage Environments                                  │
  ╰──────────────────────────────────────────────────────────╯

  › Select environment:

  ▶  ➕  Add new environment

     ○  staging-env
     ○  sambastack-dev-2
     ●  my-env  ← active

     ← Back
```

| Indicator | Meaning |
|---|---|
| `●  name  ← active` | Currently active environment |
| `○  name` | Configured but not active |
| `➕  Add new environment` | Create a new entry |

Selecting an existing environment opens its sub-menu:

```
  › my-env:

  ▶  ⚡  Activate       ← only shown when not active
     🔍  Validate
     ✏️   Edit
     🗑️   Delete
     ← Back
```

> After **Edit** or **Validate** the sub-menu stays open. **Activate**, **Delete**, and **Back** exit to the environment list.

---

#### ➕ Add New Environment

A 6-step guided flow. Press `Esc` at any step to cancel without saving.

```
  1/6  Environment name  Esc cancel: my-env

       Paste the base64-encoded kubeconfig or enter a file path.
       The file will be saved as kubeconfigs/kubeconfig-my-env.yaml

  2/6  Kubeconfig (base64 or file path)  Esc cancel: LS0tCmFwaVZlcnNpb...

  3/6  Namespace  Esc cancel: default

  4/6  UI Domain (optional)  Esc cancel: https://ui.my-env.example.com/

  5/6  API Domain (optional)  Esc cancel: https://api.my-env.example.com/

  6/6  API Key (optional)  Esc cancel: your-api-key-here
```

| Field | Required | Notes |
|---|---|---|
| Environment name | Yes | No spaces allowed. Must be unique. |
| Kubeconfig | Yes | Base64 string **or** file path. Saved as `kubeconfigs/kubeconfig-<name>.yaml` |
| Namespace | Yes | Defaults to `default` |
| UI Domain | No | SambaStack UI URL |
| API Domain | No | Required for Playground |
| API Key | No | Required for Playground |

**Kubeconfig auto-detection:**
- Contains `/`, `\`, `~`, or ends in `.yaml` → treated as a file path
- Otherwise → decoded as base64

On success:

```
  ✅ Environment "my-env" added and set as active.
  Kubeconfig        kubeconfigs/kubeconfig-my-env.yaml
  UI Domain         https://ui.my-env.example.com/
  API Domain        https://api.my-env.example.com/

  ✔  Checkpoint mapping generated
```

`checkpoint_mapping.json` is generated automatically from the cluster so Bundle Builder is ready immediately.

---

#### ⚡ Activate an Environment

Sets an environment as active and regenerates `checkpoint_mapping.json`.

```
  ✅ "my-env" is now the active environment.

  ✔  Checkpoint mapping generated
```

If the kubeconfig file is missing:

```
  ❌ Kubeconfig file not found for "my-env": kubeconfigs/kubeconfig-my-env.yaml
```

---

#### 🔍 Validate an Environment

Runs a full connectivity and configuration check. If all checks pass, `checkpoint_mapping.json` is also regenerated.

```
  ╭──────────────────────────────────────────────────────────╮
  │ 🧭  Validate Setup & Environment                         │
  ╰──────────────────────────────────────────────────────────╯

  Environment    my-env
  Namespace      default
  ──────────────────────────────────────────────────────────

  ✔  Kubeconfig         kubeconfigs/kubeconfig-my-env.yaml
  ✔  Helm               v4.0.1+g12500dd
  ✔  SambaStack         0.5.8  (min: 0.5.6)
  ✔  Kubernetes         connection OK
  ⚠  Namespace          using default

  API Domain     https://api.my-env.example.com/
  API Key        abcd••••••••1234

  ℹ  /v1/models not exposed on this cluster  (API key check will confirm auth)
  ✔  API key valid      (auth passed)

  UI Domain      https://ui.my-env.example.com/
  ✔  UI Domain reachable  (200)

  ──────────────────────────────────────────────────────────
  ✅ All checks passed!

  ✔  Checkpoint mapping generated
```

| Icon | Meaning |
|---|---|
| `✔` | Passed |
| `✖` | Failed (blocks overall pass) |
| `⚠` | Warning (non-blocking) |
| `ℹ` | Informational |

| Check | What is verified |
|---|---|
| Kubeconfig | File exists at configured path |
| Helm | `helm` binary found on `PATH` |
| SambaStack | Chart version via `helm list -A`; falls back per-namespace if RBAC denies `-A`; compared to `VERSION` file minimum |
| Kubernetes | `kubectl cluster-info` responds within 8 s |
| Namespace | Exists on cluster (skipped for `default`) |
| API `/v1/models` | 2xx = lists models; 404 = info (not an error); 401/403 = key invalid |
| API key | `POST /v1/chat/completions` auth check |
| UI Domain | Any HTTP response = reachable; connection failure = error |

If SambaStack chart is below the minimum:

```
  ✖  SambaStack 0.4.27  (minimum: 0.5.6)
     The installed SambaStack Helm chart version (0.4.27) is older than
     the minimum required version (0.5.6). Please upgrade your SambaStack
     installation.
```

---

#### ✏️ Edit an Environment

All fields are pre-populated with current values — use `←` `→` to navigate, type to change, `Enter` to keep.

```
  Editing: my-env  (Enter to keep current value)

  › Kubeconfig file  Esc cancel: kubeconfigs/kubeconfig-my-env.yaml

  › Namespace  Esc cancel: default

  › UI Domain  Esc cancel: https://ui.my-env.example.com/

  › API Domain  Esc cancel: https://api.my-env.example.com/

  › API Key  Esc cancel: your-api-key-here

  ✅ Environment "my-env" updated.
```

Sub-menu stays open after saving so you can validate or continue editing.

---

#### 🗑️ Delete an Environment

```
  › Delete environment "my-env"? [y/N]  Esc cancel:

  ✅ Environment "my-env" deleted.
```

> If the deleted environment was active, `currentKubeconfig` is automatically set to the next available environment. If none remain, it is set to `null`.

---

### 🧱 Bundle Builder

Guides you through selecting models, configuring PEF settings, previewing YAML, and optionally applying the bundle to the cluster.

> Requires `checkpoint_mapping.json`. This is generated automatically when you Add, Activate, or successfully Validate an environment.

#### Step 1 — Select models

```
  › Bundle Builder  (0 added)

  ▶  ✅  Finish and Create Bundle

     DeepSeek-R1-0528
     DeepSeek-V3-0324
     Llama-4-Maverick-17B-128E-Instruct
     Meta-Llama-3.1-405B-Instruct
     Qwen3-32B
     ...

     ✕  Cancel
```

Only models present in **both** `checkpoint_mapping.json` and `pef_mapping.json` are shown. Select models one at a time, adding as many as needed. Select **✅ Finish and Create Bundle** when done.

---

#### Step 2 — Select PEF configurations

Multi-select (`Space` to toggle):

```
  › Configurations for DeepSeek-R1-0528:
  Space toggle   Enter confirm   q / Esc to go back

      ○  SS: 128k  │ BS: 8   │ deepseek-ss131072-bs8
   ❯  ◉  SS: 16k   │ BS: 1   │ deepseek-ss16384-bs1
      ○  SS: 32k   │ BS: 4   │ deepseek-ss32768-bs4

      ✅  Done - Confirm Selection
      ✕  Back
```

| Column | Meaning |
|---|---|
| SS | Sequence size (context window) |
| BS | Batch size |
| PEF name | Processor Executable Format identifier |

```
  ✅ Added 2 config(s) for DeepSeek-R1-0528
```

---

#### Step 3 — Draft model for speculative decoding *(optional)*

Shown only when the selected model supports speculative decoding:

```
  ⚡ DeepSeek-R1-0528 supports speculative decoding.
     A smaller draft model can significantly improve throughput.
     Selected configs: SS:128k BS:8

  › Draft model for DeepSeek-R1-0528:

  ▶  ↩  Skip (no draft model)
     DeepSeek-R1
     Meta-Llama-3.1-8B-Instruct
     ← Back
```

If a matching draft is found, its configs are added automatically:

```
  ✅ Auto-added 1 draft config(s) for DeepSeek-R1
     Note: matched configs — SS:128k BS:8
```

---

#### Step 4 — Bundle summary & YAML preview

```
  ╭──────────────────────────────────────────────────────────╮
  │ 📋  Bundle Summary                                       │
  ╰──────────────────────────────────────────────────────────╯

  1.  DeepSeek-R1-0528                       SS:128k  BS:8
  2.  DeepSeek-R1                            SS:128k  BS:8

  YAML Preview  (BUNDLE_NAME = placeholder):
  ────────────────────────────────────────
  apiVersion: sambanova.ai/v1alpha1
  kind: BundleTemplate
  metadata:
    name: bt-BUNDLE_NAME
  ...
  ────────────────────────────────────────

  › Proceed with this bundle? [Y/n]  Esc cancel:
```

---

#### Step 5 — Name the bundle

```
  › Bundle name  Esc cancel: deepseek-prod
```

Resource names generated:
- `BundleTemplate` → `bt-deepseek-prod`
- `Bundle` → `b-deepseek-prod`

---

#### Step 6 — YAML actions

```
  › What next?

  ▶  ✏️   Edit in editor
     💾  Save to file
     ⏭️   Continue to deploy
     ✕  Cancel
```

| Option | Description |
|---|---|
| ✏️ Edit in editor | Opens `$EDITOR` (fallback: `vi`) — changes read back automatically |
| 💾 Save to file | Prompts for filename and writes YAML |
| ⏭️ Continue to deploy | Proceeds without saving |
| ✕ Cancel | Exits without applying |

---

#### Step 7 — Apply to cluster *(optional)*

```
  › Apply to cluster to validate? [Y/n]  Esc cancel:

  ✔  Applying bundle to cluster...
  ✔  Bundle applied — polling for validation status...

  ◉  Pending  ValidationInProgress: Checking PEF files  [9s]
  ◉  Ready    ValidationSucceeded: All checks passed    [21s]

  ✅ Bundle Validation Succeeded!
     Validated: ValidationSucceeded — All checks passed
```

On failure:

```
  ○  Failed   ValidationFailed: PEF not found  [18s]

  ❌ Bundle Validation Failed
     Validated: ValidationFailed — PEF file not found in storage
```

On timeout (90 s):

```
  ⚠ Validation timeout — check manually:
    kubectl get bundle.sambanova.ai b-deepseek-prod -n default -o yaml
```

---

### 🚀 Bundle Deployment

Deploy and delete bundle resources on the cluster.

Every visit shows the current deployment state:

```
  Current Deployments:
  ●  bd-deepseek-prod       Running
  ◌  bd-llama-staging
  ○  bd-qwen-test

  › Bundle Deployment:

  ▶  ▶  Deploy a Bundle
     ✕  Delete a Bundle / Deployment
     ← Back
```

| Icon | Meaning |
|---|---|
| `●` green | Running / Deployed |
| `◌` yellow | Pending |
| `○` red | Not running / failed |

---

#### Deploying a Bundle

**1 — Fetch and list bundles**

```
  ℹ  Found 3 bundle(s)

  · b-deepseek-prod    ✔ valid
  · b-llama-staging    ⚠ unvalidated
  · b-qwen-test        ✔ valid
```

**2 — Select bundle to deploy**

```
  › Select bundle to deploy:

  ▶  ● b-deepseek-prod    validated
     ○ b-llama-staging    unvalidated
     ← Back
```

**3 — Review deployment YAML**

```
  Deployment YAML:
  ────────────────────────────────────────
  apiVersion: sambanova.ai/v1alpha1
  kind: BundleDeployment
  metadata:
    name: bd-deepseek-prod
  spec:
    bundle: b-deepseek-prod
    groups:
    - minReplicas: 1
      name: default
  ────────────────────────────────────────
```

**4 — Confirm and deploy**

```
  › Deploy bd-deepseek-prod? [Y/n]  Esc cancel:

  ✔  Deployment bd-deepseek-prod initiated

  › Monitor progress now? [Y/n]  Esc cancel:
```

Answering `y` jumps straight into the live monitor.

---

#### Deleting Resources

**1 — Select resource type**

```
  › What to delete?

  ▶  BundleDeployment
     Bundle
     BundleTemplate
     ← Back
```

**2 — Select resources** (multi-select with `Space`)

```
  › Select BundleDeployment(s) to delete:
  Space toggle   Enter confirm   q / Esc to go back

   ❯  ◉  bd-deepseek-prod
      ○  bd-llama-staging
      ← Back
```

**3 — Confirm deletion**

```
  ⚠  The following will be permanently deleted:

  ·  bd-deepseek-prod

  › Confirm deletion? This cannot be undone [y/N]  Esc cancel:

  ✔  Deleted bd-deepseek-prod
```

> Deletion is permanent and immediate. There is no undo.

---

### 📈 Check Deployment Progress

Live monitor for a `BundleDeployment`. Polls every 5 s.

**1 — Select deployment**

```
  ℹ  Found 2 deployment(s)

  › Select deployment to monitor:

  ▶  ● bd-deepseek-prod
     ● bd-qwen-test
     ← Back
```

**2 — Live status**

```
  ╭──────────────────────────────────────────────────────────╮
  │ 📈  Monitoring: bd-deepseek-prod                         │
  ╰──────────────────────────────────────────────────────────╯
  Press q or Esc to stop monitoring

  ◌  Deploying    elapsed: 35s
  ────────────────────────────────────────
  Cache pod         … 0/1   Pending    age: 35s
  Inference pod     ⏳ waiting for pod...

  Refreshing every 5s...  (q / Esc to stop)
```

When fully ready:

```
  ●  Deployed    elapsed: 3m 0s
  ────────────────────────────────────────
  Cache pod         ✔ 1/1   Running    age: 3m
  Inference pod     ✔ 1/1   Running    age: 3m

  ✅  Deployment is fully ready!
```

| Status | Meaning |
|---|---|
| `● Deployed` | Both cache and inference pods ready |
| `◌ Deploying` | Pods exist but not all ready |
| `○ Not Deployed` | No matching pods found |

Press `q` or `Esc` to stop and return to menu.

---

### 🤖 Playground — Chat Console

Interactive chat with a deployed model.

**1 — Select bundle**

```
  ℹ  Found 2 deployment(s)

  › Select deployed bundle to chat with:

  ▶  ●  bd-deepseek-prod
     ●  bd-qwen-test
        ✏️  Enter model name manually
     ← Back
```

Only fully deployed bundles appear. If none are ready:

```
  ⚠ No fully deployed bundles ready.
  Current status:
  ◌  bd-llama-staging   Deploying
  ○  bd-qwen-test       Not Deployed

  › Model name manually (leave empty to go back)  Esc cancel:
```

**2 — Select model**

If a bundle has multiple models:

```
  › Select model from bd-deepseek-prod:

  ▶  DeepSeek-R1
     DeepSeek-R1-0528
     ← Back
```

Single-model bundles are selected automatically:

```
  ●  Using model: DeepSeek-R1-0528
```

**3 — Chat session**

```
  ╭────────────────────────────────────────────────────────────╮
  │ 🤖  Chatting with DeepSeek-R1-0528                         │
  │ q / Esc  or type 'exit' to return to menu                  │
  ╰────────────────────────────────────────────────────────────╯

  › You  Esc cancel: Explain quantum entanglement simply.

  ◌  Thinking...

  ◈  Assistant  14:32   ·   279.84 t/s   ·   5.39s total   ·   0.53s to first token
  ──────────────────────────────────────────────────────────────
  Quantum entanglement is when two particles become linked
  so that measuring one instantly affects the other...
  ──────────────────────────────────────────────────────────────

  › You  Esc cancel:
```

| Feature | Detail |
|---|---|
| Multi-turn history | Full conversation context sent with every message |
| `<think>` stripping | DeepSeek-R1 chain-of-thought blocks removed from output |
| Performance metrics | Tokens/sec · total duration · time to first token |
| Timestamp | Local time shown per response |
| Error handling | HTTP errors shown inline with suggested fixes |

**To exit:** type `exit`, `quit`, `q`, or `/back` — or press `Esc`.

---

## Configuration Reference

### `app-config.json` top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `checkpointsDir` | string | **Yes** | GCS path prefix. Must end with `/` |
| `currentKubeconfig` | string | **Yes** | Name of the active environment |
| `kubeconfigs` | object | **Yes** | Map of environment name → config |
| `checkpoint_overrides` | object | No | Override checkpoint version per model e.g. `{ "Model-Name": "1" }` |

### Per-environment fields

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | string | **Yes** | Kubeconfig YAML path relative to project root. Saved as `kubeconfigs/kubeconfig-<name>.yaml` when added via CLI |
| `namespace` | string | **Yes** | Kubernetes namespace |
| `uiDomain` | string | No | SambaStack UI URL (checked during Validate) |
| `apiDomain` | string | Playground | API base URL e.g. `https://api.example.com/` |
| `apiKey` | string | Playground | Bearer token for API requests |

### Example

```json
{
  "checkpointsDir": "gs://your-bucket/checkpoints/",
  "currentKubeconfig": "my-env",
  "kubeconfigs": {
    "my-env": {
      "file": "kubeconfigs/kubeconfig-my-env.yaml",
      "namespace": "default",
      "uiDomain": "https://ui.my-env.example.com/",
      "apiDomain": "https://api.my-env.example.com/",
      "apiKey": "your-api-key-here"
    }
  },
  "checkpoint_overrides": {
    "Llama-4-Maverick-17B-128E-Instruct": "1"
  }
}
```

---

## npm Scripts

| Script | Description |
|---|---|
| `npm run dev-cli` | **Run the CLI** (TypeScript, no compile step needed) |
| `npm run cli:watch` | Run CLI with auto-restart on file changes |
| `npm run cli:type-check` | Type-check CLI without running |
| `npm run cli:lint` | Lint the CLI source file |

---

## Troubleshooting

**`app-config.json` not found**

```bash
cp app-config.example.json app-config.json
```

---

**Kubeconfig file not found**

Paths are relative to the project root. When added via CLI the file is at `kubeconfigs/kubeconfig-<name>.yaml`.

```bash
ls -la kubeconfigs/
```

---

**Kubernetes connection fails / times out**

```bash
kubectl get nodes --kubeconfig ./kubeconfigs/kubeconfig-my-env.yaml
kubectl version --client
helm version
```

Ensure you are on the correct network or VPN.

---

**SambaStack version check skipped**

The CLI tries `helm list -A` first, then falls back to `helm list -n <namespace>`, `sambastack`, and `default` if RBAC denies cluster-wide list.

```bash
helm list -A --kubeconfig ./kubeconfigs/kubeconfig-my-env.yaml
```

---

**No models available in Bundle Builder**

`checkpoint_mapping.json` is missing or empty. Go to **Manage Environments** → select env → **🔍 Validate**. If all checks pass the file is regenerated automatically.

---

**Playground API errors**

| HTTP code | Cause |
|---|---|
| 401 / 403 | `apiKey` invalid or expired — update via Edit in Manage Environments |
| 404 | `apiDomain` URL wrong or model not deployed |
| Connection error | `apiDomain` unreachable — check network / VPN |

---

**Bundle validation timeout**

```bash
kubectl get bundle.sambanova.ai <bundle-name> -n <namespace> -o yaml
```

Check `.status.conditions` for detailed error messages.

---

**`checkpointsDir` path error during deployment**

If cache pod logs show `[CRITICAL] Failed to access source storage`:
- Confirm `checkpointsDir` in `app-config.json` ends with `/`
- Confirm the GCS path is accessible from the cluster

---

<div align="center">

*SambaWiz CLI v1.4.0 · Requires SambaStack Helm ≥ 0.5.6*

← Back to [Web UI docs (README.md)](README.md)

</div>
