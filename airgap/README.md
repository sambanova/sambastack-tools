# Air-Gap Utilities

Customer utilities for operating in air-gapped environments — stage Helm chart images into a private Harbor registry and download SambaStack ML artifacts from GCS.

## Guides

- [Installing Helm charts in air-gapped environments](docs/installing-helm-charts.md) — generate inventory → bundle → seed → install
- [Downloading ML bundle artifacts](docs/downloading-artifacts.md) — download PEFs and checkpoints for SambaStack bundles

## Scripts

| Script | Description |
|---|---|
| `install_tools.sh` | Install required CLI tools (`crane`, `yq`, `jq`, `zstd`) on the staging server |
| `generate_inventory.sh` | Render a Helm chart and extract all container image references into an inventory YAML |
| `bundle_images.sh` | Pull images from the inventory and pack them into a `.tar.zst` archive |
| `seed_images.sh` | Push a bundled archive into a Harbor private registry |
| `download_bundle_artifacts_v2.sh` | Download SambaStack ML bundle artifacts (PEFs and checkpoints) from GCS |
| `download_bundle_artifacts.sh` | v1 artifact downloader (legacy) |
