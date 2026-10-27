import { screen, waitFor, act, fireEvent } from '@testing-library/react';
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

  it('offers "Enable prompt caching" and injects the KV-cache env vars when the profile supports it', async () => {
    jest.useRealTimers();
    mockNav.params = { modelPath: 'minimax-m2-7:minimax-m2p5:1', profileName: 'minimax-m2p5-dyt-pc-cd' };

    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url === '/api/model-profiles') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              'minimax-m2p5-dyt-pc-cd': {
                model_arch: 'minimax-m2p5',
                features: ['prompt_caching', 'constrained_decoding'],
                batchingConfig: {},
                pefs: [],
              },
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, bundleDeployments: [], bundles: [] }),
      });
    });

    const user = userEvent.setup();
    await act(async () => {
      renderWithProviders(<ModelDeploymentManager />);
    });

    const yamlField = (await screen.findByDisplayValue(/kind: ModelDeployment/)) as HTMLTextAreaElement;
    // Unchecked by default → no KV-cache env vars in the YAML yet.
    expect(yamlField.value).not.toContain('ENABLE_KV_CACHE_MANAGER');

    // Dismiss the pre-deploy reminder dialog so its modal backdrop stops
    // hiding Section 2 from the accessibility tree.
    await user.click(await screen.findByRole('button', { name: 'Got it' }));

    // The checkbox appears because the profile advertises `prompt_caching`.
    const checkbox = await screen.findByRole('checkbox', { name: 'Enable prompt caching' });
    await user.click(checkbox);

    // Checking it injects all three engineConfig env lines.
    await waitFor(() =>
      expect(yamlField.value).toMatch(/ENABLE_KV_CACHE_MANAGER:\s*["']true["']/)
    );
    expect(yamlField.value).toMatch(/KV_CACHE_INCLUDE_STATS_IN_RESPONSE:\s*["']true["']/);
    expect(yamlField.value).toContain('env_vars:');
    expect(yamlField.value).toContain('startupTimeout: 7200');

    // Unchecking removes them again.
    await user.click(checkbox);
    await waitFor(() => expect(yamlField.value).not.toContain('ENABLE_KV_CACHE_MANAGER'));
    expect(yamlField.value).not.toContain('env_vars:');
    // startupTimeout survives the removal.
    expect(yamlField.value).toContain('startupTimeout: 7200');

    jest.useFakeTimers();
  });

  it('does NOT offer "Enable prompt caching" when no selected profile supports it', async () => {
    jest.useRealTimers();
    mockNav.params = { modelPath: 'minimax-m2-7:minimax-m2p5:1', profileName: 'plain-profile' };

    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url === '/api/model-profiles') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              'plain-profile': {
                model_arch: 'minimax-m2p5',
                features: ['constrained_decoding'],
                batchingConfig: {},
                pefs: [],
              },
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, bundleDeployments: [], bundles: [] }),
      });
    });

    const user = userEvent.setup();
    await act(async () => {
      renderWithProviders(<ModelDeploymentManager />);
    });

    // The YAML editor renders, but the profile has no `prompt_caching` feature,
    // so the checkbox must not be offered.
    await screen.findByDisplayValue(/kind: ModelDeployment/);
    // Dismiss the reminder dialog so its backdrop isn't what's hiding the checkbox.
    await user.click(await screen.findByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('checkbox', { name: 'Enable prompt caching' })).not.toBeInTheDocument();

    jest.useFakeTimers();
  });

  it('offers "Enable prompt caching" for a single-model bundle whose profile supports it', async () => {
    jest.useRealTimers();

    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url === '/api/model-bundles') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            bundles: [
              {
                name: 'single-bundle',
                namespace: 'default',
                creationTimestamp: '2024-01-01T00:00:00Z',
                isValid: true,
                validationReason: 'ValidationSucceeded',
                validationMessage: '',
                modelConfigs: [{ model: 'minimax-m2-7:minimax-m2p5:1', profile: 'pc-profile' }],
              },
            ],
          }),
        });
      }
      if (url === '/api/model-profiles') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: { 'pc-profile': { model_arch: 'minimax-m2p5', features: ['prompt_caching'], batchingConfig: {}, pefs: [] } },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true, bundleDeployments: [], bundles: [] }) });
    });

    const user = userEvent.setup();
    await act(async () => {
      renderWithProviders(<ModelDeploymentManager />);
    });

    const bundleSelect = await screen.findByRole('combobox', { name: 'Model Bundle' });
    await user.click(bundleSelect);
    await user.click(await screen.findByRole('option', { name: 'single-bundle' }));

    expect(await screen.findByRole('checkbox', { name: 'Enable prompt caching' })).toBeInTheDocument();

    jest.useFakeTimers();
  });

  it('does NOT offer "Enable prompt caching" for a multi-model bundle (KV cache spans multiple experts)', async () => {
    jest.useRealTimers();

    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url === '/api/model-bundles') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            bundles: [
              {
                name: 'multi-bundle',
                namespace: 'default',
                creationTimestamp: '2024-01-01T00:00:00Z',
                isValid: true,
                validationReason: 'ValidationSucceeded',
                validationMessage: '',
                // Two models — even though the first profile supports prompt
                // caching, KV cache management rejects a multi-expert bundle.
                modelConfigs: [
                  { model: 'minimax-m2-7:minimax-m2p5:1', profile: 'pc-profile' },
                  { model: 'gemma-4-31b:gemma:1', profile: 'plain-profile' },
                ],
              },
            ],
          }),
        });
      }
      if (url === '/api/model-profiles') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              'pc-profile': { model_arch: 'minimax-m2p5', features: ['prompt_caching'], batchingConfig: {}, pefs: [] },
              'plain-profile': { model_arch: 'gemma', features: [], batchingConfig: {}, pefs: [] },
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true, bundleDeployments: [], bundles: [] }) });
    });

    const user = userEvent.setup();
    await act(async () => {
      renderWithProviders(<ModelDeploymentManager />);
    });

    const bundleSelect = await screen.findByRole('combobox', { name: 'Model Bundle' });
    await user.click(bundleSelect);
    await user.click(await screen.findByRole('option', { name: 'multi-bundle' }));

    // Editor renders (a bundle is selected) but the checkbox must not appear.
    await screen.findByDisplayValue(/kind: ModelDeployment/);
    expect(screen.queryByRole('checkbox', { name: 'Enable prompt caching' })).not.toBeInTheDocument();

    jest.useFakeTimers();
  });

  it('always offers "Ignore EOS" (even without prompt_caching) and injects/removes ENABLE_IGNORE_EOS', async () => {
    jest.useRealTimers();
    mockNav.params = { modelPath: 'minimax-m2-7:minimax-m2p5:1', profileName: 'plain-profile' };

    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url === '/api/model-profiles') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            // No `prompt_caching` feature — Ignore EOS must still be offered.
            data: { 'plain-profile': { model_arch: 'minimax-m2p5', features: [], batchingConfig: {}, pefs: [] } },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true, bundleDeployments: [], bundles: [] }) });
    });

    const user = userEvent.setup();
    await act(async () => {
      renderWithProviders(<ModelDeploymentManager />);
    });

    const yamlField = (await screen.findByDisplayValue(/kind: ModelDeployment/)) as HTMLTextAreaElement;
    // Unchecked by default → no ignore-EOS env var yet.
    expect(yamlField.value).not.toContain('ENABLE_IGNORE_EOS');

    // Dismiss the pre-deploy reminder dialog so its backdrop isn't hiding Section 2.
    await user.click(await screen.findByRole('button', { name: 'Got it' }));

    // Prompt caching is NOT offered (no feature), but Ignore EOS always is.
    expect(screen.queryByRole('checkbox', { name: 'Enable prompt caching' })).not.toBeInTheDocument();
    const checkbox = await screen.findByRole('checkbox', { name: 'Ignore EOS' });
    await user.click(checkbox);

    await waitFor(() => expect(yamlField.value).toMatch(/ENABLE_IGNORE_EOS:\s*["']true["']/));
    expect(yamlField.value).toContain('env_vars:');
    expect(yamlField.value).toContain('startupTimeout: 7200');

    // Unchecking removes it (and the now-empty env_vars), leaving startupTimeout.
    await user.click(checkbox);
    await waitFor(() => expect(yamlField.value).not.toContain('ENABLE_IGNORE_EOS'));
    expect(yamlField.value).not.toContain('env_vars:');
    expect(yamlField.value).toContain('startupTimeout: 7200');

    jest.useFakeTimers();
  });

  it('toggles "Ignore EOS" independently of prompt caching (both can coexist in env_vars)', async () => {
    jest.useRealTimers();
    mockNav.params = { modelPath: 'minimax-m2-7:minimax-m2p5:1', profileName: 'minimax-m2p5-dyt-pc-cd' };

    (global.fetch as jest.Mock).mockImplementation((url: string) => {
      if (url === '/api/model-profiles') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              'minimax-m2p5-dyt-pc-cd': {
                model_arch: 'minimax-m2p5',
                features: ['prompt_caching'],
                batchingConfig: {},
                pefs: [],
              },
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true, bundleDeployments: [], bundles: [] }) });
    });

    const user = userEvent.setup();
    await act(async () => {
      renderWithProviders(<ModelDeploymentManager />);
    });

    const yamlField = (await screen.findByDisplayValue(/kind: ModelDeployment/)) as HTMLTextAreaElement;
    await user.click(await screen.findByRole('button', { name: 'Got it' }));

    // Enable both → both env vars present together.
    await user.click(await screen.findByRole('checkbox', { name: 'Enable prompt caching' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Ignore EOS' }));
    await waitFor(() => expect(yamlField.value).toMatch(/ENABLE_IGNORE_EOS:\s*["']true["']/));
    expect(yamlField.value).toMatch(/ENABLE_KV_CACHE_MANAGER:\s*["']true["']/);

    // Disabling prompt caching leaves ignore-EOS intact (independent env vars).
    await user.click(screen.getByRole('checkbox', { name: 'Enable prompt caching' }));
    await waitFor(() => expect(yamlField.value).not.toContain('ENABLE_KV_CACHE_MANAGER'));
    expect(yamlField.value).toMatch(/ENABLE_IGNORE_EOS:\s*["']true["']/);
    expect(yamlField.value).toContain('env_vars:');

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

  it('shows the resolved Model name in the "Model / Bundle" column for a model-based deployment', async () => {
    jest.useRealTimers();

    // A model-based deployment reports an empty `bundle` and the referenced
    // Model CR's display name in `model` (resolved server-side from spec.name).
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          bundleDeployments: [
            {
              name: 'md-minimax-m2-7',
              namespace: 'default',
              bundle: '',
              model: 'MiniMax-M2',
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

    // Column header was renamed from "Model Bundle" to "Model / Bundle".
    expect(await screen.findByText('Model / Bundle')).toBeInTheDocument();
    // The model display name (not a blank cell) is shown for the deployment.
    expect(await screen.findByText('MiniMax-M2')).toBeInTheDocument();

    jest.useFakeTimers();
  });

  describe('air-gapped storage (spec.storage)', () => {
    const storage = {
      hostPath: [{ name: 'nfs', mountPath: '/nfsdata', path: '/data/sambastack-ml-data' }],
    };

    // Route fetches by URL; `/api/deployment-storage-state` returns the blocks
    // remembered per bundle / model for this environment, and the
    // environment's own block from app-config.json.
    const mockFetchWithSavedStorage = (
      saved: Record<string, unknown>,
      env: { storage?: unknown; error?: string } = {}
    ) => {
      (global.fetch as jest.Mock).mockImplementation((url: string, init?: { method?: string; body?: string }) => {
        const ok = (body: unknown) => Promise.resolve({ ok: true, json: async () => body });
        if (url === '/api/deployment-storage-state' && init?.method === 'PUT') {
          return ok({ success: true, environment: 'dev', storage: JSON.parse(init.body ?? '{}').storage });
        }
        if (url === '/api/deployment-storage-state') {
          return ok({
            success: true,
            storage: saved,
            environmentStorage: env.storage ?? null,
            environmentStorageError: env.error ?? null,
          });
        }
        if (url === '/api/model-bundles') {
          return ok({
            success: true,
            bundles: [
              {
                name: 'gpt-oss-120b',
                namespace: 'default',
                creationTimestamp: '2024-01-01T00:00:00Z',
                isValid: true,
                validationReason: 'ValidationSucceeded',
                validationMessage: '',
                modelConfigs: [{ model: 'gpt-oss-120b:1', profile: 'gpt-oss-120b-p' }],
              },
            ],
          });
        }
        if (url === '/api/model-deployment-state') return ok({ success: false });
        if (url === '/api/deploy-bundle') return ok({ success: true, output: 'created' });
        // Section 3 polls these once a deployment is applied.
        if (url.startsWith('/api/pod-status')) return ok({ success: true, podStatus: { cachePod: null, defaultPod: null } });
        if (url.startsWith('/api/pod-logs') || url.startsWith('/api/deployment-describe')) return ok({ success: false });
        return ok({ success: true, bundleDeployments: [] });
      });
    };

    const storageCheckbox = () => screen.findByRole('checkbox', { name: 'Air-gapped deployment' });
    const environmentStorageWrites = () =>
      (global.fetch as jest.Mock).mock.calls
        .filter(([url, init]) => url === '/api/deployment-storage-state' && init?.method === 'PUT')
        .map(([, init]) => JSON.parse(init.body));
    const storageStateWrites = () =>
      (global.fetch as jest.Mock).mock.calls
        .filter(([url, init]) => url === '/api/deployment-storage-state' && init?.method === 'POST')
        .map(([, init]) => JSON.parse(init.body));

    const selectBundle = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(await screen.findByRole('combobox', { name: 'Model Bundle' }));
      await user.click(await screen.findByRole('option', { name: 'gpt-oss-120b' }));
      return (await screen.findByDisplayValue(/kind: ModelDeployment/)) as HTMLTextAreaElement;
    };

    it('starts unchecked; ticking inserts placeholders that block Deploy until replaced', async () => {
      jest.useRealTimers();
      mockFetchWithSavedStorage({});
      const user = userEvent.setup();
      await act(async () => {
        renderWithProviders(<ModelDeploymentManager />);
      });

      const yamlField = await selectBundle(user);
      expect(yamlField.value).not.toContain('storage:');
      const checkbox = await storageCheckbox();
      expect(checkbox).not.toBeChecked();
      expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled();

      await user.click(checkbox);
      await waitFor(() => expect(yamlField.value).toContain('mountPath: CHANGE_ME_MOUNT_PATH_IN_POD'));
      expect(yamlField.value).toContain('path: CHANGE_ME_HOST_PATH_ON_NODE');
      expect(checkbox).toBeChecked();
      expect(screen.getByText(/Replace the placeholder `mountPath` and `path`/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Deploy' })).toBeDisabled();

      // Filling in real paths in the YAML unblocks Deploy.
      fireEvent.change(yamlField, {
        target: {
          value: yamlField.value
            .replace('CHANGE_ME_MOUNT_PATH_IN_POD', '/nfsdata')
            .replace('CHANGE_ME_HOST_PATH_ON_NODE', '/data/ckpts'),
        },
      });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled());
      expect(screen.queryByText(/Replace the placeholder/)).not.toBeInTheDocument();

      // Unticking removes the block.
      await user.click(checkbox);
      await waitFor(() => expect(yamlField.value).not.toContain('storage:'));
      expect(checkbox).not.toBeChecked();

      jest.useFakeTimers();
    });

    it('restores the storage last deployed for a bundle and remembers what is deployed', async () => {
      jest.useRealTimers();
      mockFetchWithSavedStorage({ 'bundle:gpt-oss-120b': storage });
      const user = userEvent.setup();
      await act(async () => {
        renderWithProviders(<ModelDeploymentManager />);
      });

      const yamlField = await selectBundle(user);
      expect(yamlField.value).toMatch(
        /storage:\n\s+hostPath:\n\s+- name: nfs\n\s+mountPath: \/nfsdata\n\s+path: \/data\/sambastack-ml-data/
      );
      expect(await storageCheckbox()).toBeChecked();

      // Renaming the deployment regenerates the YAML but keeps the storage block.
      const nameField = screen.getByLabelText('Deployment Name');
      await user.clear(nameField);
      await user.type(nameField, 'md-renamed');
      await waitFor(() => expect(yamlField.value).toContain('name: md-renamed'));
      expect(yamlField.value).toContain('path: /data/sambastack-ml-data');

      await user.click(screen.getByRole('button', { name: 'Deploy' }));
      await waitFor(() => expect(storageStateWrites()).toEqual([{ key: 'bundle:gpt-oss-120b', storage }]));

      jest.useFakeTimers();
    });

    it('forgets the remembered storage when the bundle is deployed without it', async () => {
      jest.useRealTimers();
      mockFetchWithSavedStorage({ 'bundle:gpt-oss-120b': storage });
      const user = userEvent.setup();
      await act(async () => {
        renderWithProviders(<ModelDeploymentManager />);
      });

      const yamlField = await selectBundle(user);
      await user.click(await storageCheckbox());
      await waitFor(() => expect(yamlField.value).not.toContain('storage:'));

      await user.click(screen.getByRole('button', { name: 'Deploy' }));
      await waitFor(() => expect(storageStateWrites()).toEqual([{ key: 'bundle:gpt-oss-120b', storage: null }]));

      jest.useFakeTimers();
    });

    it('starts a bundle with nothing remembered from the environment\'s storage', async () => {
      jest.useRealTimers();
      mockFetchWithSavedStorage({}, { storage });
      const user = userEvent.setup();
      await act(async () => {
        renderWithProviders(<ModelDeploymentManager />);
      });

      const yamlField = await selectBundle(user);
      expect(yamlField.value).toContain('path: /data/sambastack-ml-data');
      const checkbox = await storageCheckbox();
      expect(checkbox).toBeChecked();

      // Unticking and ticking again brings back the environment's block, not placeholders.
      await user.click(checkbox);
      await waitFor(() => expect(yamlField.value).not.toContain('storage:'));
      await user.click(checkbox);
      await waitFor(() => expect(yamlField.value).toContain('path: /data/sambastack-ml-data'));
      expect(yamlField.value).not.toContain('CHANGE_ME');

      jest.useFakeTimers();
    });

    it('prefers the block remembered for a bundle over the environment\'s storage', async () => {
      jest.useRealTimers();
      const envStorage = { hostPath: [{ name: 'nfs', mountPath: '/env-mount', path: '/env-data' }] };
      mockFetchWithSavedStorage({ 'bundle:gpt-oss-120b': storage }, { storage: envStorage });
      const user = userEvent.setup();
      await act(async () => {
        renderWithProviders(<ModelDeploymentManager />);
      });

      const yamlField = await selectBundle(user);
      expect(yamlField.value).toContain('path: /data/sambastack-ml-data');
      expect(yamlField.value).not.toContain('/env-data');

      jest.useFakeTimers();
    });

    it('warns about invalid environment storage and falls back to placeholders', async () => {
      jest.useRealTimers();
      mockFetchWithSavedStorage({}, { error: 'Mount path must be an absolute path (start with "/") with no spaces.' });
      const user = userEvent.setup();
      await act(async () => {
        renderWithProviders(<ModelDeploymentManager />);
      });

      const yamlField = await selectBundle(user);
      expect(yamlField.value).not.toContain('storage:');
      expect(screen.getByText(/air-gapped storage for this environment in app-config.json is invalid/)).toBeInTheDocument();
      await user.click(await storageCheckbox());
      await waitFor(() => expect(yamlField.value).toContain('CHANGE_ME_MOUNT_PATH_IN_POD'));

      jest.useFakeTimers();
    });

    it('offers to save the deployed block as the environment\'s storage', async () => {
      jest.useRealTimers();
      mockFetchWithSavedStorage({});
      const user = userEvent.setup();
      await act(async () => {
        renderWithProviders(<ModelDeploymentManager />);
      });

      const yamlField = await selectBundle(user);
      await user.click(await storageCheckbox());
      await waitFor(() => expect(yamlField.value).toContain('CHANGE_ME_MOUNT_PATH_IN_POD'));
      fireEvent.change(yamlField, {
        target: {
          value: yamlField.value
            .replace('CHANGE_ME_MOUNT_PATH_IN_POD', '/nfsdata')
            .replace('CHANGE_ME_HOST_PATH_ON_NODE', '/data/sambastack-ml-data'),
        },
      });
      await waitFor(() => expect(screen.getByRole('button', { name: 'Deploy' })).toBeEnabled());
      await user.click(screen.getByRole('button', { name: 'Deploy' }));

      await user.click(await screen.findByRole('button', { name: 'Save for environment' }));
      await waitFor(() => expect(environmentStorageWrites()).toEqual([{ storage }]));
      expect(await screen.findByText(/Saved as this environment/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Save for environment' })).not.toBeInTheDocument();

      jest.useFakeTimers();
    });

    it('does not offer to save when the environment already has storage', async () => {
      jest.useRealTimers();
      mockFetchWithSavedStorage({}, { storage });
      const user = userEvent.setup();
      await act(async () => {
        renderWithProviders(<ModelDeploymentManager />);
      });

      await selectBundle(user);
      await user.click(screen.getByRole('button', { name: 'Deploy' }));
      await waitFor(() => expect(storageStateWrites()).toEqual([{ key: 'bundle:gpt-oss-120b', storage }]));
      expect(screen.queryByRole('button', { name: 'Save for environment' })).not.toBeInTheDocument();

      jest.useFakeTimers();
    });

    it('restores the storage remembered for a model + profile deployment', async () => {
      jest.useRealTimers();
      mockNav.params = { modelPath: 'gpt-oss-120b:gpt-oss:1', profileName: 'gpt-oss-120b-p' };
      mockFetchWithSavedStorage({ 'model:gpt-oss-120b:gpt-oss:1': storage });
      const user = userEvent.setup();
      await act(async () => {
        renderWithProviders(<ModelDeploymentManager />);
      });

      const yamlField = (await screen.findByDisplayValue(/kind: ModelDeployment/)) as HTMLTextAreaElement;
      // The very first YAML already carries the block (generation waits for the remembered storage).
      expect(yamlField.value).toContain('mountPath: /nfsdata');
      // secretNames stays alongside storage.
      expect(yamlField.value).toContain('sambanova-artifact-reader');
      await user.click(await screen.findByRole('button', { name: 'Got it' }));
      expect(await storageCheckbox()).toBeChecked();

      jest.useFakeTimers();
    });
  });
});
