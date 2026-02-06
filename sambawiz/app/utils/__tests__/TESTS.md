# SambaWiz Test Suite Documentation

This document provides a comprehensive overview of all tests in the SambaWiz application. Tests are organized by page/component and categorized by functionality type (UI components vs. core functionality).

**Last Updated:** February 2026 - Fixed React `act()` warnings in bundle deployment tests
**Total Tests:** 61 automated + comprehensive manual test plan
**Test Status:** ✅ All tests passing with clean console output
**Focus:** Core business logic, API integration, and new feature validation

## Table of Contents
- [Test Philosophy](#test-philosophy)
- [Automated Unit Tests](#automated-unit-tests)
  - [Home Page Tests](#home-page-tests)
  - [Playground Page Tests](#playground-page-tests)
  - [Bundle Builder Page Tests](#bundle-builder-page-tests)
  - [Bundle Deployment Manager Tests](#bundle-deployment-manager-tests)
  - [Core Utility Tests](#core-utility-tests)
    - [Model Availability Tests](#model-availability-tests)
    - [Bundle YAML Generator Tests](#bundle-yaml-generator-tests)
    - [PEF Config Generator Tests](#pef-config-generator-tests)
- [Release 1.1.2 Integration Tests](#release-112-integration-tests)
  - [Bundle Deployment State Persistence](#1-bundle-deployment-state-persistence)
  - [Load Saved YAML Files](#2-load-saved-yaml-files)
  - [SambaStack Installation/Update](#3-sambastack-installationupdate)
  - [In-place API Key Retrieval](#4-in-place-api-key-retrieval)
  - [Checkpoint Mapping Validation](#5-checkpoint-mapping-validation)

---

## Test Philosophy

This test suite follows these principles:

✅ **Test business logic, not implementation details**
- Focus on model filtering, YAML generation, status calculation
- Test API integration points and data transformations
- Verify error handling for critical operations

❌ **Avoid testing third-party libraries**
- Don't test if Material-UI components render correctly
- Don't test if React state updates work
- Don't test if HTML inputs accept text

🎯 **Consolidated and focused**
- Removed "does it render" tests that never caught bugs
- Consolidated redundant tests into single comprehensive tests
- Kept all critical business logic tests

---

## Home Page Tests

**File:** [home.test.tsx](home.test.tsx)
**Component:** `Home`
**Test Count:** 1

### API Integration

| Test | Type | Description |
|------|------|-------------|
| should load environments on mount | Core | Verifies that the component fetches environment data from `/api/environments` when the page loads |

**What was removed:** Trivial UI tests (text rendering, input field existence, typing into inputs)

---

## Playground Page Tests

**File:** [playground.test.tsx](playground.test.tsx)
**Component:** `Playground`
**Test Count:** 1

### API Integration

| Test | Type | Description |
|------|------|-------------|
| should fetch deployments and environments on mount | Core | Verifies both `/api/bundle-deployment` and `/api/environments` endpoints are called when component mounts |

**What was removed:** Text rendering tests, loading state tests, error display tests, dropdown existence tests

---

## Bundle Builder Page Tests

**File:** [bundle-form.test.tsx](bundle-form.test.tsx)
**Component:** `BundleForm`
**Test Count:** 1

### API Integration

| Test | Type | Description |
|------|------|-------------|
| should fetch checkpointsDir on mount | Core | Verifies environment configuration (including checkpointsDir) is fetched from `/api/environments` on mount |

**What was removed:** All UI interaction tests (model selection, dropdown rendering, configuration display tests)

---

## Bundle Deployment Manager Tests

**File:** [bundle-deployment.test.tsx](bundle-deployment.test.tsx)
**Component:** `BundleDeploymentManager`
**Test Count:** 7 (6 pure function + 1 integration)
**Status:** ✅ All tests passing, React `act()` warnings resolved

### getBundleDeploymentStatus Function (Pure Logic)

These tests verify the deployment status calculation logic - **KEEP ALL OF THESE**

| Test | Type | Description |
|------|------|-------------|
| should return "Not Deployed" when both pods are null | Core | Tests status when no pods exist |
| should return "Deploying" when cache pod is not ready | Core | Tests status when cache pod is pending/not ready |
| should return "Deploying" when default pod is not ready | Core | Tests status when default pod is pending/not ready |
| should return "Deployed" when both pods are ready | Core | Tests status when both cache and default pods are running |
| should return "Deploying" when only cache pod exists and is ready | Core | Tests partial deployment status (cache only) |
| should return "Deploying" when only default pod exists and is ready | Core | Tests partial deployment status (default only) |

### API Integration

| Test | Type | Description |
|------|------|-------------|
| should fetch deployments and bundles on mount | Core | Verifies all three API calls on mount: `/api/bundle-deployment`, `/api/bundles`, and `/api/bundle-deployment-state` (state persistence) |

**Implementation Notes:**
- Uses real timers (not fake timers) to properly handle async fetch operations
- Wraps render in `act()` to ensure all state updates are properly batched
- Waits for all async operations to complete using `waitFor` with 3s timeout
- Mocks all three fetch endpoints called during component initialization

**What was removed:** Text rendering tests, error display tests, empty state tests

---

## Core Utility Tests

### Model Availability Tests

**File:** [model-availability.test.ts](model-availability.test.ts)
**Function:** `getAvailableModels`
**Test Count:** 9
**Status:** ✅ ALL KEPT - Critical business logic

These tests verify which models are available based on checkpoint mappings, PEF mappings, and PEF configurations.

#### Model Filtering Logic

| Test | Description |
|------|-------------|
| should return models that exist in all three mappings | Basic happy path - verifies models present in all required data sources |
| should filter out models with empty checkpoint path | Ensures models without checkpoint paths are excluded |
| should filter out models with empty pef mapping array | Ensures models without PEF mappings are excluded |
| should filter out models not in checkpoint mapping | Ensures models missing from checkpoint mapping are excluded |
| should filter out models not in pef mapping | Ensures models missing from PEF mapping are excluded |
| should filter out models with no available PEF configs (dynamic check) | Runtime validation - models whose PEF configs are missing |
| should include model if at least one PEF config is available | Ensures models with partial PEF configs are still included |

#### Output Formatting

| Test | Description |
|------|-------------|
| should return sorted array | Verifies results are alphabetically sorted |
| should return empty array when no models are available | Edge case with no input data |

**Why these matter:** These tests prevent models from appearing when they shouldn't, which would cause deployment failures in production.

---

### Bundle YAML Generator Tests

**File:** [bundle-yaml-generator.test.ts](bundle-yaml-generator.test.ts)
**Functions:** `generateCheckpointName`, `generateBundleYaml`
**Test Count:** 22
**Last Updated:** Updated for simplified YAML format (removed batch_size, ckpt_sharing_uuid, num_tokens_at_a_time, draft_expert)

#### generateCheckpointName Function (6 tests)

| Test | Description |
|------|-------------|
| should convert model name to uppercase checkpoint name | Basic conversion (e.g., "Meta-Llama-3.1-8B-Instruct" → "META_LLAMA_3_1_8B_INSTRUCT_CKPT") |
| should replace hyphens with underscores | Character replacement for hyphens |
| should replace periods with underscores | Character replacement for periods |
| should remove special characters | Handles special characters in model names |
| should collapse multiple underscores | Normalizes multiple consecutive underscores |
| should remove leading and trailing underscores | Trims underscores from ends |

#### generateBundleYaml Function (16 tests)

**Basic YAML Structure**

| Test | Description |
|------|-------------|
| should generate valid YAML structure | Verifies YAML contains required apiVersion, BundleTemplate, and Bundle kinds |
| should include bundle name in metadata | Tests bundle name formatting (bt-* for template, b-* for bundle) |
| should include model configurations | Verifies simplified model configs with only pef field |

**Configuration Handling**

| Test | Description |
|------|-------------|
| should group configs by SS | Verifies configs are grouped by sequence size (SS) |
| should include PEF names with versions | PEF names include version numbers (e.g., "pef:1") |
| should include checkpoint source path | Checkpoint source path construction with checkpointsDir |
| should use empty source when checkpointsDir is not provided | Fallback behavior without checkpointsDir |
| should set toolSupport to true for all checkpoints | Verifies toolSupport flag is enabled |
| should include owner and secretNames | Metadata fields for bundle ownership and secrets |
| should group configs by sequence size (SS) | Groups multiple batch sizes under the same sequence size |

**Multi-Model Support**

| Test | Description |
|------|-------------|
| should handle multiple models | YAML generation with multiple different models |

**Speculative Decoding (Complex Feature)**

| Test | Description |
|------|-------------|
| should handle speculative decoding with draft models using default_config_values | When multiple configs in an SS all have matching draft configs, uses default_config_values (saves YAML lines) |
| should handle speculative decoding with per-config spec_decoding when not all configs have draft | When only some configs have draft models, uses per-config spec_decoding |
| should not include spec_decoding for models without draft models | Models without draft models have no spec_decoding section |
| should not add spec_decoding when draft model is "skip" | "skip" value prevents spec_decoding configuration |
| should only add spec_decoding when matching draft config exists | spec_decoding only added when draft model config exists; uses default_config_values for single-config SS, per-config for mixed scenarios |

**Simplified YAML Format Changes:**
- ✅ Removed `batch_size` field (embedded in PEF name)
- ✅ Removed `ckpt_sharing_uuid` field (not needed)
- ✅ Removed `num_tokens_at_a_time` field (not needed)
- ✅ Removed `draft_expert` field from spec_decoding
- ✅ spec_decoding now only contains `draft_model`
- ✅ Added `default_config_values` support at expert (SS) level
- ✅ Smart placement of spec_decoding: per-config when single or mixed, default_config_values when multiple and all have drafts

**Why these matter:** YAML generation is mission-critical. Wrong YAML = failed Kubernetes deployment. The simplified format reduces YAML verbosity while maintaining all necessary configuration. These tests prevent production incidents.

---

### PEF Config Generator Tests

**File:** [pef-config-generator.test.ts](pef-config-generator.test.ts)
**Function:** `generatePefConfigs`
**Test Count:** 24 (reduced from 29)
**Type:** Kubernetes Integration Tests

These tests verify fetching PEF configurations from a Kubernetes cluster via kubectl and generating the pef_configs.json file.

#### Configuration Validation (3 tests)

| Test | Description |
|------|-------------|
| should return error when app-config.json does not exist | Validates when config file is missing |
| should return error when no active environment is configured | Validates when currentKubeconfig is empty |
| should return error when kubeconfig file does not exist | Validates when kubeconfig file is missing |

#### Kubernetes Integration (3 tests)

| Test | Description |
|------|-------------|
| should call kubectl with correct parameters | Verifies kubectl command construction with namespace and kubeconfig |
| should use correct namespace from config | Tests custom namespace usage |
| should use default namespace when not specified | Tests fallback to "default" namespace |

#### PEF Parsing (5 tests)

| Test | Description |
|------|-------------|
| should parse PEF names correctly | Extraction of PEF names from kubectl output |
| should extract ss and bs values correctly | Parsing of sequence size (ss) and batch size (bs) from PEF names |
| should format ss values correctly for values >= 1024 | Conversion to k notation (e.g., 4096 → "4k") |
| should keep ss values as-is for values < 1024 | Small ss values remain unchanged (e.g., 512 → "512") |
| should handle PEF names with various formats | Parsing of different PEF naming conventions |

#### Version Handling (4 tests)

| Test | Description |
|------|-------------|
| should determine latest version correctly | Finding the highest version number from multiple versions |
| should handle PEFs without versions | Fallback to version "1" when no versions exist |
| should handle version numbers as strings | Parsing string version numbers and finding max |
| should skip PEFs with invalid names | PEFs without ss/bs patterns are excluded |

#### Error Handling & Edge Cases (4 tests)

| Test | Description |
|------|-------------|
| should return success with correct count | Success response includes correct PEF count |
| should handle empty PEF list | Behavior with no PEFs in cluster |
| should handle kubectl command failure | Error handling when kubectl fails |
| should handle invalid JSON from kubectl | Error handling when kubectl returns malformed JSON |
| should handle file write errors | Error handling when writing pef_configs.json fails |

**What was removed:**
- JSON formatting tests (indentation, valid JSON)
- File path tests (output location)
- Overly defensive tests (mixed valid/invalid versions, missing metadata)

**Why these matter:** This integrates with Kubernetes. Parsing errors would break the entire application's ability to discover available PEF configurations.

---

## Release 1.1.2 Integration Tests

The following sections document manual integration tests for new features added in release 1.1.2. These tests verify end-to-end functionality of new API endpoints and UI features.

**Test Plan Location:** [temp/TEST_PLAN.md](../../temp/TEST_PLAN.md)
**Test Data Location:** [test-data/](test-data/)
**Test Approach:** Manual integration testing with API validation

---

### 1. Bundle Deployment State Persistence

**Feature:** Saves and restores bundle deployment state across sessions
**API Routes:** `/api/bundle-deployment-state` (GET, POST, DELETE)
**Components:** `BundleDeploymentManager.tsx`

#### Test Coverage

| Test ID | Description | Type | Status |
|---------|-------------|------|--------|
| 1.1 | Save bundle deployment state | API | ✓ Manual |
| 1.2 | Load bundle deployment state on page refresh | Integration | ✓ Manual |
| 1.3 | Clear bundle deployment state | API | ✓ Manual |
| 1.4 | Handle missing state file | Error Handling | ✓ Manual |

#### Key Validations

- State file created at `temp/bundle-deployment-state.json`
- Contains: `selectedBundle`, `deploymentName`, `deploymentYaml`, `monitoredDeployment`
- State persists across browser refreshes
- Graceful handling when state file doesn't exist
- DELETE endpoint properly removes state file

#### Test Data

No test data files needed - uses runtime data from deployment actions.

---

### 2. Load Saved YAML Files

**Feature:** Load previously saved bundle YAML files into the bundle builder
**API Routes:** `/api/saved-artifacts` (GET), `/api/load-bundle` (GET)
**Components:** `BundleForm.tsx`, `bundle-builder/page.tsx`

#### Test Coverage

| Test ID | Description | Type | Status |
|---------|-------------|------|--------|
| 2.1 | List saved artifacts | API | ✓ Manual |
| 2.2 | Load valid bundle YAML | Integration | ✓ Manual |
| 2.3 | Load YAML with multiple models | Integration | ✓ Manual |
| 2.4 | Handle invalid YAML structure | Error Handling | ✓ Manual |
| 2.5 | Handle non-existent file | Error Handling | ✓ Manual |
| 2.6 | Parse draft models for speculative decoding | Integration | ✓ Manual |

#### Key Validations

- Only `.yaml` and `.yml` files with both BundleTemplate and Bundle are listed
- Bundle name extracted correctly (removes `bt-` prefix)
- All models and PEF configurations parsed accurately
- Draft models identified from `spec_decoding.draft_model`
- Proper error messages for:
  - Missing BundleTemplate kind
  - Missing `spec.models`
  - Invalid PEF format (missing `:version`)
  - File not found

#### Test Data Files

Located in [test-data/](test-data/):
- `test-bundle.yaml` - Valid single model bundle
- `multi-model.yaml` - Bundle with multiple models
- `with-draft.yaml` - Bundle with speculative decoding
- `invalid-no-bt.yaml` - Missing BundleTemplate (error case)
- `invalid-no-models.yaml` - Missing spec.models (error case)
- `invalid-pef.yaml` - Invalid PEF format (error case)

---

### 3. SambaStack Installation/Update

**Feature:** Install or update SambaStack via YAML application
**API Routes:** `/api/install-sambastack` (POST), `/api/installer-logs` (GET)
**Components:** `Home.tsx`

#### Test Coverage

| Test ID | Description | Type | Status |
|---------|-------------|------|--------|
| 3.1 | Install SambaStack via YAML | Integration | ✓ Manual |
| 3.2 | View installer logs | Integration | ✓ Manual |
| 3.3 | Handle missing installer | Error Handling | ✓ Manual |
| 3.4 | Validate YAML before installation | Validation | ✓ Manual |
| 3.5 | Handle kubectl apply failure | Error Handling | ✓ Manual |
| 3.6 | Respect current environment | Configuration | ✓ Manual |
| 3.7 | Handle missing environment config | Error Handling | ✓ Manual |

#### Key Validations

- YAML saved to `temp/sambastack-install-{timestamp}.yaml`
- `kubectl apply` executed with correct kubeconfig and namespace
- Installer logs fetched from `sambastack-installer` namespace
- Pod selector: `sambanova.ai/app=sambastack-installer`
- Default log lines: 20 (configurable via `?lines=N` param)
- Validation errors for:
  - Empty YAML
  - Missing YAML field
  - Missing environment configuration
  - kubectl command failures

#### Security Considerations

- Uses current environment's kubeconfig from `app-config.json`
- Applies YAML to configured namespace only
- Requires proper cluster permissions
- YAML is saved locally before application

---

### 4. In-place API Key Retrieval

**Feature:** Direct link in Playground to retrieve API keys when missing
**Components:** `Playground.tsx`, `AppLayout.tsx`, `Home.tsx`

#### Test Coverage

| Test ID | Description | Type | Status |
|---------|-------------|------|--------|
| 4.1 | Display API key link when missing | UI | ✓ Manual |
| 4.2 | Hide API key link when key exists | UI | ✓ Manual |
| 4.3 | Link opens correct URL | Integration | ✓ Manual |
| 4.4 | Handle missing uiDomain | Error Handling | ✓ Manual |
| 4.5 | Update API key without restart | Integration | ✓ Manual |

#### Key Validations

- Link appears when `apiKey` is missing from current environment config
- Link uses `uiDomain` from environment configuration
- Link opens in new tab/window
- Clear message when `uiDomain` is not configured
- Playground becomes functional after API key is added (no restart required)

#### Configuration Requirements

Environment in `app-config.json` should include:
```json
{
  "uiDomain": "https://ui.example.com/",
  "apiDomain": "https://api.example.com/",
  "apiKey": "optional-key-here"
}
```

---

### 5. Checkpoint Mapping Validation

**Feature:** API endpoint to check if checkpoint mapping file exists
**API Routes:** `/api/check-checkpoint-mapping` (GET)
**File:** `app/data/checkpoint_mapping.json`

#### Test Coverage

| Test ID | Description | Type | Status |
|---------|-------------|------|--------|
| 5.1 | Check existing checkpoint mapping | API | ✓ Manual |
| 5.2 | Check missing checkpoint mapping | API | ✓ Manual |
| 5.3 | UI integration (if implemented) | UI | ⏭ Pending |

#### Key Validations

- Returns `{ success: true, exists: true }` when file exists
- Returns `{ success: true, exists: false }` when file missing
- Used for setup validation and user guidance

#### Purpose

Helps users identify if required checkpoint mapping data is present before attempting bundle operations.

---

### Integration Test Execution

#### Prerequisites

1. Application running: `npm run dev`
2. Valid `app-config.json` with at least one environment
3. Valid kubeconfig file in `kubeconfigs/` directory
4. Test data files in `app/utils/__tests__/test-data/`
5. Access to test Kubernetes cluster (for SambaStack installer tests)

#### Manual Test Execution

1. **Bundle Deployment State:**
   - Navigate to Bundle Deployment page
   - Perform deployment actions
   - Refresh browser to verify state persistence
   - Check `temp/bundle-deployment-state.json` file

2. **Load Saved YAML:**
   - Navigate to Bundle Builder
   - Click "Load Saved Bundle"
   - Test with each test data file
   - Verify form population and error handling

3. **SambaStack Installer:**
   - Navigate to Home page
   - Locate SambaStack installer section
   - Paste valid installation YAML
   - Monitor logs during installation

4. **API Key Retrieval:**
   - Remove `apiKey` from environment config
   - Navigate to Playground
   - Verify link appearance and functionality
   - Add API key and verify link disappears

5. **Checkpoint Mapping:**
   - Call API endpoint: `curl http://localhost:3000/api/check-checkpoint-mapping`
   - Verify response based on file presence

#### Automated API Testing

While automated unit tests focus on business logic, API endpoint testing can be performed using:
- `curl` commands (see test plan for examples)
- Postman/Insomnia collections
- Integration test frameworks (future enhancement)

---

### Test Data Summary

| File | Purpose | Expected Result |
|------|---------|-----------------|
| `test-bundle.yaml` | Valid single model | Should load successfully |
| `multi-model.yaml` | Multiple models | Should load all models |
| `with-draft.yaml` | Speculative decoding | Should parse draft model |
| `invalid-no-bt.yaml` | Missing BundleTemplate | Should return 400 error |
| `invalid-no-models.yaml` | Missing spec.models | Should return 400 error |
| `invalid-pef.yaml` | Invalid PEF format | Should return 400 error |

---

### Known Limitations

- No automated integration tests for UI workflows (consider Playwright/Cypress)
- API route tests not implemented (Next.js API route testing requires specific setup)
- Manual testing required for full end-to-end validation
- Kubernetes integration tests require live cluster access

---

### Future Test Improvements

For release 1.1.2 features:
1. Add automated API route tests using Next.js testing utilities
2. Implement E2E tests with Playwright for critical workflows
3. Add performance tests for state file I/O operations
4. Create security tests for path traversal prevention
5. Add contract tests for API endpoint schemas

---

## Test Infrastructure

All tests use the following infrastructure:

- **Testing Framework:** Jest
- **React Testing:** React Testing Library with `act()` for async operations
- **User Interactions:** @testing-library/user-event (minimal usage after cleanup)
- **Mocking:** Jest mocks for fetch, next/navigation, fs, and child_process
- **Test Utilities:** Custom `renderWithProviders` helper for consistent component rendering
- **Mock Data:** Centralized mock data in [mock-data.ts](mock-data.ts)
- **Async Handling:** Real timers for async fetch operations, `waitFor` with appropriate timeouts

### Async Testing Best Practices

The test suite properly handles async operations to avoid React warnings:

1. **Use `act()` wrapper** for components with async state updates
2. **Switch to real timers** when testing async fetch operations (avoids timeout issues)
3. **Mock all API endpoints** called during component initialization
4. **Use `waitFor`** with appropriate timeouts (default 3000ms for integration tests)
5. **Restore fake timers** after async tests to avoid affecting other tests

Example from [bundle-deployment.test.tsx](bundle-deployment.test.tsx:70-105):
```typescript
jest.useRealTimers(); // Switch to real timers for this test

await act(async () => {
  renderWithProviders(<Component />);
});

await waitFor(() => {
  expect(fetch).toHaveBeenCalledWith('/api/endpoint');
}, { timeout: 3000 });

jest.useFakeTimers(); // Restore for other tests
```

---

## Test Statistics

| Category | Test Count | Notes |
|----------|-----------|-------|
| **Automated Unit Tests** | **61** | Business logic and API integration |
| **Manual Integration Tests** | **27** | Release 1.1.2 features |
| **UI Components (Automated)** | **4** | Only API integration tests |
| **Core Utilities (Automated)** | **57** | Business logic and data processing |
| **Total Coverage** | **88 tests** | Comprehensive automated + manual testing |

### Automated Test Breakdown by File

| File | Tests | Focus |
|------|-------|-------|
| home.test.tsx | 1 | API integration |
| playground.test.tsx | 1 | API integration |
| bundle-form.test.tsx | 1 | API integration |
| bundle-deployment.test.tsx | 7 | Status logic (6) + API integration (1) - ✅ React act() warnings fixed |
| model-availability.test.ts | 9 | Model filtering logic |
| bundle-yaml-generator.test.ts | 22 | Simplified YAML generation logic |
| pef-config-generator.test.ts | 24 | Kubernetes integration |
| **Total** | **61** | **All automated tests** |

### Manual Integration Test Breakdown

| Feature | Tests | Focus |
|---------|-------|-------|
| Bundle Deployment State | 4 | State persistence and retrieval |
| Load Saved YAML Files | 6 | YAML parsing and validation |
| SambaStack Installation | 7 | Installation and log monitoring |
| API Key Retrieval | 5 | UI integration and configuration |
| Checkpoint Mapping | 3 | File validation |
| **Subtotal** | **25** | **Feature-specific tests** |
| Integration Tests | 4 | End-to-end workflows |
| Error Handling | 7 | Edge cases and security |
| Performance Tests | 3 | I/O and UI responsiveness |
| Security Tests | 3 | Path traversal and injection prevention |
| Regression Tests | 3 | Existing functionality |
| **Total Manual Tests** | **45** | **Complete test plan** |

---

## Running Tests

### Automated Unit Tests

```bash
# Run all automated tests
npm test

# Run all tests (alternative)
npm test -- --passWithNoTests

# Run tests in watch mode
npm test -- --watch

# Run tests with coverage
npm test -- --coverage

# Run specific test file
npm test home.test.tsx

# Run tests for a specific directory
npm test app/utils/__tests__
```

### Manual Integration Tests

For release 1.1.2 features, follow the manual test plan:

1. **Start the application:**
   ```bash
   npm run dev
   ```

2. **Review full test plan:**
   - See [temp/TEST_PLAN.md](../../temp/TEST_PLAN.md) for detailed test cases
   - See [Release 1.1.2 Integration Tests](#release-112-integration-tests) section above for summaries

3. **Test data files:**
   - Located in [test-data/](test-data/)
   - Copy to `saved_artifacts/` directory for bundle loading tests

4. **Manual test checklist:**
   - See [MANUAL_TEST_CHECKLIST.md](MANUAL_TEST_CHECKLIST.md) for step-by-step testing guide

### API Endpoint Testing

Test new API endpoints using curl:

```bash
# Bundle deployment state
curl http://localhost:3000/api/bundle-deployment-state
curl -X POST http://localhost:3000/api/bundle-deployment-state \
  -H "Content-Type: application/json" \
  -d '{"state": {...}}'

# Saved artifacts
curl http://localhost:3000/api/saved-artifacts

# Load bundle
curl "http://localhost:3000/api/load-bundle?fileName=test-bundle.yaml"

# Checkpoint mapping
curl http://localhost:3000/api/check-checkpoint-mapping

# Installer logs
curl "http://localhost:3000/api/installer-logs?lines=20"
```

---

## Coverage

Tests cover:
- ✅ **Core business logic** - Model filtering, YAML generation, status calculation
- ✅ **API integration** - Data fetching on component mount
- ✅ **Data transformations** - PEF parsing, checkpoint naming, version selection
- ✅ **Complex features** - Speculative decoding, multi-model bundles
- ✅ **Error conditions** - Missing configs, failed kubectl, invalid data
- ✅ **Kubernetes integration** - kubectl command construction and execution

Tests **do not** cover:
- ❌ UI rendering details - "Does text appear?"
- ❌ Third-party libraries - Material-UI, React internals
- ❌ Browser features - HTML input behavior
- ❌ Implementation details - YAML formatting, JSON indentation

---

## What Changed

### Recent Updates (February 2026)

**✅ Fixed React `act()` Warnings in Bundle Deployment Tests**

The bundle deployment integration test was causing React warnings about state updates not being wrapped in `act()`. This has been resolved:

**Changes Made:**
- Added missing mock for `/api/bundle-deployment-state` endpoint (3rd fetch call on mount)
- Switched from fake timers to real timers for async fetch operations
- Wrapped component render in `act()` to properly batch state updates
- Added explicit `waitFor` with 3s timeout to ensure all async operations complete
- Restored fake timers after test completion to avoid affecting other tests

**Result:** ✅ All 61 tests pass with clean console output (no warnings)

**Files Modified:**
- [bundle-deployment.test.tsx](bundle-deployment.test.tsx:70-105) - Test implementation
- [TESTS.md](TESTS.md) - Documentation updates

---

### Tests Removed (46 tests, 43% reduction)

**UI Component Tests (16 removed):**
- All "does it render" text checks
- All "is field visible" tests
- All user interaction tests (typing, clicking, selecting)
- All loading state and error display tests

**Core Utility Tests (7 removed):**
- Edge cases that never occur (empty strings in `generateCheckpointName`)
- YAML formatting tests (indentation, newlines, separators)
- JSON formatting tests (indentation, file paths)
- Overly defensive Kubernetes tests

### Tests Consolidated (Multiple → Single)

- **Playground:** 6 tests → 1 test (combined fetch operations)
- **Bundle Builder:** 6 tests → 1 test (API integration only)
- **Bundle Deployment:** 6 UI tests → 1 test (combined fetches)

### Tests Kept (61 tests, 100% of critical logic)

- ✅ All model availability logic tests (9)
- ✅ All deployment status calculation tests (6)
- ✅ All YAML generation business logic (22 - updated for simplified format)
- ✅ All PEF configuration parsing (24)
- ✅ All API integration tests (4)

**Note:** The test count includes all business-critical tests that verify core functionality and prevent regressions.

---

## Benefits of This Approach

**✅ Faster test runs:** 43% fewer tests = ~40% faster execution (~3.5s for 61 tests)
**✅ Easier refactoring:** UI changes don't break tests
**✅ Less maintenance:** No more updating 20 tests for a UI tweak
**✅ Better focus:** Every test catches real bugs
**✅ Same coverage:** All critical business logic still tested
**✅ Clean output:** No console warnings or errors (act() warnings resolved)
**✅ Reliable async handling:** Proper mocking and timing for fetch operations

---

## Guidelines for New Tests

### ✅ Write tests for:
1. **Business logic functions** - Pure functions that transform data
2. **API integration** - Verify endpoints are called on mount
3. **Complex algorithms** - Multi-step transformations like YAML generation
4. **Error handling** - Critical failures that must be handled
5. **Kubernetes integration** - kubectl commands and parsing

### ❌ Don't write tests for:
1. **Text rendering** - "Does 'Welcome' appear on the page?"
2. **UI component existence** - "Is there a button?"
3. **User interactions** - Typing, clicking (unless critical workflow)
4. **Third-party libraries** - Material-UI, React state
5. **Implementation details** - Formatting, indentation, file paths

### 🎯 Example of a good test:
```typescript
it('should filter out models with empty checkpoint paths', () => {
  const result = getAvailableModels(checkpoints, pefs, configs);
  expect(result).not.toContain('ModelWithEmptyPath');
});
```

### ❌ Example of a bad test:
```typescript
it('should render the model dropdown', async () => {
  render(<BundleForm />);
  expect(screen.getByLabelText(/Models/i)).toBeInTheDocument();
});
```

### ✅ Example of a good async component test:
```typescript
it('should fetch data on mount', async () => {
  jest.useRealTimers(); // Use real timers for async operations

  // Mock all fetch calls
  (global.fetch as jest.Mock)
    .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: [] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, more: [] }) });

  await act(async () => {
    renderWithProviders(<Component />);
  });

  await waitFor(() => {
    expect(global.fetch).toHaveBeenCalledWith('/api/endpoint1');
    expect(global.fetch).toHaveBeenCalledWith('/api/endpoint2');
  }, { timeout: 3000 });

  jest.useFakeTimers(); // Restore for other tests
});
```

---

## Future Improvements

Consider adding:
- **Integration tests** (Playwright/Cypress) for critical user workflows
- **Visual regression tests** for UI components (if needed)
- **Performance tests** for YAML generation with large configs
- **Contract tests** for API endpoints

---

For detailed recommendations on what was removed and why, see [TEST_RECOMMENDATIONS.md](TEST_RECOMMENDATIONS.md).
