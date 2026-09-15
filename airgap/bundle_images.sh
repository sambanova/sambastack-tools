#!/usr/bin/env bash
set -euo pipefail

info() { echo -e "\033[1;32m[INFO]\033[0m $*" >&2; }
error() { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

show_help() {
  cat <<EOF
Usage:
  $0 -c <helm-chart-path> -i <inventory.yaml> -o <output.tar.zst>

Options:
  -c PATH   Path to local Helm chart
  -i FILE   Inventory YAML file with chart paths and images
  -o FILE   Output .tar.zst archive
EOF
  exit 1
}

# --- Parse arguments ---
[[ $# -lt 6 ]] && show_help
while [[ $# -gt 0 ]]; do
  case "$1" in
    -c) CHART_PATH="$2"; shift 2 ;;
    -i) INVENTORY="$2"; shift 2 ;;
    -o) OUTPUT_FILE="$2"; shift 2 ;;
    -h|--help) show_help ;;
    *) error "Unknown option: $1" ;;
  esac
done

[[ ! -e "$CHART_PATH" ]] && error "Chart not found: $CHART_PATH"
[[ ! -f "$INVENTORY" ]] && error "Inventory file not found: $INVENTORY"

for cmd in crane tar zstd yq; do
  command -v "$cmd" >/dev/null || error "Required command not found: $cmd"
done

# --- Set platform ---
PLATFORM="linux/amd64"

# --- Temp workspace ---
TMP_DIR=$(mktemp -d)
TMP_TAR="$TMP_DIR/bundle.tar"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# --- Copy/Extract Helm chart ---
if [[ "$CHART_PATH" == *.tar || "$CHART_PATH" == *.tgz ]]; then
  info "Extracting Helm chart tarball: $CHART_PATH"
  # Determine chart name without extension
  CHART_NAME=$(basename "$CHART_PATH")
  CHART_NAME="${CHART_NAME%.tar}"
  CHART_NAME="${CHART_NAME%.tgz}"
  EXTRACT_DEST="$TMP_DIR/$CHART_NAME"
  mkdir -p "$EXTRACT_DEST"
  tar -xf "$CHART_PATH" -C "$EXTRACT_DEST"
else
  info "Copying Helm chart directory: $CHART_PATH"
  cp -r "$CHART_PATH" "$TMP_DIR/"
fi

# --- Read inventory and collect images ---
info "Reading inventory..."
CHART_COUNT=$(yq e '.charts | length' "$INVENTORY")
declare -a ALL_IMAGES
for i in $(seq 0 $((CHART_COUNT-1))); do
  IMAGE_COUNT=$(yq e ".charts[$i].images | length" "$INVENTORY")
  for j in $(seq 0 $((IMAGE_COUNT-1))); do
    IMAGE=$(yq e ".charts[$i].images[$j]" "$INVENTORY")
    ALL_IMAGES+=("$IMAGE")
  done
done

TOTAL_IMAGES=${#ALL_IMAGES[@]}
[[ $TOTAL_IMAGES -gt 0 ]] || error "No images found in inventory"

# --- Validate all images exist ---
info "Validating that all $TOTAL_IMAGES images exist..."
declare -i CHECK_FAILED=0
declare -i IDX=1
for IMAGE in "${ALL_IMAGES[@]}"; do
  if ! crane manifest "$IMAGE" >/dev/null 2>&1; then
    echo -e "  [$IDX/$TOTAL_IMAGES] \033[1;31m✗ NOT FOUND: $IMAGE\033[0m" >&2
    ((CHECK_FAILED++))
  else
    echo "  [$IDX/$TOTAL_IMAGES] ✓ Found: $IMAGE"
  fi
  ((IDX++))
done

echo ""
if [[ $CHECK_FAILED -gt 0 ]]; then
  error "Image validation failed: $CHECK_FAILED/$TOTAL_IMAGES images not found"
fi

info "All images verified successfully!"
echo ""

# --- Pull images from YAML inventory ---
info "Pulling images..."
for i in $(seq 0 $((CHART_COUNT-1))); do
  CHART_NAME=$(yq e ".charts[$i].name" "$INVENTORY")
  CHART_PATH_LOCAL=$(yq e ".charts[$i].path" "$INVENTORY")
  IMAGE_COUNT=$(yq e ".charts[$i].images | length" "$INVENTORY")
  info "Processing chart $CHART_NAME with $IMAGE_COUNT images"

  for j in $(seq 0 $((IMAGE_COUNT-1))); do
    IMAGE=$(yq e ".charts[$i].images[$j]" "$INVENTORY")
    # Create a filename safe tar name
    FILENAME="${IMAGE##*/}"
    FILENAME="${FILENAME/:/__}.tar"
    OUTPUT_PATH="$TMP_DIR/$FILENAME"
    info "Pulling $IMAGE -> $OUTPUT_PATH for platform $PLATFORM"
    crane pull --platform "$PLATFORM" "$IMAGE" "$OUTPUT_PATH"
  done

  # Include chart tgz if specified
  if [[ -f "$CHART_PATH_LOCAL" && "$CHART_PATH_LOCAL" == *.tgz ]]; then
    cp "$CHART_PATH_LOCAL" "$TMP_DIR/"
  fi
done

# --- Combine into single tar ---
info "Combining charts + images into a single tar..."
tar -cf "$TMP_TAR" -C "$TMP_DIR" .

info "Compressing tar -> $OUTPUT_FILE..."
zstd -T0 -19 "$TMP_TAR" -o "$OUTPUT_FILE"

info "Bundle created successfully: $OUTPUT_FILE"
