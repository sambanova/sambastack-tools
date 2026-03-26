#!/usr/bin/env python3
"""
Check which PEFs in custom/latest_pefs.txt are not in app/data/pef_mapping.json.
"""

import json
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
ROOT_DIR = SCRIPT_DIR.parent

latest_pefs_path = ROOT_DIR / "custom" / "latest_pefs.txt"
pef_mapping_path = ROOT_DIR / "app" / "data" / "pef_mapping.json"

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
missing = [pef for pef in list_latest if pef not in list_current]

print(f"PEFs in latest_pefs.txt (non-dev/prod) not in pef_mapping.json ({len(missing)}):")
for pef in missing:
    print(f'    "{pef}",')
