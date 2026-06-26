import {
  arePodNamesShortened,
  POD_NAME_TRUNCATE_THRESHOLD,
} from '../pod-name-limits';
import { defaultPodName } from '../inference-pod-names';

describe('POD_NAME_TRUNCATE_THRESHOLD', () => {
  it('is the 52-char StatefulSet limit minus the inf- prefix and -q-default-n suffix', () => {
    expect(POD_NAME_TRUNCATE_THRESHOLD).toBe(36);
  });

  it('agrees with when defaultPodName actually starts truncating + hashing', () => {
    // At the threshold the default pod name is a clean interpolation...
    const atLimit = 'a'.repeat(POD_NAME_TRUNCATE_THRESHOLD);
    expect(defaultPodName(atLimit)).toBe(`inf-${atLimit}-q-default-n-0`);
    // ...one char over, the operator truncates and appends an 8-char sha256 hash.
    const overLimit = 'a'.repeat(POD_NAME_TRUNCATE_THRESHOLD + 1);
    expect(defaultPodName(overLimit)).toMatch(/-[0-9a-f]{8}-q-default-n-0$/);
  });
});

describe('arePodNamesShortened', () => {
  it('is false at or below the threshold and true above it', () => {
    expect(arePodNamesShortened('')).toBe(false);
    expect(arePodNamesShortened('a'.repeat(POD_NAME_TRUNCATE_THRESHOLD))).toBe(false);
    expect(arePodNamesShortened('a'.repeat(POD_NAME_TRUNCATE_THRESHOLD + 1))).toBe(true);
  });
});
