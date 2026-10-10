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
![Version](https://img.shields.io/badge/version-2.0.0-412AA0?style=for-the-badge)
![Node](https://img.shields.io/badge/Node.js-20.12+-339933?style=for-the-badge&logo=node.js&logoColor=white)
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

  SambaWiz CLI  v2.0.0
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
| Node.js | 20.12+ (the web app needs ≥ 20.9; `@inquirer/prompts` needs ≥ 20.12) |
| `kubectl` | Installed and on `PATH` |
| `helm` | Installed and on `PATH` |
| Kubernetes cluster | SambaStack installed, Helm chart ≥ `2.0.0` (the minimum in the `VERSION` file) |
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

**Gating (same rules as the UI):**
- Model Selection, Model Deployment, Check Deployment Progress, Playground and Install need a valid environment (kubeconfig file present). Without one you get *"No valid environment selected — add or activate one in Manage Environments first."* — the CLI never falls back to your ambient `kubectl` context.
- If the installed SambaStack Helm chart is older than the minimum in `VERSION`, Model Selection, Model Deployment, Check Deployment Progress and Playground are blocked with the outdated-chart message (Install stays available so you can fix it). The check is refreshed after you change environment or run Install.


---

### ⚙️ Manage Environments

All environment management is in one place. Select an environment to see available actions.

```
  ╭──────────────────────────────────────────────────────────╮
  │ ⚙️  Manage Environments                                  │
  ╰──────────────────────────────────────────────────────────╯

  › Select environment:

  ▶  ➕  Add new environment

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
  ✔  SambaStack         2.1.1  (min: 2.0.0)
  ✔  Kubernetes         connection OK
  ⚠  Namespace          using default

  API Domain     https://api.my-env.example.com/
  API Key        abcd••••••••1234

  ℹ  /v1/models not exposed on this cluster  (API key check will confirm auth)
  ✔  API key valid      (auth passed)

  UI Domain      https://ui.my-env.example.com/
  ✔  UI Domain reachable  (200)

  ──────────────────────────────────────────────────────────
  ✅ All checks passed!        (or: "All checks passed, with 1 warning (see ⚠ above)")

[Checkpoint] ✓ Generated checkpoint_mapping.json with 25 models (multi-arch)
[Model Profiles] ✓ Generated model_profiles.json with 18 profiles
[PEF Generator] ✓ Generated pef_configs.json with 139 entries
```

| Icon | Meaning |
|---|---|
| `✔` | Passed |
| `✖` | Failed (blocks overall pass) |
| `⚠` | Warning (non-blocking, but counted in the final banner: *"All checks passed, with N warning(s)"*) |
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
  ✖  SambaStack 1.9.0  (minimum: 2.0.0)
     The installed SambaStack Helm chart version (1.9.0) is older than
     the minimum required version (2.0.0). Please upgrade your SambaStack
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

An in-progress selection is also remembered in `temp/cli-selection-state.json` (CLI-only — the web UI keeps its own file, since the two use different formats) and offered back the next time you open Model Selection. It shows the cluster it was started on so you can check the environment before applying. The saved selection is deleted once a bundle **validates successfully**, or when you **save it to a file** or choose **Skip** at the *What next?* step, so it isn't offered again on your next visit. It is kept if the validation fails or you Cancel.

---

#### Step 1 — Select models

```
  › Model Selection  (0 added)

  ▶  ✅  Finish and Create Bundle

     DeepSeek-R1-0528
     DeepSeek-V3-0324
     Llama-4-Maverick-17B-128E-Instruct
     Meta-Llama-3.1-405B-Instruct
     Qwen3-32B
     ...

     ✕  Cancel
```

The model list comes from `checkpoint_mapping.json` (the `Model` CR cache), so it shows whatever models your cluster has. Select models one at a time, adding as many as needed; re-selecting an already-added model removes it (and its draft, if any) so you can redo the flow. A model with **no matching `ModelProfile` for any of its checkpoint archs** gets a `(no matching profile)` suffix and cannot be added. Select **✅ Finish and Create Bundle** when done.

---

#### Step 2 — Pick a checkpoint arch (multi-arch models only)

Most models have a single checkpoint arch and skip this step (for example **DeepSeek-R1-0528** goes straight to Step 3). It appears only when a model has more than one checkpoint arch **with a matching `ModelProfile`**, and then lists the arch names and checkpoint status your cluster reports for that model:

```
  › Select checkpoint arch for <model>:

  ▶  <arch-1>  (<checkpoint status>)
     <arch-2>  (<checkpoint status>)
     ← Back
```

The chosen arch is pinned into the model reference (`<crname>:<arch>:<version>`); single-arch models skip this step entirely (`<crname>:<version>`).

---

#### Step 3 — Pick a `ModelProfile`

Profiles whose `model_arch` matches the chosen arch are listed. A model with only one matching profile **auto-selects it**:

```
  Auto-selected profile: High Interactivity
```

Otherwise, pick one — the card title is derived from `features` (`continuous_batching` → **High Throughput**, otherwise **High Interactivity**; numbered when more than one of the same type is offered for a model), never from the profile's `metadata.name`. Each entry shows its context-length → batch-size map and features:

```
  › Model Selection  (0 added): DeepSeek-R1-0528

  › Select a profile for DeepSeek-R1-0528:
  ↑↓ navigate   Enter select   q / Esc to go back

 ▶  High Interactivity  128k:[1] 16k:[1] 32k:[1] 4k:[1,4] 8k:[1,4]   Features: default
    High Throughput  16k:[128] 32k:[64] 8k:[256]   Features: continuous_batching
    ← Back
```

After you choose, the profile card is printed:

```
  High Interactivity
    128k: batch_sizes=[1]
    16k: batch_sizes=[1]
    32k: batch_sizes=[1]
    4k: batch_sizes=[1, 4]
    8k: batch_sizes=[1, 4]
    Features: default
```

---

#### Step 4 — Override the batching config *(optional)*

Seeded from the profile's effective batching config (`recommended`, else `all`, else the resolved default):

```
  › Override this profile's batching config for the bundle? [y/N]  Esc cancel: y
```

Answering `y` opens **one grid for every context length** (same layout as the UI): a row per context length, a column per batch size. Every size the profile supports (its full `all` set) is selectable; only the recommended ones start checked. Cells a context length doesn't support show as `·` and can't be toggled.

```
  › Batching config  (context length × batch size)
  ↑↓←→ move   Space toggle   r row   c column   a all   Enter confirm   Esc cancel

  context        1    4
  128k           ◉    ·
  32k            ◉    ·
  16k            ◉    ·
  8k             ◉    ◉
  4k             ◉    ○
```

| Key | Action |
|---|---|
| `↑ ↓ ← →` | Move the highlighted cell |
| `Space` | Toggle the cell |
| `r` / `c` / `a` | Toggle the whole row / column / everything |
| `Enter` | Confirm |
| `Esc` / `q` | Cancel — keeps the profile's own batching config |

A context length with **every** supported size checked is written as `'*'` ("all sizes the profile offers"); otherwise the explicit list. If you uncheck every size of a model, that model can't be deployed and is **left out of the bundle** — a warning lists it (same wording as the UI) when the YAML preview is generated. `is_default` on the smallest tier is auto-derived (embedding models only) and is never a user control.

---

#### Step 5 — Draft model for speculative decoding *(optional)*

> Prompt caching is single-model only: while a prompt-caching profile is selected you can't add another model, and prompt-caching profiles are hidden once a model is already selected.

Shown only when the selected profile's `pefs` contains a name with `sd` in it:

```
  ⚡ Meta-Llama-3.3-70B-Instruct's profile uses speculative-decoding PEFs.
     A smaller draft model can significantly improve throughput.

  › Draft model for Meta-Llama-3.3-70B-Instruct:

  ▶  ↩  Skip (no draft model)
     Meta-Llama-3.1-8B-Instruct
     ← Back
```

Only models that have a matching profile are offered as drafts. Re-selecting a draft model removes it again (no duplicate entries). Choosing a draft repeats Steps 2–4 for the draft model (arch pick if multi-arch, profile pick, optional override). The draft is added to the bundle with `modelSettings: { routable: false }` and wired into `specDecodingPairs` (`{ target, draft }`, bare `Model` CR names — no `:version`/`:arch` suffix, and `experts` is always omitted so spec decoding applies to all of the target's experts).

When you select **✅ Finish and Create Bundle**, one last question covers the whole bundle:

```
  › Advanced options — keep some models resident in HBM (non-swappable)? [y/N]
```

The default (`N`) leaves every model swappable, so most bundles need no extra prompts. Answering `y` opens a multi-select of the bundle's models (drafts are tagged); the ones you tick are written with `modelSettings.swappable: false`.

---

#### Step 6 — Bundle summary & YAML preview

```
  ╭──────────────────────────────────────────────────────────╮
  │ 📋  Bundle Summary                                       │
  ╰──────────────────────────────────────────────────────────╯

  1.  DeepSeek-R1-0528                        High Interactivity

  ── YAML Preview  (my-bundle = placeholder) ─────────────────
  apiVersion: sambanova.ai/v1alpha1
  kind: ModelBundle
  metadata:
    name: my-bundle
  spec:
    modelConfigs:
      - model: deepseek-r1-0528:2
        profile: deepseek
        batchingConfig:
          128k:
            batch_sizes: '*'
          32k:
            batch_sizes: '*'
          16k:
            batch_sizes: '*'
          8k:
            batch_sizes: [1]
          4k:
            batch_sizes: [1]
  ────────────────────────────────────────────────────────────
```

With a draft model (Step 5) the preview also contains the draft's entry (with `modelSettings: { routable: false }`) and a `specDecodingPairs` list. If any model was dropped (see Step 4) a yellow warning appears above the preview. `checkpoint_overrides` from `app-config.json` pin checkpoint versions here, exactly as in the UI. The builder displays only the single `ModelBundle` document — no `checkpoints` block (checkpoints come from the `Model` CR) and no `secretNames` (carried by the referenced profiles).

---

#### Step 7 — Name the bundle (and optionally edit YAML)

```
  › Review the bundle and enter a name to continue, or press e to edit  Esc to previous menu: my-bundle
```

Unlike the old V2 flow, there is **no `b-`/`bt-` prefix convention** — the name you enter becomes `ModelBundle.metadata.name` directly.

**Name rules (same as the UI):** a lowercase RFC 1123 name — letters, digits, `-` and `.`, up to 253 characters. Names over 36 characters (once prefixed `md-`) trigger a warning that pod names will be truncated and hashed.

**Hotkeys at this prompt:**

| Key | Action |
|---|---|
| `e` / `E` | Open YAML in `$EDITOR` (fallback: `vi`) — edited YAML is read back; bundle name is re-parsed from the saved file via the shared `ModelBundle` parser |
| `Esc` | Go back to Model Selection (all model selections preserved) |
| `Enter` | Confirm name and continue |

The `e` hotkey only works while the pre-filled name is untouched. You can always edit later: **✏️ Edit in editor** is also in the *What next?* menu below.

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
     ✏️   Edit in editor
     💾  Save to file
     ← Skip (deploy later)
     ✕  Cancel
```

| Option | Description |
|---|---|
| ✅ Apply to cluster to validate | Applies YAML via `kubectl apply` and polls for validation status |
| ✏️ Edit in editor | Opens the final YAML in `$EDITOR`; the edited text is what gets applied |
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

  Memory utilization
    DDR            ██████░░░░░░░░░░░░░░  31%
    HBM resident   ████░░░░░░░░░░░░░░░░  22%
    Host           ███░░░░░░░░░░░░░░░░░  15%
```

Memory utilization (from `status.legalizerInfo.utilization`) is shown whether validation succeeds or fails; values above 80% are red.

`kubectl apply` output is shown immediately after applying so you can confirm the resource name. Validation polls `ModelBundle.status.conditions` every 3 s (looking for `{ type: Valid, status: True }` = succeeded, `{ type: Valid, status: False }` = failed — the same status shape as the old V2 `Bundle`) with a braille spinner. Press `q` or `Esc` to stop watching — validation continues on the cluster.

---

#### Validation failure — recovery options

When validation fails, the error text is the cluster's **legalizer errors** (`status.legalizerInfo.errors`) when present — the actionable part, same as the UI — otherwise the condition message. Then a recovery menu appears:

```
  Validation failed with the following errors:
  <legalizer errors, one per line>

  › What would you like to do?

  ▶  ✏️   Edit YAML in editor and re-apply
     ← Go back to Model Selection  (re-edit selections)
     🗑️   Delete my-bundle from cluster
     ← Back to main menu
```

| Option | Description |
|---|---|
| ✏️ Edit YAML | Opens editor, then re-applies the edited YAML |
| ← Go back to Model Selection | Deletes the failed `ModelBundle` from cluster and returns to the model list **with your selections still in place** (shown as `✔`) so you can adjust them |
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

Only **validated** bundles (`{ type: Valid, status: True }`) can be deployed, as in the UI. Unvalidated ones are hidden and counted:

```
  ℹ  Found 3 bundle(s)
  ⚠  1 unvalidated bundle(s) hidden — validate them first (Bundle Builder).
```

**2 — Select bundle to deploy**

```
  › Select bundle to deploy:

  ▶  ● deepseek-prod    validated
     ● qwen-test        validated
     ← Back
```

**3 — Options**

```
  › Enable prompt caching? [y/N]          (only for a single-model bundle whose profile has `prompt_caching`)
  › Ignore EOS token (benchmarking only)? [y/N]
  › Deployment name  md-deepseek-prod
```

Prompt caching adds `ENABLE_KV_CACHE_MANAGER` and `KV_CACHE_INCLUDE_STATS_IN_RESPONSE`; Ignore EOS adds `ENABLE_IGNORE_EOS` (all `"true"` under `engineConfig.env_vars`) — the same variables the UI injects. The name defaults like the UI (`b-foo` → `md-foo`, otherwise `md-<bundle>`) and must be a valid RFC 1123 name.

**4 — Review deployment YAML**

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

  › Deploy md-deepseek-prod?

  ▶  🚀  Deploy
     ✏️   Edit YAML in editor first
     ← Cancel
```

**✏️ Edit YAML in editor first** opens the YAML in `$EDITOR` (fallback `vi`) — use it to add anything the generator doesn't, for example the `storage:` block an air-gapped cluster needs. The edited YAML must still be a `ModelDeployment` with a valid `metadata.name` (otherwise you're told and it stays as it was); you can edit as many times as you like before deploying.

`spec.bundle` references the `ModelBundle` **by name**.

**5 — Deploy**

```
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

**2 — Select resources** (multi-select with `Space`; if you press `Enter` with nothing toggled, the highlighted entry is selected)

```
  › Select ModelDeployment(s) to delete:
  Space toggle   Enter confirm   q / Esc to go back

   ❯  ◉  md-deepseek-prod
      ○  md-llama-staging
      ← Back
```

If nothing ends up selected you'll see *"Nothing selected — move to an entry and press Space to toggle it, then Enter."*

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

Pod states `CrashLoopBackOff`, `ImagePullBackOff`, `ErrImagePull`, `Error` and `OOMKilled` are shown in red. If `kubectl` itself fails (cluster unreachable, auth error) a red `✖ kubectl error: …` line is shown instead of an endless "waiting for pod".

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
      version: 2.1.2                     # [CHANGE ME] Helm version to install
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
  [sambastack-installer] Pulling chart version 2.1.2...
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
| `checkpoint_overrides` | object | No | `{ "<model display name>": "<version>" }` — pin a checkpoint version instead of the highest |

> **V3 note:** `checkpointsDir` is no longer read or written by the CLI. Checkpoints come from the `Model` CR (`spec.checkpoints.<arch>.versions`), and a bundle pins the **highest** checkpoint version under the chosen arch — unless you set the optional `checkpoint_overrides` map (`{ "<model display name>": "<version>" }`, top level of `app-config.json`), which pins that version for the model, exactly as the UI does.

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

*SambaWiz CLI v2.0.0 · Requires SambaStack Helm ≥ 2.0.0*

← Back to [Web UI docs (README.md)](README.md)

</div>
