import { waitFor, screen } from '@testing-library/react';
import { renderWithProviders } from './test-utils';
import Playground from '../../components/Playground';
import { mockEnvironments } from './mock-data';

// Mock fetch globally
global.fetch = jest.fn();

// Wire up /api/models, /api/environments, and /api/checkpoint-mapping mocks in
// the order Playground calls them on mount.
function mockMountFetches(models: string[], checkpointMapping: Record<string, unknown>) {
  (global.fetch as jest.Mock)
    .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, models }) })
    .mockResolvedValueOnce({ ok: true, json: async () => mockEnvironments })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: checkpointMapping }) });
}

describe('Playground Page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
  });

  it('should fetch models, environments, and checkpoint mapping on mount', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, models: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => mockEnvironments,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, data: {} }),
      });

    renderWithProviders(<Playground />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/models');
      expect(global.fetch).toHaveBeenCalledWith('/api/environments');
      expect(global.fetch).toHaveBeenCalledWith('/api/checkpoint-mapping');
    });
  });

  it('shows the attach-image button for a vision-capable model', async () => {
    mockMountFetches(['gemma-3-12b-it'], {
      'gemma-3-12b-it': { capabilities: ['text', 'vision'] },
    });

    renderWithProviders(<Playground />);

    // The first (only) model is auto-selected, and it's vision-capable, so the
    // attach-image affordance should be present.
    await waitFor(() => {
      expect(screen.getByTitle('Attach image')).toBeInTheDocument();
    });
  });

  it('hides the attach-image button for a text-only model', async () => {
    mockMountFetches(['DeepSeek-V3-0324'], {
      'DeepSeek-V3-0324': { capabilities: ['text'] },
    });

    renderWithProviders(<Playground />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /view code/i })).toBeInTheDocument();
    });
    expect(screen.queryByTitle('Attach image')).not.toBeInTheDocument();
  });

  it('shows the mic record + upload controls for an ASR (Whisper) audio model', async () => {
    mockMountFetches(['Whisper-Large-v3'], {
      'Whisper-Large-v3': { capabilities: ['audio'] },
    });

    renderWithProviders(<Playground />);

    // ASR models expose recording/upload controls instead of a text box, and no
    // TTS voice selector.
    await waitFor(() => {
      expect(screen.getByTitle('Record audio')).toBeInTheDocument();
    });
    expect(screen.getByTitle('Upload audio file')).toBeInTheDocument();
    expect(screen.queryByLabelText('Voice')).not.toBeInTheDocument();
  });

  it('shows the voice and language selectors for a TTS audio model', async () => {
    // The routable id (qwen3-tts) is detected by name even when it isn't itself
    // a checkpoint_mapping key.
    mockMountFetches(['qwen3-tts'], {});

    renderWithProviders(<Playground />);

    await waitFor(() => {
      expect(screen.getByLabelText('Voice')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Language')).toBeInTheDocument();
    // TTS synthesizes from typed text, so the mic control is absent.
    expect(screen.queryByTitle('Record audio')).not.toBeInTheDocument();
  });
});
