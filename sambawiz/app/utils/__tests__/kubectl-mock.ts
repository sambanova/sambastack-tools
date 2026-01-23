/**
 * Mock kubectl command execution for testing
 */

export function mockKubectl() {
  const mockExecSync = jest.fn((command: string) => {
    const cmd = command.toString();

    // Mock various kubectl commands
    if (cmd.includes('kubectl get bundles')) {
      return Buffer.from(JSON.stringify({
        items: [
          { metadata: { name: 'b-llama-bundle' }, spec: { template: 'bt-llama-bundle' } },
          { metadata: { name: 'b-qwen-bundle' }, spec: { template: 'bt-qwen-bundle' } },
        ],
      }));
    }

    if (cmd.includes('kubectl get bundledeployments')) {
      return Buffer.from(JSON.stringify({
        items: [
          { metadata: { name: 'llama-deployment' }, spec: { bundle: 'b-llama-bundle' } },
          { metadata: { name: 'qwen-deployment' }, spec: { bundle: 'b-qwen-bundle' } },
        ],
      }));
    }

    if (cmd.includes('kubectl get pods') && cmd.includes('llama-deployment')) {
      return Buffer.from(JSON.stringify({
        items: [
          {
            metadata: { name: 'llama-deployment-cache-0' },
            status: { phase: 'Running', containerStatuses: [{ ready: true }] },
          },
          {
            metadata: { name: 'llama-deployment-default-0' },
            status: { phase: 'Running', containerStatuses: [{ ready: true }] },
          },
        ],
      }));
    }

    if (cmd.includes('kubectl get pods') && cmd.includes('qwen-deployment')) {
      return Buffer.from(JSON.stringify({
        items: [
          {
            metadata: { name: 'qwen-deployment-cache-0' },
            status: { phase: 'Pending', containerStatuses: [{ ready: false }] },
          },
          {
            metadata: { name: 'qwen-deployment-default-0' },
            status: { phase: 'Running', containerStatuses: [{ ready: true }] },
          },
        ],
      }));
    }

    if (cmd.includes('kubectl logs')) {
      return Buffer.from('2024-01-15 10:00:00 INFO Starting service\n2024-01-15 10:00:01 INFO Ready');
    }

    if (cmd.includes('kubectl apply')) {
      return Buffer.from('bundle.sambanova.ai/b-test-bundle created\nbundletemplate.sambanova.ai/bt-test-bundle created');
    }

    if (cmd.includes('kubectl delete')) {
      return Buffer.from('bundledeployment.sambanova.ai "test-deployment" deleted');
    }

    if (cmd.includes('helm version')) {
      return Buffer.from('version.BuildInfo{Version:"v3.12.0"}');
    }

    if (cmd.includes('kubectl version')) {
      return Buffer.from('Client Version: v1.28.0\nServer Version: v1.28.0');
    }

    if (cmd.includes('kubectl config current-context')) {
      return Buffer.from('dev-cluster');
    }

    return Buffer.from('');
  });

  jest.mock('child_process', () => ({
    execSync: mockExecSync,
  }));

  return mockExecSync;
}

export function setupKubectlMock() {
  return mockKubectl();
}
