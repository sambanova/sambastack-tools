/**
 * Client-side validation for the resource names the user types (bundle name,
 * deployment name). Kubernetes rejects anything that is not a lowercase RFC
 * 1123 subdomain, but that rejection only arrives from `kubectl apply` at
 * validation time, as a wall of API-server text. Checking the same rule here
 * lets the UI say what is wrong while the name is still being typed.
 */

import { POD_NAME_TRUNCATE_THRESHOLD } from './pod-name-limits';

/** Lowercase RFC 1123 subdomain, as enforced by the Kubernetes API server on `metadata.name`. */
const RFC_1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/** Max length of a `metadata.name` the API server accepts for an RFC 1123 subdomain. */
export const RFC_1123_MAX_LENGTH = 253;

/** The `md-` prefix the deployment page suggests for a deployment named after a bundle. */
const DEPLOYMENT_NAME_PREFIX = 'md-';

/**
 * Why a name is not a legal `metadata.name`, or `null` when it is legal.
 * The message names the offending characters, since that is the part the user
 * has to change (an underscore is the common one — it reads as legal but is not).
 */
export function validateResourceName(name: string): string | null {
  if (!name) return 'Name is required.';
  if (name.length > RFC_1123_MAX_LENGTH) {
    return `Name must be at most ${RFC_1123_MAX_LENGTH} characters (this one is ${name.length}).`;
  }
  if (RFC_1123_SUBDOMAIN.test(name)) return null;

  const illegal = Array.from(new Set(name.match(/[^a-z0-9.-]/g) ?? []));
  if (illegal.length > 0) {
    return (
      `Name cannot contain ${illegal.map((c) => `"${c}"`).join(', ')}. ` +
      'Kubernetes names allow only lowercase letters, digits, "-" and ".".'
    );
  }
  return 'Name must start and end with a lowercase letter or digit.';
}

/**
 * Warns when a bundle name is long enough that the deployment named after it
 * (`md-<bundle>`) would push the operator into truncating + hashing its pod
 * names. Returns `null` when the name is short enough to be used as-is.
 */
export function bundleNameLengthWarning(bundleName: string): string | null {
  const deploymentNameLength = DEPLOYMENT_NAME_PREFIX.length + bundleName.length;
  if (deploymentNameLength <= POD_NAME_TRUNCATE_THRESHOLD) return null;
  const maxBundleNameLength = POD_NAME_TRUNCATE_THRESHOLD - DEPLOYMENT_NAME_PREFIX.length;
  return (
    `A deployment named after this bundle ("${DEPLOYMENT_NAME_PREFIX}${bundleName}", ` +
    `${deploymentNameLength} characters) is long enough that the operator will ` +
    'truncate and hash its pod names. Keep the bundle name at or under ' +
    `${maxBundleNameLength} characters to avoid that.`
  );
}
