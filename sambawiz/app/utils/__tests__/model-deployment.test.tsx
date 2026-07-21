import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-utils';
import ModelDeploymentManager, { getBundleDeploymentStatus } from '../../components/ModelDeploymentManager';

// Mock next/navigation
jest.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: jest.fn(() => null),
  }),
}));

// Mock fetch globally
global.fetch = jest.fn();

describe('Model Deployment Manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
    const bundleSelect = await screen.findByLabelText('Bundle');
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
    const bundleSelect = await screen.findByLabelText('Bundle');
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
