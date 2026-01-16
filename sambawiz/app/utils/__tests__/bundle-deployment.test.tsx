import React from 'react';
import { screen, waitFor } from '@testing-library/react';
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

  describe('Initial Load', () => {
    it('should render bundle deployment page', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, bundleDeployments: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, bundles: [] }),
        });

      renderWithProviders(<BundleDeploymentManager />);

      await waitFor(() => {
        expect(screen.getByText(/Bundle Deployments/i)).toBeInTheDocument();
      });
    });

    it('should fetch deployments on mount', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, bundleDeployments: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, bundles: [] }),
        });

      renderWithProviders(<BundleDeploymentManager />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/bundle-deployment');
      });
    });

    it('should fetch bundles on mount', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, bundleDeployments: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, bundles: [] }),
        });

      renderWithProviders(<BundleDeploymentManager />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/bundles');
      });
    });

    it('should display error when API fails', async () => {
      (global.fetch as jest.Mock)
        .mockRejectedValueOnce(new Error('API Error'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, bundles: [] }),
        });

      renderWithProviders(<BundleDeploymentManager />);

      await waitFor(() => {
        expect(screen.getByText(/Failed to connect to the server/i)).toBeInTheDocument();
      });
    });
  });

  describe('Deployment List', () => {
    it('should show empty state when no deployments', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, bundleDeployments: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, bundles: [] }),
        });

      renderWithProviders(<BundleDeploymentManager />);

      await waitFor(() => {
        expect(screen.getByText(/No bundle deployments found/i)).toBeInTheDocument();
      });
    });
  });
});
