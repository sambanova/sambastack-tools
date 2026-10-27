/**
 * Reads the outcome of a `ModelDeployment` CR off its `status.conditions` —
 * the `Conditions:` section of `kubectl describe modeldeployment <name>`.
 *
 * Pod readiness alone can't report a deployment the operator rejected: a
 * failed validation (e.g. `local://` artifact sources with no `spec.storage`
 * hostPath) never creates pods, so the page would wait for them forever. The
 * operator records that verdict as a condition instead, e.g.
 *
 *   Type:    Valid
 *   Status:  False
 *   Reason:  ValidationFailed
 *   Message: Validation Errors: BundleDeployment uses local:// artifact sources ...
 *
 * Client-safe (no Node imports) so the deployment page can use it directly.
 */

export interface DeploymentCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
  observedGeneration?: number;
}

/**
 * `failed`  — a condition reports the deployment was rejected or errored.
 * `ok`      — the operator has handled the current spec and reports no failure.
 * `pending` — no verdict on the current spec yet (no conditions, or only ones about an older generation).
 */
export type DeploymentConditionOutcome = 'failed' | 'ok' | 'pending';

/** A `False` condition counts as a failure when it is the `Valid` check or its reason says so. */
function isFailingCondition(c: DeploymentCondition): boolean {
  if (c.status !== 'False') return false;
  return c.type === 'Valid' || /fail|error|invalid/i.test(c.reason ?? '');
}

/**
 * The outcome of a `ModelDeployment` and the condition that best explains it
 * (the failing one, else the `Valid` one, else the first). Conditions whose
 * `observedGeneration` (or `status.observedGeneration`) lags `metadata.generation`
 * describe an older spec and are ignored, as for ModelBundles.
 */
export function deploymentConditionOutcome(md: {
  metadata?: { generation?: number };
  status?: { conditions?: DeploymentCondition[]; observedGeneration?: number };
}): { outcome: DeploymentConditionOutcome; condition: DeploymentCondition | null } {
  const generation = md?.metadata?.generation;
  const current = (md?.status?.conditions ?? []).filter((c) => {
    const observed = c.observedGeneration ?? md?.status?.observedGeneration;
    return !(typeof generation === 'number' && typeof observed === 'number' && observed < generation);
  });
  const failing = current.find(isFailingCondition);
  if (failing) return { outcome: 'failed', condition: failing };
  if (current.length === 0) return { outcome: 'pending', condition: null };
  return { outcome: 'ok', condition: current.find((c) => c.type === 'Valid') ?? current[0] };
}

/**
 * Renders conditions the way `kubectl describe` prints them under `Status:`,
 * so the highlighted section reads the same as the terminal output.
 */
export function formatConditions(conditions: DeploymentCondition[]): string {
  const lines = ['Conditions:'];
  for (const c of conditions) {
    const fields: Array<[string, string | number | undefined]> = [
      ['Last Transition Time', c.lastTransitionTime],
      ['Message', c.message],
      ['Observed Generation', c.observedGeneration],
      ['Reason', c.reason],
      ['Status', c.status],
      ['Type', c.type],
    ];
    for (const [label, value] of fields) {
      if (value === undefined || value === '') continue;
      lines.push(`  ${`${label}:`.padEnd(22)} ${String(value).replace(/\n/g, '\n' + ' '.repeat(25))}`);
    }
  }
  return lines.join('\n');
}
