import { screen, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import yaml from 'js-yaml';
import { renderWithProviders } from './test-utils';
import type { CheckpointMappingV3, ModelProfilesCache, Model, ModelProfile } from '../../types/bundle';
import {
  mockMultiArchModel,
  mockEmbeddingModel,
  mockSpecDecodingTargetModel,
  mockSpecDecodingDraftModel,
  mockSpecDecodingTargetProfile,
  mockSpecDecodingDraftProfile,
} from './v3-mock-data';

// Mock next/navigation
const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

import ModelSelection from '../../components/ModelSelection';

global.fetch = jest.fn();

/** Adapts a fixture `Model` into a `CheckpointMappingV3` entry, matching the shape `generate-checkpoint-mapping/route.ts` writes. */
function toCheckpointEntry(model: Model): CheckpointMappingV3[string] {
  return {
    resource_name: model.metadata.name,
    checkpoints: model.spec.checkpoints,
    capabilities: model.spec.metadata.capabilities,
  };
}

/** Adapts a fixture `ModelProfile` into a `ModelProfilesCache` entry, matching the shape `generate-model-profiles/route.ts` writes. */
function toProfileEntry(profile: ModelProfile): ModelProfilesCache[string] {
  return {
    model_arch: profile.spec.model_arch,
    features: profile.spec.features,
    batchingConfig: profile.spec.defaultBatchingConfig ?? profile.status?.batchingConfig ?? {},
    pefs: profile.spec.pefs,
  };
}

function mockCaches(checkpointMapping: CheckpointMappingV3, modelProfiles: ModelProfilesCache) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url === '/api/checkpoint-mapping') {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: checkpointMapping }) });
    }
    if (url === '/api/model-profiles') {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, data: modelProfiles }) });
    }
    if (url === '/api/model-selection-state') {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, state: null }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ success: false }) });
  });
}

async function renderModelSelection(checkpointMapping: CheckpointMappingV3, modelProfiles: ModelProfilesCache) {
  mockCaches(checkpointMapping, modelProfiles);
  await act(async () => {
    renderWithProviders(<ModelSelection />);
  });
  await waitFor(() => expect(screen.getByLabelText('Models')).toBeInTheDocument());
}

async function selectModels(user: ReturnType<typeof userEvent.setup>, names: string[]) {
  await user.click(screen.getByLabelText('Models'));
  for (const name of names) {
    await user.click(await screen.findByRole('option', { name }));
  }
  await user.keyboard('{Escape}');
}

function getYamlText(): string {
  const field = screen.getByDisplayValue(/kind: ModelBundle/) as HTMLTextAreaElement;
  return field.value;
}

// Two profiles matching the same arch, used to exercise multi-tile rows.
const embeddingHighInteractivityProfile: ModelProfile = {
  metadata: { name: 'gte-qwen2-hi' },
  spec: {
    model_arch: 'gte-qwen2',
    features: [],
    defaultBatchingConfig: { '4k': { batch_sizes: [1, 2] } },
    pefs: ['gte-qwen2-ss4096-bs2-1:1'],
  },
};
const embeddingHighThroughputProfile: ModelProfile = {
  metadata: { name: 'gte-qwen2-cb' },
  spec: {
    model_arch: 'gte-qwen2',
    features: ['continuous_batching'],
    defaultBatchingConfig: { '4k': { batch_sizes: [1] } },
    pefs: ['gte-qwen2-ss4096-bs1-cb-1:1'],
  },
};

// Single profile per arch for the multi-arch model, so each arch auto-selects/collapses.
const maverickV1Profile: ModelProfile = {
  metadata: { name: 'maverick-v1-hi' },
  spec: {
    model_arch: 'llama-4-maverick',
    features: [],
    defaultBatchingConfig: { '8k': { batch_sizes: [1] } },
    pefs: ['llama-4-maverick-ss8192-bs1:1'],
  },
};
const maverickV2Profile: ModelProfile = {
  metadata: { name: 'maverick-v2-hi' },
  spec: {
    model_arch: 'llama-4-maverick-v2',
    features: [],
    defaultBatchingConfig: { '8k': { batch_sizes: [2] } },
    pefs: ['llama-4-maverick-v2-ss8192-bs1:1'],
  },
};

describe('ModelSelection (V3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPush.mockClear();
  });

  it('lists only models with a matching profile and warns about excluded models (Q4)', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
      [mockEmbeddingModel.spec.name]: toCheckpointEntry(mockEmbeddingModel), // no matching profile below
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Models'));

    expect(await screen.findByRole('option', { name: mockSpecDecodingDraftModel.spec.name })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: mockEmbeddingModel.spec.name })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    expect(
      screen.getByText(new RegExp(`No matching model profile was found for: ${mockEmbeddingModel.spec.name}`))
    ).toBeInTheDocument();
  });

  it('auto-selects and collapses the only matching profile for a single-profile model', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockSpecDecodingDraftModel.spec.name]);

    const row = await screen.findByTestId(`model-row-${mockSpecDecodingDraftModel.spec.name}`);
    // Collapsed: the card tile is not rendered, but a "Profile:" summary chip is.
    expect(within(row).queryByTestId(`profile-card-${mockSpecDecodingDraftProfile.metadata.name}`)).not.toBeInTheDocument();
    expect(within(row).getByText('Profile: High Interactivity')).toBeInTheDocument();

    // Re-expandable via "Change selection".
    await user.click(within(row).getByRole('button', { name: 'Change selection' }));
    expect(within(row).getByTestId(`profile-card-${mockSpecDecodingDraftProfile.metadata.name}`)).toBeInTheDocument();
  });

  it('renders one card tile per matching profile, single-selects, and collapses on selection', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockEmbeddingModel.spec.name]: toCheckpointEntry(mockEmbeddingModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [embeddingHighInteractivityProfile.metadata.name]: toProfileEntry(embeddingHighInteractivityProfile),
      [embeddingHighThroughputProfile.metadata.name]: toProfileEntry(embeddingHighThroughputProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockEmbeddingModel.spec.name]);

    const row = await screen.findByTestId(`model-row-${mockEmbeddingModel.spec.name}`);
    // Multiple profiles -> starts expanded, both tiles visible, none selected yet.
    expect(within(row).getByTestId(`profile-card-${embeddingHighInteractivityProfile.metadata.name}`)).toBeInTheDocument();
    expect(within(row).getByTestId(`profile-card-${embeddingHighThroughputProfile.metadata.name}`)).toBeInTheDocument();
    expect(within(row).queryByText(/^Profile:/)).not.toBeInTheDocument();

    await user.click(within(row).getByTestId(`profile-card-${embeddingHighThroughputProfile.metadata.name}`));

    // Collapse-on-select: tiles gone, summary chip shows the chosen profile's display name.
    expect(await within(row).findByText('Profile: High Throughput')).toBeInTheDocument();
    expect(within(row).queryByTestId(`profile-card-${embeddingHighInteractivityProfile.metadata.name}`)).not.toBeInTheDocument();
  });

  it('shows the arch dropdown only for models with more than one matching arch', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockMultiArchModel.spec.name]: toCheckpointEntry(mockMultiArchModel),
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [maverickV1Profile.metadata.name]: toProfileEntry(maverickV1Profile),
      [maverickV2Profile.metadata.name]: toProfileEntry(maverickV2Profile),
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockMultiArchModel.spec.name, mockSpecDecodingDraftModel.spec.name]);

    const multiArchRow = await screen.findByTestId(`model-row-${mockMultiArchModel.spec.name}`);
    const singleArchRow = await screen.findByTestId(`model-row-${mockSpecDecodingDraftModel.spec.name}`);

    expect(within(multiArchRow).getByLabelText('Architecture')).toBeInTheDocument();
    expect(within(singleArchRow).queryByLabelText('Architecture')).not.toBeInTheDocument();

    // Picking the arch resolves the (single) matching profile automatically + collapses the row.
    await user.click(within(multiArchRow).getByLabelText('Architecture'));
    await user.click(await screen.findByRole('option', { name: /llama-4-maverick \(stable\)/ }));

    expect(await within(multiArchRow).findByText('Profile: High Interactivity')).toBeInTheDocument();
  });

  it('shows the batching-config override editor seeded from the profile, supporting both list and "*" modes', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockSpecDecodingDraftModel.spec.name]);

    await waitFor(() => expect(screen.getByText('3. Override Batching Configuration')).toBeInTheDocument());

    // Default: list mode, seeded from the profile's effective batching config.
    // Two tiers ('4k', '16k') each render their own "Batch sizes" field; the
    // first corresponds to '4k' (insertion order from the profile's config).
    const listInputs = (await screen.findAllByLabelText('Batch sizes (comma-separated)')) as HTMLInputElement[];
    const listInput = listInputs[0];
    expect(listInput.value).toBe('1, 4');

    await waitFor(() => {
      const doc = yaml.load(getYamlText()) as {
        spec: { modelConfigs: Array<{ batchingConfig: Record<string, { batch_sizes: unknown }> }> };
      };
      expect(doc.spec.modelConfigs[0].batchingConfig['4k'].batch_sizes).toEqual([1, 4]);
    });

    // Editing the list updates the emitted batch_sizes.
    await user.clear(listInput);
    await user.type(listInput, '1, 2, 8');

    await waitFor(() => {
      const doc = yaml.load(getYamlText()) as {
        spec: { modelConfigs: Array<{ batchingConfig: Record<string, { batch_sizes: unknown }> }> };
      };
      expect(doc.spec.modelConfigs[0].batchingConfig['4k'].batch_sizes).toEqual([1, 2, 8]);
    });

    // Toggling "All batch sizes" switches that tier to the '*' sentinel.
    const allCheckbox = screen.getAllByRole('checkbox', { name: 'All batch sizes (*)' })[0];
    await user.click(allCheckbox);

    await waitFor(() => {
      const doc = yaml.load(getYamlText()) as {
        spec: { modelConfigs: Array<{ batchingConfig: Record<string, { batch_sizes: unknown }> }> };
      };
      expect(doc.spec.modelConfigs[0].batchingConfig['4k'].batch_sizes).toBe('*');
    });
  });

  it('shows the draft-model dropdown only for spec-decoding profiles', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingTargetModel.spec.name]: toCheckpointEntry(mockSpecDecodingTargetModel), // sd profile
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel), // non-sd profile
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingTargetProfile.metadata.name]: toProfileEntry(mockSpecDecodingTargetProfile),
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockSpecDecodingTargetModel.spec.name, mockSpecDecodingDraftModel.spec.name]);

    expect(
      await screen.findByText('This profile supports speculative decoding. Choose a draft model:')
    ).toBeInTheDocument();
    // Only one such prompt should exist (the non-sd draft-only model doesn't get one).
    expect(screen.getAllByText('This profile supports speculative decoding. Choose a draft model:')).toHaveLength(1);
  });

  it('wires a chosen draft model into the generated ModelBundle YAML (routable:false + specDecodingPairs)', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingTargetModel.spec.name]: toCheckpointEntry(mockSpecDecodingTargetModel),
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingTargetProfile.metadata.name]: toProfileEntry(mockSpecDecodingTargetProfile),
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockSpecDecodingTargetModel.spec.name]);

    const draftSelect = await screen.findByLabelText(`Draft model for ${mockSpecDecodingTargetModel.spec.name}`);
    await user.click(draftSelect);
    await user.click(await screen.findByRole('option', { name: mockSpecDecodingDraftModel.spec.name }));

    // The draft's own card-tile row appears (nested), auto-selected/collapsed since it has one profile.
    const draftRow = await screen.findByTestId(`model-row-${mockSpecDecodingDraftModel.spec.name}`);
    expect(within(draftRow).getByText('Draft model:', { exact: false })).toBeInTheDocument();

    await waitFor(() => {
      const doc = yaml.load(getYamlText()) as {
        spec: {
          modelConfigs: Array<{ model: string; modelSettings?: { routable?: boolean } }>;
          specDecodingPairs?: Array<{ target: string; draft: string }>;
        };
      };
      const draftEntry = doc.spec.modelConfigs.find((c) => c.model.startsWith(mockSpecDecodingDraftModel.metadata.name));
      expect(draftEntry?.modelSettings?.routable).toBe(false);
      expect(doc.spec.specDecodingPairs).toEqual([
        { target: mockSpecDecodingTargetModel.metadata.name, draft: mockSpecDecodingDraftModel.metadata.name },
      ]);
    });
  });

  it('generates a single ModelBundle document once a profile is resolved', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockSpecDecodingDraftModel.spec.name]);

    await waitFor(() => {
      const text = getYamlText();
      expect(text).toContain('apiVersion: sambanova.ai/v1alpha1');
      expect(text).toContain('kind: ModelBundle');
      expect(text).toContain(`profile: ${mockSpecDecodingDraftProfile.metadata.name}`);
    });
  });
});
