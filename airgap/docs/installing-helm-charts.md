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

## Step 1 — Authenticate

```bash
gcloud auth print-access-token | \
  crane auth login -u oauth2accesstoken --password-stdin us-docker.pkg.dev

gcloud auth print-access-token | \
  helm registry login -u oauth2accesstoken --password-stdin us-docker.pkg.dev
```

## Step 2 — Pull the Helm chart

```bash
VERSION="0.3.558"

helm pull oci://us-docker.pkg.dev/sambastack-production-ext-95/ext-sambastack-oci-prod/sambastack/sambastack \
  --version ${VERSION}

helm pull oci://us-docker.pkg.dev/sambastack-production-ext-95/ext-sambastack-oci-prod/sambastack/sambastack-base \
  --version ${VERSION}

tar -xzf sambastack-${VERSION}.tgz
```

## Step 3 — Generate the image inventory

`generate_inventory.sh` renders the Helm chart and collects every container image reference into a YAML file.

```bash
bash generate_inventory.sh \
  -c ./sambastack \
  -o ./inventory.yaml \
  -f ./sambastack/values.yaml
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
  -c ./sambastack \
  -i ./inventory.yaml \
  -o stack-${VERSION}.tar.zst
```

| Flag | Description |
|---|---|
| `-c PATH` | Path to Helm chart directory or `.tgz` |
| `-i FILE` | Inventory YAML produced by `generate_inventory.sh` |
| `-o FILE` | Output bundle archive (`.tar.zst`) |

The script validates that all images exist in the source registry before pulling.

Transfer `stack-${VERSION}.tar.zst`, `seed_images.sh`, and `inventory.yaml` into the air-gapped environment to a host with network access to Harbor.

## Step 5 — Seed images into Harbor

### Create `creds.json`

```json
{
  "docker": {
    "url": "<HARBOR_IP>",
    "project": "sambastack",
    "username": "<HARBOR_ADMIN_USERNAME>",
    "password": "<HARBOR_ADMIN_PASSWORD>"
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
  -b stack-${VERSION}.tar.zst \
  -c creds.json
```

| Flag | Description |
|---|---|
| `-i FILE` | Inventory YAML |
| `-b FILE` | Bundle archive from `bundle_images.sh` |
| `-c FILE` | `creds.json` with Harbor credentials |
| `-d / --dry-run` | Preview without pushing |
| `-o FILE` | Optional: write Harbor destination image map to YAML |

Images are routed automatically based on origin:

| Source | Harbor destination |
|---|---|
| SambaStack app images (`pkg.dev` without `/public/`) | `<harbor>/<project>/sambastack/…` |
| Public/infra images (keycloak, openebs, redis, …) | `<harbor>/<project>/public/…` |

## Step 6 — Install the Helm chart

With all images available in Harbor, install the chart pointing `imageRegistry` at your Harbor instance.

```bash
helm upgrade --install sambastack-base sambastack-base-${VERSION}.tgz \
  --namespace sambastack \
  --create-namespace \
  -f sambastack.yml

helm upgrade --install sambastack sambastack-${VERSION}.tgz \
  --namespace sambastack \
  --create-namespace \
  -f sambastack.yml
```

The `sambastack.yml` values file must set `global.imageRegistry` (and related fields) to your Harbor address so the cluster pulls from the private registry instead of external sources. See the [SambaStack air-gap install guide](https://sambanova.atlassian.net/wiki/spaces/SOS/pages/2945056815/SambaStack+Customer+Install+Airgapped#Sambastack-Install) for a full example values file.
