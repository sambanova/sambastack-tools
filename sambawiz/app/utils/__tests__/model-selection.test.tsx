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

function mockCaches(
  checkpointMapping: CheckpointMappingV3,
  modelProfiles: ModelProfilesCache,
  checkpointOverrides: Record<string, string> = {}
) {
  (global.fetch as jest.Mock).mockImplementation((url: string) => {
    if (url === '/api/checkpoint-mapping') {
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: checkpointMapping, checkpointOverrides }),
      });
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

async function renderModelSelection(
  checkpointMapping: CheckpointMappingV3,
  modelProfiles: ModelProfilesCache,
  checkpointOverrides: Record<string, string> = {}
) {
  mockCaches(checkpointMapping, modelProfiles, checkpointOverrides);
  await act(async () => {
    renderWithProviders(<ModelSelection />);
  });
  await waitFor(() => expect(screen.getByLabelText('Models')).toBeInTheDocument());
}

async function selectModels(user: ReturnType<typeof userEvent.setup>, names: string[]) {
  await user.click(screen.getByLabelText('Models'));
  for (const name of names) {
    // Each option's accessible name is the model display name followed by its
    // capability chips (e.g. "…-Instruct text vision"), so match by prefix.
    await user.click(await screen.findByRole('option', { name: (n) => n.startsWith(name) }));
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
// Several context-length tiers with differing batch-size lists, for the card's
// descending "Context : Max Batch Size" summary.
const embeddingMultiTierProfile: ModelProfile = {
  metadata: { name: 'gte-qwen2-multitier' },
  spec: {
    model_arch: 'gte-qwen2',
    features: [],
    defaultBatchingConfig: {
      '4k': { batch_sizes: [1, 4] },
      '8k': { batch_sizes: [1, 4] },
      '16k': { batch_sizes: [1] },
      '32k': { batch_sizes: [1] },
      '128k': { batch_sizes: [1] },
    },
    pefs: ['gte-qwen2-multitier:1'],
  },
};

// A prompt_caching profile for the embedding arch. prompt_caching profiles can
// only be deployed on their own, so they're disabled once >1 model is selected.
const embeddingPromptCachingProfile: ModelProfile = {
  metadata: { name: 'gte-qwen2-pc' },
  spec: {
    model_arch: 'gte-qwen2',
    features: ['prompt_caching'],
    defaultBatchingConfig: { '4k': { batch_sizes: [1] } },
    pefs: ['gte-qwen2-pc:1'],
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

// Regression fixture: a profile whose batch sizes include 6 — a value the old fixed column list
// ([1, 2, 4, 8, 16, 32, 64]) omitted, so 6 had no checkbox and could only leak silently into the
// generated YAML. The grid now derives its columns from the profile, so 6 is visible/removable.
const hiddenBatchSizeProfile: ModelProfile = {
  metadata: { name: 'llama-3p2-1b-bs6' },
  spec: {
    model_arch: 'llama-3p2-1b',
    features: [],
    defaultBatchingConfig: { '4k': { batch_sizes: [2, 4, 6, 8] } },
    pefs: ['llama-3p2-1b-bs6:1'],
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

    expect(
      await screen.findByRole('option', { name: (n) => n.startsWith(mockSpecDecodingDraftModel.spec.name) })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('option', { name: (n) => n.startsWith(mockEmbeddingModel.spec.name) })
    ).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    expect(
      screen.getByText(new RegExp(`No matching model profile was found for: ${mockEmbeddingModel.spec.name}`))
    ).toBeInTheDocument();
  });

  it('shows each model\'s capabilities as chips in the model picker', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Models'));

    const option = await screen.findByRole('option', {
      name: (n) => n.startsWith(mockSpecDecodingDraftModel.spec.name),
    });
    // capabilities (["text"]) render as chips to the right of the model name.
    mockSpecDecodingDraftModel.spec.metadata.capabilities?.forEach((capability) => {
      expect(within(option).getByText(capability)).toBeInTheDocument();
    });
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

  it('leaves prompt_caching profiles selectable when only one model is selected', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockEmbeddingModel.spec.name]: toCheckpointEntry(mockEmbeddingModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [embeddingHighInteractivityProfile.metadata.name]: toProfileEntry(embeddingHighInteractivityProfile),
      [embeddingPromptCachingProfile.metadata.name]: toProfileEntry(embeddingPromptCachingProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockEmbeddingModel.spec.name]);

    const row = await screen.findByTestId(`model-row-${mockEmbeddingModel.spec.name}`);
    const pcCard = within(row).getByTestId(`profile-card-${embeddingPromptCachingProfile.metadata.name}`);
    // Single model → not disabled, and selectable (collapses the row on select).
    expect(pcCard).not.toHaveAttribute('aria-disabled');
    await user.click(pcCard);
    expect(await within(row).findByText(/^Profile:/)).toBeInTheDocument();
  });

  it('disables prompt_caching profiles (with an explanatory tooltip) once more than one model is selected', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockEmbeddingModel.spec.name]: toCheckpointEntry(mockEmbeddingModel),
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [embeddingHighInteractivityProfile.metadata.name]: toProfileEntry(embeddingHighInteractivityProfile),
      [embeddingPromptCachingProfile.metadata.name]: toProfileEntry(embeddingPromptCachingProfile),
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockEmbeddingModel.spec.name, mockSpecDecodingDraftModel.spec.name]);

    const row = await screen.findByTestId(`model-row-${mockEmbeddingModel.spec.name}`);
    const pcCard = within(row).getByTestId(`profile-card-${embeddingPromptCachingProfile.metadata.name}`);
    // The non-prompt_caching sibling stays enabled.
    expect(within(row).getByTestId(`profile-card-${embeddingHighInteractivityProfile.metadata.name}`)).not.toHaveAttribute(
      'aria-disabled'
    );
    // The prompt_caching tile is disabled and clicking it does not select it (row stays expanded).
    expect(pcCard).toHaveAttribute('aria-disabled', 'true');
    await user.click(pcCard);
    expect(within(row).queryByText(/^Profile:/)).not.toBeInTheDocument();
    expect(within(row).getByTestId(`profile-card-${embeddingPromptCachingProfile.metadata.name}`)).toBeInTheDocument();

    // Hovering the disabled tile surfaces the restriction tooltip.
    await user.hover(pcCard);
    expect(await screen.findByText(/prompt caching can only be deployed on their own/i)).toBeInTheDocument();
  });

  it('shows a titled "Context / Max Batch Size" summary on each card, largest sequence length first', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockEmbeddingModel.spec.name]: toCheckpointEntry(mockEmbeddingModel),
    };
    // Two profiles keep the row expanded so the card tiles (and their summaries) render.
    const modelProfiles: ModelProfilesCache = {
      [embeddingMultiTierProfile.metadata.name]: toProfileEntry(embeddingMultiTierProfile),
      [embeddingHighThroughputProfile.metadata.name]: toProfileEntry(embeddingHighThroughputProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockEmbeddingModel.spec.name]);

    const card = await screen.findByTestId(`profile-card-${embeddingMultiTierProfile.metadata.name}`);

    // Column titles are present so the numbers are self-explanatory.
    expect(within(card).getByText('Context')).toBeInTheDocument();
    expect(within(card).getByText('Max Batch Size')).toBeInTheDocument();

    // Tiers are listed largest sequence length first.
    const tierLabels = within(card)
      .getAllByText(/^(4k|8k|16k|32k|128k)$/)
      .map((el) => el.textContent);
    expect(tierLabels).toEqual(['128k', '32k', '16k', '8k', '4k']);

    // Only the max batch size is shown per tier ('4k' supports [1, 4] → "4", never "[1, 4]").
    expect(within(card).queryByText(/\[/)).not.toBeInTheDocument();
    const fourKLabel = within(card).getByText('4k');
    // The value cell sits immediately after its tier label in DOM order.
    expect(fourKLabel.nextElementSibling?.textContent).toBe('4');
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

    // Single non-spec-decoding model shows the quick-deploy buttons; opt into
    // Advanced Settings to reveal Steps 3 & 4 (the bundle route).
    await user.click(await screen.findByRole('button', { name: 'Advanced Settings' }));

    await waitFor(() => expect(screen.getByText('3. Advanced Options')).toBeInTheDocument());

    // Step 3 is optional and collapsed by default — expand it before interacting with the grid.
    await user.click(screen.getByRole('button', { name: 'Expand advanced options' }));

    // Columns are the union of the profile's declared batch sizes (4k: [1,4], 16k: [1]) → [1, 4],
    // so 2/8/16/32/64 never get a column. The '4k' tier supports [1, 4]: cells 1 and 4 are (seeded
    // from the profile) checked; an undeclared size like 2 has no checkbox at all; and since every
    // supported cell is checked, the row's "All" is auto-checked.
    const cell1 = await screen.findByRole('checkbox', { name: 'Batch size 1 for 4k' });
    const cell4 = screen.getByRole('checkbox', { name: 'Batch size 4 for 4k' });
    const allCell = screen.getByRole('checkbox', { name: 'All batch sizes for 4k' });
    expect(cell1).toBeChecked();
    expect(cell4).toBeChecked();
    // Unsupported cell (2) renders blank, and trimmed-away columns (8, 64) have no checkbox.
    expect(screen.queryByRole('checkbox', { name: 'Batch size 2 for 4k' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Batch size 8 for 4k' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Batch size 64 for 4k' })).not.toBeInTheDocument();
    expect(allCell).toBeChecked();

    // The grid is seeded from the profile default, so the emitted config matches
    // the default and batchingConfig is omitted entirely.
    await waitFor(() => {
      const doc = yaml.load(getYamlText()) as {
        spec: { modelConfigs: Array<{ batchingConfig?: Record<string, { batch_sizes: unknown }> }> };
      };
      expect(doc.spec.modelConfigs[0].batchingConfig).toBeUndefined();
    });

    // Unchecking a supported cell in 4k diverges from the default, so batchingConfig
    // is now emitted with 4k's reduced list — while the untouched 16k tier (still at
    // its default) collapses to the '*' sentinel. "All" for 4k clears.
    await user.click(cell4);
    await waitFor(() => {
      const doc = yaml.load(getYamlText()) as {
        spec: { modelConfigs: Array<{ batchingConfig: Record<string, { batch_sizes: unknown }> }> };
      };
      expect(doc.spec.modelConfigs[0].batchingConfig['4k'].batch_sizes).toEqual([1]);
      // The at-default tier serializes as '*', not its explicit list.
      expect(doc.spec.modelConfigs[0].batchingConfig['16k'].batch_sizes).toBe('*');
    });
    expect(screen.getByRole('checkbox', { name: 'All batch sizes for 4k' })).not.toBeChecked();

    // Re-checking "All" restores 4k to its full default. Now every tier matches the
    // profile default (even though 4k is stored as the '*' sentinel), so the whole
    // batchingConfig is omitted rather than emitted as all-'*' — the fix for the
    // "batchingConfig full of '*'" bug.
    await user.click(screen.getByRole('checkbox', { name: 'All batch sizes for 4k' }));
    await waitFor(() => {
      const doc = yaml.load(getYamlText()) as {
        spec: { modelConfigs: Array<{ batchingConfig?: Record<string, { batch_sizes: unknown }> }> };
      };
      expect(doc.spec.modelConfigs[0].batchingConfig).toBeUndefined();
    });
  });

  it('gives every declared batch size its own checkbox (e.g. 6) so none can leak into the YAML unseen', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [hiddenBatchSizeProfile.metadata.name]: toProfileEntry(hiddenBatchSizeProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockSpecDecodingDraftModel.spec.name]);

    await user.click(await screen.findByRole('button', { name: 'Advanced Settings' }));
    await waitFor(() => expect(screen.getByText('3. Advanced Options')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Expand advanced options' }));

    // 6 is declared by the profile, so it now has its own checkbox (previously it was invisible and
    // could only surface as a surprise value in the YAML). It starts checked, seeded from the default.
    const cell6 = await screen.findByRole('checkbox', { name: 'Batch size 6 for 4k' });
    const cell4 = screen.getByRole('checkbox', { name: 'Batch size 4 for 4k' });
    expect(cell6).toBeChecked();
    expect(cell4).toBeChecked();

    // Grid seeded from the profile default → batchingConfig omitted entirely.
    await waitFor(() => {
      const doc = yaml.load(getYamlText()) as {
        spec: { modelConfigs: Array<{ batchingConfig?: Record<string, { batch_sizes: unknown }> }> };
      };
      expect(doc.spec.modelConfigs[0].batchingConfig).toBeUndefined();
    });

    // Unchecking 4 removes exactly 4 — 6 stays because it is genuinely supported and still checked
    // (before the fix, unchecking 4 produced [2, 6, 8] with 6 appearing "hallucinated").
    await user.click(cell4);
    await waitFor(() => {
      const doc = yaml.load(getYamlText()) as {
        spec: { modelConfigs: Array<{ batchingConfig: Record<string, { batch_sizes: unknown }> }> };
      };
      expect(doc.spec.modelConfigs[0].batchingConfig['4k'].batch_sizes).toEqual([2, 6, 8]);
    });

    // And 6 can now be unchecked (previously impossible), removing it from the YAML.
    await user.click(screen.getByRole('checkbox', { name: 'Batch size 6 for 4k' }));
    await waitFor(() => {
      const doc = yaml.load(getYamlText()) as {
        spec: { modelConfigs: Array<{ batchingConfig: Record<string, { batch_sizes: unknown }> }> };
      };
      expect(doc.spec.modelConfigs[0].batchingConfig['4k'].batch_sizes).toEqual([2, 8]);
    });
  });

  it('defaults Swappable to True (omitted from YAML) and emits modelSettings.swappable:false only when set to False', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockSpecDecodingDraftModel.spec.name]);

    // Single non-spec-decoding model shows the quick-deploy buttons; opt into
    // Advanced Settings to reveal Steps 3 & 4 (the bundle route).
    await user.click(await screen.findByRole('button', { name: 'Advanced Settings' }));

    await waitFor(() => expect(screen.getByText('3. Advanced Options')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Expand advanced options' }));

    // Default is True: no modelSettings emitted.
    const trueRadio = await screen.findByRole('radio', { name: 'True' });
    const falseRadio = screen.getByRole('radio', { name: 'False' });
    expect(trueRadio).toBeChecked();
    await waitFor(() => {
      const doc = yaml.load(getYamlText()) as { spec: { modelConfigs: Array<{ modelSettings?: unknown }> } };
      expect(doc.spec.modelConfigs[0].modelSettings).toBeUndefined();
    });

    // Switching to False emits modelSettings.swappable: false.
    await user.click(falseRadio);
    await waitFor(() => {
      const doc = yaml.load(getYamlText()) as {
        spec: { modelConfigs: Array<{ modelSettings?: { swappable?: boolean } }> };
      };
      expect(doc.spec.modelConfigs[0].modelSettings?.swappable).toBe(false);
    });

    // Switching back to True drops it again.
    await user.click(screen.getByRole('radio', { name: 'True' }));
    await waitFor(() => {
      const doc = yaml.load(getYamlText()) as { spec: { modelConfigs: Array<{ modelSettings?: unknown }> } };
      expect(doc.spec.modelConfigs[0].modelSettings).toBeUndefined();
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

    // Single non-spec-decoding model shows the quick-deploy buttons; opt into
    // Advanced Settings to reveal Step 4 (the ModelBundle YAML).
    await user.click(await screen.findByRole('button', { name: 'Advanced Settings' }));

    await waitFor(() => {
      const text = getYamlText();
      expect(text).toContain('apiVersion: sambanova.ai/v1alpha1');
      expect(text).toContain('kind: ModelBundle');
      expect(text).toContain(`profile: ${mockSpecDecodingDraftProfile.metadata.name}`);
    });
  });

  it('offers quick "Create Deployment"/"Advanced Settings" for a single non-spec-decoding model and routes to the model+profile deploy', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockSpecDecodingDraftModel.spec.name]);

    // Quick buttons appear once the (single) profile auto-resolves; Steps 3 & 4 stay hidden.
    const deployButton = await screen.findByRole('button', { name: 'Create Deployment' });
    expect(screen.getByRole('button', { name: 'Advanced Settings' })).toBeInTheDocument();
    expect(screen.queryByText('3. Advanced Options')).not.toBeInTheDocument();
    expect(screen.queryByText('4. Save & Validate Selections')).not.toBeInTheDocument();

    await user.click(deployButton);

    // Single-arch model → bare crname (no arch, no version); profile is the CR name.
    expect(mockPush).toHaveBeenCalledWith(
      `/model-deployment?modelPath=${encodeURIComponent('meta-llama-3-2-1b-instruct')}` +
        `&profileName=${encodeURIComponent('llama-3p1-1b')}`
    );
  });

  it('applies an app-config checkpoint_overrides version to both the deploy modelPath and the bundle YAML', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };
    // Pin version "2" for this model (keyed by its display name).
    const checkpointOverrides = { [mockSpecDecodingDraftModel.spec.name]: '2' };

    await renderModelSelection(checkpointMapping, modelProfiles, checkpointOverrides);
    const user = userEvent.setup();
    await selectModels(user, [mockSpecDecodingDraftModel.spec.name]);

    // Quick deploy modelPath carries the overridden version (done before opening
    // Advanced Settings, which replaces the quick buttons with Steps 3 & 4).
    await user.click(await screen.findByRole('button', { name: 'Create Deployment' }));
    expect(mockPush).toHaveBeenCalledWith(
      `/model-deployment?modelPath=${encodeURIComponent('meta-llama-3-2-1b-instruct:2')}` +
        `&profileName=${encodeURIComponent('llama-3p1-1b')}`
    );

    // Bundle YAML (Advanced Settings) pins the overridden version, not the latest.
    await user.click(screen.getByRole('button', { name: 'Advanced Settings' }));
    await waitFor(() => {
      expect(getYamlText()).toContain('model: meta-llama-3-2-1b-instruct:2');
    });
  });

  it('"Advanced Settings" reveals Steps 3 & 4 and hides the quick-deploy buttons (single model)', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockSpecDecodingDraftModel.spec.name]);

    await user.click(await screen.findByRole('button', { name: 'Advanced Settings' }));

    await waitFor(() => expect(screen.getByText('3. Advanced Options')).toBeInTheDocument());
    expect(screen.getByText('4. Save & Validate Selections')).toBeInTheDocument();
    // The single-model quick action bar is gone (its unique signal is the
    // "Advanced Settings" button); Step 4 keeps its own bundle "Create Deployment".
    expect(screen.queryByRole('button', { name: 'Advanced Settings' })).not.toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('keeps the bundle route (no quick buttons) when multiple models are selected', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingDraftModel.spec.name]: toCheckpointEntry(mockSpecDecodingDraftModel),
      [mockEmbeddingModel.spec.name]: toCheckpointEntry(mockEmbeddingModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingDraftProfile.metadata.name]: toProfileEntry(mockSpecDecodingDraftProfile),
      [embeddingHighThroughputProfile.metadata.name]: toProfileEntry(embeddingHighThroughputProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockSpecDecodingDraftModel.spec.name, mockEmbeddingModel.spec.name]);

    // Two top-level models → Steps 3 & 4 show directly, no single-model quick
    // action bar (its unique signal is the "Advanced Settings" button).
    await waitFor(() => expect(screen.getByText('4. Save & Validate Selections')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Advanced Settings' })).not.toBeInTheDocument();
  });

  it('forces the bundle route (no quick buttons) for a single spec-decoding model', async () => {
    const checkpointMapping: CheckpointMappingV3 = {
      [mockSpecDecodingTargetModel.spec.name]: toCheckpointEntry(mockSpecDecodingTargetModel),
    };
    const modelProfiles: ModelProfilesCache = {
      [mockSpecDecodingTargetProfile.metadata.name]: toProfileEntry(mockSpecDecodingTargetProfile),
    };

    await renderModelSelection(checkpointMapping, modelProfiles);
    const user = userEvent.setup();
    await selectModels(user, [mockSpecDecodingTargetModel.spec.name]);

    // Spec-decoding needs a target+draft pair → forced to Steps 3 & 4, no quick
    // action bar (its unique signal is the "Advanced Settings" button).
    await waitFor(() => expect(screen.getByText('3. Advanced Options')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Advanced Settings' })).not.toBeInTheDocument();
  });
});
