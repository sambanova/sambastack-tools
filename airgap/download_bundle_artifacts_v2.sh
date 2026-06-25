#!/usr/bin/env bash
set -euo pipefail

#######################################
# Download V2 Bundle Artifacts Script
#
# Downloads all artifacts (checkpoints and PEFs) required for a v2 bundle.
# V2 bundles use PEF name references (pef-name:version) instead of direct GCS paths.
# Requires access to helm chart (or chart directory) to resolve PEF references.
# Validates all artifacts exist before starting download (no partial downloads).
# Preserves relative directory structure from GCS paths (bucket name is stripped).
#######################################

#######################################
# Configuration
#######################################
OUTPUT_DIR="${OUTPUT_DIR:-./artifacts}"
BUNDLE_FILE=""
CHART_FILE=""
CHART_DIR=""
TEMP_EXTRACT_DIR=""

# Relative path to PEF definitions within the helm chart
PEF_DEFINITIONS_PATH="charts/bundles/pefs/sambastack"

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
# Usage
#######################################
show_help() {
  cat <<EOF
Usage: $0 [OPTIONS] <bundle-template.yaml>

Download all artifacts required for a v2 bundle deployment.

REQUIRED:
  <bundle-template.yaml>    Path to v2 bundle template YAML file
                            (can be prebuilt or custom bundle)

REQUIRED OPTIONS (mutually exclusive):
  -c, --chart FILE          Path to helm chart .tgz file
                            (used to resolve PEF references)
  -d, --chart-dir DIR       Path to extracted helm chart directory
                            (used to resolve PEF references)

OPTIONS:
  -o, --output DIR          Output directory (default: ./artifacts)
                            (can also use OUTPUT_DIR env var)
  -s, --service-account     Service account JSON key file path
                            (can also use SERVICE_ACCOUNT env var)
  -n, --dry-run            Show what would be downloaded
  --skip-auth              Skip gcloud authentication
  --debug                  Enable debug output
  -h, --help               Show this help message

ENVIRONMENT VARIABLES:
  SERVICE_ACCOUNT          Path to service account JSON key file
  OUTPUT_DIR               Output directory for artifacts

REQUIRED CHART STRUCTURE:
  When using -d/--chart-dir, the directory must contain:
    - <dir>/charts/bundles/pefs/sambastack/

EXAMPLES:
  # Download artifacts for prebuilt bundle with extracted chart
  $0 -d ./sambastack 70b-ss-4-8k-tk.yaml

  # Download artifacts for prebuilt bundle with helm chart
  $0 -c sambastack-<VERSION>.tgz 70b-ss-4-8k-tk.yaml

  # Use custom output directory
  $0 -d ./sambastack 70b-ss-4-8k-tk.yaml -o /tmp/artifacts

  # Use service account authentication
  SERVICE_ACCOUNT=/path/to/key.json $0 -d ./sambastack 70b-ss-4-8k-tk.yaml

  # Dry run to see what would be downloaded
  $0 -d ./sambastack 70b-ss-4-8k-tk.yaml --dry-run

EOF
  exit 0
}

#######################################
# Cleanup Function
#######################################
cleanup() {
  [[ -n "${TEMP_EXTRACT_DIR:-}" ]] && [[ -d "$TEMP_EXTRACT_DIR" ]] && rm -rf "$TEMP_EXTRACT_DIR"
  [[ -n "${PATHS_FILE:-}" ]] && rm -f "$PATHS_FILE"
  [[ -n "${PEF_REFS_FILE:-}" ]] && rm -f "$PEF_REFS_FILE"
}

trap cleanup EXIT

#######################################
# Parse Arguments
#######################################
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"
DRY_RUN=0
SKIP_AUTH=0
DEBUG=0

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

#######################################
# Validate Prerequisites
#######################################
info "Checking prerequisites..."

check_command() {
  local cmd="$1"
  local install_hint="${2:-}"

  if ! command -v "$cmd" &> /dev/null; then
    error "Required command '$cmd' not found. ${install_hint}"
  fi
  debug "✓ Found: $cmd"
}

check_command "gcloud" "Install from: https://cloud.google.com/sdk/docs/install"
check_command "gsutil" "Part of gcloud SDK"
check_command "yq"
check_command "grep"
check_command "sed"
check_command "awk"
check_command "tar" "Usually pre-installed on macOS/Linux"

info "✓ All prerequisite commands are available"

#######################################
# Validate Input
#######################################

# Check bundle file
if [[ -z "$BUNDLE_FILE" ]]; then
  error "Bundle template file is required. Run $0 -h for more info."
fi

if [[ ! -f "$BUNDLE_FILE" ]]; then
  error "Bundle template file not found: $BUNDLE_FILE"
fi

info "Bundle template: $BUNDLE_FILE"

# Check mutual exclusivity of chart options
if [[ -n "$CHART_FILE" ]] && [[ -n "$CHART_DIR" ]]; then
  error "Options -c/--chart and -d/--chart-dir are mutually exclusive. Use only one."
fi

if [[ -z "$CHART_FILE" ]] && [[ -z "$CHART_DIR" ]]; then
  error "Either -c/--chart or -d/--chart-dir is required. Run $0 -h for more info."
fi

# Validate chart file if provided
if [[ -n "$CHART_FILE" ]]; then
  if [[ ! -f "$CHART_FILE" ]]; then
    error "Helm chart file not found: $CHART_FILE"
  fi
  info "Helm chart: $CHART_FILE"
fi

# Validate chart directory if provided
if [[ -n "$CHART_DIR" ]]; then
  if [[ ! -d "$CHART_DIR" ]]; then
    error "Chart directory not found: $CHART_DIR"
  fi
  info "Chart directory: $CHART_DIR"
fi

#######################################
# Extract Helm Chart if Provided
#######################################
extract_helm_chart() {
  local chart_file="$1"

  info "Extracting helm chart..."
  TEMP_EXTRACT_DIR=$(mktemp -d)
  debug "Temporary extraction directory: $TEMP_EXTRACT_DIR"

  if ! tar -xzf "$chart_file" -C "$TEMP_EXTRACT_DIR" 2>/dev/null; then
    error "Failed to extract helm chart: $chart_file"
  fi

  # Find the extracted directory (usually 'sambastack')
  local extracted_dir=$(find "$TEMP_EXTRACT_DIR" -mindepth 1 -maxdepth 1 -type d | head -1)

  if [[ -z "$extracted_dir" ]]; then
    error "No directory found after extracting helm chart"
  fi

  info "✓ Chart extracted successfully"
  echo "$extracted_dir"
}

if [[ -n "$CHART_FILE" ]]; then
  CHART_DIR=$(extract_helm_chart "$CHART_FILE")
fi

#######################################
# Validate Chart Structure
#######################################
validate_chart_structure() {
  local chart_dir="$1"

  info "Validating chart structure..."

  local pefs_dir="$chart_dir/$PEF_DEFINITIONS_PATH"

  if [[ ! -d "$pefs_dir" ]]; then
    error "Required directory not found: $pefs_dir

Expected chart structure:
  <chart-dir>/$PEF_DEFINITIONS_PATH

This directory is needed to resolve PEF references to GCS paths."
  fi

  # Check if there are any PEF definition files
  local pef_count=$(find "$pefs_dir" -name "*.yaml" -type f 2>/dev/null | wc -l)
  if [[ "$pef_count" -eq 0 ]]; then
    error "No PEF definition files found in: $pefs_dir"
  fi

  info "✓ Chart structure is valid"
  debug "  Found $pef_count PEF definition file(s)"
}

validate_chart_structure "$CHART_DIR"

#######################################
# Authenticate with gcloud
#######################################
if [[ "$SKIP_AUTH" == "0" ]]; then
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
else
  info "Skipping authentication (--skip-auth)"

  # Check if user is actually logged in when using --skip-auth
  ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1)

  if [[ -z "$ACTIVE_ACCOUNT" ]]; then
    error "No active gcloud account found. Cannot use --skip-auth without authentication.

Please either:
  1. Authenticate with gcloud: gcloud auth login
  2. Use a service account: $0 -s /path/to/service-account.json -d <chart-dir> <bundle-file>
  3. Set SERVICE_ACCOUNT env var: SERVICE_ACCOUNT=/path/to/key.json $0 -d <chart-dir> <bundle-file>"
  fi

  # If no SERVICE_ACCOUNT was provided, prompt user to confirm using active account
  if [[ -z "$SERVICE_ACCOUNT" ]]; then
    echo ""
    info "Active gcloud account: $ACTIVE_ACCOUNT"
    echo ""

    # Prompt user for confirmation
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

    info "✓ Proceeding with account: $ACTIVE_ACCOUNT"
  else
    info "✓ Using SERVICE_ACCOUNT env var (authentication skipped)"
  fi
fi

#######################################
# PEF Resolution Functions
#######################################

# Parse PEF reference (format: pef-name:version)
parse_pef_reference() {
  local pef_ref="$1"

  if [[ ! "$pef_ref" =~ ^([^:]+):([^:]+)$ ]]; then
    error "Invalid PEF reference format: $pef_ref
Expected format: <pef-name>:<version> (e.g., llama-3p1-1b-ss4096-bs1:1)"
  fi

  local pef_name="${BASH_REMATCH[1]}"
  local pef_version="${BASH_REMATCH[2]}"

  debug "Parsed PEF reference: $pef_ref -> name=$pef_name, version=$pef_version"

  echo "$pef_name|$pef_version"
}

# Resolve PEF reference to GCS paths
resolve_pef_to_gcs() {
  local pef_ref="$1"
  local chart_dir="$2"

  # Parse PEF reference
  local parsed=$(parse_pef_reference "$pef_ref")
  local pef_name=$(echo "$parsed" | cut -d'|' -f1)
  local pef_version=$(echo "$parsed" | cut -d'|' -f2)

  # Locate PEF definition file
  local pef_file="$chart_dir/$PEF_DEFINITIONS_PATH/${pef_name}.yaml"

  if [[ ! -f "$pef_file" ]]; then
    error "PEF definition file not found: $pef_file
PEF reference: $pef_ref
Bundle file: $BUNDLE_FILE

Please ensure the chart contains the PEF definition for '$pef_name'."
  fi

  debug "Reading PEF definition: $pef_file"

  # Extract GCS source path for the specified version
  local source_path=$(yq eval ".spec.versions.\"${pef_version}\".source" "$pef_file")

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

  # Check for copy_pef
  local copy_pef_path=$(yq eval ".spec.copy_pef" "$pef_file")

  if [[ -n "$copy_pef_path" ]] && [[ "$copy_pef_path" != "null" ]]; then
    if [[ "$copy_pef_path" =~ ^gs:// ]]; then
      debug "  ✓ Found copy_pef: $copy_pef_path"
      echo "$copy_pef_path"
    fi
  fi

  # Check for vision_embedding_pef
  local vision_embedding_pef_path=$(yq eval ".spec.vision_embedding_pef" "$pef_file")

  if [[ -n "$vision_embedding_pef_path" ]] && [[ "$vision_embedding_pef_path" != "null" ]]; then
    if [[ "$vision_embedding_pef_path" =~ ^gs:// ]]; then
      debug "  ✓ Found vision_embedding_pef: $vision_embedding_pef_path"
      echo "$vision_embedding_pef_path"
    fi
  fi
}

#######################################
# Extract GCS Paths from V2 Bundle
#######################################
info "Parsing v2 bundle template..."

# Create temporary file for paths
PATHS_FILE=$(mktemp)

info "Extracting artifacts from bundle: $(basename "$BUNDLE_FILE")"

# Temporary file for PEF references
PEF_REFS_FILE=$(mktemp)

# Extract all PEF references from the specific bundle file
debug "Processing bundle: $BUNDLE_FILE"

# Extract PEF references (format: pef-name:version)
# Note: || true handles valid empty results (bundle without PEFs)
yq eval '.. | select(has("pef")) | .pef' "$BUNDLE_FILE" | \
  grep -E '^[^:]+:[^:]+$' >> "$PEF_REFS_FILE" || true

# Extract checkpoint sources (same as v1)
# Note: || true handles valid empty results (bundle without checkpoints)
yq eval '.spec.checkpoints.*.source' "$BUNDLE_FILE" | \
  grep -E '^gs://' >> "$PATHS_FILE" || true

# Get unique PEF references
sort -u "$PEF_REFS_FILE" -o "$PEF_REFS_FILE"

PEF_COUNT=$(wc -l < "$PEF_REFS_FILE")
info "Found $PEF_COUNT unique PEF reference(s)"

# Resolve PEF references to GCS paths
if [[ "$PEF_COUNT" -gt 0 ]]; then
  info "Resolving PEF references to GCS paths..."

  while IFS= read -r pef_ref; do
    if [[ -n "$pef_ref" ]]; then
      debug "Resolving: $pef_ref"
      resolve_pef_to_gcs "$pef_ref" "$CHART_DIR" >> "$PATHS_FILE"
    fi
  done < "$PEF_REFS_FILE"
fi

# Sort and deduplicate all paths
sort -u "$PATHS_FILE" -o "$PATHS_FILE"

#######################################
# Validate GCS Paths
#######################################
info "Validating GCS paths..."

validate_gcs_paths() {
  local paths_file="$1"
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
}

validate_gcs_paths "$PATHS_FILE"
debug "✓ All GCS paths validated"

ARTIFACT_COUNT=$(wc -l < "$PATHS_FILE")

if [[ "$ARTIFACT_COUNT" -eq 0 ]]; then
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

#######################################
# Display and Validate Artifacts
#######################################
info "Artifacts to download:"
echo ""

TOTAL_SIZE=0
VALIDATION_FAILED=0
MISSING_ARTIFACTS=()

while IFS= read -r gs_path; do
  # Show full path relative to bucket for all artifacts (consistent display)
  # Strip bucket name to show: version/x.x.x/pefs-checkpoints/...
  bucket_and_path="${gs_path#gs://}"
  bucket_name="${bucket_and_path%%/*}"
  display_name="${bucket_and_path#*/}"

  if [[ "$DRY_RUN" == "0" ]]; then
    # For PEF files, get size of parent directory instead
    if [[ "$gs_path" =~ \.pef$ ]]; then
      pef_dir="${gs_path%/*}"
      size_info=$(gsutil du -s "$pef_dir" 2>/dev/null | awk '{print $1}' || echo "0")
      debug "  PEF file detected, checking parent directory: $pef_dir"
    else
      size_info=$(gsutil du -s "$gs_path" 2>/dev/null | awk '{print $1}' || echo "0")
    fi

    if [[ "$size_info" == "0" ]]; then
      echo "  - $display_name (not found)"
      MISSING_ARTIFACTS+=("$gs_path")
      VALIDATION_FAILED=1
      debug "  Path: $gs_path"
    else
      size_gib=$(awk "BEGIN {printf \"%.2f\", $size_info/1024/1024/1024}")
      TOTAL_SIZE=$((TOTAL_SIZE + size_info))
      echo "  - $display_name (${size_gib} GiB)"
      debug "✓ Verified: $(basename "$gs_path")"
    fi
  else
    echo "  - $display_name"
  fi

  debug "  Full path: $gs_path"
done < "$PATHS_FILE"

if [[ "$TOTAL_SIZE" -gt 0 ]]; then
  # Convert bytes to GiB for display (1024-based)
  total_gib=$(awk "BEGIN {printf \"%.2f\", $TOTAL_SIZE/1024/1024/1024}")
  echo ""
  info "Total download size: ${total_gib} GiB"

  # Check available disk space (in both dry-run and execution modes)
  info "Checking available disk space..."

  # Get the parent directory of OUTPUT_DIR to check space
  output_parent=$(dirname "$(realpath "$OUTPUT_DIR" 2>/dev/null || echo "$OUTPUT_DIR")")

  # Get available space in bytes (works on both macOS and Linux)
  if [[ "$(uname)" == "Darwin" ]]; then
    # macOS
    available_space=$(df -k "$output_parent" | tail -1 | awk '{print $4}')
    available_space=$((available_space * 1024))  # Convert KB to bytes
  else
    # Linux
    available_space=$(df -B1 "$output_parent" | tail -1 | awk '{print $4}')
  fi

  # Convert bytes to GiB for display (1024-based)
  available_gib=$(awk "BEGIN {printf \"%.2f\", $available_space/1024/1024/1024}")

  info "Available disk space: ${available_gib} GiB"

  # Compare raw bytes (resistant to GB/GiB discrepancies)
  if [[ "$available_space" -lt "$TOTAL_SIZE" ]]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      # Warning in dry-run mode
      warn "Insufficient disk space detected!

Required: ${total_gib} GiB
Available: ${available_gib} GiB
Output directory: $OUTPUT_DIR

Please free up disk space or choose a different output directory before running actual download."
    else
      # Error in execution mode
      error "Insufficient disk space!

Required: ${total_gib} GiB
Available: ${available_gib} GiB
Output directory: $OUTPUT_DIR

Please free up disk space or choose a different output directory."
    fi
  else
    info "✓ Sufficient disk space available"
  fi
fi

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

#######################################
# Dry Run Exit
#######################################
if [[ "$DRY_RUN" == "1" ]]; then
  echo ""
  info "Dry run complete."
  info "Output directory would be: $OUTPUT_DIR"
  exit 0
fi

#######################################
# Create Output Directory
#######################################
mkdir -p "$OUTPUT_DIR"
info "Output directory: $OUTPUT_DIR"

#######################################
# Download Artifacts
#######################################
info "Starting download..."
echo ""

# Function to check if a GCS path is a file or directory
#
# Uses gsutil stat to determine if a path is a file or directory:
# - Files: gsutil stat succeeds (exit code 0)
# - Directories: gsutil stat fails with "No URLs matched" (exit code non-zero)
is_gcs_file() {
  local gs_path="$1"

  # Check if gsutil stat succeeds (file) or fails (directory)
  if gsutil -q stat "$gs_path"; then
    return 0  # It's a file
  else
    return 1  # It's a directory
  fi
}

# Function to download a single artifact
download_artifact() {
  local gs_path="$1"
  local output_base="$2"

  # Parse GCS path: gs://bucket/path/to/artifact
  local bucket_and_path="${gs_path#gs://}"
  local bucket_name="${bucket_and_path%%/*}"
  local relative_path="${bucket_and_path#*/}"

  # Strip bucket name from local path (as per v1 script behavior)
  local local_path="${output_base}/${relative_path}"
  local local_dir=$(dirname "$local_path")

  # For PEF files, sync the parent directory instead of copying the file
  if [[ "$gs_path" =~ \.pef$ ]]; then
    local pef_filename=$(basename "$gs_path")
    local pef_dir="${gs_path%/*}"
    local pef_dir_name=$(basename "$pef_dir")

    # Calculate local path for PEF directory (strip bucket name)
    local pef_dir_bucket_and_path="${pef_dir#gs://}"
    local pef_dir_relative="${pef_dir_bucket_and_path#*/}"
    local pef_local_path="${output_base}/${pef_dir_relative}"

    info "Syncing PEF directory: $pef_dir_name (contains $pef_filename)"

    mkdir -p "$pef_local_path"

    if gsutil -m rsync -r "$pef_dir/" "$pef_local_path/"; then
      info "✓ Synced PEF directory: $pef_dir_name"
      return 0
    else
      error "✗ Failed to sync PEF directory: $pef_dir_name"
    fi
  elif is_gcs_file "$gs_path"; then
    local filename=$(basename "$gs_path")
    info "Downloading file: $filename"

    mkdir -p "$local_dir"

    if gsutil -m cp "$gs_path" "$local_path"; then
      info "✓ Downloaded file: $filename"
      return 0
    else
      error "✗ Failed to download: $filename"
    fi
  else
    local dir_name=$(basename "$gs_path")
    info "Syncing directory: $dir_name"

    mkdir -p "$local_path"

    if gsutil -m rsync -r "$gs_path" "$local_path"; then
      info "✓ Synced directory: $dir_name"
      return 0
    else
      error "✗ Failed to sync directory: $dir_name"
    fi
  fi
}

while IFS= read -r gs_path; do
  if ! download_artifact "$gs_path" "$OUTPUT_DIR"; then
    error "Download failed for: $gs_path"
  fi
  echo ""
done < "$PATHS_FILE"

#######################################
# Generate Download Manifest
#######################################
MANIFEST_FILE="$OUTPUT_DIR/download-manifest.txt"
info "Generating download manifest..."

{
  echo "# V2 Bundle Artifact Download Manifest"
  echo "# Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
  echo "# Bundle: $BUNDLE_FILE"
  echo "# Chart: $CHART_DIR"
  echo "# Artifacts: $ARTIFACT_COUNT"
  echo ""
  echo "# Downloaded Artifacts:"
  echo "# Format: local_path|gs_path|size|type"

  while IFS= read -r gs_path; do
    bucket_and_path="${gs_path#gs://}"
    bucket_name="${bucket_and_path%%/*}"
    relative_path="${bucket_and_path#*/}"
    local_path="${OUTPUT_DIR}/${relative_path}"

    if [[ -f "$local_path" ]]; then
      file_size=$(du -h "$local_path" | awk '{print $1}')
      echo "$local_path|$gs_path|$file_size|file"
    elif [[ -d "$local_path" ]]; then
      dir_size=$(du -sh "$local_path" | awk '{print $1}')
      echo "$local_path|$gs_path|$dir_size|directory"
    fi
  done < "$PATHS_FILE"
} > "$MANIFEST_FILE"

info "✓ Manifest saved to: $MANIFEST_FILE"

#######################################
# Generate Directory Tree
#######################################
if command -v tree &> /dev/null; then
  info "Directory structure:"
  tree -h -L 3 "$OUTPUT_DIR"
else
  info "Directory structure (install 'tree' for better visualization):"
  find "$OUTPUT_DIR" -type f -exec ls -lh {} \; | awk '{print $9, "("$5")"}'
fi

#######################################
# Summary
#######################################
echo ""
info "=========================================="
info "Download Complete!"
info "=========================================="
info "Bundle: $(basename "$BUNDLE_FILE")"
info "Artifacts: $ARTIFACT_COUNT"
info "Output: $OUTPUT_DIR"
info "Manifest: $MANIFEST_FILE"
echo ""

# Display bucket mapping
info "Bucket to local directory mapping:"
while IFS= read -r gs_path; do
  bucket_name="${gs_path#gs://}"
  bucket_name="${bucket_name%%/*}"
  echo "  gs://$bucket_name/* → $OUTPUT_DIR/* (bucket name stripped)"
done < "$PATHS_FILE" | sort -u
