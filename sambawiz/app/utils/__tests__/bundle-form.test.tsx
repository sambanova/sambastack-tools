import React from 'react';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-utils';
import { mockCheckpointMapping, mockPefMapping, mockPefConfigs, mockEnvironments } from './mock-data';

// Mock next/navigation
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

// Mock the data imports - must be done before importing BundleForm
jest.mock('../../data/pef_configs.json', () => require('./mock-data').mockPefConfigs, { virtual: true });
jest.mock('../../data/pef_mapping.json', () => require('./mock-data').mockPefMapping, { virtual: true });
jest.mock('../../data/checkpoint_mapping.json', () => require('./mock-data').mockCheckpointMapping, { virtual: true });

import BundleForm from '../../components/BundleForm';

// Mock fetch globally
global.fetch = jest.fn();

describe('Bundle Builder Page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPush.mockClear();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => mockEnvironments,
    });
  });

  describe('Initial Load', () => {
    it('should render bundle builder page', async () => {
      renderWithProviders(<BundleForm />);

      await waitFor(() => {
        expect(screen.getByText(/1\. Select Models/i)).toBeInTheDocument();
      });
    });

    it('should fetch checkpointsDir on mount', async () => {
      renderWithProviders(<BundleForm />);

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/api/environments');
      });
    });

    it('should show available models in dropdown', async () => {
      const user = userEvent.setup();
      renderWithProviders(<BundleForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Models/i)).toBeInTheDocument();
      });

      const select = screen.getByLabelText(/Models/i);
      await user.click(select);

      expect(screen.getByText('Meta-Llama-3.1-8B-Instruct')).toBeInTheDocument();
      expect(screen.getByText('Meta-Llama-3.1-70B-Instruct')).toBeInTheDocument();
      expect(screen.getByText('Qwen2.5-72B-Instruct')).toBeInTheDocument();
    });
  });

  describe('Model Selection', () => {
    it('should allow selecting a single model', async () => {
      const user = userEvent.setup();
      renderWithProviders(<BundleForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Models/i)).toBeInTheDocument();
      });

      const select = screen.getByLabelText(/Models/i);
      await user.click(select);
      await user.click(screen.getByText('Meta-Llama-3.1-8B-Instruct'));

      await waitFor(() => {
        expect(screen.getByText(/2\. Select Configurations/i)).toBeInTheDocument();
      });
    });

    it('should display configuration table after model selection', async () => {
      const user = userEvent.setup();
      renderWithProviders(<BundleForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Models/i)).toBeInTheDocument();
      });

      const select = screen.getByLabelText(/Models/i);
      await user.click(select);
      await user.click(screen.getByText('Meta-Llama-3.1-8B-Instruct'));

      await waitFor(() => {
        expect(screen.getByText(/Sequence Length \(SS\)/i)).toBeInTheDocument();
        expect(screen.getByText(/Batch Size \(BS\)/i)).toBeInTheDocument();
      });
    });

    it('should remove configs when model is deselected', async () => {
      const user = userEvent.setup();
      renderWithProviders(<BundleForm />);

      await waitFor(() => {
        expect(screen.getByLabelText(/Models/i)).toBeInTheDocument();
      });

      const select = screen.getByLabelText(/Models/i);
      await user.click(select);
      await user.click(screen.getByText('Meta-Llama-3.1-8B-Instruct'));

      // Select a configuration
      await waitFor(() => {
        const checkboxes = screen.getAllByRole('checkbox');
        fireEvent.click(checkboxes[1]); // Click first config checkbox
      });

      // Deselect the model
      await user.click(select);
      await user.click(screen.getByText('Meta-Llama-3.1-8B-Instruct'));

      await waitFor(() => {
        expect(screen.queryByText(/3\. Selected PEFs/i)).not.toBeInTheDocument();
      });
    });
  });

});
