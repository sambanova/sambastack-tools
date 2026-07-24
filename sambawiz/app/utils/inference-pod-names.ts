import { createHash } from 'crypto';

import { STATEFULSET_NAME_LIMIT, DEFAULT_POD_SUFFIX } from './pod-name-limits';

/**
 * Kubernetes-compliant name generation for inference deployment pods.
 *
 * The inference operator (fast-coe `server/pycommon/api/inference_deployment.py`)
 * derives StatefulSet / pod names from the model deployment name. When a derived
 * name would exceed the relevant length limit it is NOT simply concatenated:
 * the operator truncates the base name and appends a short sha256 hash so the
 * result stays unique and within the Kubernetes limit (see `make_kube_name` /
 * `_truncate_value` in fast-coe `server/pycommon/api/schema.py`).
 *
 * sambawiz used to build pod names by naive string interpolation
 * (`inf-${name}-q-default-n-0`), which silently diverged from the real pod name
 * for any deployment whose name was long enough to trigger truncation, e.g.:
 *
 *   model deployment : bd-llama-4-maverick-17b-128e-instruct-alcf
 *   sambawiz expected : inf-bd-llama-4-maverick-17b-128e-instruct-alcf-q-default-n-0
 *   actual pod        : inf-bd-llama-4-maverick-17b-128-f0968391-q-default-n-0
 *
 * The functions below are a faithful port of the operator logic so that the
 * names sambawiz predicts (for status matching, log tailing and display) match
 * the names the operator actually creates.
 *
 * NOTE: this module uses Node's `crypto` and must only be imported from
 * server-side code (API route handlers), never from a client component.
 */

const KUBE_NAME_LIMIT = 63;
const HASH_LEN = 8;

/**
 * Port of fast-coe `_truncate_value`.
 *
 * If `value` fits within `limit` it is returned unchanged. Otherwise it is
 * truncated to `limit - hashLen - 1` characters and an 8-char sha256 hash of the
 * ORIGINAL value is appended (separated by `-`), keeping the result `<= limit`.
 */
export function truncateValue(value: string, limit: number = KUBE_NAME_LIMIT, hashLen: number = HASH_LEN): string {
  if (value.length <= limit) return value;

  const hash = createHash('sha256').update(value).digest('hex').slice(0, hashLen);
  const availableLength = limit - hashLen - 1;
  return `${value.slice(0, availableLength)}-${hash}`;
}

/**
 * Port of fast-coe `make_kube_name`. Truncates `baseName` so that
 * `prefix + name + suffix` stays within `limit`, then re-applies the affixes.
 */
export function makeKubeName(
  baseName: string,
  { prefix = '', suffix = '', limit = KUBE_NAME_LIMIT }: { prefix?: string; suffix?: string; limit?: number } = {}
): string {
  const affixLen = prefix.length + suffix.length;
  const truncName = truncateValue(baseName, limit - affixLen);
  return `${prefix}${truncName}${suffix}`;
}

/**
 * The inference deployment resource name (`InferenceDeployment.deployment_name`):
 * the model deployment name with an `inf-` prefix, truncated to 63 chars.
 */
export function inferenceDeploymentName(deploymentName: string): string {
  return makeKubeName(deploymentName, { prefix: 'inf-' });
}

/**
 * Name of the cache StatefulSet's pod 0 (`inf-<name>-cache-0`).
 * The cache StatefulSet name is limited to the default 63 chars.
 */
export function cachePodName(deploymentName: string): string {
  return `${makeKubeName(inferenceDeploymentName(deploymentName), { suffix: '-cache' })}-0`;
}

/**
 * Name of the default queue inference StatefulSet's pod 0
 * (`inf-<name>-q-default-n-0`, replica `default`, mode shortname `n`).
 *
 * The StatefulSet name is limited to 52 (not 63) chars because Kubernetes appends
 * an 11-char hash to the controller-revision label, which is derived from the
 * StatefulSet name. This lower limit is why the default pod gets truncated/hashed
 * far sooner than the cache pod.
 */
export function defaultPodName(deploymentName: string): string {
  return `${makeKubeName(inferenceDeploymentName(deploymentName), { suffix: DEFAULT_POD_SUFFIX, limit: STATEFULSET_NAME_LIMIT })}-0`;
}

export type InferencePodNames = {
  cache: string;
  default: string;
};

/** Convenience helper returning both pod names sambawiz monitors. */
export function inferencePodNames(deploymentName: string): InferencePodNames {
  return {
    cache: cachePodName(deploymentName),
    default: defaultPodName(deploymentName),
  };
}
