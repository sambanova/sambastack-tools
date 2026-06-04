/**
 * Normalization for the `checkpointsDir` app-config setting.
 *
 * SambaWiz supports checkpoints on different storage backends, so `checkpointsDir`
 * may be a Google Cloud Storage bucket (`gs://...`) or an arbitrary filesystem
 * root such as an NFS mount (`/mnt/nfs/checkpoints/`). Only the GCS case has a
 * structural constraint:
 *
 * For GCS, `checkpointsDir` must be ONLY the bucket root (e.g. `gs://my-bucket/`).
 * Each model's checkpoint sub-path is derived automatically at bundle-generation
 * time — the bucket prefix is stripped from the model's `source` (see
 * generate-checkpoint-mapping) and then re-joined onto `checkpointsDir`. If
 * `checkpointsDir` itself contains a path below the bucket root — e.g.
 * `gs://my-bucket/version/0.1.0/pefs-checkpoints/ckpts/` — that segment is
 * duplicated when re-joined, producing a broken GCS path. `normalizeCheckpointsDir`
 * collapses such a value back to the bucket root and reports when it had to, so
 * callers can warn the user. It does NOT hard-code any bucket name.
 *
 * For non-GCS roots (NFS, local paths, etc.) there is no equivalent bucket-root
 * invariant, so the value is passed through unchanged apart from ensuring a single
 * trailing slash. These are never flagged.
 */

/** Result of normalizing a user-supplied `checkpointsDir`. */
export interface NormalizedCheckpointsDir {
  /**
   * The value to use. For GCS, the bucket root `gs://<bucket>/`. For other roots,
   * the input with a trailing slash ensured. Empty string when the input was empty.
   */
  value: string;
  /** The trimmed input exactly as the user supplied it. */
  original: string;
  /** True when a path below a GCS bucket root was present and removed. */
  stripped: boolean;
  /** True when the value is usable as a checkpoints root (GCS or any other path). */
  valid: boolean;
  /**
   * A user-facing warning describing a GCS misconfiguration and the correct
   * syntax, set only when a GCS sub-path was stripped; otherwise undefined.
   */
  warning?: string;
}

// Matches "gs://<bucket>" plus an optional single trailing slash. Case-insensitive
// on the scheme; the bucket is everything up to the next slash.
const GCS_PREFIX = /^gs:\/\/([^/]+)(\/?)/i;

/** Ensure a single trailing slash (and no-op on empty input). */
function withTrailingSlash(value: string): string {
  if (value === '') return '';
  return value.endsWith('/') ? value : `${value}/`;
}

/**
 * Normalize a `checkpointsDir`.
 *
 * - GCS (`gs://...`): collapse to the bucket root, warning if a sub-path was stripped.
 * - Anything else (NFS, local, ...): pass through with a trailing slash, no warning.
 *
 * @param input Raw value from config or user input (may be undefined/empty).
 */
export function normalizeCheckpointsDir(input: string | undefined | null): NormalizedCheckpointsDir {
  const original = (input ?? '').trim();

  if (original === '') {
    return { value: '', original, stripped: false, valid: false };
  }

  const match = original.match(GCS_PREFIX);
  if (!match) {
    // Non-GCS root (NFS mount, local directory, etc.). SambaWiz supports these
    // as-is — there is no bucket-root invariant to enforce, so don't warn.
    return { value: withTrailingSlash(original), original, stripped: false, valid: true };
  }

  const bucket = match[1];
  const bucketRoot = `gs://${bucket}/`;

  // Everything after "gs://<bucket>/" (ignoring trailing slashes) is an extra
  // path that does not belong in checkpointsDir.
  const remainder = original.slice(match[0].length).replace(/\/+$/, '');
  const stripped = remainder.length > 0;

  return {
    value: bucketRoot,
    original,
    stripped,
    valid: true,
    warning: stripped
      ? `checkpointsDir "${original}" includes a path below the GCS bucket root. ` +
        `For GCS, checkpoint sub-paths are derived automatically per model, so ` +
        `checkpointsDir must be only the bucket root — it has been corrected to ` +
        `"${bucketRoot}". Set checkpointsDir to "gs://<your-bucket>/" to avoid this warning.`
      : undefined,
  };
}
