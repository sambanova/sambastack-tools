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
![Version](https://img.shields.io/badge/version-1.5.3-412AA0?style=for-the-badge)
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
  - [Model Selection](#model-selection)
  - [Model Deployment](#model-deployment)
  - [Check Deployment Progress](#check-deployment-progress)
  - [Playground — Chat Console](#playground--chat-console)
  - [Install / Upgrade SambaStack](#install--upgrade-sambastack)
- [Configuration Reference](#configuration-reference)
- [npm Scripts](#npm-scripts)
- [Troubleshooting](#troubleshooting)

---

## Overview

The SambaWiz CLI is a fully interactive terminal application. It covers every workflow available in the web UI — environment management, bundle building, deployment, live monitoring, and model chat — all from the command line.

> **V3 bundles.** The CLI emits the V3 CR family: a single **`ModelBundle`** (replaces the old `BundleTemplate` + `Bundle` pair) and a **`ModelDeployment`** (replaces `BundleDeployment`) that references it by name. Model→PEF/SS/BS selection is gone — you now pick a **model → checkpoint arch (if multi-arch) → `ModelProfile`**, optionally add a **draft model** for speculative decoding, and optionally **override the profile's batching config**. Checkpoints are no longer authored by the builder; they come from the `Model` CR at reconcile time, so `checkpointsDir` is no longer used by the CLI.

```
 ____                  _        __        ___
/ ___|  __ _ _ __ ___ | |__   __\ \      / (_)____
\___ \ / _` | '_ ` _ \| '_ \ / _`\ \ /\ / /| |_  /
 ___) | (_| | | | | | | |_) | (_| |\ V  V / | |/ /
|____/ \__,_|_| |_| |_|_.__/ \__,_| \_/\_/  |_/___|

  SambaWiz CLI  v1.5.3
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
| `a` | Select all / deselect all *(multi-select menus only)* |
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
| Kubernetes cluster | SambaStack installed, Helm chart ≥ `1.1.1` |
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

A minimal starting point:

```json
{
  "currentKubeconfig": "",
  "kubeconfigs": {}
}
```

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

     🧱  Model Selection
       Create and validate bundles

     🚀  Model Deployment
       Deploy or delete bundles

     📈  Check Deployment Progress
       Live pod status monitor

     🤖  Playground (Chat Console)
       Chat with deployed models

     🔧  Install / Upgrade SambaStack
       Apply installer ConfigMap and stream logs

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

  [1/3]  checkpoint_mapping.json  ........  ✓  25 models    (1.2s)
  [2/3]  model_profiles.json      ........  ✓  18 profiles  (0.6s)
  [3/3]  pef_configs.json         ........  ✓  139 PEFs     (2.1s)
```

`checkpoint_mapping.json` (multi-arch `Model` CR cache), `model_profiles.json` (`ModelProfile` CR cache), and `pef_configs.json` (PEF SS/BS/version cache, still used to validate batch sizes) are all generated automatically so Model Selection is ready immediately.

---

#### ⚡ Activate an Environment

Sets an environment as active and regenerates `checkpoint_mapping.json`, `model_profiles.json`, and `pef_configs.json`.

```
  ✅ "my-env" is now the active environment.

  [1/3]  checkpoint_mapping.json  ........  ✓  25 models    (1.2s)
  [2/3]  model_profiles.json      ........  ✓  18 profiles  (0.6s)
  [3/3]  pef_configs.json         ........  ✓  139 PEFs     (2.1s)
```

If the kubeconfig file is missing:

```
  ❌ Kubeconfig file not found for "my-env": kubeconfigs/kubeconfig-my-env.yaml
```

---

#### 🔍 Validate an Environment

Runs a full connectivity and configuration check. If all checks pass, `checkpoint_mapping.json`, `model_profiles.json`, and `pef_configs.json` are regenerated.

```
  ╭──────────────────────────────────────────────────────────╮
  │ 🧭  Validate Setup & Environment                         │
  ╰──────────────────────────────────────────────────────────╯

  Environment    my-env
  Namespace      default
  ──────────────────────────────────────────────────────────

  ✔  Kubeconfig         kubeconfigs/kubeconfig-my-env.yaml
  ✔  Helm               v4.0.1+g12500dd
  ✔  SambaStack         1.1.2  (min: 1.1.1)
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

[Checkpoint] ✓ Generated checkpoint_mapping.json with 25 models (multi-arch)
[Model Profiles] ✓ Generated model_profiles.json with 18 profiles
[PEF Generator] ✓ Generated pef_configs.json with 139 entries
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
  ✖  SambaStack 1.0.9  (minimum: 1.1.1)
     The installed SambaStack Helm chart version (1.0.9) is older than
     the minimum required version (1.1.1). Please upgrade your SambaStack
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

  › Enable Updates (y/n)  Esc cancel: y

  ✅ Environment "my-env" updated.
```

Sub-menu stays open after saving so you can validate or continue editing.

> When the **namespace** changes for the active environment, `pef_configs.json` is regenerated automatically — PEFs are namespace-scoped.

> **Enable Updates** controls whether the SambaStack update banner is shown in the web UI for this environment. Defaults to `y`.

---

#### 🗑️ Delete an Environment

```
  › Delete environment "my-env"? [y/N]  Esc cancel:

  ✅ Environment "my-env" deleted.
```

> If the deleted environment was active, `currentKubeconfig` is automatically set to the next available environment. If none remain, it is set to `null`.

---

### 🧱 Model Selection

Guides you through selecting models, picking a `ModelProfile` for each (with an optional draft model for speculative decoding), optionally overriding the profile's batching config, previewing the `ModelBundle` YAML, and optionally applying it to the cluster.

> Requires `checkpoint_mapping.json` (the `Model` CR cache) and `model_profiles.json` (the `ModelProfile` CR cache). Both are generated automatically on startup and when you Add, Activate, or successfully Validate an environment. `pef_configs.json` is still generated alongside them but is no longer used for model/PEF selection.

#### Start — New or load saved

If saved bundle files exist in `saved_artifacts/`, you are asked how to start:

```
  › Model Selection — start from:

  ▶  🆕  Build new bundle
     📂  Load from saved_artifacts/
     ✕  Cancel
```

Only files containing `kind: ModelBundle` are listed (V3-only — no backwards compatibility with old `BundleTemplate`/`Bundle` files). Choosing **📂 Load** lets you pick a saved YAML file, preview it, then edit, save, or apply it directly — skipping the model-selection flow.

---

#### Step 1 — Select models

```
  › Model Selection  (0 added)

  ▶  ✅  Finish and Create Bundle

     DeepSeek-R1-0528
     DeepSeek-V3-0324
     Llama-4-Maverick-17B-128E-Instruct  (no matching profile)
     Meta-Llama-3.1-405B-Instruct
     Qwen3-32B
     ...

     ✕  Cancel
```

Models come from `checkpoint_mapping.json` (the `Model` CR cache). Select models one at a time, adding as many as needed; re-selecting an already-added model removes it (and its draft, if any) so you can redo the flow. A model with **no matching `ModelProfile` for any of its checkpoint archs** is labeled `(no matching profile)` and cannot be added. Select **✅ Finish and Create Bundle** when done.

---

#### Step 2 — Pick a checkpoint arch (multi-arch models only)

Shown only when a model has more than one checkpoint arch **with a matching `ModelProfile`**:

```
  › Select checkpoint arch for Llama-4-Maverick-17B-128E-Instruct:

  ▶  llama-4-maverick  (stable)
     llama-4-maverick-v2  (preview)
     ← Back
```

The chosen arch is pinned into the model reference (`<crname>:<arch>:<version>`); single-arch models skip this step entirely (`<crname>:<version>`).

---

#### Step 3 — Pick a `ModelProfile`

Profiles whose `model_arch` matches the chosen arch are listed. A model with only one matching profile **auto-selects it**:

```
  Auto-selected profile: High Interactivity
```

Otherwise, pick one — the card title is derived from `features` (`continuous_batching` → **High Throughput**, otherwise **High Interactivity**; numbered when more than one of the same type is offered for a model), never from the profile's `metadata.name`:

```
  › Select a profile for Meta-Llama-3.3-70B-Instruct:

  ▶  High Interactivity 1     4k:[1,4] 16k:[1]   Features: default
     High Interactivity 2     4k:[1] 16k:[1,2]   Features: default
     ← Back

  High Interactivity 1
    4k: batch_sizes=[1, 4]
    16k: batch_sizes=[1]
    Features: default
```

---

#### Step 4 — Override the batching config *(optional)*

Seeded from the profile's effective batching config (`spec.defaultBatchingConfig`, else `status.batchingConfig`):

```
  › Override this profile's batching config for the bundle? [y/N]  Esc cancel: n
```

Answering `y` prompts per tier — enter a comma-separated list or `*` for "all batch sizes the PEF/tier offers":

```
  › Batch sizes for tier 4k (comma-separated, or * for all)  Esc cancel: 1,4
```

The full `batchingConfig` — overridden or not — is always written into `ModelBundle.spec.modelConfigs[].batchingConfig` as an explicit record of the bundle's contents. `is_default` on the smallest tier is auto-derived (embedding models only — `Model.spec.metadata.capabilities` contains `"embeddings"`) and is never a user control.

---

#### Step 5 — Draft model for speculative decoding *(optional)*

Shown only when the selected profile's `pefs` contains a name with `sd` in it:

```
  ⚡ Meta-Llama-3.3-70B-Instruct's profile uses speculative-decoding PEFs.
     A smaller draft model can significantly improve throughput.

  › Draft model for Meta-Llama-3.3-70B-Instruct:

  ▶  ↩  Skip (no draft model)
     Meta-Llama-3.1-8B-Instruct
     ← Back
```

Choosing a draft repeats Steps 2–4 for the draft model (arch pick if multi-arch, profile pick, optional override). The draft is added to the bundle with `modelSettings: { routable: false }` and wired into `specDecodingPairs` (`{ target, draft }`, bare `Model` CR names — no `:version`/`:arch` suffix, and `experts` is always omitted so spec decoding applies to all of the target's experts).

---

#### Step 6 — Bundle summary & YAML preview

```
  ╭──────────────────────────────────────────────────────────╮
  │ 📋  Bundle Summary                                       │
  ╰──────────────────────────────────────────────────────────╯

  1.  Meta-Llama-3.1-8B-Instruct              High Interactivity  (draft)
  2.  Meta-Llama-3.3-70B-Instruct             High Interactivity

  ── YAML Preview  (my-bundle = placeholder) ─────────────────
  apiVersion: sambanova.ai/v1alpha1
  kind: ModelBundle
  metadata:
    name: my-bundle
  spec:
    modelConfigs:
    - model: meta-llama-3-1-8b-instruct:1
      profile: llama-3p1-8b
      modelSettings:
        routable: false
      batchingConfig: { ... }
    - model: meta-llama-3-3-70b-instruct:1
      profile: llama-3p1-70b-sd
      batchingConfig: { ... }
    specDecodingPairs:
    - draft: meta-llama-3-1-8b-instruct
      target: meta-llama-3-3-70b-instruct
  ────────────────────────────────────────────────────────────
```

The builder displays only the single `ModelBundle` document — no `checkpoints` block (checkpoints come from the `Model` CR) and no `secretNames` (carried by the referenced profiles).

---

#### Step 7 — Name the bundle (and optionally edit YAML)

```
  › Review the bundle and enter a name to continue, or press e to edit  Esc to previous menu: my-bundle
```

Unlike the old V2 flow, there is **no `b-`/`bt-` prefix convention** — the name you enter becomes `ModelBundle.metadata.name` directly.

**Hotkeys at this prompt:**

| Key | Action |
|---|---|
| `e` | Open YAML in `$EDITOR` (fallback: `vi`) — edited YAML is read back; bundle name is re-parsed from the saved file via the shared `ModelBundle` parser |
| `Esc` | Go back to Model Selection (all model selections preserved) |
| `Enter` | Confirm name and continue |

After confirming a name the final YAML is displayed before the action menu.

---

#### Step 8 — YAML actions

```
  ── Final YAML  (my-bundle) ──────────────────────────────────
  apiVersion: sambanova.ai/v1alpha1
  kind: ModelBundle
  metadata:
    name: my-bundle
  ...
  ────────────────────────────────────────────────────────────

  › What next?

  ▶  ✅  Apply to cluster to validate
     💾  Save to file
     ← Skip (deploy later)
     ✕  Cancel
```

| Option | Description |
|---|---|
| ✅ Apply to cluster to validate | Applies YAML via `kubectl apply` and polls for validation status |
| 💾 Save to file | Saves YAML to `saved_artifacts/<bundle-name>.yaml`; path is pre-populated and editable |
| ← Skip (deploy later) | Exits without applying; use **Model Deployment** later |
| ✕ Cancel | Exits without saving or applying |

> You can save to file and then apply in the same session — the menu loops until you choose Skip or Cancel.

---

#### Step 9 — Apply and validate

```
  ✔  Bundle applied — polling for validation status...

  kubectl apply output:
    modelbundle.sambanova.ai/my-bundle created

  ⠋  Pending  3s  Legalizing
  ⠸  Pending  9s  Legalizing
  ⠼  Running  12s  Legalized

  ✅ Bundle Validation Succeeded!
```

`kubectl apply` output is shown immediately after applying so you can confirm the resource name. Validation polls `ModelBundle.status.conditions` every 3 s (looking for `{ type: Valid, status: True }` = succeeded, `{ type: Valid, status: False }` = failed — the same status shape as the old V2 `Bundle`) with a braille spinner. Press `q` or `Esc` to stop watching — validation continues on the cluster.

---

#### Validation failure — recovery options

When validation fails, a recovery menu appears:

```
  Validation failed with the following errors:
  Validation Errors: Legalization failed, see legalizerInfo for details

  › What would you like to do?

  ▶  ✏️   Edit YAML in editor and re-apply
     ← Go back to Model Selection  (re-edit selections)
     🗑️   Delete my-bundle from cluster
     ← Back to main menu
```

| Option | Description |
|---|---|
| ✏️ Edit YAML | Opens editor, then re-applies the edited YAML |
| ← Go back to Model Selection | Deletes the failed `ModelBundle` from cluster and returns to model selection with all previous selections preserved |
| 🗑️ Delete from cluster | Removes the `ModelBundle` from the cluster |
| ← Back to main menu | Leaves the resource on cluster, returns to main menu |

---

### 🚀 Model Deployment

Deploy and delete bundle resources on the cluster.

Every visit shows the current deployment state:

```
  Current Deployments:
  ●  bd-deepseek-prod       Running
  ◌  bd-llama-staging
  ○  bd-qwen-test

  › Model Deployment:

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

  · deepseek-prod    ✔ valid
  · llama-staging    ⚠ unvalidated
  · qwen-test        ✔ valid
```

Validity is read from `ModelBundle.status.conditions` (`{ type: Valid, status: True }` = valid).

**2 — Select bundle to deploy**

```
  › Select bundle to deploy:

  ▶  ● deepseek-prod    validated
     ○ llama-staging    unvalidated
     ← Back
```

**3 — Review deployment YAML**

```
  Deployment YAML:
  ────────────────────────────────────────
  apiVersion: sambanova.ai/v1alpha1
  kind: ModelDeployment
  metadata:
    name: md-deepseek-prod
  spec:
    bundle: deepseek-prod
    groups:
    - minReplicas: 1
      name: default
  ────────────────────────────────────────
```

`spec.bundle` always references the `ModelBundle` **by name** — the CLI never generates the inline `spec.models` form (you can hand-edit the YAML for that). All other deployment knobs (`groups`, `owner`, `secretNames`, `engineConfig`, etc.) are unchanged from the old `BundleDeployment` builder.

**4 — Confirm and deploy**

```
  › Deploy md-deepseek-prod? [Y/n]  Esc cancel:

  ✔  Deployment md-deepseek-prod initiated

  › Monitor progress now? [Y/n]  Esc cancel:
```

Answering `y` jumps straight into the live monitor.

---

#### Deleting Resources

**1 — Select resource type**

```
  › What to delete?

  ▶  ModelDeployment
     ModelBundle
     ← Back
```

`ModelProfile`s and `Model`s are pre-existing cluster resources the builder only references by name — it never creates or deletes them, so they aren't offered here (compare to V2's `BundleTemplate`, which the builder did own and cascade-delete).

**2 — Select resources** (multi-select with `Space`)

```
  › Select ModelDeployment(s) to delete:
  Space toggle   Enter confirm   q / Esc to go back

   ❯  ◉  md-deepseek-prod
      ○  md-llama-staging
      ← Back
```

**3 — Confirm deletion**

```
  ⚠  The following will be permanently deleted:

  ·  md-deepseek-prod

  › Confirm deletion? This cannot be undone [y/N]  Esc cancel:

  ✔  Deleted md-deepseek-prod
```

> Deletion is permanent and immediate. There is no undo.

---

### 📈 Check Deployment Progress

Live monitor for a `ModelDeployment`. Polls every 5 s.

**1 — Select deployment**

```
  ℹ  Found 2 deployment(s)

  › Select deployment to monitor:

  ▶  ● md-deepseek-prod
     ● md-qwen-test
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

  ▶  ●  md-deepseek-prod
     ●  md-qwen-test
        ✏️  Enter model name manually
     ← Back
```

Only fully deployed bundles appear. If none are ready:

```
  ⚠ No fully deployed bundles ready.
  Current status:
  ◌  md-llama-staging   Deploying
  ○  md-qwen-test       Not Deployed

  › Model name manually (leave empty to go back)  Esc cancel:
```

**2 — Select model**

The CLI fetches the referenced `ModelBundle`, reads `spec.modelConfigs[].model` (`<crname>[:arch]:version` refs), and maps each crname back to its display name via `checkpoint_mapping.json`. If a bundle has multiple models:

```
  › Select model from md-deepseek-prod:

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

### 🔧 Install / Upgrade SambaStack

Applies a SambaStack installer `ConfigMap` to the cluster and streams the installer pod logs until completion.

**1 — Review and edit the ConfigMap YAML**

The CLI pre-populates the `version` field with the recommended next version (current installed version + 1 patch, clamped to the minimum required version from the `VERSION` file):

```
  ── Install ConfigMap (edit before applying) ─────────────────
  apiVersion: v1
  kind: ConfigMap
  metadata:
    name: sambastack
    labels:
      sambastack-installer: "true"
  data:
    sambastack.yaml: |
      version: 1.1.2                     # [CHANGE ME] Helm version to install
  ────────────────────────────────────────────────────────────

  › Edit in editor before applying? [y/N]
```

Answering `y` opens `$EDITOR` (fallback: `vi`) with the YAML. The updated file is read back after saving.

**2 — Apply**

```
  › Apply this YAML to cluster? [Y/n]

  ✔  Applying installation ConfigMap...
  ✔  Installation ConfigMap applied — streaming logs...
     Press q or Esc to stop watching logs
```

**3 — Stream installer logs**

Logs are fetched from `kubectl -n sambastack-installer logs -l sambanova.ai/app=sambastack-installer --tail=20` and refreshed every 3 s:

```
  [sambastack-installer] Pulling chart version 1.1.2...
  [sambastack-installer] Upgrading sambastack release...
  ...
  [sambastack-installer] configure_default_ingress complete
  ✅ SambaStack installation complete!
```

Installation is detected as complete when the log line contains `configure_default_ingress`. Press `q` or `Esc` at any time to stop watching — the installation continues in the background.

---

## Configuration Reference

### `app-config.json` top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `currentKubeconfig` | string | **Yes** | Name of the active environment |
| `kubeconfigs` | object | **Yes** | Map of environment name → config |

> **V3 note:** `checkpointsDir` and `checkpoint_overrides` are no longer read or written by the CLI. Checkpoints now come from the `Model` CR (`spec.checkpoints.<arch>.versions`), and the bundle always pins the **highest** checkpoint version under the chosen arch — there's no per-model override.

### Per-environment fields

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | string | **Yes** | Kubeconfig YAML path relative to project root. Saved as `kubeconfigs/kubeconfig-<name>.yaml` when added via CLI |
| `namespace` | string | **Yes** | Kubernetes namespace |
| `uiDomain` | string | No | SambaStack UI URL (checked during Validate) |
| `apiDomain` | string | Playground | API base URL e.g. `https://api.example.com/` |
| `apiKey` | string | Playground | Bearer token for API requests |
| `enableUpdates` | boolean | No | Show SambaStack update banner in the web UI. Defaults to `true`. Set to `false` to hide it for this environment. |

### Example

```json
{
  "currentKubeconfig": "my-env",
  "kubeconfigs": {
    "my-env": {
      "file": "kubeconfigs/kubeconfig-my-env.yaml",
      "namespace": "default",
      "uiDomain": "https://ui.my-env.example.com/",
      "apiDomain": "https://api.my-env.example.com/",
      "apiKey": "your-api-key-here",
      "enableUpdates": true
    }
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

Ensure you are on the correct network or VPN. The CLI times out kubectl calls after 15 s and falls back to cached data files if available.

---

**SambaStack version check skipped**

The CLI tries `helm list -A` first, then falls back to `helm list -n <namespace>`, `sambastack`, and `default` if RBAC denies cluster-wide list.

```bash
helm list -A --kubeconfig ./kubeconfigs/kubeconfig-my-env.yaml
```

---

**No models available in Model Selection**

`checkpoint_mapping.json` or `model_profiles.json` is missing or empty. Both files are regenerated on every startup when the cluster is reachable. To force a refresh: **Manage Environments** → select env → **🔍 Validate**. If all checks pass, both files (plus `pef_configs.json`) are regenerated automatically.

---

**"No matching profile" next to every model**

`model_profiles.json` is likely empty or stale — regenerate it via **Manage Environments** → select env → **🔍 Validate**, and confirm `kubectl get modelprofiles -n <namespace>` returns results (the join is on `ModelProfile.spec.model_arch` == `Model.spec.checkpoints.<arch>`).

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
kubectl get modelbundle.sambanova.ai <bundle-name> -n <namespace> -o yaml
```

Check `.status.conditions` for detailed error messages (`{ type: Valid, status, reason, message }`) and `.status.legalizerInfo` for utilization/errors.

---

<div align="center">

*SambaWiz CLI v1.5.3 · Requires SambaStack Helm ≥ 1.1.1*

← Back to [Web UI docs (README.md)](README.md)

</div>
