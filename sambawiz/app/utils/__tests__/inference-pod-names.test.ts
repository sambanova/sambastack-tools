import {
  truncateValue,
  makeKubeName,
  inferenceDeploymentName,
  cachePodName,
  defaultPodName,
  inferencePodNames,
} from '../inference-pod-names';

describe('truncateValue', () => {
  it('returns the value unchanged when within the limit', () => {
    expect(truncateValue('short-name', 63)).toBe('short-name');
    expect(truncateValue('a'.repeat(63), 63)).toBe('a'.repeat(63));
  });

  it('truncates and appends an 8-char sha256 hash when over the limit', () => {
    const value = 'a'.repeat(64);
    const result = truncateValue(value, 63);
    expect(result.length).toBe(63);
    // limit - hashLen - 1 = 63 - 8 - 1 = 54 chars of original, then '-', then 8 hex
    expect(result).toMatch(/^a{54}-[0-9a-f]{8}$/);
  });
});

describe('inference pod names (port of fast-coe operator naming)', () => {
  // Short names are used verbatim, matching the legacy sambawiz behaviour.
  it('builds verbatim names for short deployment names', () => {
    expect(cachePodName('bd-gc-demo')).toBe('inf-bd-gc-demo-cache-0');
    expect(defaultPodName('bd-gc-demo')).toBe('inf-bd-gc-demo-q-default-n-0');
  });

  // Regression: the customer-reported llama-4-maverick case.
  // Model deployment: bd-llama-4-maverick-17b-128e-instruct-alcf
  // The default (q-default) StatefulSet is truncated+hashed; the cache pod is not.
  describe('bd-llama-4-maverick-17b-128e-instruct-alcf', () => {
    const name = 'bd-llama-4-maverick-17b-128e-instruct-alcf';

    it('keeps the cache pod name verbatim (fits within 63)', () => {
      expect(cachePodName(name)).toBe('inf-bd-llama-4-maverick-17b-128e-instruct-alcf-cache-0');
    });

    it('truncates+hashes the default pod name (52-char STS limit)', () => {
      expect(defaultPodName(name)).toBe('inf-bd-llama-4-maverick-17b-128-f0968391-q-default-n-0');
    });

    it('inferencePodNames returns both', () => {
      expect(inferencePodNames(name)).toEqual({
        cache: 'inf-bd-llama-4-maverick-17b-128e-instruct-alcf-cache-0',
        default: 'inf-bd-llama-4-maverick-17b-128-f0968391-q-default-n-0',
      });
    });
  });

  it('produces Kubernetes-valid lengths', () => {
    const longName = 'bd-' + 'x'.repeat(80);
    // inf- deployment name capped at 63
    expect(inferenceDeploymentName(longName).length).toBeLessThanOrEqual(63);
    // cache pod: cache StatefulSet name (<=63) + "-0"
    expect(cachePodName(longName).length).toBeLessThanOrEqual(65);
    // default pod: q-default StatefulSet name (<=52) + "-0"
    expect(defaultPodName(longName).length).toBeLessThanOrEqual(54);
  });
});

describe('makeKubeName', () => {
  it('reserves room for prefix and suffix before truncating', () => {
    const name = makeKubeName('a'.repeat(60), { prefix: 'inf-', suffix: '-q-default-n', limit: 52 });
    expect(name.length).toBeLessThanOrEqual(52);
    expect(name.startsWith('inf-')).toBe(true);
    expect(name.endsWith('-q-default-n')).toBe(true);
  });
});
