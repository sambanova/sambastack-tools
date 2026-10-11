#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

info() { echo "[INFO] $*" >&2; }
error() { echo "[ERROR] $*" >&2; exit 1; }

show_help() {
  cat <<EOF
Usage: $0 -c <chart-path> -o <output.yaml> [OPTIONS]

Required:
  -c PATH           Path to Helm chart (directory or tarball)
  -o FILE           Output inventory YAML file

Options:
  -f FILE           Values file
  -h, --help        Show this help message

- Activate your serviece account and Authenticate your crane cli
`gcloud auth print-access-token | crane auth login -u oauth2accesstoken --password-stdin us-west2-docker.pkg.dev`

- Install yq as a prerequisite for extracting images from annotations

EOF
  exit 1
}

# Use Bazel-provided yq if available, else fall back to PATH
YQ="${YQ:-yq}"

# Check for required dependencies
for cmd in helm tar; do
  command -v "$cmd" >/dev/null 2>&1 || error "$cmd is required"
done
command -v "$YQ" >/dev/null 2>&1 || error "yq is required (set \$YQ or install yq on PATH)"

[[ $# -lt 1 ]] && show_help

declare -a VALUES_FILES
while [[ $# -gt 0 ]]; do
  case "$1" in
    -c) CHART_PATH="$2"; shift 2 ;;
    -o) OUTPUT_FILE="$2"; shift 2 ;;
    -f) VALUES_FILES+=("$2"); shift 2 ;;
    -h|--help) show_help ;;
    *) error "Unknown arg $1" ;;
  esac
done

[[ -z "${CHART_PATH:-}" ]] && error "Chart path (-c) is required"
[[ -z "${OUTPUT_FILE:-}" ]] && error "Output file (-o) is required"
[[ ! -e "$CHART_PATH" ]] && error "Chart not found: $CHART_PATH"
mkdir -p "$(dirname "$OUTPUT_FILE")"
STACKCHART_TMPDIR=$(mktemp -d -t "stackchart.XXXXXX")
trap 'rm -rf "$STACKCHART_TMPDIR"' EXIT

# Add a temporary directory for extraction if CHART_PATH is a tarball
if [[ "$CHART_PATH" == *.tar || "$CHART_PATH" == *.tgz ]]; then
  info "Extracting Helm chart tarball: $CHART_PATH"
  # Create a temporary directory to extract the chart
  TEMP_CHART_DIR="$STACKCHART_TMPDIR/chartdir"
  mkdir -p "$TEMP_CHART_DIR"

  # Untar the chart into the temporary directory
  tar -xf "$CHART_PATH" -C "$TEMP_CHART_DIR"

  # Find the actual chart directory inside the temporary directory
  # Assuming the tarball contains a single top-level directory (the chart)
  FOUND_CHART_ROOT=$(find "$TEMP_CHART_DIR" -maxdepth 1 -mindepth 1 -type d -print -quit)
  if [[ -z "$FOUND_CHART_ROOT" ]]; then
    error "Could not find chart root directory in extracted tarball."
  fi
  CHART_PATH="$FOUND_CHART_ROOT" # Update CHART_PATH to point to the extracted directory
  info "Using extracted chart path: $CHART_PATH"
fi

info "Processing chart: $CHART_PATH"

# Get chart metadata
CHART_ABS=$(cd "$CHART_PATH" && pwd)
NAME="$(helm show chart "$CHART_ABS" | awk '/^name:/ {print $2}')"
VERSION="$(helm show chart "$CHART_ABS" | awk '/^version:/ {print $2}')"
[[ -z "$NAME" || -z "$VERSION" ]] && error "Cannot read chart metadata"

# Build values args if provided
VALUES_ARGS=()
for values_file in "${VALUES_FILES[@]+"${VALUES_FILES[@]}"}"; do
  VALUES_ARGS+=(-f "$values_file")
done

# Create temporary file for images
TMP_HELM_IMAGES="$STACKCHART_TMPDIR/images.txt"
echo "" > "$TMP_HELM_IMAGES"

# Extract images from helm template using grep and sed.
# The leading "-?[[:space:]]*" also catches the YAML list-item shorthand
# some (esp. third-party) charts use, e.g. "- image: repo:tag" as the first
# key of a containers[] entry, not just "  image: repo:tag" on its own line.
info "Extracting images from helm template"
helm template "$CHART_ABS" "${VALUES_ARGS[@]+"${VALUES_ARGS[@]}"}" \
  2> >(cat >&2) \
  | grep -E '^[[:space:]]*-?[[:space:]]*image:' \
  | sed -E 's/^[[:space:]]*-?[[:space:]]*image:[[:space:]]*//' \
  | sed -E 's/^"(.*)"$/\1/' \
  | sort -u > "$TMP_HELM_IMAGES" || error "Failed to extract images"


# Extract images from helm chart annotations (for operators)
info "Extracting images from annotations"
helm template "$CHART_ABS" "${VALUES_ARGS[@]+"${VALUES_ARGS[@]}"}" \
  2> >(cat >&2) \
  | "$YQ" eval '
      select(.metadata.annotations != null)
      | .metadata.annotations
      | with_entries(select(.key | test("image")))
      | .[] | select(. != null)
    ' - \
  | sed -e 's/^"//' -e 's/"$//' \
  | sort -u >> "$TMP_HELM_IMAGES" || error "failed to extract from annotations"


# Deduplicate images collected from both sources
if [[ -s "$TMP_HELM_IMAGES" ]]; then
  TMP_SORTED=$(mktemp)
  sort -u "$TMP_HELM_IMAGES" > "$TMP_SORTED"
  mv "$TMP_SORTED" "$TMP_HELM_IMAGES"
  # Remove empty lines
  sed -i.bak '/^[[:space:]]*$/d' "$TMP_HELM_IMAGES"
  rm -f "$TMP_HELM_IMAGES.bak"
fi

# Replace docker.io/bitnami with docker.io/bitnamilegacy
if [[ -s "$TMP_HELM_IMAGES" ]]; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' 's|^docker\.io/bitnami|docker\.io/bitnamilegacy|' "$TMP_HELM_IMAGES"
  else
    sed -i 's|^docker\.io/bitnami|docker\.io/bitnamilegacy|' "$TMP_HELM_IMAGES"
  fi
fi

# Construct the final OUTPUT_FILE using yq
info "Constructing the final inventory file: $OUTPUT_FILE"
echo "charts: []" > "$OUTPUT_FILE"

# Add chart entry
"$YQ" eval -i ".charts += [{\"name\": \"$NAME\", \"version\": \"$VERSION\", \"path\": \".\"}]" "$OUTPUT_FILE"

# Inject images for the chart
IMAGES_YAML="$STACKCHART_TMPDIR/images.yaml"
echo "" > $IMAGES_YAML
sed 's/^/- /' "$TMP_HELM_IMAGES" > "$IMAGES_YAML"
"$YQ" eval -i "(.charts[0]).images = load(\"$IMAGES_YAML\")" "$OUTPUT_FILE"
rm -f "$IMAGES_YAML"

# Extract chart dependencies, skipping local (file://) references.
# Aliased dependencies (e.g. the global-queue-redis and response-queue-redis
# aliases of redis) point at the same upstream package, so they collapse to
# identical name/version/repository entries once the alias is dropped. Only the
# package matters for mirroring, so deduplicate them.
info "Extracting chart dependencies"
DEPS_YAML="$STACKCHART_TMPDIR/deps.yaml"
helm show chart "$CHART_ABS" \
  | "$YQ" eval '
      [.dependencies // [] | .[]
        | select((.repository // "") != "")
        | select((.repository // "") | test("^file:") | not)
        | {"name": .name, "version": .version, "repository": .repository}]
      | unique_by([.name, .version, .repository])
    ' - > "$DEPS_YAML" || error "Failed to extract chart dependencies"

# Inject chart dependencies for the chart
"$YQ" eval -i "(.charts[0]).charts = load(\"$DEPS_YAML\")" "$OUTPUT_FILE"
rm -f "$DEPS_YAML"

info "Inventory generation complete."
