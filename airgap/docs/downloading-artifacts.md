# Downloading ML Bundle Artifacts

`download_bundle_artifacts_v2.sh` resolves PEF references and checkpoint sources from a SambaStack bundle template, validates all GCS paths, checks available disk space, and downloads everything to a local or NFS-mounted directory.

Run this on the **artifact staging server**.

## Prerequisites

| Tool | Purpose |
|---|---|
| `gcloud` / `gsutil` | Authenticate and download from GCS |
| `yq` | Parse bundle and chart YAML |

## Authenticate

```bash
# Service account (recommended for automation)
export SERVICE_ACCOUNT=/path/to/service-account.json

# Or use your personal gcloud credentials
gcloud auth login
```

## Dry-run (preview artifacts and size)

Always run a dry-run first to review what will be downloaded and verify disk space.

```bash
bash download_bundle_artifacts_v2.sh \
  -d ./sambastack \
  --dry-run \
  sambastack/charts/bundles/bundles-v2/sambastack/70b-ss-4-8k-tk.yaml
```

## Download

```bash
bash download_bundle_artifacts_v2.sh \
  -s "$SERVICE_ACCOUNT" \
  -d ./sambastack \
  -o /data/sambastack-ml-data \
  sambastack/charts/bundles/bundles-v2/sambastack/70b-ss-4-8k-tk.yaml
```

Repeat for each additional bundle template needed. Bundle templates are located at:

```
sambastack/charts/bundles/bundles-v2/sambastack/
```

## Options

| Flag | Description |
|---|---|
| `<bundle-template.yaml>` | Path to a v2 bundle template (positional, required) |
| `-c / --chart FILE` | Helm chart `.tgz` to resolve PEF references (mutually exclusive with `-d`) |
| `-d / --chart-dir DIR` | Extracted chart directory (mutually exclusive with `-c`) |
| `-o / --output DIR` | Output directory (default: `./artifacts`) |
| `-s / --service-account FILE` | GCP service account JSON key file |
| `-n / --dry-run` | Show what would be downloaded without downloading |
| `--skip-auth` | Skip gcloud auth (requires an already active session) |
| `--debug` | Enable verbose debug output |

## Path mapping

The GCS bucket name is stripped from the local path. For example, with `-o /data/sambastack-ml-data`:

```
gs://bucket/dir1/dir2/file.pef  →  /data/sambastack-ml-data/dir1/dir2/file.pef
```

## Transfer to NFS

If the staging server does not have the NFS share mounted directly, transfer the downloaded artifacts using `rsync`:

```bash
rsync -av --progress /staging/artifacts/ snadm@<rdu-host>:/data/sambastack-ml-data/
```

## Download manifest

A `download-manifest.txt` is written to the output directory after a successful run, listing every downloaded artifact with its local path, GCS source, size, and type (file or directory).
