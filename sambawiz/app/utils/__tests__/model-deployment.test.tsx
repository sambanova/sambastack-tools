import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-utils';
import ModelDeploymentManager, { getBundleDeploymentStatus, isPodProbeFailure } from '../../components/ModelDeploymentManager';

// Mock next/navigation. `mockNav` is read lazily (only when the hooks are
// invoked during render), so tests can set query params and inspect router
// navigation per case. Prefixed `mock*` so Jest allows it inside the factory.
const mockNav = {
  params: {} as Record<string, string | null>,
  push: jest.fn(),
};
jest.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: (key: string) => mockNav.params[key] ?? null,
  }),
  useRouter: () => ({
    push: mockNav.push,
    replace: jest.fn(),
    prefetch: jest.fn(),
  }),
}));

// Mock fetch globally
global.fetch = jest.fn();

describe('Model Deployment Manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNav.params = {};
    jest.useFakeTimers();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  describe('getBundleDeploymentStatus', () => {
    it('should return "Not Deployed" when both pods are null', () => {
      const status = getBundleDeploymentStatus(null, null);
      expect(status).toBe('Not Deployed');
    });

    it('should return "Deploying" when cache pod is not ready', () => {
      const cachePod = { ready: 0, total: 1, status: 'Pending' };
      const defaultPod = { ready: 1, total: 1, status: 'Running' };
      const status = getBundleDeploymentStatus(cachePod, defaultPod);
      expect(status).toBe('Deploying');
    });

    it('should return "Deploying" when default pod is not ready', () => {
      const cachePod = { ready: 1, total: 1, status: 'Running' };
      const defaultPod = { ready: 0, total: 1, status: 'Pending' };
      const status = getBundleDeploymentStatus(cachePod, defaultPod);
      expect(status).toBe('Deploying');
    });

    it('should return "Deployed" when both pods are ready', () => {
      const cachePod = { ready: 1, total: 1, status: 'Running' };
      const defaultPod = { ready: 1, total: 1, status: 'Running' };
      const status = getBundleDeploymentStatus(cachePod, defaultPod);
      expect(status).toBe('Deployed');
    });

    it('should return "Deploying" when only cache pod exists and is ready', () => {
      const cachePod = { ready: 1, total: 1, status: 'Running' };
      const status = getBundleDeploymentStatus(cachePod, null);
      expect(status).toBe('Deploying');
    });

    it('should return "Deploying" when only default pod exists and is ready', () => {
      const defaultPod = { ready: 1, total: 1, status: 'Running' };
      const status = getBundleDeploymentStatus(null, defaultPod);
      expect(status).toBe('Deploying');
    });
  });

  describe('isPodProbeFailure', () => {
    it('returns false when there is no error message', () => {
      expect(isPodProbeFailure(null)).toBe(false);
    });

    it('does NOT flag a logs probe failing because the container is still initializing', () => {
      // Regression: a fresh deployment whose default pod is still PodInitializing
      // was wrongly reported as "Deployment failed" because the logs command fails
      // with a "command failed" message while the container is waiting to start.
      const msg =
        'Command failed: kubectl -n default logs inf-bd-ds-v32-gemma-4-31b-llama-75550aed-q-default-n-0 -c inf --tail=5\n' +
        'Error from server (BadRequest): container "inf" in pod "inf-bd-ds-v32-gemma-4-31b-llama-75550aed-q-default-n-62521c1375" is waiting to start: PodInitializing';
      expect(isPodProbeFailure(msg)).toBe(false);
    });

    it('does NOT flag a container that is still being created', () => {
      const msg =
        'Command failed: kubectl logs ...\ncontainer "inf" is waiting to start: ContainerCreating';
      expect(isPodProbeFailure(msg)).toBe(false);
    });

    it('flags a pod that could not be found', () => {
      expect(isPodProbeFailure('Error from server (NotFound): pods "inf-x-cache-0" not found')).toBe(true);
    });

    it('flags a generic command failure that is not a startup state', () => {
      expect(isPodProbeFailure('Command failed: kubectl get pods\nUnable to connect to the server')).toBe(true);
    });

    it('flags "no resources" (nothing scheduled)', () => {
      expect(isPodProbeFailure('No resources found in default namespace.')).toBe(true);
    });

    it('flags a real crash even though the container is "waiting to start"', () => {
      // CrashLoopBackOff / ImagePullBackOff also say "waiting to start", but they
      // are genuine failures — only PodInitializing/ContainerCreating are benign.
      const msg =
        'Command failed: kubectl logs ...\ncontainer "inf" is waiting to start: CrashLoopBackOff';
      expect(isPodProbeFailure(msg)).toBe(true);
    });
  });

  it('should fetch deployments and bundles from the v3 routes on mount (always fresh, never cached)', async () => {
    // Use real timers for this test since we're testing async fetch operations
    jest.useRealTimers();

    // Mock all three fetch calls that happen on mount
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, bundleDeployments: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, bundles: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false }), // loadSavedState returns no state
      });

    await act(async () => {
      renderWithProviders(<ModelDeploymentManager />);
    });

    // Wait for all async operations to complete
    await waitFor(
      () => {
        expect(global.fetch).toHaveBeenCalledWith('/api/model-deployment');
        expect(global.fetch).toHaveBeenCalledWith('/api/model-bundles');
        expect(global.fetch).toHaveBeenCalledWith('/api/model-deployment-state');
      },
      { timeout: 3000 }
    );

    // Restore fake timers for other tests
    jest.useFakeTimers();
  });

  it('only lists bundles whose validation succeeded in the bundle picker', async () => {
    jest.useRealTimers();

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, bundleDeployments: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          bundles: [
            {
              name: 'valid-bundle',
              namespace: 'default',
              creationTimestamp: '2024-01-01T00:00:00Z',
              isValid: true,
              validationReason: 'ValidationSucceeded',
              validationMessage: '',
              modelConfigs: [{ model: 'llama-3-8b-instruct:1', profile: 'llama-3-8b-hi' }],
            },
            {
              name: 'invalid-bundle',
              namespace: 'default',
              creationTimestamp: '2024-01-01T00:00:00Z',
              isValid: false,
              validationReason: 'ValidationFailed',
              validationMessage: 'legalizer error',
              modelConfigs: [],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false }),
      });

    await act(async () => {
      renderWithProviders(<ModelDeploymentManager />);
    });

    const user = userEvent.setup();
    const bundleSelect = await screen.findByRole('combobox', { name: 'Model Bundle' });
    await user.click(bundleSelect);

    expect(await screen.findByRole('option', { name: 'valid-bundle' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'invalid-bundle' })).not.toBeInTheDocument();

    jest.useFakeTimers();
  });

  it('generates a ModelDeployment document that references the bundle by name (never inline spec.models)', async () => {
    jest.useRealTimers();

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, bundleDeployments: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          bundles: [
            {
              name: 'my-bundle',
              namespace: 'default',
              creationTimestamp: '2024-01-01T00:00:00Z',
              isValid: true,
              validationReason: 'ValidationSucceeded',
              validationMessage: '',
              modelConfigs: [{ model: 'llama-3-8b-instruct:1', profile: 'llama-3-8b-hi' }],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false }),
      });

    await act(async () => {
      renderWithProviders(<ModelDeploymentManager />);
    });

    const user = userEvent.setup();
    const bundleSelect = await screen.findByRole('combobox', { name: 'Model Bundle' });
    await user.click(bundleSelect);
    await user.click(await screen.findByRole('option', { name: 'my-bundle' }));

    const yamlField = (await screen.findByDisplayValue(/kind: ModelDeployment/)) as HTMLTextAreaElement;
    const generatedYaml = yamlField.value;

    expect(generatedYaml).toContain('apiVersion: sambanova.ai/v1alpha1');
    expect(generatedYaml).toContain('kind: ModelDeployment');
    expect(generatedYaml).toContain('bundle: my-bundle');
    expect(generatedYaml).not.toMatch(/^\s*models:/m);
    expect(generatedYaml).toContain('engineConfig:');
    expect(generatedYaml).toContain('startupTimeout: 7200');
    expect(generatedYaml).toContain('owner: no-reply@sambanova.ai');
    expect(generatedYaml).toContain('sambanova-artifact-reader');

    jest.useFakeTimers();
  });

  it('generates a model + profile ModelDeployment (spec.models) when modelPath and profileName query params are set', async () => {
    jest.useRealTimers();
    mockNav.params = { modelPath: 'minimax-m2-7:minimax-m2p5:1', profileName: 'deepseek-cb' };

    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, bundleDeployments: [], bundles: [] }),
    });

    await act(async () => {
      renderWithProviders(<ModelDeploymentManager />);
    });

    // Section header renamed for the model/bundle choice.
    expect(await screen.findByText('2. Deploy a Model/Bundle')).toBeInTheDocument();

    // Arriving from Model Selection shows the pre-deploy reminder dialog.
    expect(
      await screen.findByText(/Confirm that no deployments are currently active/)
    ).toBeInTheDocument();

    const yamlField = (await screen.findByDisplayValue(/kind: ModelDeployment/)) as HTMLTextAreaElement;
    const generatedYaml = yamlField.value;

    expect(generatedYaml).toContain('apiVersion: sambanova.ai/v1alpha1');
    expect(generatedYaml).toContain('kind: ModelDeployment');
    // Inline spec.models with a single model + named profile, no bundle ref.
    expect(generatedYaml).toMatch(/^\s*models:/m);
    expect(generatedYaml).toContain('modelConfigs:');
    expect(generatedYaml).toContain('model: minimax-m2-7:minimax-m2p5:1');
    expect(generatedYaml).toContain('profile: deepseek-cb');
    expect(generatedYaml).not.toMatch(/^\s*bundle:/m);
    // Deployment name derived from the model CR name (suffix stripped).
    expect(generatedYaml).toContain('name: md-minimax-m2-7');
    // Deployment knobs carry over from the bundle path.
    expect(generatedYaml).toContain('engineConfig:');
    expect(generatedYaml).toContain('startupTimeout: 7200');
    expect(generatedYaml).toContain('owner: no-reply@sambanova.ai');
    expect(generatedYaml).toContain('sambanova-artifact-reader');

    jest.useFakeTimers();
  });

  it('redirects to the Model Selection page when "Model" is chosen without model params', async () => {
    jest.useRealTimers();
    // No modelPath/profileName → defaults to bundle mode.
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, bundleDeployments: [], bundles: [] }),
    });

    await act(async () => {
      renderWithProviders(<ModelDeploymentManager />);
    });

    const user = userEvent.setup();
    const modelRadio = await screen.findByRole('radio', { name: 'Model' });
    await user.click(modelRadio);

    expect(mockNav.push).toHaveBeenCalledWith('/model-selection');

    jest.useFakeTimers();
  });

  it('previews the operator-shortened pod names in the long-name warning', async () => {
    jest.useRealTimers();

    const longName = 'bd-llama-4-maverick-17b-128e-instruct-alcf'; // > 36 chars → default pod truncated
    // For this name the cache pod (63-char limit) is NOT shortened — it matches
    // its naive `inf-<name>-cache-0` form — so only the default pod is listed.
    const naiveCache = `inf-${longName}-cache-0`;
    const shortenedDefault = 'inf-bd-llama-4-maverick-17b-128-f0968391-q-default-n-0';

    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url.startsWith('/api/predicted-pod-names')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            deploymentName: longName,
            podNames: { cache: naiveCache, default: shortenedDefault },
          }),
        });
      }
      if (url === '/api/model-bundles') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            bundles: [
              {
                name: 'my-bundle',
                namespace: 'default',
                creationTimestamp: '2024-01-01T00:00:00Z',
                isValid: true,
                validationReason: 'ValidationSucceeded',
                validationMessage: '',
                modelConfigs: [{ model: 'llama-3-8b-instruct:1', profile: 'llama-3-8b-hi' }],
              },
            ],
          }),
        });
      }
      // model-deployment (list) + model-deployment-state (no saved state)
      return Promise.resolve({ ok: true, json: async () => ({ success: false, bundleDeployments: [] }) });
    });

    await act(async () => {
      renderWithProviders(<ModelDeploymentManager />);
    });

    const user = userEvent.setup();
    const bundleSelect = await screen.findByRole('combobox', { name: 'Model Bundle' });
    await user.click(bundleSelect);
    await user.click(await screen.findByRole('option', { name: 'my-bundle' }));

    const nameField = await screen.findByLabelText('Deployment Name');
    await user.clear(nameField); // clear the bundle-derived default name first
    await user.type(nameField, longName);

    // The warning fetches the operator-derived names (debounced) and renders them.
    await waitFor(
      () => {
        expect(global.fetch).toHaveBeenCalledWith(
          `/api/predicted-pod-names?deploymentName=${encodeURIComponent(longName)}`
        );
      },
      { timeout: 3000 }
    );

    const warning = await screen.findByText(/the pod names will be shortened as follows/i);
    await waitFor(() => expect(warning.textContent).toContain(`default: ${shortenedDefault}`));
    // The cache pod isn't shortened for this name, so it must NOT be listed.
    expect(warning.textContent).not.toContain('cache:');
    expect(warning.textContent).not.toContain(naiveCache);

    jest.useFakeTimers();
  });

  it('deletes a deployment via the modeldeployment.sambanova.ai-backed route', async () => {
    jest.useRealTimers();

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          bundleDeployments: [
            {
              name: 'my-deployment',
              namespace: 'default',
              bundle: 'my-bundle',
              creationTimestamp: '2024-01-01T00:00:00Z',
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, podStatus: { cachePod: null, defaultPod: null } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, bundles: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: false }),
      });

    await act(async () => {
      renderWithProviders(<ModelDeploymentManager />);
    });

    const user = userEvent.setup();
    // Only one "Delete" button exists before the confirmation dialog opens
    // (the row action button).
    const rowDeleteButton = await screen.findByRole('button', { name: 'Delete' });
    await user.click(rowDeleteButton);

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, message: 'deleted' }),
      })
      // Refresh call after delete
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, bundleDeployments: [] }),
      });

    // The dialog adds a second "Delete" button (its own confirm action) — the
    // dialog's is the last one rendered.
    const dialogButtons = await screen.findAllByRole('button', { name: 'Delete' });
    await user.click(dialogButtons[dialogButtons.length - 1]);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/model-deployment',
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    jest.useFakeTimers();
  });
});
