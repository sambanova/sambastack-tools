import { waitFor, act } from '@testing-library/react';
import { renderWithProviders } from './test-utils';
import BundleDeploymentManager, { getBundleDeploymentStatus } from '../../components/BundleDeploymentManager';

// Mock next/navigation
jest.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: jest.fn(() => null),
  }),
}));

// Mock fetch globally
global.fetch = jest.fn();

describe('Bundle Deployment Manager', () => {
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

  it('should fetch deployments and bundles on mount', async () => {
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
      renderWithProviders(<BundleDeploymentManager />);
    });

    // Wait for all async operations to complete
    await waitFor(
      () => {
        expect(global.fetch).toHaveBeenCalledWith('/api/bundle-deployment');
        expect(global.fetch).toHaveBeenCalledWith('/api/bundles');
        expect(global.fetch).toHaveBeenCalledWith('/api/bundle-deployment-state');
      },
      { timeout: 3000 }
    );

    // Restore fake timers for other tests
    jest.useFakeTimers();
  });
});
