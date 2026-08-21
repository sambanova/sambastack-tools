"""Seed-bundle transfer for production seeding (prodplan §5).

The prod image deliberately does NOT bake in the example ``data/`` tree, so the
seed content is shipped through the object store:

  1. An operator uploads the example tree once (from a repo checkout):
        sambaeval-seed push --data-dir data --prefix seed
  2. The Helm seed Job (or `make dev-seed`) then runs:
        sambaeval-backfill --seed-prefix seed
     which pulls the bundle from the object store into a temp dir and backfills
     Postgres + MinIO from it.

Only the four content subtrees backfill consumes are shipped — never
``providers.json`` (secrets) or ``private/`` (developer-local).

Large binary fixtures (``test_data.h5``, ``chinook.db``, …) travel a *separate*
path, because they have a different lifecycle: they are never backfilled into
Postgres, they are read as files at run time, and they are far too big to hold
in memory. ``push-fixture`` streams one to ``fixtures/<name>`` and records its
sha256; ``sambaeval.fixtures.ensure_fixture`` materialises it on the worker
(prodplan §7a).
"""

from __future__ import annotations

import argparse
import glob
import os

from . import fixtures, paths, storage_s3
from .config import settings


def _put_file(fp: str, key: str) -> None:
    with open(fp, "rb") as fh:
        storage_s3.put_bytes(key, fh.read())


def push(data_dir: str, prefix: str) -> int:
    """Upload exactly the content the backfill consumes to ``<prefix>/`` in the
    object store: ``experiments/*.json``, ``scorers/*.json``, the top-level
    ``datasets/*.{jsonl,csv}``, and the full ``results/`` tree. Large/binary
    fixtures (chinook.db, *.h5, scicode/, spider1/) are intentionally excluded —
    those come through the admin API when the sandbox path lands (§7/§7a).

    The target prefix is cleared first so re-runs never accumulate stale objects.
    Returns the number of files uploaded.
    """
    storage_s3.ensure_bucket()
    prefix = prefix.rstrip("/")
    storage_s3.delete_prefix(prefix)
    total = 0

    for sub in ("experiments", "scorers"):
        for fp in sorted(glob.glob(os.path.join(data_dir, sub, "*.json"))):
            _put_file(fp, f"{prefix}/{sub}/{os.path.basename(fp)}")
            total += 1

    ds_dir = os.path.join(data_dir, "datasets")
    if os.path.isdir(ds_dir):
        for name in sorted(os.listdir(ds_dir)):
            fp = os.path.join(ds_dir, name)
            if os.path.isfile(fp) and name.lower().endswith((".jsonl", ".csv")):
                _put_file(fp, f"{prefix}/datasets/{name}")
                total += 1

    results_dir = os.path.join(data_dir, "results")
    if os.path.isdir(results_dir):
        total += storage_s3.upload_dir(results_dir, f"{prefix}/results")

    print(f"[seed] pushed {total} files to s3://{settings.s3_bucket}/{prefix}/")
    return total


def push_fixture(local_path: str, name: str) -> str:
    """Stream a large fixture to ``fixtures/<name>`` and record its sha256.

    Uses the managed-transfer upload (multipart + retries, constant memory) —
    ``_put_file`` above would read the whole ~1 GB file into RAM. The digest is
    stored as object metadata so a worker can verify what it caches.
    """
    if not os.path.isfile(local_path):
        raise SystemExit(f"no such file: {local_path}")
    storage_s3.ensure_bucket()
    key = fixtures.fixture_key(name)
    size = os.path.getsize(local_path)

    print(f"[seed] hashing {local_path} ({size / (1024 * 1024):.1f} MiB)...")
    digest = fixtures.sha256_file(local_path)

    print(f"[seed] uploading -> s3://{settings.s3_bucket}/{key}")
    storage_s3.upload_file(local_path, key, metadata={"sha256": digest})

    print(f"[seed] done. sha256={digest}")
    return key


def pull(prefix: str, dest: str) -> int:
    """Download the seed bundle at ``prefix`` into ``dest``. Returns file count."""
    os.makedirs(dest, exist_ok=True)
    n = storage_s3.download_prefix(prefix, dest)
    print(f"[seed] pulled {n} files from s3://{settings.s3_bucket}/{prefix.rstrip('/')}/ -> {dest}")
    return n


def main() -> None:
    ap = argparse.ArgumentParser(prog="sambaeval-seed")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("push", help="upload the example data/ tree to the object store")
    p.add_argument("--data-dir", default=None, help="defaults to the resolved data dir")
    p.add_argument("--prefix", default="seed")

    q = sub.add_parser("pull", help="download the seed bundle from the object store")
    q.add_argument("--prefix", default="seed")
    q.add_argument("--dest", required=True)

    f = sub.add_parser(
        "push-fixture",
        help="upload one large binary fixture (e.g. SciCode's test_data.h5)",
    )
    f.add_argument("path", help="local file to upload")
    f.add_argument(
        "--name",
        required=True,
        help="fixture name under fixtures/, e.g. scicode/test_data.h5",
    )

    args = ap.parse_args()
    if args.cmd == "push":
        push(args.data_dir or str(paths.data_dir()), args.prefix)
    elif args.cmd == "push-fixture":
        push_fixture(args.path, args.name)
    else:
        pull(args.prefix, args.dest)


if __name__ == "__main__":
    main()
