#!/usr/bin/env bash
set -euo pipefail

#######################################
# Download Bundle Artifacts
#
# Downloads all artifacts (checkpoints and PEFs) a bundle needs. Supports both bundle
# formats, detected from the manifest's .kind:
#   BundleTemplate / Bundle   references held inline in the manifest
#   ModelBundle               references a ModelProfile (PEFs) and a Model (checkpoint)
#
# Requires a helm chart (.tgz or extracted directory) to resolve those references, and
# accepts either chart that carries the model definitions:
#   sambastack        the umbrella chart, definitions nested under its subcharts
#   sambastack-models the standalone models chart, definitions at the chart root
# Which one applies is detected from the chart's own layout, so no flag selects it.
# Under global.modelComponents.enabled=false the umbrella chart no longer renders the
# model CRs and sambastack-models owns them, making it the chart to pass here.
#
# Validates every artifact exists before downloading anything, then downloads while
# preserving the directory layout below the bucket. Run with -h for usage.
#######################################

#######################################
# Configuration
#######################################
OUTPUT_DIR="${OUTPUT_DIR:-./artifacts}"
BUNDLE_FILE=""
CHART_FILE=""
CHART_DIR=""
TEMP_EXTRACT_DIR=""
BUNDLE_KIND=""

SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"
DRY_RUN=0
SKIP_AUTH=0
DEBUG=0

# Chart environments searched in order when resolving a reference; --env narrows to one.
DEFAULT_CHART_ENVS=(sambastack prod dev)
CHART_ENVS=()

# Chart layouts, each naming where its PEF, ModelProfile and Model definitions sit
# relative to the chart root. Both charts hold the same definitions; only the depth
# differs, because the umbrella chart nests them inside its 'bundles' and 'configs'
# subcharts while the models chart roots them directly.
#
# Usage: <layout>_LAYOUT=(<pef-root> <profile-root> <model-root>)
SAMBASTACK_LAYOUT=(charts/bundles/pefs charts/bundles/bundles-v3 charts/configs/models)
MODELS_LAYOUT=(pefs bundles-v3 models)

# Detected chart layout. Set by detect_chart_layout; CHART_LAYOUT names it for messages,
# and each root is suffixed with an environment at lookup.
CHART_LAYOUT=""
PEF_DEFINITIONS_ROOT=""
PROFILE_DEFINITIONS_ROOT=""
MODEL_DEFINITIONS_ROOT=""

# Temporary files, created during artifact collection and removed by the EXIT trap.
PATHS_FILE=""
PEF_REFS_FILE=""

#######################################
# Colors and Logging
#######################################
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info() {
  echo -e "${GREEN}[INFO]${NC} $*" >&2
}

warn() {
  echo -e "${YELLOW}[WARN]${NC} $*" >&2
}

error() {
  echo -e "${RED}[ERROR]${NC} $*" >&2
  exit 1
}

debug() {
  if [[ "${DEBUG:-0}" == "1" ]]; then
    echo -e "${BLUE}[DEBUG]${NC} $*" >&2
  fi
}

#######################################
# Cleanup
#######################################
cleanup() {
  [[ -n "${TEMP_EXTRACT_DIR:-}" ]] && [[ -d "$TEMP_EXTRACT_DIR" ]] && rm -rf "$TEMP_EXTRACT_DIR"
  [[ -n "${PATHS_FILE:-}" ]] && rm -f "$PATHS_FILE"
  [[ -n "${PEF_REFS_FILE:-}" ]] && rm -f "$PEF_REFS_FILE"
}

trap cleanup EXIT

#######################################
# Pure utilities (never fail; return via stdout)
#######################################

# Print the path below the bucket of a GCS URI.
# Usage: gcs_relative_path <gs-uri>
gcs_relative_path() {
  local bucket_and_path="${1#gs://}"
  echo "${bucket_and_path#*/}"
}

# Print the bucket name from a GCS URI.
#
# Usage: gcs_bucket <gs-uri>
gcs_bucket() {
  local bucket_and_path="${1#gs://}"
  echo "${bucket_and_path%%/*}"
}

# Format a byte count as GiB with two decimals.
# Usage: to_gib <bytes>
to_gib() {
  awk "BEGIN {printf \"%.2f\", $1/1024/1024/1024}"
}

# List a mapping's keys space-separated, for "available X" error messages.
# Usage: yaml_keys <expression> <file>
yaml_keys() {
  yq eval "$1 | keys | .[]" "$2" 2>/dev/null | tr '\n' ' '
}

#######################################
# CLI
#######################################

# Print the two charts' definition roots side by side, for the help text.
#
# The column width is computed from the values themselves so the table stays aligned
# when a root is renamed.
layout_table() {
  local rows=(
    "PEFs|${SAMBASTACK_LAYOUT[0]}/<env>/|${MODELS_LAYOUT[0]}/<env>/"
    "Profiles|${SAMBASTACK_LAYOUT[1]}/<env>/model-profiles/|${MODELS_LAYOUT[1]}/<env>/model-profiles/"
    "Models|${SAMBASTACK_LAYOUT[2]}/<env>/|${MODELS_LAYOUT[2]}/<env>/"
  )

  local width=16 row middle
  for row in "${rows[@]}"; do
    middle="${row#*|}"
    middle="${middle%%|*}"
    [[ "${#middle}" -ge "$width" ]] && width=$((${#middle} + 2))
  done

  printf '    %-10s %-*s %s\n' "" "$width" "sambastack chart" "sambastack-models chart"
  for row in "${rows[@]}"; do
    IFS='|' read -r label stack models <<< "$row"
    printf '    %-10s %-*s %s\n' "$label" "$width" "$stack" "$models"
  done
}

show_help() {
  cat <<EOF
Usage: $0 [OPTIONS] <bundle.yaml>

Download all artifacts required for a bundle deployment. Both v2 bundles
(BundleTemplate/Bundle) and v3 bundles (ModelBundle) are supported; the format is
detected from the manifest's .kind field.

REQUIRED:
  <bundle.yaml>             Path to a bundle YAML file: a v2 BundleTemplate/Bundle
                            or a v3 ModelBundle (prebuilt or custom)

REQUIRED OPTIONS (mutually exclusive):
  -c, --chart FILE          Path to helm chart .tgz file
                            (used to resolve PEF/profile/model references)
  -d, --chart-dir DIR       Path to extracted helm chart directory
                            (used to resolve PEF/profile/model references)

  Either the sambastack chart or the standalone sambastack-models chart may be
  given; which one it is is detected from the chart's layout. When the infra
  release runs with global.modelComponents.enabled=false, sambastack-models owns
  the model CRs and is the chart to pass.

OPTIONS:
  -o, --output DIR          Output directory (default: ./artifacts)
                            (can also use OUTPUT_DIR env var)
  -s, --service-account     Service account JSON key file path
                            (can also use SERVICE_ACCOUNT env var)
  -e, --env ENV             Restrict reference resolution to a single chart
                            environment (${DEFAULT_CHART_ENVS[*]}).
                            Defaults to searching all three in that order.
  -n, --dry-run            Show what would be downloaded
  --skip-auth              Skip gcloud authentication
  --debug                  Enable debug output
  -h, --help               Show this help message

ENVIRONMENT VARIABLES:
  SERVICE_ACCOUNT          Path to service account JSON key file
  OUTPUT_DIR               Output directory for artifacts

REQUIRED CHART STRUCTURE:
  Definitions sit at a different depth in each chart. v2 bundles need the PEF root;
  v3 bundles need all three.

$(layout_table)

  In the sambastack chart the Model definitions live in the 'configs' subchart, so a
  chart trimmed to only the 'bundles' subchart cannot resolve v3 checkpoints.

EXAMPLES:
  # Download artifacts for a v2 bundle with an extracted chart
  $0 -d ./sambastack 70b-ss-4-8k-tk.yaml

  # Download artifacts for a v3 ModelBundle
  $0 -d ./sambastack 70b-3dot3-ss-4-8-16-32-64-128k.yaml

  # Download artifacts for prebuilt bundle with helm chart
  $0 -c sambastack-<VERSION>.tgz 70b-ss-4-8k-tk.yaml

  # Use the standalone models chart, which owns the model CRs when the infra
  # release sets global.modelComponents.enabled=false
  $0 -c sambastack-models-<VERSION>.tgz 70b-ss-4-8k-tk.yaml

  # Use custom output directory
  $0 -d ./sambastack 70b-ss-4-8k-tk.yaml -o /tmp/artifacts

  # Pin resolution to one environment
  $0 -d ./sambastack --env sambastack 70b-ss-4-8k-tk.yaml

  # Use service account authentication
  SERVICE_ACCOUNT=/path/to/key.json $0 -d ./sambastack 70b-ss-4-8k-tk.yaml

  # Dry run to see what would be downloaded
  $0 -d ./sambastack 70b-ss-4-8k-tk.yaml --dry-run

EOF
  exit 0
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help)
        show_help
        ;;
      -c|--chart)
        CHART_FILE="$2"
        shift 2
        ;;
      -d|--chart-dir)
        CHART_DIR="$2"
        shift 2
        ;;
      -o|--output)
        OUTPUT_DIR="$2"
        shift 2
        ;;
      -s|--service-account)
        SERVICE_ACCOUNT="$2"
        shift 2
        ;;
      -e|--env)
        CHART_ENVS=("$2")
        shift 2
        ;;
      -n|--dry-run)
        DRY_RUN=1
        shift
        ;;
      --skip-auth)
        SKIP_AUTH=1
        shift
        ;;
      --debug)
        DEBUG=1
        shift
        ;;
      -*)
        error "Unknown option: $1"
        ;;
      *)
        BUNDLE_FILE="$1"
        shift
        ;;
    esac
  done
}

#######################################
# Prerequisites
#######################################
check_command() {
  local cmd="$1"
  local install_hint="${2:-}"

  if ! command -v "$cmd" &> /dev/null; then
    error "Required command '$cmd' not found. ${install_hint}"
  fi
  debug "✓ Found: $cmd"
}

check_prerequisites() {
  info "Checking prerequisites..."

  # The gcloud SDK is only needed to download, not to resolve paths for a dry run.
  if [[ "$DRY_RUN" == "0" ]]; then
    check_command "gcloud" "Install from: https://cloud.google.com/sdk/docs/install"
    check_command "gsutil" "Part of gcloud SDK"
  fi

  check_command "yq"
  check_command "grep"
  check_command "sed"
  check_command "awk"
  check_command "tar" "Usually pre-installed on macOS/Linux"

  info "✓ All prerequisite commands are available"
}

#######################################
# Input validation
#######################################
validate_bundle_file() {
  if [[ -z "$BUNDLE_FILE" ]]; then
    error "Bundle template file is required. Run $0 -h for more info."
  fi

  if [[ ! -f "$BUNDLE_FILE" ]]; then
    error "Bundle template file not found: $BUNDLE_FILE"
  fi

  info "Bundle: $BUNDLE_FILE"
}

# Default to searching every packaged environment; --env narrows it to one.
resolve_chart_envs() {
  if [[ "${#CHART_ENVS[@]}" -eq 0 ]]; then
    CHART_ENVS=("${DEFAULT_CHART_ENVS[@]}")
    return 0
  fi

  local valid_env=0 known_env
  for known_env in "${DEFAULT_CHART_ENVS[@]}"; do
    [[ "${CHART_ENVS[0]}" == "$known_env" ]] && valid_env=1
  done
  if [[ "$valid_env" == "0" ]]; then
    error "Unknown environment: ${CHART_ENVS[0]}
Valid environments: ${DEFAULT_CHART_ENVS[*]}"
  fi
  info "Restricting resolution to environment: ${CHART_ENVS[0]}"
}

# Detect the bundle format from the manifest's .kind. Sets BUNDLE_KIND.
# Only the first document is inspected (a v2 file pairs two documents).
detect_bundle_kind() {
  BUNDLE_KIND=$(yq eval 'select(documentIndex == 0) | .kind // ""' "$BUNDLE_FILE" 2>/dev/null || echo "")

  case "$BUNDLE_KIND" in
    BundleTemplate|Bundle)
      info "Detected v2 bundle (kind: $BUNDLE_KIND)"
      ;;
    ModelBundle)
      info "Detected v3 bundle (kind: ModelBundle)"
      ;;
    "")
      error "Could not read .kind from bundle file: $BUNDLE_FILE

Expected a YAML manifest with a 'kind' field of BundleTemplate, Bundle, or ModelBundle."
      ;;
    *)
      error "Unsupported bundle kind: $BUNDLE_KIND
Bundle file: $BUNDLE_FILE

Supported kinds:
  BundleTemplate, Bundle  v2 bundles
  ModelBundle             v3 bundles"
      ;;
  esac
}

# Validate the -c/-d options are well-formed and the referenced path exists.
validate_chart_options() {
  if [[ -n "$CHART_FILE" ]] && [[ -n "$CHART_DIR" ]]; then
    error "Options -c/--chart and -d/--chart-dir are mutually exclusive. Use only one."
  fi

  if [[ -z "$CHART_FILE" ]] && [[ -z "$CHART_DIR" ]]; then
    error "Either -c/--chart or -d/--chart-dir is required. Run $0 -h for more info."
  fi

  if [[ -n "$CHART_FILE" ]]; then
    if [[ ! -f "$CHART_FILE" ]]; then
      error "Helm chart file not found: $CHART_FILE"
    fi
    info "Helm chart: $CHART_FILE"
  fi

  if [[ -n "$CHART_DIR" ]]; then
    if [[ ! -d "$CHART_DIR" ]]; then
      error "Chart directory not found: $CHART_DIR"
    fi
    info "Chart directory: $CHART_DIR"
  fi
}

#######################################
# Chart staging
#######################################

# Extract a packaged chart into a temp dir and set CHART_DIR to the directory inside.
# Usage: extract_helm_chart <chart.tgz>
extract_helm_chart() {
  local chart_file="$1"

  info "Extracting helm chart..."
  TEMP_EXTRACT_DIR=$(mktemp -d)
  debug "Temporary extraction directory: $TEMP_EXTRACT_DIR"

  if ! tar -xzf "$chart_file" -C "$TEMP_EXTRACT_DIR" 2>/dev/null; then
    error "Failed to extract helm chart: $chart_file"
  fi

  # Find the extracted directory (usually 'sambastack')
  local extracted_dir
  extracted_dir=$(find "$TEMP_EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d -print -quit)

  if [[ -z "$extracted_dir" ]]; then
    error "No directory found after extracting helm chart"
  fi

  info "✓ Chart extracted successfully"
  CHART_DIR="$extracted_dir"
}

# Ensure CHART_DIR points at an extracted chart, extracting a .tgz first if -c was given.
resolve_chart_dir() {
  if [[ -n "$CHART_FILE" ]]; then
    extract_helm_chart "$CHART_FILE"
  fi
}

#######################################
# Chart layout detection
#######################################

# Adopt a layout's three definition roots.
# Usage: apply_chart_layout <name> <pef-root> <profile-root> <model-root>
apply_chart_layout() {
  CHART_LAYOUT="$1"
  PEF_DEFINITIONS_ROOT="$2"
  PROFILE_DEFINITIONS_ROOT="$3"
  MODEL_DEFINITIONS_ROOT="$4"

  debug "Chart layout '$CHART_LAYOUT':"
  debug "  PEFs:     $PEF_DEFINITIONS_ROOT/<env>"
  debug "  Profiles: $PROFILE_DEFINITIONS_ROOT/<env>/model-profiles"
  debug "  Models:   $MODEL_DEFINITIONS_ROOT/<env>"
}

# Return 0 when a layout's PEF root holds definitions for any searched environment.
# Usage: layout_matches <chart-dir> <pef-root>
#
# The PEF root alone identifies the layout: every bundle needs it, and the two charts
# place it at different depths. The remaining roots are checked by
# validate_chart_structure, which reports what a bundle of this kind actually needs.
layout_matches() {
  local chart_dir="$1"
  local pef_root="$2"

  local env
  for env in "${CHART_ENVS[@]}"; do
    [[ -d "$chart_dir/$pef_root/$env" ]] && return 0
  done

  return 1
}

# Detect which chart was supplied and set the definition roots to match.
#
# Usage: detect_chart_layout <chart-dir>
#
# Both charts are accepted so an operator can pass whichever one their install owns the
# model CRs through, without a flag to say which. Neither matching means the chart holds
# no PEF definitions at all, so the error names both layouts rather than guessing.
detect_chart_layout() {
  local chart_dir="$1"

  if layout_matches "$chart_dir" "${SAMBASTACK_LAYOUT[0]}"; then
    apply_chart_layout sambastack "${SAMBASTACK_LAYOUT[@]}"
  elif layout_matches "$chart_dir" "${MODELS_LAYOUT[0]}"; then
    apply_chart_layout sambastack-models "${MODELS_LAYOUT[@]}"
  else
    error "Could not find PEF definitions in chart: $chart_dir

Expected one of these layouts:
$(printf '  %-40s (%s chart)\n' \
    "<chart-dir>/${SAMBASTACK_LAYOUT[0]}/<env>" sambastack \
    "<chart-dir>/${MODELS_LAYOUT[0]}/<env>" sambastack-models)

Environments searched: ${CHART_ENVS[*]}

Pass the sambastack chart, or the sambastack-models chart that owns the model CRs when
the infra release runs with global.modelComponents.enabled=false."
  fi

  info "Detected chart layout: $CHART_LAYOUT"
}

#######################################
# Chart structure validation
#######################################

# Explain why a chart may lack Model definitions, in terms of the detected layout.
#
# The two charts omit them for different reasons: the umbrella chart when trimmed to
# its 'bundles' subchart, the models chart when packaged without its models data.
model_definitions_hint() {
  if [[ "$CHART_LAYOUT" == "sambastack-models" ]]; then
    echo "They ship at the root of the sambastack-models chart; a chart packaged
without them cannot resolve v3 checkpoints."
  else
    echo "They live in the 'configs' subchart, which is absent from a bundles-only chart."
  fi
}

# Count *.yaml definitions under a chart-relative root across the searched environments.
# Usage: count_definitions <chart-dir> <root> [subdir]  ->  "<count> <first-existing-dir>"
count_definitions() {
  local chart_dir="$1"
  local root="$2"
  local subdir="${3:-}"

  local total=0 found_dir="" env dir count
  for env in "${CHART_ENVS[@]}"; do
    dir="$chart_dir/$root/$env"
    [[ -n "$subdir" ]] && dir="$dir/$subdir"
    [[ -d "$dir" ]] || continue
    count=$(find "$dir" -name "*.yaml" -type f 2>/dev/null | wc -l | tr -d ' ')
    total=$((total + count))
    [[ -z "$found_dir" ]] && found_dir="$dir"
  done

  echo "$total $found_dir"
}

# Fail unless a definition root resolves to at least one YAML across the environments.
# Usage: require_definitions <chart-dir> <root> <subdir> <label> <purpose>
require_definitions() {
  local chart_dir="$1"
  local root="$2"
  local subdir="$3"
  local label="$4"
  local purpose="$5"

  local result count
  result=$(count_definitions "$chart_dir" "$root" "$subdir")
  count="${result%% *}"

  if [[ "$count" -eq 0 ]]; then
    local expected="$root/<env>"
    [[ -n "$subdir" ]] && expected="$expected/$subdir"
    error "No $label definitions found under: $chart_dir/$root

Expected chart structure:
  <chart-dir>/$expected

Environments searched: ${CHART_ENVS[*]}

$purpose"
  fi

  debug "  Found $count $label definition file(s)"
}

validate_chart_structure() {
  local chart_dir="$1"

  info "Validating chart structure..."

  require_definitions "$chart_dir" "$PEF_DEFINITIONS_ROOT" "" "PEF" \
    "These definitions are needed to resolve PEF references to GCS paths."

  # ModelBundles reference profiles and models indirectly, so both roots must be present.
  if [[ "$BUNDLE_KIND" == "ModelBundle" ]]; then
    require_definitions "$chart_dir" "$PROFILE_DEFINITIONS_ROOT" "model-profiles" "ModelProfile" \
      "These definitions map a v3 modelConfigs[].profile to its PEF references."

    require_definitions "$chart_dir" "$MODEL_DEFINITIONS_ROOT" "" "Model" \
      "These definitions map a v3 modelConfigs[].model to its checkpoint source.
$(model_definitions_hint)"
  fi

  info "✓ Chart structure is valid"
}

#######################################
# Authentication
#######################################

# Authenticate with a service account key, or fall back to the active gcloud login.
authenticate_service_account() {
  if [[ -n "$SERVICE_ACCOUNT" ]]; then
    if [[ ! -f "$SERVICE_ACCOUNT" ]]; then
      error "Service account file not found: $SERVICE_ACCOUNT"
    fi

    info "Authenticating with service account: $SERVICE_ACCOUNT"
    gcloud auth activate-service-account --key-file="$SERVICE_ACCOUNT" || \
      error "Failed to authenticate with service account"
    info "✓ Authentication successful"
  else
    warn "No service account specified. Using current gcloud credentials."
    info "Current gcloud account:"
    gcloud auth list --filter=status:ACTIVE --format="value(account)" || \
      error "No active gcloud account. Please authenticate or provide SERVICE_ACCOUNT"
  fi
}

# Confirm an existing login can be used when --skip-auth bypasses authentication.
confirm_existing_credentials() {
  info "Skipping authentication (--skip-auth)"

  local active_account
  active_account=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1)

  if [[ -z "$active_account" ]]; then
    error "No active gcloud account found. Cannot use --skip-auth without authentication.

Please either:
  1. Authenticate with gcloud: gcloud auth login
  2. Use a service account: $0 -s /path/to/service-account.json -d <chart-dir> <bundle-file>
  3. Set SERVICE_ACCOUNT env var: SERVICE_ACCOUNT=/path/to/key.json $0 -d <chart-dir> <bundle-file>"
  fi

  if [[ -n "$SERVICE_ACCOUNT" ]]; then
    info "✓ Using SERVICE_ACCOUNT env var (authentication skipped)"
    return 0
  fi

  echo ""
  info "Active gcloud account: $active_account"
  echo ""

  read -p "$(echo -e "${YELLOW}Do you want to proceed with this account? (Y/n):${NC} ")" -n 1 -r
  echo ""

  if [[ $REPLY =~ ^[Nn]$ ]]; then
    echo ""
    error "Authentication cancelled by user.

Please provide a service account using one of these methods:
  1. Use -s flag: $0 -s /path/to/service-account.json -d <chart-dir> <bundle-file>
  2. Set env var: SERVICE_ACCOUNT=/path/to/key.json $0 -d <chart-dir> <bundle-file>

Or authenticate with the correct account:
  gcloud auth login"
  fi

  info "✓ Proceeding with account: $active_account"
}

# A dry run resolves and prints paths only, so it skips authentication.
authenticate() {
  if [[ "$DRY_RUN" == "1" ]]; then
    info "Skipping authentication (dry run)"
  elif [[ "$SKIP_AUTH" == "0" ]]; then
    authenticate_service_account
  else
    confirm_existing_credentials
  fi
}

#######################################
# GCS field reader
#######################################

# Read a field from a YAML (or JSON) document and emit it when it holds a GCS path.
#
# Usage: emit_gcs_path <expression> <source> <label> [--json]
#
# Prints the path and returns 0 when the field holds a gs:// value; returns 1 when the
# field is absent, and warns then returns 1 when it is present but not a GCS path.
emit_gcs_path() {
  local expression="$1"
  local source="$2"
  local label="$3"
  local format="${4:-}"

  local path
  # A missing field must arrive as 'null', never an empty string, so that absent stays
  # distinguishable from present-but-empty downstream.
  if [[ "$format" == "--json" ]]; then
    path=$(yq eval -p=json "$expression" <<< "$source")
  else
    path=$(yq eval "$expression" "$source")
  fi

  if [[ -z "$path" ]] || [[ "$path" == "null" ]]; then
    return 1
  fi

  if [[ ! "$path" =~ ^gs:// ]]; then
    warn "Ignoring non-GCS $label: $path"
    return 1
  fi

  debug "  ✓ Found $label: $path"
  echo "$path"
}

#######################################
# Definition lookup
#######################################

# Locate a definition YAML by name across the searched environments.
# Usage: find_definition_file <chart-dir> <root> <subdir> <name>
# Prints the first match and returns 0, or returns 1 when absent.
find_definition_file() {
  local chart_dir="$1"
  local root="$2"
  local subdir="$3"
  local name="$4"

  local env dir candidate
  for env in "${CHART_ENVS[@]}"; do
    dir="$chart_dir/$root/$env"
    [[ -n "$subdir" ]] && dir="$dir/$subdir"
    candidate="$dir/${name}.yaml"
    if [[ -f "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

# List the directories searched for a definition kind, for error messages.
#
# Usage: searched_dirs <root> <subdir>
searched_dirs() {
  local root="$1"
  local subdir="$2"

  local env dir
  for env in "${CHART_ENVS[@]}"; do
    dir="$root/$env"
    [[ -n "$subdir" ]] && dir="$dir/$subdir"
    echo "  - $dir"
  done
}

#######################################
# Reference parsing
#######################################

# Validate a PEF reference and split it into name and version.
# Usage: parse_pef_reference <ref>  ->  sets PEF_NAME, PEF_VERSION
parse_pef_reference() {
  local pef_ref="$1"

  if [[ ! "$pef_ref" =~ ^([^:]+):([^:]+)$ ]]; then
    error "Invalid PEF reference format: $pef_ref
Expected format: <pef-name>:<version> (e.g., llama-3p1-1b-ss4096-bs1:1)"
  fi

  PEF_NAME="${BASH_REMATCH[1]}"
  PEF_VERSION="${BASH_REMATCH[2]}"
  debug "Parsed PEF reference: $pef_ref -> name=$PEF_NAME, version=$PEF_VERSION"
}

# Parse a model reference into its components.
# Usage: parse_model_reference <ref>  ->  sets MODEL_NAME, MODEL_ARCH, MODEL_VERSION
#
# References take one of three forms (arch and/or version empty when absent):
#   <name>:<arch>:<version>   model with more than one checkpoint arch
#   <name>:<version>          model with exactly one arch
#   <name>                    checkpoint carried inline by checkpointOverrides
parse_model_reference() {
  local model_ref="$1"

  case "$model_ref" in
    *:*:*)
      MODEL_NAME="${model_ref%%:*}"
      local rest="${model_ref#*:}"
      MODEL_ARCH="${rest%%:*}"
      MODEL_VERSION="${rest#*:}"
      ;;
    *:*)
      MODEL_NAME="${model_ref%%:*}"
      MODEL_ARCH=""
      MODEL_VERSION="${model_ref#*:}"
      ;;
    *)
      MODEL_NAME="$model_ref"
      MODEL_ARCH=""
      MODEL_VERSION=""
      ;;
  esac

  debug "Parsed model reference: $model_ref -> name=$MODEL_NAME, arch=${MODEL_ARCH:-<none>}, version=${MODEL_VERSION:-<none>}"
}

# Set CHECKPOINT_ARCH to the single checkpoint arch a model declares.
# Usage: sole_checkpoint_arch <model-file> <model-ref>
#
# The arch is read from the definition, not derived from the model name; the two are
# independent. Errors when the model declares zero or several archs.
sole_checkpoint_arch() {
  local model_file="$1"
  local model_ref="$2"

  local arch_count
  arch_count=$(yq eval '.spec.checkpoints | length' "$model_file")

  if [[ "$arch_count" != "1" ]]; then
    error "Model reference '$model_ref' omits the checkpoint arch, but its CR declares $arch_count.
Model file: $model_file
Available archs: $(yaml_keys '.spec.checkpoints' "$model_file")

An unambiguous reference is required. Expected format: <model>:<arch>:<version>"
  fi

  CHECKPOINT_ARCH=$(yq eval '.spec.checkpoints | keys | .[0]' "$model_file")
  debug "  Using sole checkpoint arch: $CHECKPOINT_ARCH"
}

#######################################
# PEF resolution
#######################################

# Emit every GCS path a PEF reference contributes.
# Usage: resolve_pef_to_gcs <pef-ref> <chart-dir>
#
# Beyond the main PEF, a vision model needs auxiliary ones (copy_pef, vision_embedding_pef),
# declared either per-version alongside 'source' or once at .spec; both layouts are read.
resolve_pef_to_gcs() {
  local pef_ref="$1"
  local chart_dir="$2"

  parse_pef_reference "$pef_ref"
  local pef_name="$PEF_NAME" pef_version="$PEF_VERSION"

  local pef_file
  if ! pef_file=$(find_definition_file "$chart_dir" "$PEF_DEFINITIONS_ROOT" "" "$pef_name"); then
    error "PEF definition file not found: ${pef_name}.yaml
PEF reference: $pef_ref
Bundle file: $BUNDLE_FILE

Searched:
$(searched_dirs "$PEF_DEFINITIONS_ROOT" "")

Please ensure the chart contains the PEF definition for '$pef_name'."
  fi

  debug "Reading PEF definition: $pef_file"

  local version_path=".spec.versions.\"${pef_version}\""
  local source_path
  source_path=$(yq eval "${version_path}.source" "$pef_file")

  if [[ -z "$source_path" ]] || [[ "$source_path" == "null" ]]; then
    error "PEF version '$pef_version' not found in: $pef_file
PEF reference: $pef_ref
Bundle file: $BUNDLE_FILE
Available versions: $(yq eval '.spec.versions | keys | .[]' "$pef_file" 2>/dev/null | tr '\n' ' ')"
  fi

  if [[ ! "$source_path" =~ ^gs:// ]]; then
    error "Invalid GCS path in PEF definition: $source_path
PEF file: $pef_file
PEF version: $pef_version"
  fi

  debug "  ✓ Resolved $pef_ref -> $source_path"
  echo "$source_path"

  # Read each auxiliary PEF from both the .spec and per-version locations, skipping a
  # path that appears in both.
  local field legacy_path versioned_path
  for field in copy_pef vision_embedding_pef; do
    legacy_path=$(emit_gcs_path ".spec.${field}" "$pef_file" \
      "$field at .spec (legacy layout)") && echo "$legacy_path"

    versioned_path=$(emit_gcs_path "${version_path}.${field}" "$pef_file" \
      "$field in $pef_file (version $pef_version)") || continue

    if [[ "$versioned_path" == "$legacy_path" ]]; then
      debug "  Skipping duplicate $field (already resolved from .spec): $versioned_path"
      continue
    fi

    echo "$versioned_path"
  done
}

#######################################
# V3 resolution
#######################################

# Emit the GCS paths an inline checkpointOverrides entry declares.
#
# Usage: resolve_override_checkpoint <model-ref> <override-json>
resolve_override_checkpoint() {
  local model_ref="$1"
  local override_json="$2"

  local field
  for field in source vision_embedding_checkpoint; do
    emit_gcs_path ".${field}" "$override_json" \
      "$field in checkpointOverrides for '$model_ref'" --json || true
  done
}

# Emit the GCS paths a modelConfigs entry contributes for its checkpoint.
# Usage: resolve_model_checkpoint <chart-dir> <model-ref> <override-json>
#
# An inline checkpointOverrides entry fully replaces the model's checkpoint and takes
# precedence. Emits the source and, when present, its vision embedding checkpoint.
resolve_model_checkpoint() {
  local chart_dir="$1"
  local model_ref="$2"
  local override_json="$3"

  # An override supplies the whole checkpoint; no definition lookup is needed. An absent
  # one arrives as 'null' or as a quoted empty JSON string.
  if [[ -n "$override_json" ]] && [[ "$override_json" != "null" ]] && [[ "$override_json" != '""' ]]; then
    resolve_override_checkpoint "$model_ref" "$override_json"
    return 0
  fi

  parse_model_reference "$model_ref"
  local model_name="$MODEL_NAME" model_arch="$MODEL_ARCH" model_version="$MODEL_VERSION"

  # A bare reference must carry its checkpoint inline; reaching here without one is a
  # malformed bundle.
  if [[ -z "$model_version" ]]; then
    error "Model reference '$model_ref' has no version and no checkpointOverrides.
Bundle file: $BUNDLE_FILE

An unversioned model reference carries its checkpoint inline at
  .spec.modelConfigs[].modelSettings.checkpointOverrides.checkpoint
but none was found for this entry."
  fi

  local model_file
  if ! model_file=$(find_definition_file "$chart_dir" "$MODEL_DEFINITIONS_ROOT" "" "$model_name"); then
    error "Model definition file not found: ${model_name}.yaml
Model reference: $model_ref
Bundle file: $BUNDLE_FILE

Searched:
$(searched_dirs "$MODEL_DEFINITIONS_ROOT" "")

$(model_definitions_hint)"
  fi

  debug "Reading Model definition: $model_file"

  if [[ -z "$model_arch" ]]; then
    sole_checkpoint_arch "$model_file" "$model_ref"
    model_arch="$CHECKPOINT_ARCH"
  fi

  local version_path=".spec.checkpoints.\"${model_arch}\".versions.\"${model_version}\""
  local source_path
  source_path=$(yq eval "${version_path}.source // \"\"" "$model_file")

  if [[ -z "$source_path" ]] || [[ "$source_path" == "null" ]]; then
    error "Checkpoint '${model_arch}' version '${model_version}' not found in: $model_file
Model reference: $model_ref
Bundle file: $BUNDLE_FILE
Available archs: $(yaml_keys '.spec.checkpoints' "$model_file")
Available versions for '${model_arch}': $(yaml_keys "${version_path%.versions.*}.versions" "$model_file")"
  fi

  if [[ ! "$source_path" =~ ^gs:// ]]; then
    error "Invalid GCS path in Model definition: $source_path
Model file: $model_file
Checkpoint: ${model_arch} version ${model_version}"
  fi

  debug "  ✓ Resolved $model_ref -> $source_path"
  echo "$source_path"

  # Vision models carry a second checkpoint alongside the main one.
  emit_gcs_path "${version_path}.vision_embedding_checkpoint" "$model_file" \
    "vision_embedding_checkpoint in $model_file" || true
}

# Append the PEF references a ModelProfile declares to PEF_REFS_FILE.
# Usage: collect_profile_pef_refs <chart-dir> <profile-name>
collect_profile_pef_refs() {
  local chart_dir="$1"
  local profile_name="$2"

  local profile_file
  if ! profile_file=$(find_definition_file \
      "$chart_dir" "$PROFILE_DEFINITIONS_ROOT" "model-profiles" "$profile_name"); then
    error "ModelProfile definition file not found: ${profile_name}.yaml
Profile reference: $profile_name
Bundle file: $BUNDLE_FILE

Searched:
$(searched_dirs "$PROFILE_DEFINITIONS_ROOT" "model-profiles")

Please ensure the chart contains the ModelProfile definition for '$profile_name'."
  fi

  debug "Reading ModelProfile definition: $profile_file"

  local ref_count
  ref_count=$(yq eval '.spec.pefs // [] | length' "$profile_file")
  if [[ "$ref_count" == "0" ]]; then
    warn "ModelProfile '$profile_name' declares no PEF references ($profile_file)"
    return 0
  fi

  yq eval '.spec.pefs[]' "$profile_file" >> "$PEF_REFS_FILE"
  debug "  ✓ Collected $ref_count PEF reference(s) from profile '$profile_name'"
}

# Append the PEF references a modelConfig's inline profileDefinition declares.
# Usage: collect_inline_profile_pef_refs <config-index>
collect_inline_profile_pef_refs() {
  local index="$1"

  local ref_count
  ref_count=$(yq eval ".spec.modelConfigs[$index].profileDefinition.pefs // [] | length" \
    "$BUNDLE_FILE")
  if [[ "$ref_count" == "0" ]]; then
    warn "Model config [$index] inline profileDefinition declares no PEF references"
    return 0
  fi

  yq eval ".spec.modelConfigs[$index].profileDefinition.pefs[]" "$BUNDLE_FILE" \
    >> "$PEF_REFS_FILE"
  debug "  ✓ Collected $ref_count PEF reference(s) from inline profileDefinition [$index]"
}

#######################################
# Artifact collection
#######################################

# BundleTemplate/Bundle manifests carry PEF refs and checkpoints inline.
extract_v2_artifacts() {
  info "Parsing v2 bundle template..."

  # PEF references, format pef-name:version (|| true: a bundle may have none)
  yq eval '.. | select(has("pef")) | .pef' "$BUNDLE_FILE" | \
    grep -E '^[^:]+:[^:]+$' >> "$PEF_REFS_FILE" || true

  # Checkpoint sources (|| true: a bundle may have none)
  yq eval '.spec.checkpoints.*.source' "$BUNDLE_FILE" | \
    grep -E '^gs://' >> "$PATHS_FILE" || true
}

# ModelBundle manifests reference a ModelProfile (PEF refs) and a Model (checkpoint) per
# modelConfigs entry, each resolved in turn.
extract_v3_artifacts() {
  info "Parsing v3 model bundle..."

  local config_count
  config_count=$(yq eval '.spec.modelConfigs // [] | length' "$BUNDLE_FILE")

  if [[ "$config_count" == "0" ]]; then
    error "No modelConfigs found in v3 bundle: $BUNDLE_FILE

Expected structure:
  spec:
    modelConfigs:
    - model: <model-name>:<version>
      profile: <profile-name>"
  fi

  info "Found $config_count model config(s)"

  local index model_ref profile_name override_json
  for ((index = 0; index < config_count; index++)); do
    model_ref=$(yq eval ".spec.modelConfigs[$index].model // \"\"" "$BUNDLE_FILE")
    profile_name=$(yq eval ".spec.modelConfigs[$index].profile // \"\"" "$BUNDLE_FILE")
    # Absent overrides stay as 'null', treated as "no override" downstream.
    override_json=$(yq eval -o=json \
      ".spec.modelConfigs[$index].modelSettings.checkpointOverrides.checkpoint" \
      "$BUNDLE_FILE")

    if [[ -z "$model_ref" ]]; then
      error "Model config at index $index has no 'model' reference: $BUNDLE_FILE"
    fi

    debug "Model config [$index]: model=$model_ref profile=${profile_name:-<none>}"

    resolve_model_checkpoint "$CHART_DIR" "$model_ref" "$override_json" >> "$PATHS_FILE"

    # Per the ModelBundle CRD exactly one of 'profile' (a named ModelProfile) or
    # 'profileDefinition' (an inline spec) is set; a config with neither is malformed.
    if [[ -n "$profile_name" ]]; then
      collect_profile_pef_refs "$CHART_DIR" "$profile_name"
    elif [[ "$(yq eval ".spec.modelConfigs[$index] | has(\"profileDefinition\")" \
        "$BUNDLE_FILE")" == "true" ]]; then
      collect_inline_profile_pef_refs "$index"
    else
      error "Model config at index $index sets neither 'profile' nor 'profileDefinition': $BUNDLE_FILE"
    fi
  done
}

# Create the working files and dispatch extraction on the bundle format.
collect_artifacts() {
  PATHS_FILE=$(mktemp)
  PEF_REFS_FILE=$(mktemp)

  info "Extracting artifacts from bundle: $(basename "$BUNDLE_FILE")"
  debug "Processing bundle: $BUNDLE_FILE"

  case "$BUNDLE_KIND" in
    BundleTemplate|Bundle) extract_v2_artifacts ;;
    ModelBundle)           extract_v3_artifacts ;;
  esac
}

# Resolve the collected PEF references to GCS paths, appending them to PATHS_FILE, then
# sort and de-duplicate the full path list.
resolve_pef_refs() {
  sort -u "$PEF_REFS_FILE" -o "$PEF_REFS_FILE"

  local pef_count
  pef_count=$(grep -c . "$PEF_REFS_FILE" || true)
  info "Found $pef_count unique PEF reference(s)"

  if [[ "$pef_count" -gt 0 ]]; then
    info "Resolving PEF references to GCS paths..."

    local pef_ref
    while IFS= read -r pef_ref; do
      if [[ -n "$pef_ref" ]]; then
        debug "Resolving: $pef_ref"
        resolve_pef_to_gcs "$pef_ref" "$CHART_DIR" >> "$PATHS_FILE"
      fi
    done < "$PEF_REFS_FILE"
  fi

  sort -u "$PATHS_FILE" -o "$PATHS_FILE"
}

#######################################
# Path validation
#######################################
validate_gcs_paths() {
  local paths_file="$1"

  info "Validating GCS paths..."

  local invalid_paths=()
  local line_num=0

  while IFS= read -r gs_path; do
    line_num=$((line_num + 1))

    # Check if path starts with gs://
    if [[ ! "$gs_path" =~ ^gs:// ]]; then
      invalid_paths+=("Line $line_num: Invalid GCS path (must start with gs://): $gs_path")
      continue
    fi

    # Extract the path component after gs://bucket/
    local path_component="${gs_path#gs://*/}"

    # Check for path traversal patterns
    if [[ "$path_component" =~ \.\./|/\.\. ]]; then
      invalid_paths+=("Line $line_num: Path traversal detected (contains ../): $gs_path")
      continue
    fi

    # Check for absolute paths after bucket (shouldn't start with /)
    if [[ "$path_component" =~ ^/ ]]; then
      invalid_paths+=("Line $line_num: Invalid path (starts with / after bucket): $gs_path")
      continue
    fi
  done < "$paths_file"

  if [[ ${#invalid_paths[@]} -gt 0 ]]; then
    error "GCS path validation failed. Found ${#invalid_paths[@]} invalid path(s):

$(printf '%s\n' "${invalid_paths[@]}")

Please verify:
  1. All paths start with gs://
  2. Paths do not contain ../ (path traversal)
  3. Paths do not start with / after bucket name

This may indicate a malformed bundle file or security issue."
  fi

  debug "✓ All GCS paths validated"
}

# Fail when a bundle resolved to no artifacts. Sets ARTIFACT_COUNT for reporting.
require_nonempty_artifacts() {
  ARTIFACT_COUNT=$(wc -l < "$PATHS_FILE")

  if [[ "$ARTIFACT_COUNT" -eq 0 ]]; then
    if [[ "$BUNDLE_KIND" == "ModelBundle" ]]; then
      error "No artifacts found in v3 bundle file: $BUNDLE_FILE

Every modelConfigs entry resolved to zero artifacts, which should not happen for a
well-formed bundle.

Expected structure:
  spec:
    modelConfigs:
    - model: <model-name>:<version>   # checkpoint comes from the Model CR
      profile: <profile-name>         # PEF refs come from the ModelProfile CR"
    fi

    error "No artifacts found in bundle file: $BUNDLE_FILE

This script requires v2 bundle format with PEF references and/or checkpoint definitions.

Expected structure:
  spec:
    models:
      MODEL_NAME:
        experts:
          EXPERT:
            configs:
            - pef: pef-name:version

  spec:
    checkpoints:
      CHECKPOINT_NAME:
        source: gs://bucket/path/to/checkpoint

Please verify your bundle file is in v2 format."
  fi

  info "Found $ARTIFACT_COUNT unique artifact(s) to download"
}

#######################################
# Sizing and disk space
#######################################

# Report the size a GCS artifact occupies, or 0 when it does not exist.
# Usage: artifact_size_bytes <gs-path>
#
# A .pef path is sized by its parent directory, which the download syncs whole.
artifact_size_bytes() {
  local gs_path="$1"

  if [[ "$gs_path" =~ \.pef$ ]]; then
    local pef_dir="${gs_path%/*}"
    debug "  PEF file detected, checking parent directory: $pef_dir"
    gsutil du -s "$pef_dir" 2>/dev/null | awk '{print $1}' || echo "0"
  else
    gsutil du -s "$gs_path" 2>/dev/null | awk '{print $1}' || echo "0"
  fi
}

# List every artifact, verifying each exists and totalling the transfer size.
# Sets TOTAL_SIZE, VALIDATION_FAILED, MISSING_ARTIFACTS. A dry run only lists paths.
display_artifacts() {
  info "Artifacts to download:"
  echo ""

  TOTAL_SIZE=0
  VALIDATION_FAILED=0
  MISSING_ARTIFACTS=()

  local gs_path display_name size_info
  while IFS= read -r gs_path; do
    # Display the path below the bucket, matching where each lands on disk.
    display_name="$(gcs_relative_path "$gs_path")"

    if [[ "$DRY_RUN" == "1" ]]; then
      echo "  - $display_name"
      debug "  Full path: $gs_path"
      continue
    fi

    size_info="$(artifact_size_bytes "$gs_path")"

    if [[ "$size_info" == "0" ]]; then
      echo "  - $display_name (not found)"
      MISSING_ARTIFACTS+=("$gs_path")
      VALIDATION_FAILED=1
      debug "  Path: $gs_path"
    else
      TOTAL_SIZE=$((TOTAL_SIZE + size_info))
      echo "  - $display_name ($(to_gib "$size_info") GiB)"
      debug "✓ Verified: $(basename "$gs_path")"
    fi

    debug "  Full path: $gs_path"
  done < "$PATHS_FILE"
}

# Warn (dry run) or fail (real run) when the output filesystem cannot hold the transfer.
# Usage: check_disk_space <required-bytes>
check_disk_space() {
  local required_bytes="$1"

  local total_gib
  total_gib="$(to_gib "$required_bytes")"
  echo ""
  info "Total download size: ${total_gib} GiB"

  info "Checking available disk space..."

  local output_parent available_space available_gib
  output_parent=$(dirname "$(realpath "$OUTPUT_DIR" 2>/dev/null || echo "$OUTPUT_DIR")")

  # df reports 1K blocks on macOS and accepts an explicit byte size on Linux.
  if [[ "$(uname)" == "Darwin" ]]; then
    available_space=$(df -k "$output_parent" | tail -1 | awk '{print $4}')
    available_space=$((available_space * 1024))
  else
    available_space=$(df -B1 "$output_parent" | tail -1 | awk '{print $4}')
  fi

  available_gib="$(to_gib "$available_space")"
  info "Available disk space: ${available_gib} GiB"

  if [[ "$available_space" -ge "$required_bytes" ]]; then
    info "✓ Sufficient disk space available"
    return 0
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    warn "Insufficient disk space detected!

Required: ${total_gib} GiB
Available: ${available_gib} GiB
Output directory: $OUTPUT_DIR

Please free up disk space or choose a different output directory before running actual download."
  else
    error "Insufficient disk space!

Required: ${total_gib} GiB
Available: ${available_gib} GiB
Output directory: $OUTPUT_DIR

Please free up disk space or choose a different output directory."
  fi
}

# Report the outcome of artifact validation and abort a real run on any missing artifact.
gate_on_validation() {
  if [[ "$DRY_RUN" == "0" ]] && [[ "$VALIDATION_FAILED" == "1" ]]; then
    echo ""
    error "Validation failed: ${#MISSING_ARTIFACTS[@]} artifact(s) not found in GCS.

Missing artifacts:
$(printf '  - %s\n' "${MISSING_ARTIFACTS[@]}")

Please verify:
  1. The bundle file is correct and up-to-date
  2. You have access to the GCS bucket
  3. The artifacts exist at the specified paths

No files were downloaded (prevented partial download)."
  fi

  if [[ "$DRY_RUN" == "0" ]] && [[ "$VALIDATION_FAILED" == "0" ]]; then
    echo ""
    info "✓ All artifacts validated successfully"
    echo ""
  fi
}

#######################################
# Download
#######################################

# Return 0 if a GCS path is a file, 1 if it is a directory (via gsutil stat).
is_gcs_file() {
  local gs_path="$1"

  if gsutil -q stat "$gs_path"; then
    return 0
  else
    return 1
  fi
}

# Download one artifact, preserving its path below the bucket.
# Usage: download_artifact <gs-path> <output-base>
#
# A .pef path syncs its whole parent directory; anything else is copied (file) or synced
# (directory) according to what it is in GCS.
download_artifact() {
  local gs_path="$1"
  local output_base="$2"

  local local_path="${output_base}/$(gcs_relative_path "$gs_path")"

  if [[ "$gs_path" =~ \.pef$ ]]; then
    local pef_dir="${gs_path%/*}"
    local pef_local_path="${output_base}/$(gcs_relative_path "$pef_dir")"

    info "Syncing PEF directory: $(basename "$pef_dir") (contains $(basename "$gs_path"))"
    mkdir -p "$pef_local_path"

    gsutil -m rsync -r "$pef_dir/" "$pef_local_path/" ||
      error "✗ Failed to sync PEF directory: $(basename "$pef_dir")"
    info "✓ Synced PEF directory: $(basename "$pef_dir")"
  elif is_gcs_file "$gs_path"; then
    info "Downloading file: $(basename "$gs_path")"
    mkdir -p "$(dirname "$local_path")"

    gsutil -m cp "$gs_path" "$local_path" ||
      error "✗ Failed to download: $(basename "$gs_path")"
    info "✓ Downloaded file: $(basename "$gs_path")"
  else
    info "Syncing directory: $(basename "$gs_path")"
    mkdir -p "$local_path"

    gsutil -m rsync -r "$gs_path" "$local_path" ||
      error "✗ Failed to sync directory: $(basename "$gs_path")"
    info "✓ Synced directory: $(basename "$gs_path")"
  fi
}

# Create the output directory for a real download.
prepare_output_dir() {
  mkdir -p "$OUTPUT_DIR"
  info "Output directory: $OUTPUT_DIR"
}

# Download every resolved artifact into the output directory.
download_all() {
  info "Starting download..."
  echo ""

  local gs_path
  while IFS= read -r gs_path; do
    if ! download_artifact "$gs_path" "$OUTPUT_DIR"; then
      error "Download failed for: $gs_path"
    fi
    echo ""
  done < "$PATHS_FILE"
}

#######################################
# Reporting
#######################################

# Write a machine-readable record of what was downloaded. Sets MANIFEST_FILE.
write_manifest() {
  MANIFEST_FILE="$OUTPUT_DIR/download-manifest.txt"
  info "Generating download manifest..."

  {
    echo "# Bundle Artifact Download Manifest"
    echo "# Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
    echo "# Bundle: $BUNDLE_FILE"
    echo "# Kind: $BUNDLE_KIND"
    echo "# Chart: $CHART_DIR"
    echo "# Artifacts: $ARTIFACT_COUNT"
    echo ""
    echo "# Downloaded Artifacts:"
    echo "# Format: local_path|gs_path|size|type"

    local gs_path local_path
    while IFS= read -r gs_path; do
      local_path="${OUTPUT_DIR}/$(gcs_relative_path "$gs_path")"

      if [[ -f "$local_path" ]]; then
        echo "$local_path|$gs_path|$(du -h "$local_path" | awk '{print $1}')|file"
      elif [[ -d "$local_path" ]]; then
        echo "$local_path|$gs_path|$(du -sh "$local_path" | awk '{print $1}')|directory"
      fi
    done < "$PATHS_FILE"
  } > "$MANIFEST_FILE"

  info "✓ Manifest saved to: $MANIFEST_FILE"
}

# Print the downloaded directory tree, falling back to find when 'tree' is absent.
show_tree() {
  if command -v tree &> /dev/null; then
    info "Directory structure:"
    tree -h -L 3 "$OUTPUT_DIR"
  else
    info "Directory structure (install 'tree' for better visualization):"
    find "$OUTPUT_DIR" -type f -exec ls -lh {} \; | awk '{print $9, "("$5")"}'
  fi
}

# Print the closing summary and the bucket-to-local mapping.
show_summary() {
  echo ""
  info "=========================================="
  info "Download Complete!"
  info "=========================================="
  info "Bundle: $(basename "$BUNDLE_FILE")"
  info "Artifacts: $ARTIFACT_COUNT"
  info "Output: $OUTPUT_DIR"
  info "Manifest: $MANIFEST_FILE"
  echo ""

  info "Bucket to local directory mapping:"
  local gs_path
  while IFS= read -r gs_path; do
    echo "  gs://$(gcs_bucket "$gs_path")/* → $OUTPUT_DIR/* (bucket name stripped)"
  done < "$PATHS_FILE" | sort -u
}

#######################################
# Orchestration
#######################################
main() {
  parse_args "$@"

  check_prerequisites

  validate_bundle_file
  resolve_chart_envs
  detect_bundle_kind
  validate_chart_options
  resolve_chart_dir
  detect_chart_layout "$CHART_DIR"
  validate_chart_structure "$CHART_DIR"

  authenticate

  collect_artifacts
  resolve_pef_refs

  validate_gcs_paths "$PATHS_FILE"
  require_nonempty_artifacts

  display_artifacts
  if [[ "$TOTAL_SIZE" -gt 0 ]]; then
    check_disk_space "$TOTAL_SIZE"
  fi
  gate_on_validation

  if [[ "$DRY_RUN" == "1" ]]; then
    echo ""
    info "Dry run complete."
    info "Output directory would be: $OUTPUT_DIR"
    return 0
  fi

  prepare_output_dir
  download_all
  write_manifest
  show_tree
  show_summary
}

main "$@"
