import { validateResourceName, bundleNameLengthWarning, RFC_1123_MAX_LENGTH } from '../resource-names';
import { POD_NAME_TRUNCATE_THRESHOLD } from '../pod-name-limits';

describe('validateResourceName', () => {
  it('accepts lowercase RFC 1123 subdomains', () => {
    ['b', 'bundle1', 'example-bundle', 'b-llama-3p3-70b.v2', 'a1'].forEach((name) => {
      expect(validateResourceName(name)).toBeNull();
    });
  });

  it('names the illegal characters, so an underscore is caught in the field and not by kubectl', () => {
    // The reported case: "example_bundle" was accepted by the UI and rejected by the API server.
    expect(validateResourceName('example_bundle')).toContain('"_"');
    expect(validateResourceName('Example')).toContain('"E"');
    expect(validateResourceName('a b')).toContain('" "');
    // Each offending character is reported once, in first-seen order.
    expect(validateResourceName('a_b_C')).toContain('"_", "C"');
  });

  it('rejects names that do not start and end with an alphanumeric', () => {
    ['-bundle', 'bundle-', '.bundle', 'bundle.'].forEach((name) => {
      expect(validateResourceName(name)).toBe('Name must start and end with a lowercase letter or digit.');
    });
  });

  it('requires a name and caps it at the API server limit', () => {
    expect(validateResourceName('')).toBe('Name is required.');
    expect(validateResourceName('a'.repeat(RFC_1123_MAX_LENGTH))).toBeNull();
    expect(validateResourceName('a'.repeat(RFC_1123_MAX_LENGTH + 1))).toContain(
      `at most ${RFC_1123_MAX_LENGTH} characters`
    );
  });
});

describe('bundleNameLengthWarning', () => {
  // The deployment page suggests `md-<bundle>`, so the bundle name has 3 fewer
  // characters than the deployment name before pod names get truncated.
  const maxQuietLength = POD_NAME_TRUNCATE_THRESHOLD - 'md-'.length; // 33

  it('stays quiet while a deployment named after the bundle still fits', () => {
    expect(bundleNameLengthWarning('a'.repeat(maxQuietLength))).toBeNull();
  });

  it('warns once one more character would push the derived pod names over the limit', () => {
    const warning = bundleNameLengthWarning('a'.repeat(maxQuietLength + 1));
    expect(warning).toContain('truncate and hash its pod names');
    expect(warning).toContain(`${maxQuietLength} characters`);
  });
});
