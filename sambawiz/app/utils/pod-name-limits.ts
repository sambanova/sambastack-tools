/**
 * Pure DNS-label length math for the operator's inference pod names — no crypto,
 * so this is safe to import from BOTH client components and server code. The
 * actual (possibly truncated + sha256-hashed) name materialization lives in
 * `inference-pod-names.ts`, which depends on Node's `crypto` and is therefore
 * server-only; this module deliberately holds only the length thresholds that
 * decide *whether* truncation happens, which a client can compute on its own.
 */

/** Prefix the operator wraps around the model deployment name (`inf-<name>`). */
export const INFERENCE_POD_PREFIX = 'inf-';

/**
 * The default-queue inference StatefulSet's name is capped at 52 (not the usual
 * 63): Kubernetes appends an 11-char controller-revision hash to a StatefulSet's
 * name, so the operator reserves those characters. This lower cap is why the
 * default pod name is the first to get truncated as the deployment name grows.
 */
export const STATEFULSET_NAME_LIMIT = 52;

/** Suffix counted against the 52-char limit (the trailing `-0` is added afterwards). */
export const DEFAULT_POD_SUFFIX = '-q-default-n';

/**
 * Deployment-name length beyond which the derived pod names exceed the limit and
 * get truncated + hashed. Driven by the default pod (the first to overflow):
 * `inf-<name>` must fit within `52 - len('-q-default-n')`, so the bare name must
 * be at most `52 - 4 - 12 = 36` characters.
 */
export const POD_NAME_TRUNCATE_THRESHOLD =
  STATEFULSET_NAME_LIMIT - INFERENCE_POD_PREFIX.length - DEFAULT_POD_SUFFIX.length; // 36

/** Whether the deployment's derived pod names get truncated + hashed to fit the limit. */
export function arePodNamesShortened(deploymentName: string): boolean {
  return deploymentName.length > POD_NAME_TRUNCATE_THRESHOLD;
}
