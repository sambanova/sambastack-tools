# SambaWiz Test Suite Documentation

This document provides a comprehensive overview of all tests in the SambaWiz application. Tests are organized by page/component and categorized by functionality type (UI components vs. core functionality).

**Last Updated:** 2026-07-28 — Restricted the "Enable prompt caching" checkbox in bundle mode: it now shows only when the bundle contains exactly one model whose profile supports `prompt_caching` (KV cache management, `ENABLE_KV_CACHE_MANAGER`, rejects a multi-model bundle whose experts span more than one `ckpt_sharing_uuid`); model mode (single model + profile) is unchanged. Added 2 bundle-mode Model Deployment Manager integration tests. Earlier (2026-07-27): Added an "Enable prompt caching" checkbox above the Section-2 deployment YAML: it only shows when the selected model's profile — or, for a bundle, any referenced profile — advertises the `prompt_caching` feature (from the `/api/model-profiles` cache), and checking it injects `engineConfig.env_vars` (`ENABLE_KV_CACHE_MANAGER`/`KV_CACHE_INCLUDE_STATS_IN_RESPONSE: "true"`) into the YAML (removed on uncheck; reset on each new selection). Added 2 Model Deployment Manager integration tests. Earlier (same date): On the Model Deployment page, renamed the Section-1 table column "Model Bundle" → "Model / Bundle" and, for a model-based deployment (inline `spec.models`, empty `spec.bundle`), now show the referenced Model CR's display name (`spec.name`) instead of a blank cell; `/api/model-deployment` resolves crname → `spec.name` via a single `kubectl get models` call (only when a model-based deployment is present). Added 1 Model Deployment Manager integration test and documented 2 previously-undocumented integration tests. Earlier (2026-07-23): Deprecated the user-facing term "bundle deployment" in favor of "model deployment" throughout the Model Deployment page copy, API response/log messages, doc comments, and docs/README (code identifiers like `getBundleDeploymentStatus`/`bundleDeployments` and the historical `BundleDeployment` CR-kind references are unchanged); no test behavior affected. Earlier (same date): Redesigned the Step-2 profile card's batching summary: a titled "Context / Max Batch Size" two-column layout, tiers sorted by descending sequence length, each tier reduced to just its max batch size (was a raw `tier: [batch sizes]` list); added 1 model-selection test and exported `parseTierKey` from the generator. Earlier (same date): renamed the user-facing "Bundle" term to "Model Bundle" on the Model Deployment page (bundle-picker `InputLabel`/`Select` label, the Section-1 table column header, and the Section-2 empty-state/help copy); the three Model Deployment Manager tests now query the picker via `findByLabelText('Model Bundle')`. Also hardened `/api/model-bundles` to only surface `kind: ModelBundle` items (belt-and-suspenders over the already-ModelBundle-scoped `kubectl get modelbundle.sambanova.ai` query), keeping the deprecated `Bundle` CR out of the picker. No tests added/removed (165 total). Earlier (2026-07-22): Made the Step-3 override drop any sequence-length tier whose batch sizes are all unchecked (no more `batch_sizes: []` in the emitted YAML; the embedding `is_default` re-targets to the smallest remaining tier); added 2 generator tests. Earlier (same date): redesigned Model Selection Section 3 into "Advanced Options": each model now shows an "Override Batching Config" subsection (the existing grid) plus a "Swappable" True/False toggle (default True, only emitted to the YAML as `modelSettings.swappable:false` when set to False); added 4 tests (1 UI toggle test + 3 generator tests) and updated the Section-3 label/aria-label assertions. Earlier (2026-07-21): added 7 `isPodProbeFailure` unit tests: a fresh deployment whose pod is still `PodInitializing`/`ContainerCreating` no longer reports "Deployment failed" (the logs probe's transient "command failed" is now excluded), while genuine failures (not found, no resources, CrashLoopBackOff, ...) still report. Earlier (same date): added a Model Deployment Manager integration test covering the long-name warning — it previews the operator-shortened pod names (fetched from the new `/api/predicted-pod-names` route) and lists only the pods actually truncated+hashed. Earlier still: rewritten for the **v3 bundle** migration (SambaWiz 2.0.0) — the old V2 `BundleTemplate`+`Bundle` generator/parser tests were replaced with V3 `ModelBundle` / `ModelProfile` / `ModelDeployment` tests; new suites were added for the parser, the CLI, and the two cache-generation routes; the two node-env route suites now run (jest.setup.ts guarded for `window`).
**Total Tests:** 191 automated across 13 suites + a legacy manual test plan
**Test Status:** ✅ All 191 tests passing (13/13 suites)
**Focus:** Core business logic (V3 YAML generation/parsing, model↔profile join, batching config), API/route integration, and CLI parity

## Table of Contents
- [Test Philosophy](#test-philosophy)
- [Automated Tests by Suite](#automated-tests-by-suite)
  - [Home Page](#home-page)
  - [Playground Page](#playground-page)
  - [Model Selection Page (V3)](#model-selection-page-v3)
  - [Model Deployment Manager](#model-deployment-manager)
  - [Model Availability (V3 join)](#model-availability-v3-join)
  - [Bundle YAML Generator (V3 ModelBundle)](#bundle-yaml-generator-v3-modelbundle)
  - [Parse Bundle YAML (V3 ModelBundle)](#parse-bundle-yaml-v3-modelbundle)
  - [PEF Config Generator](#pef-config-generator)
  - [Pod Naming Utilities](#pod-naming-utilities)
  - [API Route Tests (cache generators)](#api-route-tests-cache-generators)
  - [CLI (V3)](#cli-v3)
- [Legacy Manual Integration Test Plan](#legacy-manual-integration-test-plan)
- [Test Statistics](#test-statistics)
- [Running Tests](#running-tests)
- [Guidelines for New Tests](#guidelines-for-new-tests)
- [What Changed](#what-changed)

---

## Test Philosophy

This test suite follows these principles:

✅ **Test business logic, not implementation details**
- Focus on the model↔profile join, `ModelBundle`/`ModelDeployment` YAML generation, batching-config
  resolution, and validation-status calculation
- Test route/API integration points and data transformations
- Verify error handling for critical operations

❌ **Avoid testing third-party libraries**
- Don't test that Material-UI components render, that React state updates, or that inputs accept text

🎯 **Consolidated and focused** — every test targets behavior that would cause a real production
(deployment/legalization) failure if it regressed.

---

## Automated Tests by Suite

### Home Page

**File:** [home.test.tsx](home.test.tsx) · **Component:** `Home` · **Tests:** 1

| Test | Type | Description |
|------|------|-------------|
| should load environments on mount | Core | Verifies the page fetches environment data from `/api/environments` on load |

---

### Playground Page

**File:** [playground.test.tsx](playground.test.tsx) · **Component:** `Playground` · **Tests:** 1

| Test | Type | Description |
|------|------|-------------|
| should fetch models, environments, and checkpoint mapping on mount | Core | Verifies `/api/models`, `/api/environments`, and `/api/checkpoint-mapping` are called on mount |

---

### Model Selection Page (V3)

**File:** [model-selection.test.tsx](model-selection.test.tsx) · **Component:** `ModelSelection` (formerly `BundleForm`) · **Tests:** 10

Real UI-behavior tests for the V3 Model Selection flow (the old suite was a single API-integration
test). Drives the full flow: pick models → pick one profile per model → override batching → wire spec
decoding → observe the generated `ModelBundle` YAML.

| Test | Description |
|------|-------------|
| lists only models with a matching profile and warns about excluded models (Q4) | Models with no `model_arch`→profile join are blocked, with a UI warning |
| auto-selects and collapses the only matching profile for a single-profile model | Single-profile models are auto-selected and their row starts collapsed |
| renders one card tile per matching profile, single-selects, and collapses on selection | Card-tile row behavior: one tile per profile, single-select, collapse-on-select |
| shows a titled "Context / Max Batch Size" summary on each card, largest sequence length first | Step-2 card batching summary: titled two-column layout, tiers sorted by descending sequence length, each tier reduced to its max batch size (no raw batch-size list) |
| shows the arch dropdown only for models with more than one matching arch | Multi-arch models require an arch pick before profiles list (Q3) |
| renders the override grid seeded from the profile: supported cells enabled, "All" auto-checks, and "*" mode | Step-3 override is a checkbox grid (context-length rows × fixed batch-size columns); cells enable per profile support, "All" auto-checks when every supported cell is checked and collapses the tier to `*` |
| defaults Swappable to True (omitted from YAML) and emits modelSettings.swappable:false only when set to False | Step-3 Advanced Options "Swappable" toggle defaults to True (no `modelSettings` emitted); switching to False emits `modelSettings.swappable:false`; switching back to True drops it |
| shows the draft-model dropdown only for spec-decoding profiles | The draft dropdown appears only when the profile has an `sd` PEF |
| wires a chosen draft model into the generated ModelBundle YAML (routable:false + specDecodingPairs) | End-to-end: draft selection produces `specDecodingPairs` + `modelSettings.routable:false` on the draft |

**Note:** the draft-model `Select` uses a proper `InputLabel`+`labelId` (matching the arch `Select`) so
it is queryable by accessible name and correctly labeled for assistive tech.

---

### Model Deployment Manager

**File:** [model-deployment.test.tsx](model-deployment.test.tsx) · **Component:** `ModelDeploymentManager` (formerly `BundleDeploymentManager`) · **Tests:** 25 (6 status logic + 7 probe-failure logic + 12 integration)

#### `getBundleDeploymentStatus` (pure logic — 6)

| Test | Description |
|------|-------------|
| should return "Not Deployed" when both pods are null | No pods exist |
| should return "Deploying" when cache pod is not ready | Cache pod pending/not ready |
| should return "Deploying" when default pod is not ready | Default pod pending/not ready |
| should return "Deployed" when both pods are ready | Both cache and default pods running |
| should return "Deploying" when only cache pod exists and is ready | Partial deployment (cache only) |
| should return "Deploying" when only default pod exists and is ready | Partial deployment (default only) |

#### `isPodProbeFailure` (pure logic — 7)

Decides whether a status/logs probe error means the pods are genuinely not running (→ "Deployment failed") vs. a benign startup state.

| Test | Description |
|------|-------------|
| returns false when there is no error message | `null` → not a failure |
| does NOT flag a logs probe failing because the container is still initializing | Regression: `PodInitializing` "command failed" during a fresh deploy is not a failure |
| does NOT flag a container that is still being created | `ContainerCreating` is a benign transient state |
| flags a pod that could not be found | `NotFound` → genuine failure |
| flags a generic command failure that is not a startup state | e.g. `Unable to connect to the server` |
| flags "no resources" (nothing scheduled) | `No resources found` → genuine failure |
| flags a real crash even though the container is "waiting to start" | `CrashLoopBackOff` is not excluded (only PodInitializing/ContainerCreating are) |

#### Integration (12)

| Test | Description |
|------|-------------|
| should fetch deployments and bundles from the v3 routes on mount (always fresh, never cached) | Confirms the deployment page always makes fresh calls (Q14), never reading the cache |
| only lists bundles whose validation succeeded in the bundle picker | Only `Valid`-condition `ModelBundle`s are offered for deployment |
| generates a ModelDeployment document that references the bundle by name (never inline spec.models) | Emits `spec.bundle: <name>`, never inline `spec.models` (Q6) |
| generates a model + profile ModelDeployment (spec.models) when modelPath and profileName query params are set | Inline `spec.models.modelConfigs` (model + named profile), no bundle ref |
| offers "Enable prompt caching" and injects the KV-cache env vars when the profile supports it | Profile with `prompt_caching` feature → checkbox shown; checking injects `engineConfig.env_vars` (`ENABLE_KV_CACHE_MANAGER`/`KV_CACHE_INCLUDE_STATS_IN_RESPONSE`), unchecking removes them while keeping `startupTimeout` |
| does NOT offer "Enable prompt caching" when no selected profile supports it | Profile without the `prompt_caching` feature → checkbox is not rendered |
| offers "Enable prompt caching" for a single-model bundle whose profile supports it | A one-model bundle whose profile advertises `prompt_caching` → checkbox shown |
| does NOT offer "Enable prompt caching" for a multi-model bundle (KV cache spans multiple experts) | A bundle with >1 model → checkbox hidden even if one profile supports `prompt_caching` |
| redirects to the Model Selection page when "Model" is chosen without model params | Selecting "Model" with no `modelPath`/`profileName` routes to `/model-selection` |
| previews the operator-shortened pod names in the long-name warning | For a name past the truncate threshold, fetches `/api/predicted-pod-names` and lists only the pods actually shortened (default here; cache omitted because it matches its naive form) |
| deletes a deployment via the modeldeployment.sambanova.ai-backed route | Deletion targets the `ModelDeployment` CR |
| shows the resolved Model name in the "Model / Bundle" column for a model-based deployment | A model-based deployment (empty `bundle`) renders the Model CR's `spec.name` (resolved server-side) in the renamed "Model / Bundle" column instead of a blank cell |

---

### Model Availability (V3 join)

**File:** [model-availability.test.ts](model-availability.test.ts) · **Function:** `getAvailableModels` · **Tests:** 9

Rewritten around the V3 **Model↔ModelProfile join on `model_arch`** (the old `pef_mapping`/`pef_configs`
intersection is gone).

| Test | Description |
|------|-------------|
| marks a model available when its single arch has a matching profile | Basic join happy path |
| excludes a model with no matching profile on any arch (Q4 no-profile guard) | No-profile models are excluded |
| handles a multi-arch model where only one arch has a matching profile | Multi-arch models available via any matching arch |
| flags embedding models via isEmbeddingModel (Q10: capabilities includes "embeddings") | Embedding detection from `Model.spec.metadata.capabilities` |
| does not flag a non-embedding model as embedding | Negative case for embedding detection |
| joins multiple profiles onto the same arch (returns all matching profiles) | Multiple profiles per arch all surface |
| handles a full mixed cache: some models available, some excluded, sorted output | Realistic mixed cache, alphabetically sorted |
| returns empty available/excluded for empty inputs | Empty-input edge case |
| excludes a model whose checkpoints map has no archs at all | Model with no archs is excluded |

---

### Bundle YAML Generator (V3 ModelBundle)

**File:** [bundle-yaml-generator.test.ts](bundle-yaml-generator.test.ts) · **Module:** framework-agnostic V3 generator · **Tests:** 27

Covers the shared, React-free `ModelBundle` generator + its helpers (also consumed by the CLI). The old
`generateCheckpointName`/`generateBundleYaml` (V2 `BundleTemplate`+`Bundle`) tests were removed.

#### Helpers

| Group | Tests | What they verify |
|-------|-------|------------------|
| `getHighestVersion` | 1 | Picks the numeric-highest version, not lexicographically-highest |
| `formatModelRef` | 2 | `crname:version` for single-arch; `crname:arch:version` for multi-arch |
| `isEmbeddingModel` | 2 | True iff `capabilities` includes `"embeddings"` (Q10) |
| `getEffectiveBatchingConfig` | 3 | `spec.defaultBatchingConfig` → `status.batchingConfig` → `{}` fallback chain |
| `deriveIsDefaultTier` | 4 | `is_default` on smallest tier for embedding only; never otherwise; strips any pre-existing flag; handles bare-int and `t`-suffixed tier keys |
| `getDisplayName` | 3 | Features→title ("High Interactivity" default; numbered per model when a type repeats; lone type unnumbered) |
| `isSpecDecodingProfile` | 2 | True iff a `pef` name contains `"sd"` |

#### `buildModelBundleObject` / `generateModelBundleYaml` (13)

| Test | Description |
|------|-------------|
| emits one modelConfigs entry per selection, with full batchingConfig always present | One entry per selection; `batchingConfig` always emitted (Q1) |
| applies is_default to the smallest tier only for embedding models | Embedding is_default derivation (Q2) |
| never sets is_default for non-embedding models | Negative case |
| uses batchingConfigOverride instead of the profile default when present | Step-3 override supersedes the profile default |
| drops tiers whose batch_sizes were fully unchecked in the override (no empty batch_sizes emitted) | A tier with an empty `batch_sizes` array is omitted from the emitted config; `'*'` is preserved |
| re-targets is_default to the smallest remaining tier after empty tiers are dropped (embedding) | Dropping the smallest tier moves the embedding `is_default:true` to the new smallest remaining tier |
| builds specDecodingPairs with bare crnames and no experts field, and marks the draft routable:false | Spec-decoding emission (Q12): bare crnames, no `experts`, draft `routable:false` |
| omits modelSettings when swappable is true, undefined, or unset (the operator default) | Swappable defaults to true → no `modelSettings` emitted |
| emits modelSettings.swappable:false only when swappable is explicitly false | `modelSettings.swappable:false` emitted only on explicit opt-out |
| merges routable:false and swappable:false into a single modelSettings for a non-swappable draft | A non-swappable spec-decoding draft merges both into one `modelSettings` |
| omits specDecodingPairs entirely when there are none | No empty `specDecodingPairs` key |
| generates a ModelBundle YAML document with apiVersion/kind/metadata.name and no secretNames | Single `kind: ModelBundle` doc, no `secretNames` (Q7) |
| matches the field order from the worked spec-decoding example (model, profile, modelSettings, batchingConfig) | Field ordering matches the plan's worked example |

---

### Parse Bundle YAML (V3 ModelBundle)

**File:** [parse-bundle-yaml.test.ts](parse-bundle-yaml.test.ts) · **Functions:** `parseModelRef`, `parseModelBundleYamlContent` · **Tests:** 10 · **(new suite)**

V3-only parser (no backwards compatibility with V2 bundles, Q9).

#### `parseModelRef` (3)

| Test | Description |
|------|-------------|
| parses a bare crname:version ref | `crname:version` form |
| parses a crname:arch:version ref | Multi-arch form with pinned arch |
| parses a bare crname (no version/arch), as used in specDecodingPairs | Bare-crname form used by `specDecodingPairs` |

#### `parseModelBundleYamlContent` (7)

| Test | Description |
|------|-------------|
| rejects non-ModelBundle input (e.g. V2 BundleTemplate) | V2 input is rejected outright |
| rejects a ModelBundle with an empty modelConfigs array | Structural validation |
| rejects a modelConfigs entry with both profile and profileDefinition | Exactly-one-of enforcement |
| rejects a modelConfigs entry with neither profile nor profileDefinition | Exactly-one-of enforcement |
| round-trips a generated single-model ModelBundle | generate→parse fidelity (single model; embedding `is_default` preserved) |
| round-trips a multi-arch model ref | generate→parse fidelity for `crname:arch:version` |

---

### PEF Config Generator

**File:** [pef-config-generator.test.ts](pef-config-generator.test.ts) · **Function:** `generatePefConfigs` · **Tests:** 26 · **Type:** Kubernetes integration (mocked `kubectl`/`fs`)

Generates `pef_configs.json` from `kubectl get pef -o json`. Updated for V3: the generator **no longer
reads `pef_mapping.json`** (the DYT-precedence pruning and `task_name`→`model_type` back-fill that used
it were removed — embedding now comes from Model `capabilities`).

| Group | Tests | Coverage |
|-------|-------|----------|
| Configuration validation | 4 | Missing app-config / no active env / missing kubeconfig; **confirms `pef_mapping.json` is never read** |
| Kubernetes integration | 3 | kubectl command construction, namespace resolution + default |
| PEF parsing | 5 | Name parsing, ss/bs extraction, `k`-notation formatting (≥1024), sub-1024 values, format variants |
| Version handling | 4 | Latest-version selection, missing versions, string versions, invalid-name skips |
| DYT PEF handling | 5 | Cartesian SS×BS from `decode_seq`, `max`-only fallback, <32k filter skip, missing `dynamic_dims` skip, static-batch-size DYT |
| Error handling & edge cases | 5 | Success count, empty list, kubectl failure, invalid JSON, file-write errors |

---

### Pod Naming Utilities

Pre-existing, unchanged utilities that guard Kubernetes name-length/format constraints.

| File | Function | Tests | Coverage |
|------|----------|-------|----------|
| [inference-pod-names.test.ts](inference-pod-names.test.ts) | inference pod name derivation | 8 | Pod-name construction from deployment/expert names |
| [pod-name-limits.test.ts](pod-name-limits.test.ts) | pod-name length limits | 3 | Truncation/validation against K8s length limits |

---

### API Route Tests (cache generators)

These test Next.js Route Handlers directly by importing and invoking the exported `POST` function
(mocking `child_process.execSync`/`fs` the same way `pef-config-generator.test.ts` does). They live next
to their routes and use a `@jest-environment node` docblock — the reason `jest.setup.ts` now guards its
`window.matchMedia` mock with `typeof window !== 'undefined'` (so it's a no-op in the node environment).

#### Generate Checkpoint Mapping Route

**File:** [../../api/generate-checkpoint-mapping/route.test.ts](../../api/generate-checkpoint-mapping/route.test.ts) · **Tests:** 13

Covers the V3 rewrite: captures **all** archs from `Model.spec.checkpoints` (not just the first) plus
`spec.metadata.capabilities`, writing a `CheckpointMappingV3`-shaped `checkpoint_mapping.json`.

| Test | Description |
|------|-------------|
| captures ALL checkpoint archs for a multi-arch model, not just the first | Core multi-arch capture regression |
| preserves each arch's version data (checkpoint_status, tool_support, vision_embedding_checkpoint) | Per-version fields survive per-arch |
| captures spec.metadata.capabilities, including "embeddings" | `capabilities` copied for embedding detection |
| strips the gs://bucket/ prefix and trailing slash from source paths | `stripGcsPrefix` behavior |
| handles a model with only a single checkpoint arch | Single-arch still keyed by its one arch |
| skips checkpoint archs with no valid versions | Empty-`versions` arch dropped, sibling kept |
| skips models missing spec.name, metadata.name, or checkpoints | Incomplete models excluded |
| returns success with the model count | Response `count` correctness |
| calls kubectl get models with the correct namespace and kubeconfig | Command construction |
| re-runs PEF config generation after writing the checkpoint mapping | `generatePefConfigs` invoked after write |
| returns 400 when no kubeconfig file is configured | Missing `currentKubeconfig` |
| returns 500 when app-config.json cannot be read | `readFile` rejection surfaced as 500 |
| returns 500 when kubectl fails | `execSync` throw surfaced as 500 |

#### Generate Model Profiles Route

**File:** [../../api/generate-model-profiles/route.test.ts](../../api/generate-model-profiles/route.test.ts) · **Tests:** 11 · **(new route)**

The new V3 profile cache generator: `kubectl get modelprofiles -o json` → `ModelProfilesCache`-shaped
`model_profiles.json`.

| Test | Description |
|------|-------------|
| uses spec.defaultBatchingConfig when present | Fallback chain, first branch |
| falls back to status.batchingConfig when defaultBatchingConfig is absent | Fallback chain, second branch |
| defaults batchingConfig to {} when neither exists | Fallback chain, final branch |
| writes the ModelProfilesCache shape ({ model_arch, features, batchingConfig, pefs }) for each profile | Full cache-entry shape |
| skips profiles missing metadata.name or spec.model_arch | Incomplete profiles excluded |
| calls kubectl get modelprofiles with the correct namespace and kubeconfig | Command construction |
| returns success with the correct profile count | Response `count` correctness |
| returns 400 when no kubeconfig file is configured (no active environment) | Missing `currentKubeconfig` |
| returns 500 when app-config.json cannot be read (not found) | `readFile` rejection surfaced as 500 |
| returns 500 when kubectl fails | `execSync` throw surfaced as 500 |
| returns a clear 400 (not a 500) when the backend has no ModelProfile CRD (v2-only backend) | Detects the "no resource type modelprofiles" kubectl error and returns a "does not support v3 bundles" message |

---

### CLI (V3)

**File:** [../../../bin/__tests__/cli.test.ts](../../../bin/__tests__/cli.test.ts) · **Tests:** 24 · **(new suite)**

Covers the V3 CLI rewrite (`bin/cli.ts`), including its cache→CR conversions, the model↔profile join,
override parsing, and — importantly — that the CLI drives the **same shared generator** as the GUI.

| Group | Tests | Coverage |
|-------|-------|----------|
| `toModelCR` | 2 | Converts a `CheckpointMappingV3` entry into a `Model` CR; carries `"embeddings"` capability |
| `toModelProfileCR` | 1 | Converts a `ModelProfilesCache` entry into a `ModelProfile` CR |
| `getArchsWithProfiles` | 3 | Single-arch match; filters archs with no profile (multi-arch); empty when none (Q4) |
| `getProfilesForArch` | 2 | Returns profiles joined on `model_arch`; empty for an arch with no profiles |
| `parseBatchSizesInput` | 3 | `*` wildcard; comma-separated list; drops non-numeric entries |
| `crNameToDisplayName` | 2 | Reverse crname→display lookup; `undefined` for unknown crname |
| `readValidCondition` | 3 | `pending`/`succeeded`/`failed` from the `Valid` condition |
| `buildModelDeploymentYaml` | 2 | Emits a `ModelDeployment` referencing the bundle by name (Q6); carries over the old deployment knobs |
| `extractBundleName` | 2 | Extracts the name from a `ModelBundle` YAML; empty string for non-ModelBundle |
| CLI selections → `generateModelBundleYaml` (shared generator integration) | 4 | Single-arch ref + effective batching + no `specDecodingPairs`; multi-arch ref pinning chosen arch; embedding `is_default` on smallest tier; draft wired into `specDecodingPairs` with `routable:false` + bare crnames |

**Why this matters:** the CLI and GUI share one generator module, so these tests confirm the CLI produces
byte-identical `ModelBundle`/`ModelDeployment` output to the UI path.

---

## Legacy Manual Integration Test Plan

> ⚠️ The sections below are the **release 1.1.2 manual test plan**. They predate the v3 migration and
> some steps/data reference the old V2 `BundleTemplate`+`Bundle` load flow. V3 load/parse is now covered
> automatically by [parse-bundle-yaml.test.ts](parse-bundle-yaml.test.ts) (ModelBundle-only). Update the
> manual test-data files to `ModelBundle` YAML before re-running the load-related steps.

**Test Plan Location:** [temp/TEST_PLAN.md](../../../temp/TEST_PLAN.md)

### 1. Bundle/Model Deployment State Persistence
**API:** `/api/model-deployment-state` (GET, POST, DELETE) · **Component:** `ModelDeploymentManager.tsx`
- State file at `temp/model-deployment-state.json`; persists across refreshes; DELETE removes it; graceful when absent.

### 2. Load Saved YAML Files (V3)
**API:** `/api/saved-artifacts` (GET), `/api/load-bundle` (GET) · **Components:** `ModelSelection.tsx`, `model-selection/page.tsx`
- V3: only `ModelBundle` YAML is accepted (no V2 fallback). Verify parsing of `modelConfigs`, per-model
  batching, and `specDecodingPairs`; verify clear errors for non-ModelBundle input and malformed refs.

### 3. SambaStack Installation/Update
**API:** `/api/install-sambastack` (POST), `/api/installer-logs` (GET) · **Component:** `Home.tsx`
- YAML saved to `temp/sambastack-install-{timestamp}.yaml`; `kubectl apply` with the current
  kubeconfig/namespace; installer logs from the `sambastack-installer` namespace.

### 4. In-place API Key Retrieval
**Components:** `Playground.tsx`, `AppLayout.tsx`, `Home.tsx`
- Link appears when `apiKey` is missing; uses `uiDomain`; Playground becomes functional after a key is
  added (no restart).

#### Prerequisites
1. `npm run dev` 2. Valid `app-config.json` with an environment 3. Valid kubeconfig in `kubeconfigs/`
4. Access to a test cluster (installer/validation steps).

---

## Test Statistics

| Category | Count | Notes |
|----------|-------|-------|
| **Total automated tests** | **166** | across 13 suites, all passing |
| UI components (API/behavior) | 30 | home (1), playground (1), model-selection (10), model-deployment (18) |
| Core utilities | 88 | availability (9), generator (32), parser (10), pef-config (26), inference-pod-names (8), pod-name-limits (3) |
| API route handlers | 24 | generate-checkpoint-mapping (13), generate-model-profiles (11) |
| CLI | 24 | bin/__tests__/cli.test.ts |

### Automated Test Breakdown by File

| File | Tests | Focus |
|------|-------|-------|
| home.test.tsx | 1 | API integration on mount |
| playground.test.tsx | 1 | API integration on mount |
| model-selection.test.tsx | 10 | V3 selection flow (cards + batching summary, arch dropdown, overrides, swappable, spec decoding → ModelBundle) |
| model-deployment.test.tsx | 25 | Deployment status logic (6) + probe-failure logic (7) + ModelDeployment integration (12) |
| model-availability.test.ts | 9 | V3 model↔profile join, no-profile guard, embedding detection |
| bundle-yaml-generator.test.ts | 32 | V3 ModelBundle generator + helpers |
| parse-bundle-yaml.test.ts | 10 | V3 ModelBundle parser (round-trip, V2 rejection) |
| pef-config-generator.test.ts | 26 | kubectl PEF cache generation + DYT logic (no `pef_mapping.json`) |
| inference-pod-names.test.ts | 8 | Pod-name derivation |
| pod-name-limits.test.ts | 3 | Pod-name length limits |
| api/generate-checkpoint-mapping/route.test.ts | 13 | Multi-arch checkpoint capture + capabilities (V3) |
| api/generate-model-profiles/route.test.ts | 11 | ModelProfile cache generation + batching fallback + non-v3-backend detection (V3) |
| bin/__tests__/cli.test.ts | 24 | V3 CLI: cache→CR conversion, join, shared-generator parity |
| **Total** | **158** | |

---

## Running Tests

```bash
npm test                       # run all suites
npm test -- --watch            # watch mode
npm test -- --coverage         # with coverage
npx jest model-selection       # a single suite by name
npx jest app/api               # API route suites
```

**Infrastructure:** Jest + ts-jest; `jsdom` for component/util suites, `@jest-environment node` for the
API-route suites (`jest.setup.ts` guards `window` so both environments share one setup file). React
Testing Library + `@testing-library/user-event` for `.tsx`; centralized V3 fixtures in
[v3-mock-data.ts](v3-mock-data.ts) (legacy fixtures in [mock-data.ts](mock-data.ts)); `execSync`/`fs`
mocked via [kubectl-mock.ts](kubectl-mock.ts) for route/CLI suites.

---

## Guidelines for New Tests

### ✅ Write tests for
1. Business logic — the model↔profile join, `ModelBundle`/`ModelDeployment` generation, batching
   resolution, validation-status parsing
2. Route/API integration — endpoints called, kubectl command construction, cache shapes
3. Error handling — missing config, failed kubectl, malformed input
4. CLI/GUI parity — the shared generator producing identical output

### ❌ Don't write tests for
1. Text rendering ("does 'Welcome' appear?") 2. Component existence ("is there a button?")
3. Incidental interactions 4. Third-party libraries (MUI/React internals) 5. Formatting/indentation

### 🎯 Good test
```typescript
it('excludes a model with no matching profile on any arch (Q4)', () => {
  const { available, excluded } = getAvailableModels(checkpointMapping, modelProfiles);
  expect(available).not.toContain('LonelyModel');
  expect(excluded).toContain('LonelyModel');
});
```

---

## What Changed

### V3 migration — SambaWiz 2.0.0 (July 2026)

The bundle builder moved from V2 (`BundleTemplate` + `Bundle` + `BundleDeployment`) to **v3 bundles**
(`ModelProfile` / `ModelBundle` / `ModelDeployment`, checkpoints sourced from the `Model` CR by
`model_arch`). See [v3plan.md](../../../v3plan.md) for the full design and the resolved Q1–Q15 decisions.

**Suites added**
- `parse-bundle-yaml.test.ts` (10) — V3-only `ModelBundle` parser (round-trip + V2 rejection)
- `bin/__tests__/cli.test.ts` (24) — V3 CLI + shared-generator parity
- `api/generate-checkpoint-mapping/route.test.ts` (13) and `api/generate-model-profiles/route.test.ts` (10) — the Home-apply cache generators

**Suites rewritten**
- `bundle-yaml-generator.test.ts` — now the V3 `ModelBundle` generator + helpers (`formatModelRef`,
  `isEmbeddingModel`, `getEffectiveBatchingConfig`, `deriveIsDefaultTier`, `getDisplayName`,
  `isSpecDecodingProfile`). The V2 `generateCheckpointName`/`generateBundleYaml` tests were removed.
- `model-availability.test.ts` — rebuilt around the `model_arch` join + no-profile guard + embedding
  detection (replacing the `pef_mapping`/`pef_configs` intersection).
- `model-selection.test.tsx` / `model-deployment.test.tsx` — renamed from `bundle-form` /
  `bundle-deployment`; now exercise the V3 card-tile selection flow and `ModelDeployment` emission.
- `pef-config-generator.test.ts` — no longer reads the deleted `pef_mapping.json`.

**Suites deleted**
- `checkpoints-dir.test.ts` (V2 `checkpointsDir` logic removed — checkpoints come from the Model CR).

**Fixes applied while getting the suite green (2026-07-21)**
1. Two embedding-model assertions in `bundle-yaml-generator.test.ts` / `parse-bundle-yaml.test.ts` were
   updated to expect `is_default: true` on the smallest tier (the code correctly derives it for
   embedding models per Q2 — these were stale test expectations, not code bugs).
2. `jest.setup.ts` guarded its `window.matchMedia` mock with `typeof window !== 'undefined'` so the two
   `@jest-environment node` route suites can start.
3. The draft-model `Select` in `ModelSelection.tsx` was given a proper `InputLabel`+`labelId` (matching
   the arch `Select`) — fixes the draft-wiring test and improves accessibility.
4. **Empty-profiles-cache guard.** `generate-model-profiles` now detects a backend with no
   `ModelProfile` CRD (a v2-only backend) and returns a clear 400 ("does not support v3 bundles")
   instead of a raw 500; `Home.handleApply` blocks with an actionable message when the profiles cache
   comes back with `count: 0`. Added one route test for the non-v3-backend branch (generate-model-profiles: 10 → 11).

Result: **151/151 passing across 13 suites.**
