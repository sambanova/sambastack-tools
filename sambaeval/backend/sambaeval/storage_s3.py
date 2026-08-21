"""Object storage over the S3 API (MinIO in-cluster / locally; GCS/S3 later).

A thin wrapper around a boto3 S3 client pointed at ``settings.s3_endpoint_url``.
The same code talks to MinIO locally and in the cluster; only the endpoint/creds
differ (prodplan §3.7 / §7a). Object keys follow the §7a layout, e.g.:

    datasets/public/<dataset_id>/<filename>
    datasets/users/<user_id>/<dataset_id>/<filename>
    fixtures/<name>/...
    backups/...
"""

from __future__ import annotations

import os
import threading
from functools import lru_cache

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from .config import settings

_lock = threading.Lock()


@lru_cache(maxsize=1)
def _client():
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name=settings.s3_region,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def ensure_bucket() -> None:
    """Create the bucket if it does not exist (idempotent)."""
    c = _client()
    bucket = settings.s3_bucket
    with _lock:
        try:
            c.head_bucket(Bucket=bucket)
        except ClientError:
            try:
                c.create_bucket(Bucket=bucket)
            except ClientError:
                pass  # racing creator / already exists


def put_bytes(key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
    _client().put_object(
        Bucket=settings.s3_bucket, Key=key, Body=data, ContentType=content_type
    )
    return key


def put_text(key: str, text: str, content_type: str = "text/plain; charset=utf-8") -> str:
    return put_bytes(key, text.encode("utf-8"), content_type=content_type)


def upload_file(
    local_path: str,
    key: str,
    content_type: str = "application/octet-stream",
    metadata: dict | None = None,
) -> str:
    """Stream a file to ``key`` via boto3's managed transfer.

    Unlike :func:`put_bytes` this never holds the payload in memory, so it is
    the only safe path for the large fixtures (``fixtures/…``, ~1 GB) — managed
    transfer also gives multipart + retries for free.
    """
    extra: dict = {"ContentType": content_type}
    if metadata:
        extra["Metadata"] = metadata
    _client().upload_file(local_path, settings.s3_bucket, key, ExtraArgs=extra)
    return key


def download_file(key: str, local_path: str) -> str:
    """Stream ``key`` down to ``local_path`` (managed transfer; no full read)."""
    os.makedirs(os.path.dirname(os.path.abspath(local_path)) or ".", exist_ok=True)
    _client().download_file(settings.s3_bucket, key, local_path)
    return local_path


def head(key: str) -> dict | None:
    """``head_object`` for ``key`` (size, ETag, user metadata), or None."""
    try:
        return _client().head_object(Bucket=settings.s3_bucket, Key=key)
    except ClientError:
        return None


def get_bytes(key: str) -> bytes:
    obj = _client().get_object(Bucket=settings.s3_bucket, Key=key)
    return obj["Body"].read()


def get_text(key: str) -> str:
    return get_bytes(key).decode("utf-8")


def exists(key: str) -> bool:
    try:
        _client().head_object(Bucket=settings.s3_bucket, Key=key)
        return True
    except ClientError:
        return False


def delete(key: str) -> None:
    try:
        _client().delete_object(Bucket=settings.s3_bucket, Key=key)
    except ClientError:
        pass


# --------------------------------------------------------------------------- #
# Directory <-> prefix helpers (used by the seed bundle — prodplan §5)
# --------------------------------------------------------------------------- #
def list_keys(prefix: str) -> list[str]:
    """All object keys under a prefix (paginated)."""
    c = _client()
    keys: list[str] = []
    token: str | None = None
    while True:
        kw = {"Bucket": settings.s3_bucket, "Prefix": prefix}
        if token:
            kw["ContinuationToken"] = token
        resp = c.list_objects_v2(**kw)
        for obj in resp.get("Contents", []):
            keys.append(obj["Key"])
        if resp.get("IsTruncated"):
            token = resp.get("NextContinuationToken")
        else:
            break
    return keys


def delete_prefix(prefix: str) -> int:
    """Delete every object under a prefix (used to keep the seed bundle clean)."""
    keys = list_keys(prefix.rstrip("/") + "/")
    for key in keys:
        delete(key)
    return len(keys)


def upload_dir(local_dir: str, prefix: str) -> int:
    """Upload every file under ``local_dir`` to ``<prefix>/<relpath>``. Returns count."""
    local_dir = str(local_dir)
    prefix = prefix.rstrip("/")
    n = 0
    for root, _dirs, files in os.walk(local_dir):
        for name in files:
            if name.startswith("."):
                continue
            fp = os.path.join(root, name)
            rel = os.path.relpath(fp, local_dir).replace(os.sep, "/")
            with open(fp, "rb") as fh:
                put_bytes(f"{prefix}/{rel}", fh.read())
            n += 1
    return n


def download_prefix(prefix: str, dest_dir: str) -> int:
    """Download every object under ``prefix`` into ``dest_dir`` (mirrors the tree)."""
    prefix = prefix.rstrip("/")
    n = 0
    for key in list_keys(prefix + "/"):
        rel = key[len(prefix) + 1:]
        if not rel:
            continue
        dst = os.path.join(dest_dir, *rel.split("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as fh:
            fh.write(get_bytes(key))
        n += 1
    return n
