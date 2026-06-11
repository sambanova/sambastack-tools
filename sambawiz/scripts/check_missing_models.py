#!/usr/bin/env python3
"""
Fetch the latest models from the cluster and check which ones are not in
app/data/pef_mapping.json.
"""

import json
import os
import subprocess
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
ROOT_DIR = SCRIPT_DIR.parent

kubeconfig_path = ROOT_DIR / "kubeconfigs" / "sambastack-dev-3.yaml"
latest_models_path = ROOT_DIR / "custom" / "latest_models.json"
pef_mapping_path = ROOT_DIR / "app" / "data" / "pef_mapping.json"

# Step 1: Fetch latest models from cluster
env = {**os.environ, "KUBECONFIG": str(kubeconfig_path)}
result = subprocess.run(
    ["kubectl", "get", "models", "-o", "json"],
    env=env,
    capture_output=True,
    text=True,
    check=True,
)
latest_models_path.write_text(result.stdout)

# Step 2: Extract model names from spec.name
with open(latest_models_path) as f:
    latest_models = json.load(f)

list_latest = [
    item["spec"]["name"]
    for item in latest_models.get("items", [])
    if item.get("spec", {}).get("name")
]

# Step 3: Load existing model keys from pef_mapping.json
with open(pef_mapping_path) as f:
    pef_mapping = json.load(f)

list_current = set(pef_mapping.keys())

# Step 4: Diff
missing = [name for name in list_latest if name not in list_current]
extra = [name for name in list_current if name not in list_latest]

print(f"Models in latest_models.json not in pef_mapping.json ({len(missing)}):")
for name in missing:
    print(f'    "{name}",')

print(f"\nModels in pef_mapping.json not in latest_models.json ({len(extra)}):")
for name in extra:
    print(f'    "{name}",')
