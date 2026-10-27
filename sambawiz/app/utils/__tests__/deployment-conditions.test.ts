import { deploymentConditionOutcome, formatConditions } from '../deployment-conditions';

// `kubectl get modeldeployment md-bundle1 -o json` for an air-gapped deployment applied without spec.storage.
const validationFailed = {
  metadata: { generation: 1 },
  status: {
    observedGeneration: 1,
    conditions: [
      {
        lastTransitionTime: '2026-10-27T15:07:29.201960+00:00',
        message:
          'Validation Errors:\nBundleDeployment uses local:// artifact sources but no storage configuration with HostPath volumes is defined. Please configure storage.hostPath in the BundleDeployment.',
        observedGeneration: 1,
        reason: 'ValidationFailed',
        status: 'False',
        type: 'Valid',
      },
    ],
  },
};

describe('deploymentConditionOutcome', () => {
  it('reports Valid=False as failed, with the failing condition', () => {
    const { outcome, condition } = deploymentConditionOutcome(validationFailed);
    expect(outcome).toBe('failed');
    expect(condition?.reason).toBe('ValidationFailed');
  });

  it('reports Valid=True as ok', () => {
    const md = { metadata: { generation: 1 }, status: { conditions: [{ type: 'Valid', status: 'True', reason: 'ValidationSucceeded' }] } };
    expect(deploymentConditionOutcome(md)).toEqual({ outcome: 'ok', condition: md.status.conditions[0] });
  });

  it('reports a False condition with a failure reason as failed even when it is not Valid', () => {
    const md = { status: { conditions: [{ type: 'Valid', status: 'True' }, { type: 'Ready', status: 'False', reason: 'DeployError' }] } };
    expect(deploymentConditionOutcome(md).outcome).toBe('failed');
  });

  it('does not treat a not-yet-ready condition as a failure', () => {
    const md = { status: { conditions: [{ type: 'Ready', status: 'False', reason: 'Progressing' }] } };
    expect(deploymentConditionOutcome(md).outcome).toBe('ok');
  });

  it('is pending with no conditions', () => {
    expect(deploymentConditionOutcome({ status: {} })).toEqual({ outcome: 'pending', condition: null });
    expect(deploymentConditionOutcome({})).toEqual({ outcome: 'pending', condition: null });
  });

  it('ignores a verdict about an older generation of the spec', () => {
    const md = { ...validationFailed, metadata: { generation: 2 } };
    expect(deploymentConditionOutcome(md)).toEqual({ outcome: 'pending', condition: null });
  });
});

describe('formatConditions', () => {
  it('prints conditions like kubectl describe, indenting multi-line messages', () => {
    const text = formatConditions(validationFailed.status.conditions);
    expect(text.split('\n')[0]).toBe('Conditions:');
    expect(text).toContain('  Reason:                ValidationFailed');
    expect(text).toContain('  Status:                False');
    expect(text).toContain('  Message:               Validation Errors:\n                         BundleDeployment uses local://');
  });
});
