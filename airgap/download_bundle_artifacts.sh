#!/usr/bin/env bash
set -euo pipefail

#######################################
# Download Bundle Artifacts Script
#
# Downloads all artifacts (checkpoints and PEFs) required for a bundle.
# Validates all artifacts exist before starting download (no partial downloads).
# Preserves relative directory structure from GCS paths.
#######################################

#######################################
# Configuration
#######################################
OUTPUT_DIR="${OUTPUT_DIR:-./artifacts}"

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

Download all artifacts required for a bundle deployment.

REQUIRED:
  <bundle-template.yaml>    Path to bundle template YAML file

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

EXAMPLES:
  # Download artifacts for a bundle
  $0 helm/charts/bundles/bundles/sambastack/gpt-oss-120b-8k.yaml

  # Use custom output directory
  $0 -o /tmp/bundle-artifacts gpt-oss-120b-8k.yaml

  # Use service account authentication
  SERVICE_ACCOUNT=/path/to/key.json $0 bundle.yaml

  # Dry run to see what would be downloaded
  $0 --dry-run bundle.yaml

EOF
  exit 0
}

#######################################
# Parse Arguments
#######################################
BUNDLE_FILE=""
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-}"
DRY_RUN=0
SKIP_AUTH=0
DEBUG=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      show_help
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
check_command "yq" "Install with: brew install yq (or pip install yq)"
check_command "grep"
check_command "sed"
check_command "awk"

info "✓ All prerequisite commands are available"

#######################################
# Validate Input
#######################################
if [[ -z "$BUNDLE_FILE" ]]; then
  error "Bundle template file is required. Run $0 -h for more info."
fi

if [[ ! -f "$BUNDLE_FILE" ]]; then
  error "Bundle template file not found: $BUNDLE_FILE"
fi

info "Bundle template: $BUNDLE_FILE"

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
  2. Use a service account: $0 -s /path/to/service-account.json <bundle-file>
  3. Set SERVICE_ACCOUNT env var: SERVICE_ACCOUNT=/path/to/key.json $0 <bundle-file>"
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
  1. Use -s flag: $0 -s /path/to/service-account.json <bundle-file>
  2. Set env var: SERVICE_ACCOUNT=/path/to/key.json $0 <bundle-file>

Or authenticate with the correct account:
  gcloud auth login"
    fi

    info "✓ Proceeding with account: $ACTIVE_ACCOUNT"
  else
    info "✓ Using SERVICE_ACCOUNT env var (authentication skipped)"
  fi
fi

#######################################
# Extract GCS Paths from Bundle YAML
#######################################
info "Parsing bundle template..."

# Create temporary file for paths
PATHS_FILE=$(mktemp)
trap "rm -f '$PATHS_FILE'" EXIT

info "Extracting artifacts from bundle..."

# Extract all GCS source paths (PEFs and checkpoints)
yq eval '.. | select(has("source")) | .source' "$BUNDLE_FILE" 2>/dev/null | \
  grep -E '^gs://' | sort -u > "$PATHS_FILE"

ARTIFACT_COUNT=$(wc -l < "$PATHS_FILE")

if [[ "$ARTIFACT_COUNT" -eq 0 ]]; then
  error "No artifacts found in bundle file.

This script requires bundle format with inline PEF and checkpoint definitions.

Expected structure:
  spec:
    pefs:
      PEF_NAME:
        source: gs://bucket/path/to/pef

  spec:
    checkpoints:
      CHECKPOINT_NAME:
        source: gs://bucket/path/to/checkpoint

Please verify your bundle file contains 'source: gs://...' paths."
fi

info "Found $ARTIFACT_COUNT unique artifact(s)"

#######################################
# Display and Validate Artifacts
#######################################
info "Artifacts to download:"
echo ""

TOTAL_SIZE=0
VALIDATION_FAILED=0
MISSING_ARTIFACTS=()

while IFS= read -r gs_path; do
  filename=$(basename "$gs_path")

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
      echo "  - $filename (not found)"
      MISSING_ARTIFACTS+=("$gs_path")
      VALIDATION_FAILED=1
      debug "  Path: $gs_path"
    else
      size_gb=$(awk "BEGIN {printf \"%.2f\", $size_info/1024/1024/1024}")
      TOTAL_SIZE=$((TOTAL_SIZE + size_info))
      echo "  - $filename (${size_gb} GB)"
      debug "✓ Verified: $filename"
    fi
  else
    echo "  - $filename"
  fi

  debug "  Full path: $gs_path"
done < "$PATHS_FILE"

if [[ "$DRY_RUN" == "0" ]] && [[ "$TOTAL_SIZE" -gt 0 ]]; then
  total_gb=$(awk "BEGIN {printf \"%.2f\", $TOTAL_SIZE/1024/1024/1024}")
  echo ""
  info "Total download size: ${total_gb} GB"
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
is_gcs_file() {
  local gs_path="$1"

  # Check if path has a file extension
  if [[ "$gs_path" =~ \.[a-zA-Z0-9]+$ ]]; then
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
  local local_path="${output_base}/${relative_path}"
  local local_dir=$(dirname "$local_path")

  # For PEF files, sync the parent directory instead of copying the file
  if [[ "$gs_path" =~ \.pef$ ]]; then
    local pef_filename=$(basename "$gs_path")
    local pef_dir="${gs_path%/*}"
    local pef_dir_name=$(basename "$pef_dir")

    # Calculate local path for PEF directory
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
      return 1
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
      return 1
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
      return 1
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
  echo "# Bundle Artifact Download Manifest"
  echo "# Generated: $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
  echo "# Bundle: $BUNDLE_FILE"
  echo "# Artifacts: $ARTIFACT_COUNT"
  echo ""
  echo "# Downloaded Artifacts:"
  echo "# Format: local_path|gs_path|size|type"

  while IFS= read -r gs_path; do
    bucket_and_path="${gs_path#gs://}"
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
  echo "  gs://$bucket_name/* → $OUTPUT_DIR/*"
done < "$PATHS_FILE" | sort -u
