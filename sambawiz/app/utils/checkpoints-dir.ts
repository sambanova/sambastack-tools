/**
 * Normalization for the `checkpointsDir` app-config setting.
 *
 * `checkpointsDir` must be ONLY the Google Cloud Storage bucket root, e.g.
 * `gs://my-bucket/`. Each model's checkpoint sub-path is derived automatically
 * at bundle-generation time: the bucket prefix is stripped from the model's
 * `source` (see generate-checkpoint-mapping) and then re-joined onto
 * `checkpointsDir`. If `checkpointsDir` itself contains a path below the bucket
 * root — e.g. `gs://my-bucket/version/0.1.0/pefs-checkpoints/ckpts/` — that
 * segment is duplicated when re-joined, producing a broken GCS path. This is a
 * common customer misconfiguration.
 *
 * `normalizeCheckpointsDir` collapses any such input back to the bucket root and
 * reports when it had to do so, so callers can warn the user. Note it does NOT
 * hard-code any specific bucket name: a customer may legitimately use their own
 * bucket, but the value should always be just that bucket's root.
 */

/** Result of normalizing a user-supplied `checkpointsDir`. */
export interface NormalizedCheckpointsDir {
  /**
   * The value to use: the bucket root `gs://<bucket>/` (with trailing slash).
   * Empty string when the input was empty. For input that is not a recognizable
   * `gs://` path this echoes the trimmed input unchanged.
   */
  value: string;
  /** The trimmed input exactly as the user supplied it. */
  original: string;
  /** True when a path below the bucket root was present and removed. */
  stripped: boolean;
  /** True when the input is a syntactically valid `gs://<bucket>/...` path. */
  valid: boolean;
  /**
   * A user-facing warning describing the problem and the correct syntax, set
   * when stripping occurred or the value is not a valid GCS path; otherwise
   * undefined.
   */
  warning?: string;
}

// Matches "gs://<bucket>" plus an optional single trailing slash. Case-insensitive
// on the scheme; the bucket is everything up to the next slash.
const GCS_PREFIX = /^gs:\/\/([^/]+)(\/?)/i;

/**
 * Normalize a `checkpointsDir` to its GCS bucket root.
 *
 * @param input Raw value from config or user input (may be undefined/empty).
 * @returns The normalized value plus metadata describing any correction made.
 */
export function normalizeCheckpointsDir(input: string | undefined | null): NormalizedCheckpointsDir {
  const original = (input ?? '').trim();

  if (original === '') {
    return { value: '', original, stripped: false, valid: false };
  }

  const match = original.match(GCS_PREFIX);
  if (!match) {
    return {
      value: original,
      original,
      stripped: false,
      valid: false,
      warning:
        `checkpointsDir "${original}" is not a valid Google Cloud Storage path. ` +
        `It must be a bucket root of the form "gs://<your-bucket>/".`,
    };
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
      ? `checkpointsDir "${original}" includes a path below the bucket root. ` +
        `Checkpoint sub-paths are derived automatically per model, so checkpointsDir ` +
        `must be only the bucket root — it has been corrected to "${bucketRoot}". ` +
        `Set checkpointsDir to "gs://<your-bucket>/" to avoid this warning.`
      : undefined,
  };
}
