import { waitFor } from '@testing-library/react';
import { renderWithProviders } from './test-utils';
import { mockEnvironments } from './mock-data';

// Mock next/navigation
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

// Mock the data imports - must be done before importing BundleForm
/* eslint-disable @typescript-eslint/no-require-imports */
jest.mock('../../data/pef_configs.json', () => require('./mock-data').mockPefConfigs, { virtual: true });
jest.mock('../../data/pef_mapping.json', () => require('./mock-data').mockPefMapping, { virtual: true });
jest.mock('../../data/checkpoint_mapping.json', () => require('./mock-data').mockCheckpointMapping, { virtual: true });
/* eslint-enable @typescript-eslint/no-require-imports */

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

  it('should fetch checkpointsDir on mount', async () => {
    renderWithProviders(<BundleForm />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/environments');
    });
  });
});
