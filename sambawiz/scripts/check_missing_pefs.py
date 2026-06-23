#!/usr/bin/env python3
"""
Check which PEFs in custom/latest_pefs.txt are not in app/data/pef_mapping.json.
"""

import json
import subprocess
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
ROOT_DIR = SCRIPT_DIR.parent

latest_pefs_path = ROOT_DIR / "custom" / "latest_pefs.txt"
pef_mapping_path = ROOT_DIR / "app" / "data" / "pef_mapping.json"

# Step 0: Refresh latest_pefs.txt from the cluster (tabular output, parsed below)
latest_pefs_path.parent.mkdir(parents=True, exist_ok=True)
print(f"Fetching PEFs from cluster into {latest_pefs_path} ...")
with open(latest_pefs_path, "w") as f:
    subprocess.run(["kubectl", "get", "pefs"], stdout=f, check=True)

# Step 1: Extract first column values that don't end in '-dev' or '-prod'
list_latest = []
with open(latest_pefs_path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        first_col = line.split()[0]
        if first_col == "NAME":  # skip header
            continue
        if not first_col.endswith("-dev") and not first_col.endswith("-prod"):
            list_latest.append(first_col)

# Step 2: Construct set of all PEFs from pef_mapping.json
with open(pef_mapping_path) as f:
    pef_mapping = json.load(f)

list_current = set()
for pefs in pef_mapping.values():
    list_current.update(pefs)

# Step 3: Print PEFs in list_latest that are not in list_current
set_latest = set(list_latest)
missing = [pef for pef in list_latest if pef not in list_current]

print(f"PEFs in latest_pefs.txt (non-dev/prod) not in pef_mapping.json ({len(missing)}):")
for pef in missing:
    print(f'    "{pef}",')

# Step 4: Print PEFs in list_current that are not in list_latest
stale = sorted(pef for pef in list_current if pef not in set_latest)

print(f"\nPEFs in pef_mapping.json not in latest_pefs.txt (non-dev/prod) ({len(stale)}):")
for pef in stale:
    print(f'    "{pef}",')
