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

  it('renders the override grid seeded from the profile: supported cells enabled, "All" auto-checks, and "*" mode', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockSpecDecodingDraftModel.spec.name]);

    await waitFor(() => expect(screen.getByText('3. Override Batching Configuration (Optional)')).toBeInTheDocument());

    // Step 3 is optional and collapsed by default — expand it before interacting with the grid.
    await user.click(screen.getByRole('button', { name: 'Expand batching overrides' }));

    // The '4k' tier of the profile supports batch sizes [1, 4]. In the grid, cells 1 and 4 are
    // enabled and (seeded from the profile) checked; an unsupported size like 2 is disabled; and
    // since every supported cell is checked, the row's "All" checkbox is auto-checked.
    const cell1 = await screen.findByRole('checkbox', { name: 'Batch size 1 for 4k' });
    const cell4 = screen.getByRole('checkbox', { name: 'Batch size 4 for 4k' });
    const cell2 = screen.getByRole('checkbox', { name: 'Batch size 2 for 4k' });
    const allCell = screen.getByRole('checkbox', { name: 'All batch sizes for 4k' });
    expect(cell1).toBeChecked();
    expect(cell4).toBeChecked();
    expect(cell2).toBeDisabled();
    expect(allCell).toBeChecked();

    await waitFor(() => {
      const doc = yaml.load(getYamlText()) as {
        spec: { modelConfigs: Array<{ batchingConfig: Record<string, { batch_sizes: unknown }> }> };
      };
      expect(doc.spec.modelConfigs[0].batchingConfig['4k'].batch_sizes).toEqual([1, 4]);
    });

    // Unchecking a supported cell drops it from the list and clears "All".
    await user.click(cell4);
    await waitFor(() => {
      const doc = yaml.load(getYamlText()) as {
        spec: { modelConfigs: Array<{ batchingConfig: Record<string, { batch_sizes: unknown }> }> };
      };
      expect(doc.spec.modelConfigs[0].batchingConfig['4k'].batch_sizes).toEqual([1]);
    });
    expect(screen.getByRole('checkbox', { name: 'All batch sizes for 4k' })).not.toBeChecked();

    // Checking "All" collapses the tier to the '*' sentinel.
    await user.click(screen.getByRole('checkbox', { name: 'All batch sizes for 4k' }));
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
