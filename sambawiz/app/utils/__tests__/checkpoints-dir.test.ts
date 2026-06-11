import { normalizeCheckpointsDir } from '../checkpoints-dir';

describe('normalizeCheckpointsDir', () => {
  describe('empty / missing input', () => {
    it('returns empty + invalid for an empty string', () => {
      const r = normalizeCheckpointsDir('');
      expect(r).toEqual({ value: '', original: '', stripped: false, valid: false });
    });

    it('treats whitespace-only as empty', () => {
      expect(normalizeCheckpointsDir('   ').value).toBe('');
      expect(normalizeCheckpointsDir('   ').valid).toBe(false);
    });

    it('handles null/undefined without throwing', () => {
      expect(normalizeCheckpointsDir(undefined).value).toBe('');
      expect(normalizeCheckpointsDir(null).value).toBe('');
    });
  });

  describe('already a bucket root (no change)', () => {
    it('passes through a bucket root with trailing slash, no warning', () => {
      const r = normalizeCheckpointsDir('gs://my-bucket/');
      expect(r.value).toBe('gs://my-bucket/');
      expect(r.stripped).toBe(false);
      expect(r.valid).toBe(true);
      expect(r.warning).toBeUndefined();
    });

    it('adds a trailing slash when missing, without warning', () => {
      const r = normalizeCheckpointsDir('gs://my-bucket');
      expect(r.value).toBe('gs://my-bucket/');
      expect(r.stripped).toBe(false);
      expect(r.warning).toBeUndefined();
    });

    it('does not warn for redundant trailing slashes only', () => {
      const r = normalizeCheckpointsDir('gs://my-bucket//');
      expect(r.value).toBe('gs://my-bucket/');
      expect(r.stripped).toBe(false);
      expect(r.warning).toBeUndefined();
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeCheckpointsDir('  gs://my-bucket/  ').value).toBe('gs://my-bucket/');
    });
  });

  describe('deep path (the common customer mistake)', () => {
    it('strips a deep checkpoints path down to the bucket root and warns', () => {
      // Mirrors the common mistake of pasting a full checkpoint path instead of
      // just the bucket root. Bucket name is a generic placeholder on purpose.
      const bad = 'gs://example-checkpoints-bucket/version/0.1.0/pefs-checkpoints/ckpts/';
      const r = normalizeCheckpointsDir(bad);
      expect(r.value).toBe('gs://example-checkpoints-bucket/');
      expect(r.stripped).toBe(true);
      expect(r.valid).toBe(true);
      expect(r.warning).toBeDefined();
      // Warning should name the problem and suggest the correct syntax.
      expect(r.warning).toContain('gs://example-checkpoints-bucket/');
      expect(r.warning).toContain('gs://<your-bucket>/');
    });

    it('strips a sub-path without a trailing slash', () => {
      const r = normalizeCheckpointsDir('gs://my-bucket/some/deep/path');
      expect(r.value).toBe('gs://my-bucket/');
      expect(r.stripped).toBe(true);
      expect(r.warning).toBeDefined();
    });

    it('is bucket-agnostic — strips a customer\'s own bucket to its root', () => {
      const r = normalizeCheckpointsDir('gs://acme-internal-checkpoints/foo/bar/');
      expect(r.value).toBe('gs://acme-internal-checkpoints/');
      expect(r.stripped).toBe(true);
    });
  });

  describe('non-GCS roots (NFS, local, etc.) pass through untouched', () => {
    it('keeps an NFS-style absolute path, adds a trailing slash, no warning', () => {
      const r = normalizeCheckpointsDir('/mnt/nfs/checkpoints');
      expect(r.value).toBe('/mnt/nfs/checkpoints/');
      expect(r.valid).toBe(true);
      expect(r.stripped).toBe(false);
      expect(r.warning).toBeUndefined();
    });

    it('does NOT strip a deep NFS path (no bucket-root invariant off GCS)', () => {
      const r = normalizeCheckpointsDir('/sambastack/shared/ckpts/version/0.1.0/');
      expect(r.value).toBe('/sambastack/shared/ckpts/version/0.1.0/');
      expect(r.valid).toBe(true);
      expect(r.stripped).toBe(false);
      expect(r.warning).toBeUndefined();
    });

    it('passes an nfs:// URI through unchanged (with trailing slash), no warning', () => {
      const r = normalizeCheckpointsDir('nfs://fileserver/exports/checkpoints/');
      expect(r.value).toBe('nfs://fileserver/exports/checkpoints/');
      expect(r.valid).toBe(true);
      expect(r.warning).toBeUndefined();
    });

    it('does not warn for a non-gs scheme such as s3://', () => {
      const r = normalizeCheckpointsDir('s3://my-bucket/checkpoints/');
      expect(r.value).toBe('s3://my-bucket/checkpoints/');
      expect(r.warning).toBeUndefined();
    });
  });
});
