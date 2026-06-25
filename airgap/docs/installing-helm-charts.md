# Installing Helm Charts in Air-Gapped Environments

Installing a Helm chart in an air-gapped cluster requires getting all container images into a private Harbor registry before running `helm install`. The steps below cover the full pipeline: pull the chart, generate an image inventory, bundle the images, seed them into Harbor, then install.

Steps 1–4 run on the **artifact staging server** (internet-connected). Steps 5–6 run inside the air-gapped environment.

## Prerequisites

| Tool | Purpose |
|---|---|
| `helm` | Render chart templates and pull OCI charts |
| `crane` | Pull and push container images |
| `yq` | Parse YAML inventory |
| `jq` | Parse credentials file |
| `zstd` | Compress/decompress image bundles |

Use `install_tools.sh` to install these on the staging server.

## Step 1 — Authenticate to the source registry

Authenticate `crane` and `helm` to whichever registry hosts your chart and images. The example below uses Google Artifact Registry; substitute credentials for your registry as needed.

```bash
# Google Artifact Registry
gcloud auth print-access-token | \
  crane auth login -u oauth2accesstoken --password-stdin <REGISTRY_HOST>

gcloud auth print-access-token | \
  helm registry login -u oauth2accesstoken --password-stdin <REGISTRY_HOST>

# Generic registry (username/password)
crane auth login <REGISTRY_HOST> -u <USERNAME> -p <PASSWORD>
helm registry login <REGISTRY_HOST> -u <USERNAME> -p <PASSWORD>
```

## Step 2 — Pull the Helm chart

Pull the chart from its OCI or HTTPS registry and extract it locally.

```bash
CHART="<chart-name>"
VERSION="<chart-version>"

# OCI registry
helm pull oci://<REGISTRY_HOST>/<path>/${CHART} --version ${VERSION}

# Classic HTTPS repo
helm repo add <repo-name> <repo-url>
helm pull <repo-name>/${CHART} --version ${VERSION}

tar -xzf ${CHART}-${VERSION}.tgz
```

## Step 3 — Generate the image inventory

`generate_inventory.sh` renders the Helm chart and collects every container image reference into a YAML file.

```bash
bash generate_inventory.sh \
  -c ./${CHART} \
  -o ./inventory.yaml \
  -f ./${CHART}/values.yaml   # optional: pass your own values file
```

| Flag | Description |
|---|---|
| `-c PATH` | Path to Helm chart directory or `.tgz` tarball |
| `-o FILE` | Output inventory YAML file |
| `-f FILE` | Optional values file (repeatable) |

The generated `inventory.yaml` lists all images required by the chart and is consumed by the next step.

## Step 4 — Bundle and transfer images

`bundle_images.sh` pulls every image in the inventory and packs them into a single compressed archive.

```bash
bash bundle_images.sh \
  -c ./${CHART} \
  -i ./inventory.yaml \
  -o ${CHART}-${VERSION}.tar.zst
```

| Flag | Description |
|---|---|
| `-c PATH` | Path to Helm chart directory or `.tgz` |
| `-i FILE` | Inventory YAML produced by `generate_inventory.sh` |
| `-o FILE` | Output bundle archive (`.tar.zst`) |

The script validates that all images exist in the source registry before pulling.

Transfer `${CHART}-${VERSION}.tar.zst`, `seed_images.sh`, `inventory.yaml`, and the chart `.tgz` into the air-gapped environment to a host with network access to Harbor.

## Step 5 — Seed images into Harbor

### Create `creds.json`

```json
{
  "docker": {
    "url": "<HARBOR_IP>",
    "project": "<HARBOR_PROJECT>",
    "username": "<HARBOR_USERNAME>",
    "password": "<HARBOR_PASSWORD>"
  }
}
```

### Dry-run (preview what would be pushed)

```bash
bash seed_images.sh \
  -i inventory.yaml \
  --dry-run
```

### Push

```bash
bash seed_images.sh \
  -i inventory.yaml \
  -b ${CHART}-${VERSION}.tar.zst \
  -c creds.json
```

| Flag | Description |
|---|---|
| `-i FILE` | Inventory YAML |
| `-b FILE` | Bundle archive from `bundle_images.sh` |
| `-c FILE` | `creds.json` with Harbor credentials |
| `-d / --dry-run` | Preview without pushing |
| `-o FILE` | Optional: write Harbor destination image map to YAML |

Images are routed to Harbor paths based on their source registry:

| Source | Harbor destination |
|---|---|
| Private images (`pkg.dev` without `/public/`) | `<harbor>/<project>/<image-path>` |
| Public/infra images (all other registries) | `<harbor>/<project>/public/<image-path>` |

## Step 6 — Install the Helm chart

With all images in Harbor, install the chart and override the image registry to point at Harbor.

```bash
helm upgrade --install ${CHART} ${CHART}-${VERSION}.tgz \
  --namespace <NAMESPACE> \
  --create-namespace \
  --set global.imageRegistry=<HARBOR_IP>/<HARBOR_PROJECT> \
  -f values.yaml
```

The key override is `global.imageRegistry` (or the equivalent field for your chart) so the cluster pulls from Harbor instead of external registries. Consult your chart's `values.yaml` for the exact field name.

---

## Appendix: SambaStack full example

End-to-end walkthrough for installing SambaStack in an air-gapped environment.

### Variables

Set these once and reuse them throughout.

```bash
VERSION="0.3.558"
HARBOR_IP="<HARBOR_IP>"
HARBOR_PROJECT="sambastack"
HARBOR_USER="svc-sambastack"
HARBOR_PASSWORD="<HARBOR_SERVICE_ACCOUNT_SECRET>"
```

### 1. Authenticate (artifact staging server)

```bash
gcloud auth print-access-token | \
  crane auth login -u oauth2accesstoken --password-stdin us-docker.pkg.dev

gcloud auth print-access-token | \
  helm registry login -u oauth2accesstoken --password-stdin us-docker.pkg.dev
```

### 2. Pull the charts

```bash
helm pull oci://us-docker.pkg.dev/sambastack-production-ext-95/ext-sambastack-oci-prod/sambastack/sambastack \
  --version ${VERSION}

helm pull oci://us-docker.pkg.dev/sambastack-production-ext-95/ext-sambastack-oci-prod/sambastack/sambastack-base \
  --version ${VERSION}

tar -xzf sambastack-${VERSION}.tgz
```

### 3. Generate the image inventory

```bash
bash generate_inventory.sh \
  -c ./sambastack \
  -o ./inventory.yaml \
  -f ./sambastack/values.yaml
```

### 4. Bundle images

```bash
bash bundle_images.sh \
  -c ./sambastack \
  -i ./inventory.yaml \
  -o sambastack-${VERSION}.tar.zst
```

Transfer `sambastack-${VERSION}.tar.zst`, `sambastack-${VERSION}.tgz`, `sambastack-base-${VERSION}.tgz`, `seed_images.sh`, and `inventory.yaml` into the air-gapped environment.

### 5. Seed images into Harbor

Create `creds.json`:

```json
{
  "docker": {
    "url": "<HARBOR_IP>",
    "project": "sambastack",
    "username": "admin",
    "password": "<HARBOR_ADMIN_PASSWORD>"
  }
}
```

```bash
bash seed_images.sh \
  -i inventory.yaml \
  -b sambastack-${VERSION}.tar.zst \
  -c creds.json
```

### 6. Create the values file

Save the following as `sambastack-airgap.yaml`, replacing all placeholders:

```yaml
global:
  imageRegistry: <HARBOR_IP>/sambastack/public
  image:
    registry: <HARBOR_IP>/sambastack/sambastack
    pullPolicy: IfNotPresent

cloud-ui:
  ingress:
    hosts:
    - host: <UI_FQDN>
      tlsSecretName: tls-cert-ui

db-admin:
  admins:
  - temp-admin@cluster.local

gateway:
  ingress:
    hosts:
    - host: <API_FQDN>
      tlsSecretName: tls-cert-api

openebs:
  enabled: true
  global:
    imageRegistry: <HARBOR_IP>/sambastack/public
  localpv-provisioner:
    analytics:
      enabled: false
  preUpgradeHook:
    image:
      registry: <HARBOR_IP>/sambastack/public
      repo: openebs/kubectl
      tag: "1.25.15"

cloudnative-pg:
  clusterSpec:
    affinity:
      nodeSelector:
        node-role.kubernetes.io/control-plane: "true"
      enablePodAntiAffinity: true
      podAntiAffinityType: required
      topologyKey: kubernetes.io/hostname
    imageName: <HARBOR_IP>/sambastack/public/cloudnative-pg/postgresql:15
    storage:
      storageClass: openebs-hostpath
  image:
    repository: <HARBOR_IP>/sambastack/public/cloudnative-pg/cloudnative-pg
  installer:
    image:
      registry: <HARBOR_IP>/sambastack/public
      repository: bitnami/kubectl
```

### 7. Install

```bash
# Create namespace and required secrets
kubectl create namespace sambastack

kubectl create secret tls tls-cert-ui \
  --cert=ui_tls.crt --key=ui_tls.key -n sambastack

kubectl create secret tls tls-cert-api \
  --cert=api_tls.crt --key=api_tls.key -n sambastack

kubectl create secret docker-registry regcred \
  --docker-server=${HARBOR_IP} \
  --docker-username=${HARBOR_USER} \
  --docker-password=${HARBOR_PASSWORD} \
  --namespace=sambastack

# Install CRDs first, then the main chart
helm upgrade --install sambastack-base sambastack-base-${VERSION}.tgz \
  --namespace sambastack \
  --create-namespace \
  -f sambastack-airgap.yaml

helm upgrade --install sambastack sambastack-${VERSION}.tgz \
  --namespace sambastack \
  --create-namespace \
  -f sambastack-airgap.yaml
```
