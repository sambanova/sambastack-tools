#!/usr/bin/env bash
set -euo pipefail

LOCAL_BIN="$HOME/.local/bin"
mkdir -p "$LOCAL_BIN"
echo "Installing tools into $LOCAL_BIN"

# Minimum supported versions. These mirror the pins in the repo-root mise.toml;
# helm additionally must stay below 4.0.0 (see tools/helm-* version gate).
JQ_MIN_VERSION="1.8.1"
YQ_MIN_VERSION="4.47.1"
HELM_MIN_VERSION="3.20.1"
HELM_MAX_MAJOR="3"
CRANE_MIN_VERSION="0.21.6"

# Extract a dotted numeric version (e.g. "1.8.1") from arbitrary version output.
extract_version() { grep -oE '[0-9]+(\.[0-9]+)+' <<< "$1" | head -1; }

# require_min_version <name> <found> <minimum>: fail unless found >= minimum.
require_min_version() {
    local name="$1" found="$2" min="$3"
    if [ -z "$found" ]; then
        echo "ERROR: could not determine $name version" >&2; exit 1
    fi
    if [ "$(printf '%s\n%s\n' "$min" "$found" | sort -V | head -1)" != "$min" ]; then
        echo "ERROR: $name $found is older than the required minimum $min" >&2; exit 1
    fi
}

################################################################################
# jq
################################################################################
echo ">>> Installing jq"
if ! command -v jq &> /dev/null; then
    curl -sL "https://github.com/stedolan/jq/releases/latest/download/jq-linux64" -o "$LOCAL_BIN/jq"
    chmod +x "$LOCAL_BIN/jq"
else
    echo "jq already exists: $(command -v jq)"
fi

################################################################################
# yq
################################################################################
echo ">>> Installing yq"
if ! command -v yq &> /dev/null; then
    curl -sL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64" -o "$LOCAL_BIN/yq"
    chmod +x "$LOCAL_BIN/yq"
else
    echo "yq already exists: $(command -v yq)"
fi

################################################################################
# helm
################################################################################
echo ">>> Installing helm"
if ! command -v helm &> /dev/null; then
    # Use the official get-helm-3 installer, which stays on the v3 line (the
    # tools/helm-* scripts require helm 3.x) and handles OS/arch detection.
    # See https://helm.sh/docs/v3/intro/install#from-script.
    GET_HELM=$(mktemp)
    curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 -o "$GET_HELM"
    chmod 700 "$GET_HELM"
    HELM_INSTALL_DIR="$LOCAL_BIN" USE_SUDO=false "$GET_HELM"
    rm -f "$GET_HELM"
else
    echo "helm already exists: $(command -v helm)"
fi

################################################################################
# crane
################################################################################
echo ">>> Installing crane"
if ! command -v crane &> /dev/null; then
    # get latest tag
    CR_TAG=$(curl -s https://api.github.com/repos/google/go-containerregistry/releases/latest | jq -r .tag_name)

    # architecture detection
    OS="Linux"
    ARCH=$(uname -m)
    case "$ARCH" in
      x86_64) ARCH="x86_64" ;;
      aarch64) ARCH="arm64" ;;
      *) echo "Unsupported architecture: $ARCH"; exit 1;;
    esac

    CR_URL="https://github.com/google/go-containerregistry/releases/download/${CR_TAG}/go-containerregistry_${OS}_${ARCH}.tar.gz"

    TMPCR=$(mktemp)
    echo "Downloading crane from $CR_URL"
    curl -sL "$CR_URL" -o "$TMPCR"
    tar -xzf "$TMPCR" -C "$LOCAL_BIN" crane
    chmod +x "$LOCAL_BIN/crane"
    rm -f "$TMPCR"
else
    echo "crane already exists: $(command -v crane)"
fi

################################################################################
# Verify minimum versions
################################################################################
echo ">>> Verifying tool versions"
JQ_VERSION=$(extract_version "$(jq --version 2>/dev/null || true)")
YQ_VERSION=$(extract_version "$(yq --version 2>/dev/null || true)")
HELM_VERSION=$(extract_version "$(helm version --short 2>/dev/null || true)")
CRANE_VERSION=$(extract_version "$(crane version 2>/dev/null || true)")

require_min_version jq "$JQ_VERSION" "$JQ_MIN_VERSION"
require_min_version yq "$YQ_VERSION" "$YQ_MIN_VERSION"
require_min_version helm "$HELM_VERSION" "$HELM_MIN_VERSION"
if [ "${HELM_VERSION%%.*}" != "$HELM_MAX_MAJOR" ]; then
    echo "ERROR: helm $HELM_VERSION is not supported (must be major version $HELM_MAX_MAJOR)" >&2; exit 1
fi
require_min_version crane "$CRANE_VERSION" "$CRANE_MIN_VERSION"

################################################################################
# Summary
################################################################################
echo
echo "Installed tools:"
echo "  jq:    $JQ_VERSION"
echo "  yq:    $YQ_VERSION"
echo "  helm:  $HELM_VERSION"
echo "  crane: $CRANE_VERSION"
echo
echo "Make sure ~/.local/bin is in your PATH"
