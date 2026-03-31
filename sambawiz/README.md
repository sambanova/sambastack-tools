<a href="https://sambanova.ai/">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../images/light-logo.png" height="100">
  <img alt="SambaNova logo" src="../images/dark-logo.png" height="100">
</picture>
</a>

# SambaWiz

SambaWiz is a GUI wizard that accelerates the creation and deployment of model bundles on [SambaStack](https://docs.sambanova.ai/docs/en/admin/overview/sambastack-overview).

## Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
  - [1. Install Dependencies](#1-install-dependencies)
  - [2. Configure Application Settings](#2-configure-application-settings)
  - [3. Configure Kubernetes Access](#3-configure-kubernetes-access)
  - [4. Verify Configuration Files](#4-verify-configuration-files)
  - [5. Run Development Server](#5-run-development-server)
  - [6. Build for Production](#6-build-for-production)
- [Features](#features)
  - [1. Home](#1-home)
  - [2. Bundle Builder](#2-bundle-builder)
  - [3. Bundle Deployment](#3-bundle-deployment)
  - [4. Playground](#4-playground)
- [Project Structure](#project-structure)
- [API Endpoints](#api-endpoints)
  - [GET /api/kubeconfig-validate](#get-apikubeconfig-validate)
  - [POST /api/validate](#post-apivalidate)
- [Technology Stack](#technology-stack)
- [Development](#development)
- [Testing](#testing)
- [Security Considerations](#security-considerations)
- [Troubleshooting](#troubleshooting)
  - [Configuration Issues](#configuration-issues)
  - [Version Compatibility Issues](#version-compatibility-issues)
  - [Connection Issues](#connection-issues)
  - [Common Error Messages](#common-error-messages)

## Overview

SambaWiz provides an intuitive interface to:
- Select AI models from an available catalog
- Configure PEF (Processor Executable Format) settings including sequence size (SS) and batch size (BS)
- Map models to checkpoints
- Generate valid Kubernetes YAML manifests (BundleTemplate and Bundle resources)
- Validate and apply bundles to a Kubernetes cluster
- View bundle validation status and error messages

## Prerequisites

- Access to a Kubernetes cluster with SambaStack [installed](https://docs.sambanova.ai/docs/en/admin/installation/prerequisites) and SambaNova CRDs available (minimum Helm version specified in the [VERSION](VERSION) file)
- Valid `kubeconfig.yaml` for your SambaStack environment
- Node.js 18+ and npm
- `checkpoint_mapping.json` file and the root directory for checkpoints (provided by your SambaNova contact)
- `kubectl` and `helm` CLI tools installed and configured (must be in your PATH as the application uses these commands via Node.js)

## Getting Started

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Application Settings

Create an `app-config.json` file in the project root directory by copying the example:

```bash
# Copy the example config file
cp app-config.example.json app-config.json
```

Edit `app-config.json` with your settings:

```json
{
  "checkpointsDir": "gs://your-bucket-name/path/to/checkpoints/",
  "currentKubeconfig": "your-environment-name",
  "kubeconfigs": {
    "your-environment-name": {
      "file": "kubeconfigs/your-environment.yaml",
      "namespace": "default",
      "uiDomain": "https://ui-your-environment.example.com/",
      "apiDomain": "https://api-your-environment.example.com/",
      "apiKey": "your-api-key-here"
    }
  }
}
```

**Important**:
- `app-config.json` is gitignored for security
- `checkpoint_mapping.json` must be obtained from your SambaNova contact and placed in the `app/data/` folder
- `checkpointsDir`: GCS checkpoint directory path relative to which the checkpoints in `checkpoint_mapping.json` can be found
- `currentKubeconfig`: Name of the currently selected environment
- `kubeconfigs`: Object containing all configured environments
  - Each environment has:
    - `file`: Path to kubeconfig file relative to sambawiz folder
    - `namespace`: Kubernetes namespace for this environment
    - `uiDomain`: Optional UI domain URL for the environment (used to create an API key)
    - `apiDomain`: API domain URL for the environment (required for Playground chat functionality)
    - `apiKey`: API key for environment-specific authentication (required for Playground chat functionality)
- The checkpoints directory is used to construct full checkpoint paths
- Configuration can be updated through the home page UI
- You can configure multiple environments in the `kubeconfigs` object

### 3. Configure Kubernetes Access

Place your kubeconfig files in the `kubeconfigs/` directory:

```bash
# Copy your kubeconfig to the kubeconfigs directory
cp /path/to/your/kubeconfig.yaml ./kubeconfigs/your-environment.yaml
```

Then add the environment to the `kubeconfigs` object in `app-config.json` with the corresponding file path, namespace, and optional API key.

**Important**:
- All files in the `kubeconfigs/` directory are gitignored for security (except `kubeconfig_example.yaml`)
- The application reads the kubeconfig file path from `app-config.json`
- The kubeconfig is validated on app startup using `helm list` to verify cluster connectivity
- If validation fails, an error alert is displayed with instructions to check your kubeconfig and network/VPN connection
- The SambaStack Helm version is displayed in the navigation sidebar when validation succeeds

### 4. Verify Configuration Files

The application uses several configuration files:

**VERSION File**: Contains version compatibility information in the project root:
- `app`: Current version of SambaWiz
- `minimum-sambastack-helm`: Minimum SambaStack Helm chart version required
- Version requirements are enforced during kubeconfig validation

**Data Configuration Files** in `app/data/`:
- `pef_mapping.json`: Maps model names to their available PEF configurations
- `checkpoint_mapping.json`: Maps model names to their checkpoint GCS paths (this is provided by your SambaNova contact)

These files are included with the application and typically don't require modification.

### 5. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

The home page will display the environment selector where you can choose your kubeconfig and namespace.

### 6. Build for Production

```bash
npm run build
npm start
```

## Features

### 1. Home
- **Prerequisites Validation**: Automatically checks kubeconfig validity and cluster connectivity
- **Environment Configuration**: Configure API keys, domains, and checkpoint directories for each environment
- **Multi-Environment Support**: Switch between multiple SambaStack environments seamlessly
- **Version Display**: Shows SambaStack Helm version in the navigation sidebar when connected

### 2. Bundle Builder
- **Model Selection**: Choose from multiple AI models including Meta-Llama and more
- **PEF Configuration**: Configure sequence sizes (16k, 32k, etc.) and batch sizes for each model
- **Automatic Checkpoint Mapping**: Models are automatically mapped to their corresponding checkpoints
- **YAML Generation**: Generates properly formatted Kubernetes manifests with BundleTemplate and Bundle resources
- **Editable YAML**: Manually edit generated YAML before validation
- **Bundle Validation**: Validate bundle deployability by applying resources to your cluster and checking their status

![Bundle Builder - Configuration](images/bundlebuilder1.png)
*Configure model settings, PEF parameters, and resource requirements*

![Bundle Builder - YAML Preview](images/bundlebuilder2.png)
*Review and edit generated YAML before validation*

### 3. Bundle Deployment
- **Deployment Management**: Deploy validated bundles to your Kubernetes cluster
- **Status Monitoring**: Real-time monitoring of deployment status including pod readiness
- **Error Reporting**: View detailed error messages and status conditions from the cluster
- **Deployment History**: Track all deployed bundles with creation timestamps

![Bundle Deployment](images/bundledeployment.png)
*Monitor deployment status and manage bundle lifecycle*

### 4. Playground
- **Interactive Chat Interface**: Test deployed models with an intuitive chat interface
- **Multi-Turn Conversations**: Full conversation history maintained for contextual responses
- **Performance Metrics**: Real-time display of tokens/second, total latency, and time-to-first-token
- **Code Examples**: View and copy cURL and Python code snippets with syntax highlighting
- **Model Selection**: Choose from available deployed models to interact with
- **Chat Management**: Clear conversation history to start fresh interactions

![Playground](images/playground.png)
*Interactive chat interface with performance metrics and code examples*
## Project Structure

```
sambawiz/
├── app/
│   ├── api/
│   │   ├── kubeconfig-validate/    # API endpoint for kubeconfig validation
│   │   └── validate/               # API endpoint for bundle validation
│   ├── components/
│   │   ├── AppLayout.tsx           # Main layout with navigation and version display
│   │   └── BundleForm.tsx          # Main form component
│   ├── data/
│   │   ├── pef_mapping.json        # Model to PEF mappings
│   │   └── checkpoint_mapping.json # Model to checkpoint mappings
│   ├── utils/
│   │   └── bundle-yaml-generator.ts # YAML generation logic
│   ├── lib/
│   │   └── emotion-cache.ts        # MUI styling cache
│   ├── types/
│   │   └── bundle.ts               # TypeScript interfaces
│   ├── theme.ts                    # MUI theme configuration
│   └── page.tsx                    # Home page
├── kubeconfigs/                    # Kubeconfig files (gitignored except example)
│   ├── your-kubeconfig-name.yaml   # Your kubeconfig (gitignored)
│   └── kubeconfig_example.yaml     # Example template
├── public/                         # Static assets
├── instrumentation.ts              # Server startup initialization
└── temp/                           # Temporary YAML files (gitignored)
```

## API Endpoints

### GET /api/kubeconfig-validate

Validates kubeconfig and retrieves SambaStack Helm version.

**Response (Success):**
```json
{
  "success": true,
  "version": "0.3.496"
}
```

**Response (Error):**
```json
{
  "success": false,
  "error": "Your kubeconfig.yaml seems to be invalid. Please check it and re-run the app. Also ensure that you are on the right network/VPN to access the server."
}
```

### POST /api/validate

Validates and applies a bundle YAML to the Kubernetes cluster.

**Request Body:**
```json
{
  "yaml": "apiVersion: sambanova.ai/v1alpha1\nkind: BundleTemplate\n..."
}
```

**Response:**
```json
{
  "success": true,
  "message": "Bundle validated and applied successfully",
  "applyOutput": "bundletemplate.sambanova.ai/bt-name created\nbundle.sambanova.ai/b-name created",
  "statusConditions": "Last Transition Time: ...\nMessage: ...",
  "bundleName": "b-name",
  "filePath": "/path/to/temp/bundle-123456.yaml"
}
```

## Technology Stack

- **Framework**: Next.js 15 (App Router)
- **UI Library**: Material-UI (MUI) v6
- **Language**: TypeScript
- **Styling**: Emotion (CSS-in-JS)
- **Backend**: Next.js API Routes with Node.js child_process for kubectl

## Development

```bash
# Run development server with hot reload
npm run dev

# Type checking
npm run type-check

# Linting
npm run lint

# Build for production
npm run build
```

## Testing

SambaWiz includes a comprehensive test suite covering business logic, API integration, and feature validation.

### Running Tests

```bash
# Run all automated tests
npm test

# Run tests in watch mode (auto-rerun on file changes)
npm test -- --watch

# Run tests with coverage report
npm test -- --coverage

# Run specific test file
npm test bundle-yaml-generator.test.ts

# Run tests for a specific directory
npm test app/utils/__tests__
```

### Test Documentation

Comprehensive test documentation is available at [app/utils/__tests__/TESTS.md](app/utils/__tests__/TESTS.md), which includes:
- Test philosophy and guidelines for writing new tests
- Detailed breakdown of all test categories
- Test coverage and statistics
- Manual integration test procedures for new features

### Test Coverage

The test suite focuses on critical business logic:
- ✅ Model availability and filtering logic
- ✅ Bundle YAML generation
- ✅ PEF configuration parsing and validation
- ✅ Deployment status calculation
- ✅ API integration for all page components
- ✅ Kubernetes integration tests
- ✅ Data transformations and error handling

Tests explicitly **do not** cover:
- ❌ UI rendering details
- ❌ Third-party libraries (Material-UI, React internals)
- ❌ Browser features

## Security Considerations

- `app-config.json` and all files in `kubeconfigs/` (except the example) are gitignored to prevent credential leaks
- Temporary YAML files stored in the `temp/` directory are also gitignored
- The validation endpoint runs kubectl commands server-side with appropriate timeouts
- Kubeconfig validation is performed on app startup to ensure cluster connectivity
- Consider implementing authentication/authorization for production deployments
- Never commit sensitive configuration files or credentials to version control
- Use `app-config.example.json` as a template (safe to commit)

## Troubleshooting

### Configuration Issues

**Problem: Application fails to start or shows configuration errors**

1. **Verify `app-config.json` exists**
   - The `app-config.json` file must exist in the sambawiz folder root directory
   - If it doesn't exist, create it by copying the example file:
     ```bash
     cp app-config.example.json app-config.json
     ```

2. **Check `app-config.json` fields**
   - Ensure all required fields are populated:
     - `checkpointsDir`: Must be set to a valid GCS bucket path that serves as a root folder for the relative paths in `checkpoint_mapping.json`. If this path is invalid, you will see an error in your cache pod logs during deployment: `[CRITICAL] Failed to access source storage`
     - `currentKubeconfig`: Must match an environment name in the `kubeconfigs` object
     - `kubeconfigs`: Must contain at least one environment with:
       - `file`: Path to a kubeconfig file (e.g., `kubeconfigs/your-environment.yaml`)
       - `namespace`: Kubernetes namespace for the environment
       - `apiDomain`: Required for Playground functionality
       - `apiKey`: Required for Playground functionality

3. **Verify kubeconfig files exist**
   - Ensure the kubeconfig file specified in `app-config.json` exists at the specified path
   - Example: If `file` is `"kubeconfigs/production.yaml"`, verify the file exists at `./kubeconfigs/production.yaml`
   - The kubeconfig file must be valid and contain proper cluster credentials

### Version Compatibility Issues

**Problem: Kubeconfig validation fails or version mismatch errors**

1. **Check SambaStack Helm version**
   - Verify your SambaStack Helm chart version meets the minimum requirement
   - Minimum required version: as specified in the [VERSION](VERSION) file
   - To check your current SambaStack Helm version:
     ```bash
     helm list --kubeconfig ./kubeconfigs/your-environment.yaml -n <namespace>
     ```
   - Look for the SambaStack chart in the output and verify the CHART VERSION column
   - If your version is below the minimum, upgrade your SambaStack deployment

2. **Check Node.js and npm versions**
   - Minimum required Node.js version: **18+** (as specified in Prerequisites)
   - To check your current versions:
     ```bash
     node --version
     npm --version
     ```
   - If your versions are below the minimum, upgrade Node.js and npm:
     - Visit [nodejs.org](https://nodejs.org/) for installation instructions
     - npm is typically included with Node.js

### Connection Issues

**Problem: Kubeconfig validation fails with connection errors**

- Ensure you are connected to the correct network or VPN required to access your Kubernetes cluster
- Verify that `kubectl` and `helm` are installed and accessible in your PATH:
  ```bash
  kubectl version --client
  helm version
  ```
- Test cluster connectivity manually:
  ```bash
  kubectl get nodes --kubeconfig ./kubeconfigs/your-environment.yaml
  ```

### Common Error Messages

- **"Your kubeconfig.yaml seems to be invalid"**: Check that the kubeconfig file exists, is properly formatted YAML, and contains valid cluster credentials
- **"Version mismatch"**: Your SambaStack Helm version is below the minimum required version (as specified in the [VERSION](VERSION) file)
- **"Cannot find module" or "ENOENT"**: The kubeconfig file path in `app-config.json` is incorrect or the file doesn't exist
- **"Connection refused" or "timeout"**: Check your network/VPN connection and cluster accessibility

---

---

<div align="center">

# ⌨️ SambaWiz CLI

### Interactive terminal interface for SambaStack bundle management — no browser needed

![CLI](https://img.shields.io/badge/interface-CLI-6C3FC4?style=for-the-badge)
![Version](https://img.shields.io/badge/version-1.4.0-412AA0?style=for-the-badge)
![Node](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white)

</div>

---

## CLI Contents

- [CLI Overview](#cli-overview)
- [CLI Navigation](#cli-navigation)
- [CLI Prerequisites](#cli-prerequisites)
- [CLI Quick Start](#cli-quick-start)
- [CLI Menus](#cli-menus)
  - [Main Menu](#main-menu)
  - [Add / Edit Environment](#add--edit-environment-cli)
  - [Validate Setup & Environment](#validate-setup--environment-cli)
  - [Bundle Builder](#bundle-builder-cli)
  - [Bundle Deployment](#bundle-deployment-cli)
  - [Check Deployment Progress](#check-deployment-progress-cli)
  - [Playground — Chat Console](#playground--chat-console-cli)
- [CLI Configuration Reference](#cli-configuration-reference)
- [CLI npm Scripts](#cli-npm-scripts)
- [CLI Troubleshooting](#cli-troubleshooting)

---

## CLI Overview

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

## CLI Navigation

| Key | Action |
|---|---|
| `↑` `↓` | Move cursor up / down |
| `Enter` | Select / confirm |
| `Space` | Toggle checkbox *(multi-select menus only)* |
| `q` or `Esc` | Go back / cancel |
| `Ctrl+C` | Force exit |

---

## CLI Prerequisites

| Requirement | Details |
|---|---|
| Node.js | 18+ |
| `kubectl` | Installed and on `PATH` |
| `helm` | Installed and on `PATH` |
| Kubernetes cluster | SambaStack installed, Helm chart ≥ `0.5.6` |
| `app-config.json` | Configured with at least one valid environment |
| Kubeconfig file | Valid `.yaml` placed in the `kubeconfigs/` directory |

---

## CLI Quick Start

### Step 1 — Install dependencies

```bash
cd sambawiz
npm install
```

### Step 2 — Create your config file

```bash
cp app-config.example.json app-config.json
```

Edit `app-config.json`:

```json
{
  "checkpointsDir": "gs://your-bucket/path/to/checkpoints/",
  "currentKubeconfig": "my-env",
  "kubeconfigs": {
    "my-env": {
      "file": "kubeconfigs/my-env.yaml",
      "namespace": "default",
      "apiDomain": "https://api.my-env.example.com/",
      "apiKey": "your-api-key-here",
      "uiDomain": "https://ui.my-env.example.com/"
    }
  }
}
```

> **Important:** `app-config.json` is gitignored. Never commit it — it contains cluster credentials.

### Step 3 — Add your kubeconfig

```bash
cp /path/to/your/kubeconfig.yaml ./kubeconfigs/my-env.yaml
```

> All files inside `kubeconfigs/` are gitignored except `kubeconfig_example.yaml`.

### Step 4 — Launch the CLI

```bash
npm run dev-cli
```

---

## CLI Menus

### Main Menu

The main menu appears after launch and shows the active environment in brackets.

```
  › Main Menu  [my-env]
  ↑↓ navigate   Enter select   q / Esc to go back

  ▶  ➕  Add / Edit Environment
       Manage kubeconfig environments

     🧭  Validate Setup & Environment
       Check kubeconfig, helm, API key

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

Select any option with `Enter`. The environment badge updates automatically when you switch environments.

---

### Add / Edit Environment (CLI)

Manage all environments in `app-config.json` without editing the file directly.

#### Step 1 — Select environment or add new

```
  › Select environment:

  ▶  ➕  Add new environment

     ●  my-env  ← active
     ○  staging-env

     ← Back
```

| Entry | Description |
|---|---|
| `➕ Add new environment` | Opens guided prompts to create a new entry |
| `● name ← active` | Currently selected environment |
| `○ name` | Another configured environment |

#### Step 2 — Choose action for an existing environment

```
  › my-env:

  ▶  ✏️   Edit
     🗑️   Delete
     ← Back
```

---

#### Adding a New Environment

Select **➕ Add new environment** and fill in each prompt. Press `Esc` at any field to cancel without saving.

```
  › Environment name  Esc cancel: my-env

  › Kubeconfig file path (relative to project root)  Esc cancel: kubeconfigs/my-env.yaml

  › Namespace  (default)  Esc cancel: default

  › API Domain (optional)  Esc cancel: https://api.my-env.example.com/

  › API Key (optional)  Esc cancel:
```

| Field | Required | Description |
|---|---|---|
| Environment name | Yes | Key used in `kubeconfigs` object |
| Kubeconfig file path | Yes | Relative to project root, e.g. `kubeconfigs/my-env.yaml` |
| Namespace | Yes | Kubernetes namespace (defaults to `default`) |
| API Domain | No | Required for Playground chat |
| API Key | No | Required for Playground chat |

On success:

```
  ✅ Environment "my-env" added.
```

---

#### Editing an Environment

Select an existing environment → **✏️ Edit**. Each field shows the current value as a default — press `Enter` to keep it or type a new value.

```
  Editing: my-env  (Enter to keep current value)

  › Kubeconfig file  (kubeconfigs/my-env.yaml)  Esc cancel:
  › Namespace  (default)  Esc cancel:
  › API Domain  (https://api.my-env.example.com/)  Esc cancel:
  › API Key  (abcd••••1234)  Esc cancel:
```

On success:

```
  ✅ Environment "my-env" updated.
```

---

#### Deleting an Environment

Select an existing environment → **🗑️ Delete**. A confirmation prompt prevents accidental deletion.

```
  › Delete environment "my-env"? [y/N]  Esc cancel:
```

> **Note:** If you delete the active environment, the CLI automatically switches to the next available one. If none remain, `currentKubeconfig` is set to `null` and you must add a new environment.

---

### Validate Setup & Environment (CLI)

Runs a full connectivity and configuration check for any environment.

#### Step 1 — Select environment to validate

```
  › Select environment to validate:

  ▶  ● my-env       ns:default  ← active
     ○ staging-env  ns:staging
     ← Back
```

Environments with a missing kubeconfig are flagged:

```
     ● broken-env   ns:default  kubeconfig missing
```

#### Step 2 — Validation results

```
  Environment    my-env
  Namespace      default
  ────────────────────────────────────────────────────────

  ✔  Kubeconfig         kubeconfigs/my-env.yaml
  ✔  Helm               v3.14.0+g4f8a2b1
  ✔  Kubernetes         connection OK
  ⚠  Namespace          using default

  API Domain     https://api.my-env.example.com/
  API Key        abcd••••••••1234

  ✔  API reachable      (12 models)
       DeepSeek-R1-0528, Llama-4-Maverick-17B +10 more
  ✔  API key valid      (tested with DeepSeek-R1-0528)

  ────────────────────────────────────────────────────────
  ✅ All checks passed!
```

| Icon | Meaning |
|---|---|
| `✔` | Check passed |
| `✖` | Check failed |
| `⚠` | Warning (non-blocking) |

| Check | What is verified |
|---|---|
| Kubeconfig | File exists at the configured path |
| Helm | `helm` binary found on `PATH` |
| Kubernetes | `kubectl cluster-info` responds within 8 s |
| Namespace | Namespace exists on cluster (skipped for `default`) |
| API Domain | `GET /v1/models` returns HTTP 2xx |
| API Key | `POST /v1/chat/completions` passes authentication |
| UI Domain *(optional)* | HTTP reachable if `uiDomain` is set |

---

### Bundle Builder (CLI)

Guides you through selecting models, configuring PEF settings, generating YAML, and optionally applying the bundle to the cluster.

#### Workflow

```
  Select models  →  Select PEF configs  →  Optional draft model
        ↓
  Bundle summary  →  YAML preview  →  Name the bundle
        ↓
  Edit / Save / Continue  →  Apply to cluster? (optional)
        ↓
  Poll validation status (up to 90 s)
```

---

#### Step 1 — Select models

```
  › Bundle Builder  (0 added)

  ▶  ✅  Finish and Create Bundle

     DeepSeek-R1-0528
     DeepSeek-R1
     Llama-4-Maverick-17B-128E-Instruct
     Meta-Llama-3.1-405B-Instruct
     Qwen2.5-72B-Instruct
     ...

     ✕  Cancel
```

- Select a model to configure its PEF settings
- Add as many models as needed to the same bundle
- Select **✅ Finish and Create Bundle** when done
- Select **✕ Cancel** or press `q` / `Esc` to exit

---

#### Step 2 — Select PEF configurations

A multi-select list shows all available PEF configs for the chosen model:

```
  › Configurations for DeepSeek-R1-0528:
  Space toggle   Enter confirm   q / Esc to go back

   ❯  ○  SS: 128k  │ BS: 8   │ deepseek-ss131072-bs8
      ○  SS: 16k   │ BS: 1   │ deepseek-ss16384-bs1
      ○  SS: 32k   │ BS: 4   │ deepseek-ss32768-bs4
      ✅  Done - Confirm Selection
      ✕  Back
```

| Column | Meaning |
|---|---|
| SS | Sequence size (context window) |
| BS | Batch size (throughput vs latency trade-off) |
| PEF name | Internal Processor Executable Format identifier |

- `Space` to toggle (`◉` selected / `○` unselected)
- `Enter` on **Done** to confirm selections
- `Enter` on **Back** or press `q` / `Esc` to return without adding

---

#### Step 3 — Draft model for speculative decoding *(optional)*

If the selected model supports speculative decoding, you are offered a draft model:

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

When a draft model is selected, matching SS/BS configs are added automatically:

```
  ✅ Auto-added 1 draft config(s) for DeepSeek-R1
     Note: matched configs — SS:128k BS:8
```

---

#### Step 4 — Bundle summary & YAML preview

```
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
```

Confirm to proceed:

```
  › Proceed with this bundle? [Y/n]  Esc cancel:
```

---

#### Step 5 — Name the bundle

```
  › Bundle name  (my-bundle-4721)  Esc cancel: deepseek-prod
```

Sets resource names:
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
| 💾 Save to file | Prompts for filename and writes the YAML |
| ⏭️ Continue to deploy | Proceeds without saving |
| ✕ Cancel | Exits without applying |

---

#### Step 7 — Apply to cluster *(optional)*

```
  › Apply to cluster to validate? [Y/n]  Esc cancel:
```

If confirmed, the CLI runs `kubectl apply` and polls bundle status every 3 s:

```
  ◉  Pending  ValidationInProgress: Checking PEF files  [9s]
  ◉  Ready    ValidationSucceeded: All checks passed    [21s]

  ✅ Bundle Validation Succeeded!
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

### Bundle Deployment (CLI)

Deploy and delete bundle resources on the cluster.

#### Current deployments summary

Every visit shows the current cluster state at the top:

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

| Icon | Status |
|---|---|
| `●` green | Running / Deployed |
| `◌` yellow | Pending |
| `○` red | Not running |

---

#### Deploying a Bundle

**1 — Select bundle**

```
  ℹ  Found 3 bundle(s)

  · b-deepseek-prod    ✔ valid
  · b-llama-staging    ⚠ unvalidated
  · b-qwen-test        ✔ valid

  › Select bundle to deploy:

  ▶  ● b-deepseek-prod    validated
     ○ b-llama-staging    unvalidated
     ← Back
```

**2 — Deployment YAML preview**

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

**3 — Confirm and deploy**

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

**2 — Select resources (multi-select)**

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

> **Warning:** Deletion is permanent and immediate. There is no undo.

---

### Check Deployment Progress (CLI)

Live monitor for a `BundleDeployment`. Polls pod status every 5 s.

#### Step 1 — Select deployment

```
  ℹ  Found 2 deployment(s)

  › Select deployment to monitor:

  ▶  ● bd-deepseek-prod
     ● bd-qwen-test
     ← Back
```

#### Step 2 — Live status display

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
  ●  Deployed     elapsed: 3m 0s
  ────────────────────────────────────────
  Cache pod         ✔ 1/1   Running    age: 3m
  Inference pod     ✔ 1/1   Running    age: 3m

  ✅  Deployment is fully ready!
```

| Status | Meaning |
|---|---|
| `● Deployed` | Both cache and inference pods are ready |
| `◌ Deploying` | Pods exist but not all containers are ready |
| `○ Not Deployed` | No matching pods found |

Press `q` or `Esc` to stop monitoring and return to the menu.

---

### Playground — Chat Console (CLI)

Interactive chat with a deployed model directly from the terminal.

#### Step 1 — Select bundle

```
  ℹ  Found 2 deployment(s)

  › Select deployed bundle to chat with:

  ▶  ●  bd-deepseek-prod
     ●  bd-qwen-test
        ✏️  Enter model name manually
     ← Back
```

Only **fully deployed** bundles appear. Bundles still deploying are listed with their current status:

```
  ⚠ No fully deployed bundles ready.
  Current status:
  ◌  bd-llama-staging   Deploying
  ○  bd-qwen-test       Not Deployed

  › Model name manually (leave empty to go back)  Esc cancel:
```

#### Step 2 — Select model

If a bundle contains multiple models:

```
  › Select model from bd-deepseek-prod:

  ▶  DeepSeek-R1
     DeepSeek-R1-0528
     ← Back
```

If the bundle has exactly one model, it is selected automatically:

```
  ●  Using model: DeepSeek-R1-0528
```

#### Step 3 — Chat session

```
  ╭────────────────────────────────────────────────────────────╮
  │ 🤖  Chatting with DeepSeek-R1-0528                         │
  │ q / Esc  or type 'exit' to return to menu                  │
  ╰────────────────────────────────────────────────────────────╯

  › You  Esc cancel: Explain quantum entanglement simply.

  ◌  Thinking...

  ◈  Assistant  14:32
  ──────────────────────────────────────────────────────────────
  Quantum entanglement is when two particles become linked
  so that measuring one instantly affects the other, no matter
  how far apart they are...
  ──────────────────────────────────────────────────────────────

  › You  Esc cancel:
```

| Feature | Detail |
|---|---|
| Multi-turn history | Full conversation context sent with every message |
| `<think>` stripping | DeepSeek-R1 chain-of-thought blocks removed from output |
| Timestamp | Each response shows the local time |
| Error handling | HTTP errors shown inline with suggested fixes |

**To exit:** type `exit`, `quit`, `q`, or `/back` — or press `Esc`.

---

## CLI Configuration Reference

### `app-config.json` top-level fields

| Field | Type | Required | Description |
|---|---|---|---|
| `checkpointsDir` | string | **Yes** | GCS path prefix. Must end with `/` |
| `currentKubeconfig` | string | **Yes** | Name of the active environment |
| `kubeconfigs` | object | **Yes** | Map of environment name → config |
| `checkpoint_overrides` | object | No | Override checkpoint version per model |

### Per-environment fields

| Field | Type | Required | Description |
|---|---|---|---|
| `file` | string | **Yes** | Kubeconfig YAML path relative to project root |
| `namespace` | string | **Yes** | Kubernetes namespace |
| `apiDomain` | string | Playground | API base URL e.g. `https://api.example.com/` |
| `apiKey` | string | Playground | Bearer token for API requests |
| `uiDomain` | string | No | SambaStack UI URL (optional connectivity check) |

---

## CLI npm Scripts

| Script | Description |
|---|---|
| `npm run dev-cli` | **Run the CLI** (TypeScript, no compile step needed) |
| `npm run cli:watch` | Run CLI with auto-restart on file changes |
| `npm run cli:type-check` | Type-check CLI without running |
| `npm run cli:lint` | Lint the CLI source file |

---

## CLI Troubleshooting

**`app-config.json` not found**

```bash
cp app-config.example.json app-config.json
```

The file must be in the project root (`sambawiz/`).

---

**Kubeconfig file not found**

Verify the `file` path in `app-config.json` resolves correctly:

```bash
ls -la kubeconfigs/
```

Paths are relative to project root — e.g. `kubeconfigs/my-env.yaml`.

---

**Kubernetes connection fails / times out**

```bash
kubectl get nodes --kubeconfig ./kubeconfigs/my-env.yaml
kubectl version --client
helm version
```

Ensure you are on the correct network or VPN. The CLI uses an 8-second timeout.

---

**Playground API errors**

| HTTP code | Cause |
|---|---|
| 401 / 403 | `apiKey` invalid or expired — update in `app-config.json` |
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

</div>
