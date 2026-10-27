/**
 * Namespace SambaStack is installed into. Used whenever an environment in
 * app-config.json does not set its own `namespace`, so kubectl/helm commands
 * always target it explicitly rather than the cluster's `default` namespace.
 */
export const DEFAULT_NAMESPACE = 'sambastack';
