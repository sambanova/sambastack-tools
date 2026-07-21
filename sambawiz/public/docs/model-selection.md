# Model Selection Page

## Overview

The Model Selection page (formerly "Bundle Builder") lets you build and validate a single
`ModelBundle` resource for deployment on SambaStack. A `ModelBundle` combines one or more
already-existing `ModelProfile` and `Model` custom resources — it references them **by name**.
This page does not author or edit `ModelProfile` or `Model` resources; those are expected to
already exist in the cluster. Picking a model and a profile for it simply adds one entry to the
bundle's `spec.modelConfigs` list.

## What Happens on This Page

1. **Select Model(s)**: Choose one or more models from the models available in your cluster.
   Only models that have at least one matching `ModelProfile` are selectable — models with no
   matching profile on any of their checkpoint architectures are excluded from the list and
   called out in a warning banner instead.
2. **Select Architecture** (multi-arch models only): If a model has more than one checkpoint
   architecture, an architecture dropdown appears and must be resolved before its profiles can be
   listed. Single-architecture models skip this step entirely.
3. **Select Model Profile**: For each model (per resolved architecture), pick exactly one
   `ModelProfile` from an expandable row of card tiles. If only one profile matches, it is
   auto-selected and the row starts collapsed; otherwise the row stays expanded until you pick one,
   then collapses.
4. **Speculative Decoding (conditional)**: If the profile you picked references a PEF whose name
   contains `sd`, a draft-model dropdown appears. Choosing a draft model repeats steps 2–3 for that
   draft model (its own arch pick and profile pick), and the draft is added to the bundle as its
   own model entry.
5. **Override Batching Configuration**: Each selected model's effective batching config (from its
   chosen profile) is shown as an editable override — per sequence-length tier, either an explicit
   list of batch sizes or `*` for "all batch sizes". This override always ends up in the generated
   YAML, even when it matches the profile's own default.
6. **YAML Generation**: A single `ModelBundle` YAML document is generated automatically as
   selections change.
7. **Validation**: Validate the bundle by applying it to your cluster.
8. **Save**: Save the generated YAML to the `saved_artifacts/` directory.
9. **Create Deployment**: Navigate directly to the Model Deployment page after a successful
   validation.

## Data Sourcing

Unlike the old page, Model Selection does not call `kubectl` itself to list models or profiles.
Instead it reads from two local JSON caches (`app/data/checkpoint_mapping.json` and
`app/data/model_profiles.json`) that are populated when you click **Apply** on the Home page. That
Apply flow runs:

```bash
kubectl -n <namespace> get models -o json
kubectl -n <namespace> get modelprofiles -o json
```

(see `app/api/generate-checkpoint-mapping/route.ts` and `app/api/generate-model-profiles/route.ts`).
The model cache captures each `Model`'s display name, resource name, every checkpoint architecture
and version, and its `capabilities` (used for embedding detection). The profile cache captures each
`ModelProfile`'s `model_arch` (the join key back to a model's checkpoint architecture), its
`features`, its effective batching config, and its `pefs` list. Model Selection joins these two
caches on `model_arch` to decide which profiles are offered for which model. If you add or change
models/profiles in the cluster, you need to return to Home and click Apply again before they show
up here.

## kubectl Commands Used

This page itself only calls `kubectl` for validation; the model/profile listing above comes from
caches refreshed by the Home page, not from a live call made by this page.

### 1. Apply ModelBundle YAML
```bash
kubectl -n <namespace> apply -f <temp-file>.yaml
```
**Purpose**: Creates or updates the `ModelBundle` resource in the cluster
**When**: When you click "Validate"
**Namespace**: Uses the namespace from your current environment configuration
**What It Does**: Submits the generated `ModelBundle` YAML for validation by the SambaStack operator

### 2. Get ModelBundle Status
```bash
kubectl -n <namespace> get modelbundle.sambanova.ai <bundle-name> -o json
```
**Purpose**: Checks the validation status of the bundle
**When**: After applying the bundle (5 seconds wait)
**Namespace**: Uses the namespace from your current environment configuration
**What It Does**: Retrieves the bundle's `status` to determine if validation succeeded or failed

## Key Concepts

### ModelProfile vs ModelBundle vs Model

- **`ModelProfile`**: Defines the shape for a **single** model — which PEFs it uses, its batching
  configuration per sequence-length tier, and its `model_arch` (the join key to a `Model`'s
  checkpoints). Profiles are reusable across bundles and are not authored on this page.
- **`ModelBundle`**: Combines **multiple** profiles into one deployable unit. Its
  `spec.modelConfigs` list has one entry per selected model, each referencing a `Model` (by
  `<crname>[:arch]:version`) and a `ModelProfile` (by name), plus an optional per-bundle
  `batchingConfig` override. This is the single resource this page generates and validates.
- **`Model`**: The source of checkpoints. A `Model` CR's `spec.checkpoints.<arch>` holds the
  checkpoint versions for each architecture it supports; `model_arch` is what joins a `Model` to
  the `ModelProfile`s that can run it. Checkpoints are never authored in the bundle — the operator
  resolves them from the referenced `Model` at reconcile time.

### PEF (Processor Executable Format)

Pre-compiled model executables that a `ModelProfile` lists in its `spec.pefs`. This page does not
expose individual PEF/sequence-size/batch-size selection directly — that level of detail is fully
abstracted behind the profile you choose. The only place a PEF's identity surfaces to the user is
indirectly: a profile is treated as a speculative-decoding profile if any of its PEF names contains
`sd`, which is what triggers the draft-model dropdown.

### Speculative Decoding

A performance optimization technique where a smaller "draft" model generates candidate tokens that
a larger "target" model validates, improving inference speed. On this page, choosing a profile that
has an `sd` PEF surfaces a draft-model dropdown; picking a draft model adds it to the bundle as its
own `modelConfigs` entry (marked `modelSettings: { routable: false }`, since a draft is only ever
served for its target's speculative decoding, not routed to directly) and records the pairing in
the bundle's `spec.specDecodingPairs`.

## Validation Process

1. Generate the single `ModelBundle` YAML document from the current selections.
2. Apply the YAML to the cluster using `kubectl apply`.
3. Wait, then fetch the resulting `ModelBundle`'s status with `kubectl get modelbundle.sambanova.ai`.
4. Read the first entry in `status.conditions` (`reason`/`status`/`message`) to determine overall
   pass/fail, and `status.legalizerInfo` (`errors`, `warnings`, `status`, and memory `utilization`:
   `ddr`, `hbm_resident`, `host`) for the detailed legalizer result. The SambaStack operator
   performs this legalization: it checks that referenced checkpoints exist and are accessible, that
   the profile/PEF configurations are compatible, and that resource requirements (DDR/HBM/host
   memory) can be met.
5. Display the validation result — including any legalizer errors/warnings and the DDR/host memory
   utilization gauges — to the user.
