import React from 'react';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './test-utils';
import Playground from '../../components/Playground';
import { mockDeploymentList, mockPodStatus, mockEnvironments } from './mock-data';

// Mock fetch globally
global.fetch = jest.fn();

describe('Playground Page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
  });

  describe('Initial Load', () => {
    it('should render playground page', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, bundleDeployments: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockEnvironments,
        });

      renderWithProviders(<Playground />);

      await waitFor(() => {
        expect(screen.getByText(/Playground/i)).toBeInTheDocument();
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
          json: async () => mockEnvironments,
        });

      renderWithProviders(<Playground />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/bundle-deployment');
      });
    });

    it('should fetch environment config on mount', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, bundleDeployments: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockEnvironments,
        });

      renderWithProviders(<Playground />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/environments');
      });
    });

    it('should display error when API fails', async () => {
      (global.fetch as jest.Mock)
        .mockRejectedValueOnce(new Error('API Error'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockEnvironments,
        });

      renderWithProviders(<Playground />);

      await waitFor(() => {
        expect(screen.getByText(/Failed to connect to the server/i)).toBeInTheDocument();
      });
    });

    it('should show loading state initially', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(new Promise(() => {})) // Never resolves
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockEnvironments,
        });

      renderWithProviders(<Playground />);

      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });
  });

  describe('Deployment Selection', () => {
    it('should show deployment dropdown', async () => {
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            success: true,
            bundleDeployments: mockDeploymentList.map(d => ({
              name: d.name,
              bundle: d.bundle,
              namespace: 'default',
              creationTimestamp: '2024-01-15T10:00:00Z',
            })),
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, podStatus: mockPodStatus['llama-deployment'] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, podStatus: mockPodStatus['qwen-deployment'] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockEnvironments,
        });

      renderWithProviders(<Playground />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Select Deployed Bundle/i)).toBeInTheDocument();
      });
    });
  });
});
