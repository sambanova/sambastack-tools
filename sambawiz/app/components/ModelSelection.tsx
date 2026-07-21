'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Box,
  Paper,
  Typography,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Checkbox,
  ListItemText,
  Card,
  CardContent,
  Chip,
  SelectChangeEvent,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Tooltip,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  FormControlLabel,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import SaveIcon from '@mui/icons-material/Save';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import type {
  CheckpointMappingV3,
  ModelProfilesCache,
  Model,
  ModelProfile,
  BatchingConfig,
  ModelConfigEntry,
  SpecDecodingPair,
} from '../types/bundle';
import {
  type ModelBundleSelection,
  getEffectiveBatchingConfig,
  getDisplayName,
  isSpecDecodingProfile,
  generateModelBundleYaml,
} from '../utils/bundle-yaml-generator';
import {
  getAvailableModels,
  type AvailableModel,
  type AvailableModelArch,
} from '../utils/model-availability';
import { parseModelRef, type ParsedModelBundleState } from '../utils/parse-bundle-yaml';
import DocumentationPanel from './DocumentationPanel';
import GaugeChart from 'react-gauge-chart';

/**
 * Per-model UI state for the Step 2/3 flow (arch pin, profile pick, expand/
 * collapse, batching override, spec-decoding draft linkage). Keyed by the
 * `Model.spec.name` display name in `BuilderSelectionState.modelStates` —
 * this covers both top-level user-selected models and any spec-decoding
 * draft models that get auto-added alongside their target.
 */
interface PerModelState {
  arch?: string;
  profileName?: string;
  expanded: boolean;
  override: BatchingConfig;
  /** 'skip' or the display name of the chosen draft model (only meaningful when the selected profile is spec-decoding). */
  draftChoice?: string;
  /** Set when this model entry only exists because it was auto-added as a draft for another model. */
  draftForDisplayName?: string;
}

interface BuilderSelectionState {
  selectedModels: string[];
  modelStates: Record<string, PerModelState>;
}

function createEmptyState(): PerModelState {
  return { expanded: true, override: {} };
}

/** Resolves the (arch, matching profiles) auto-select/collapse state once an arch is known. */
function resolveAutoProfileState(avail: AvailableModel, arch: string): PerModelState {
  const archEntry = avail.archs.find((a) => a.arch === arch);
  const profiles = archEntry?.matchingProfiles ?? [];
  if (profiles.length === 1) {
    const profile = profiles[0];
    return {
      arch,
      profileName: profile.metadata.name,
      expanded: false,
      override: getEffectiveBatchingConfig(profile),
    };
  }
  return { arch, expanded: true, override: {} };
}

/** Initial state for a newly-selected model: single-arch models resolve immediately, multi-arch models wait on the arch dropdown. */
function initializeModelState(avail: AvailableModel | undefined): PerModelState {
  if (!avail) return createEmptyState();
  if (avail.archs.length === 1) {
    return resolveAutoProfileState(avail, avail.archs[0].arch);
  }
  return createEmptyState();
}

/** Removes a target's chosen draft (state + selectedModels entry) when the target's profile/arch changes away from spec-decoding. */
function cascadeRemoveDraftFor(
  targetDisplayName: string,
  selectedModels: string[],
  modelStates: Record<string, PerModelState>
): { selectedModels: string[]; modelStates: Record<string, PerModelState> } {
  const targetState = modelStates[targetDisplayName];
  if (!targetState?.draftChoice || targetState.draftChoice === 'skip') {
    return { selectedModels, modelStates };
  }
  const draftName = targetState.draftChoice;
  const draftState = modelStates[draftName];
  const nextModelStates = { ...modelStates };
  let nextSelectedModels = selectedModels;
  if (draftState?.draftForDisplayName === targetDisplayName) {
    delete nextModelStates[draftName];
    nextSelectedModels = nextSelectedModels.filter((m) => m !== draftName);
  }
  nextModelStates[targetDisplayName] = { ...nextModelStates[targetDisplayName], draftChoice: undefined };
  return { selectedModels: nextSelectedModels, modelStates: nextModelStates };
}

/** Picks the highest-version checkpoint_status for an arch, for the Step-2 arch dropdown labels. */
function getArchStatusLabel(rawEntry: CheckpointMappingV3[string] | undefined, arch: string): string | undefined {
  const archData = rawEntry?.checkpoints[arch];
  if (!archData) return undefined;
  const versions = Object.keys(archData.versions);
  if (versions.length === 0) return undefined;
  const highest = versions.reduce((max, v) => (Number(v) > Number(max) ? v : max));
  return archData.versions[highest]?.checkpoint_status;
}

function getSelectedProfileLabel(profiles: ModelProfile[], profileName?: string): string {
  if (!profileName) return '';
  const profile = profiles.find((p) => p.metadata.name === profileName);
  if (!profile) return profileName;
  return getDisplayName(profile, profiles);
}

/** Reconstructs a minimal `ModelProfile` from the `ModelProfilesCache` entry (used as a fallback when loading a bundle whose profile isn't in the current arch join, e.g. a stale/foreign arch). */
function buildProfileFromCache(profileName: string, modelProfiles: ModelProfilesCache): ModelProfile | undefined {
  const cached = modelProfiles[profileName];
  if (!cached) return undefined;
  return {
    metadata: { name: profileName },
    spec: {
      model_arch: cached.model_arch,
      features: cached.features,
      defaultBatchingConfig: cached.batchingConfig,
      pefs: cached.pefs,
    },
  };
}

/** A single profile card tile: display name (never metadata.name), effective batching tiers, and features. */
function ProfileCard({
  profile,
  siblingProfiles,
  selected,
  onSelect,
}: {
  profile: ModelProfile;
  siblingProfiles: ModelProfile[];
  selected: boolean;
  onSelect: () => void;
}) {
  const title = getDisplayName(profile, siblingProfiles);
  const batching = getEffectiveBatchingConfig(profile);
  const tierEntries = Object.entries(batching);
  const features = profile.spec.features ?? [];

  return (
    <Card
      variant="outlined"
      onClick={onSelect}
      data-testid={`profile-card-${profile.metadata.name}`}
      sx={{
        minWidth: 220,
        maxWidth: 260,
        flex: '0 0 auto',
        cursor: 'pointer',
        borderColor: selected ? 'primary.main' : 'divider',
        borderWidth: selected ? 2 : 1,
        bgcolor: selected ? 'action.selected' : 'background.paper',
      }}
    >
      <CardContent>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>
          {title}
        </Typography>
        <Box sx={{ mb: 1 }}>
          {tierEntries.length === 0 && (
            <Typography variant="caption" color="text.secondary">
              No batching config
            </Typography>
          )}
          {tierEntries.map(([tier, cfg]) => (
            <Typography key={tier} variant="caption" sx={{ display: 'block' }}>
              {tier}: {cfg.batch_sizes === '*' ? 'all batch sizes' : `[${cfg.batch_sizes.join(', ')}]`}
            </Typography>
          ))}
        </Box>
        <Typography variant="caption" color="text.secondary">
          Features: {features.length === 0 ? 'default' : features.join(', ')}
        </Typography>
      </CardContent>
    </Card>
  );
}

/** Editable batching-config override for a single model, seeded from the profile's effective config. Never exposes `is_default` (auto-derived by the generator). */
function BatchingOverrideEditor({
  editorKey,
  override,
  onChange,
}: {
  editorKey: string;
  override: BatchingConfig;
  onChange: (next: BatchingConfig) => void;
}) {
  const [rawText, setRawText] = useState<Record<string, string>>({});

  useEffect(() => {
    const initial: Record<string, string> = {};
    Object.entries(override).forEach(([tier, cfg]) => {
      initial[tier] = Array.isArray(cfg.batch_sizes) ? cfg.batch_sizes.join(', ') : '';
    });
    setRawText(initial);
    // Only reset raw text when switching to a different model/profile, not on every override tweak.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorKey]);

  const tiers = Object.keys(override);

  if (tiers.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        This profile has no batching configuration to override.
      </Typography>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {tiers.map((tier) => {
        const cfg = override[tier];
        const isAll = cfg.batch_sizes === '*';
        return (
          <Box key={tier} sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            <Typography variant="body2" sx={{ minWidth: 60, fontWeight: 600 }}>
              {tier}
            </Typography>
            <FormControlLabel
              control={
                <Checkbox
                  checked={isAll}
                  onChange={(e) => {
                    const next: BatchingConfig = { ...override, [tier]: { batch_sizes: e.target.checked ? '*' : [] } };
                    onChange(next);
                  }}
                />
              }
              label="All batch sizes (*)"
            />
            {!isAll && (
              <TextField
                size="small"
                label="Batch sizes (comma-separated)"
                value={rawText[tier] ?? ''}
                onChange={(e) => {
                  const text = e.target.value;
                  setRawText((prev) => ({ ...prev, [tier]: text }));
                  const parsed = text
                    .split(',')
                    .map((v) => v.trim())
                    .filter((v) => v.length > 0)
                    .map((v) => Number(v))
                    .filter((v) => !Number.isNaN(v));
                  const next: BatchingConfig = { ...override, [tier]: { batch_sizes: parsed } };
                  onChange(next);
                }}
                sx={{ minWidth: 260 }}
              />
            )}
          </Box>
        );
      })}
    </Box>
  );
}

/** One expandable row of profile card tiles for a single model (fixed header, horizontal-scroll tiles, single-select, collapse-on-select). Used for both top-level selections and spec-decoding draft models (rendered nested/indented). */
function ModelProfileRow({
  displayName,
  avail,
  rawEntry,
  state,
  isDraftRow,
  onArchChange,
  onProfileSelect,
  onToggleExpand,
}: {
  displayName: string;
  avail: AvailableModel;
  rawEntry: CheckpointMappingV3[string] | undefined;
  state: PerModelState;
  isDraftRow?: boolean;
  onArchChange: (arch: string) => void;
  onProfileSelect: (profile: ModelProfile) => void;
  onToggleExpand: () => void;
}) {
  const needsArch = avail.archs.length > 1;
  const resolvedArch = needsArch ? state.arch : avail.archs[0]?.arch;
  const archEntry: AvailableModelArch | undefined = avail.archs.find((a) => a.arch === resolvedArch);
  const matchingProfiles = archEntry?.matchingProfiles ?? [];

  return (
    <Box
      sx={{
        mb: 2,
        pl: isDraftRow ? 3 : 0,
        borderLeft: isDraftRow ? '2px solid' : 'none',
        borderColor: 'divider',
      }}
      data-testid={`model-row-${displayName}`}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          {isDraftRow ? `Draft model: ${displayName}` : displayName}
        </Typography>
        {state.profileName && (
          <Button size="small" onClick={onToggleExpand}>
            {state.expanded ? 'Collapse' : 'Change selection'}
          </Button>
        )}
      </Box>

      {needsArch && !resolvedArch && (
        <FormControl size="small" sx={{ minWidth: 280, mb: 2 }}>
          <InputLabel id={`arch-select-label-${displayName}`}>Architecture</InputLabel>
          <Select
            labelId={`arch-select-label-${displayName}`}
            label="Architecture"
            value=""
            onChange={(e) => onArchChange(e.target.value as string)}
          >
            {avail.archs.map((a) => {
              const statusLabel = getArchStatusLabel(rawEntry, a.arch);
              return (
                <MenuItem key={a.arch} value={a.arch}>
                  {a.arch}
                  {statusLabel ? ` (${statusLabel})` : ''}
                </MenuItem>
              );
            })}
          </Select>
        </FormControl>
      )}

      {resolvedArch && !state.expanded && state.profileName && (
        <Chip
          label={`Profile: ${getSelectedProfileLabel(matchingProfiles, state.profileName)}`}
          onClick={onToggleExpand}
          sx={{ cursor: 'pointer' }}
        />
      )}

      {resolvedArch && state.expanded && (
        <Box sx={{ display: 'flex', gap: 2, overflowX: 'auto', pb: 1 }}>
          {matchingProfiles.map((profile) => (
            <ProfileCard
              key={profile.metadata.name}
              profile={profile}
              siblingProfiles={matchingProfiles}
              selected={state.profileName === profile.metadata.name}
              onSelect={() => onProfileSelect(profile)}
            />
          ))}
        </Box>
      )}
    </Box>
  );
}

export default function ModelSelection() {
  const router = useRouter();

  const bundleNameId = 'bundle-form-bundle-name';
  const generatedYamlId = 'bundle-form-generated-yaml';

  const [checkpointMapping, setCheckpointMapping] = useState<CheckpointMappingV3>({});
  const [modelProfiles, setModelProfiles] = useState<ModelProfilesCache>({});
  const [selection, setSelection] = useState<BuilderSelectionState>({ selectedModels: [], modelStates: {} });
  const [bundleName, setBundleName] = useState<string>('bundle1');
  const [generatedYaml, setGeneratedYaml] = useState<string>('');
  const [isValidating, setIsValidating] = useState<boolean>(false);
  const [copiedToClipboard, setCopiedToClipboard] = useState<boolean>(false);
  const [pendingLoad, setPendingLoad] = useState<ParsedModelBundleState | null>(null);
  const [validationResult, setValidationResult] = useState<{
    success: boolean;
    message: string;
    applyOutput?: string;
    validationStatus?: {
      reason: string;
      message: string;
      isValid: boolean;
      legalizerInfo?: {
        errors?: string[];
        warnings?: string[];
        status?: string;
        utilization?: {
          ddr?: string;
          hbm_resident?: string;
          host?: string;
        };
      };
    };
    bundleName?: string;
  } | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);

  // Track if we're loading from saved/external state to prevent YAML regeneration mid-restore
  const isLoadingFromSavedState = useRef<boolean>(false);

  // Load the checkpoint-mapping (Model CRs) and model-profiles (ModelProfile CRs) caches.
  useEffect(() => {
    const loadCheckpointMapping = async () => {
      try {
        const response = await fetch('/api/checkpoint-mapping');
        const result = await response.json();
        if (result.success && result.data) {
          setCheckpointMapping(result.data);
        } else {
          setCheckpointMapping({});
        }
      } catch (error) {
        console.warn('Failed to load checkpoint_mapping.json:', error);
        setCheckpointMapping({});
      }
    };

    const loadModelProfiles = async () => {
      try {
        const response = await fetch('/api/model-profiles');
        const result = await response.json();
        if (result.success && result.data) {
          setModelProfiles(result.data);
        } else {
          setModelProfiles({});
        }
      } catch (error) {
        console.warn('Failed to load model_profiles.json:', error);
        setModelProfiles({});
      }
    };

    loadCheckpointMapping();
    loadModelProfiles();
  }, []);

  // Load previously-saved builder state on mount.
  useEffect(() => {
    const loadSavedState = async () => {
      try {
        const response = await fetch('/api/model-selection-state');
        const data = await response.json();
        if (data.success && data.state) {
          isLoadingFromSavedState.current = true;
          setSelection({
            selectedModels: data.state.selectedModels || [],
            modelStates: data.state.modelStates || {},
          });
          setBundleName(data.state.bundleName || 'bundle1');
          setGeneratedYaml(data.state.generatedYaml || '');
          setTimeout(() => {
            isLoadingFromSavedState.current = false;
          }, 100);
        }
      } catch (error) {
        console.error('Failed to load saved state:', error);
        isLoadingFromSavedState.current = false;
      }
    };

    loadSavedState();
  }, []);

  // Listen for "load existing bundle" events dispatched by model-selection/page.tsx.
  // The payload now matches ParsedModelBundleState (bundleName/modelConfigs/specDecodingPairs)
  // since the parser (and load-bundle/load-deployed-bundle routes) are V3-only.
  useEffect(() => {
    const handleLoadBundleState = (event: Event) => {
      const customEvent = event as CustomEvent<{
        bundleName: string;
        modelConfigs: ModelConfigEntry[];
        specDecodingPairs: SpecDecodingPair[];
      }>;
      setPendingLoad({
        bundleName: customEvent.detail.bundleName,
        modelConfigs: customEvent.detail.modelConfigs,
        specDecodingPairs: customEvent.detail.specDecodingPairs ?? [],
      });
      setValidationResult(null);
    };

    window.addEventListener('loadBundleState', handleLoadBundleState);
    return () => window.removeEventListener('loadBundleState', handleLoadBundleState);
  }, []);

  // Availability join (model cache x profile cache on model_arch), with the no-profile guard (Q4).
  const availability = useMemo(
    () => getAvailableModels(checkpointMapping, modelProfiles),
    [checkpointMapping, modelProfiles]
  );
  const availableModels = availability.available;
  const availableByDisplayName = useMemo(() => {
    const map: Record<string, AvailableModel> = {};
    availableModels.forEach((m) => {
      map[m.displayName] = m;
    });
    return map;
  }, [availableModels]);

  // Apply a pending "load existing bundle" event once the caches it depends on are ready.
  useEffect(() => {
    if (!pendingLoad) return;
    if (Object.keys(checkpointMapping).length === 0) return;

    const parsed = pendingLoad;
    isLoadingFromSavedState.current = true;

    const byCrname: Record<string, string> = {};
    Object.entries(checkpointMapping).forEach(([displayName, entry]) => {
      byCrname[entry.resource_name] = displayName;
    });

    const draftCrnameSet = new Set(parsed.specDecodingPairs.map((p) => p.draft));
    const targetCrnameForDraft: Record<string, string> = {};
    const draftCrnameForTarget: Record<string, string> = {};
    parsed.specDecodingPairs.forEach((p) => {
      targetCrnameForDraft[p.draft] = p.target;
      draftCrnameForTarget[p.target] = p.draft;
    });

    const newSelectedModels: string[] = [];
    const newModelStates: Record<string, PerModelState> = {};

    parsed.modelConfigs.forEach((entry) => {
      if (typeof entry.profile !== 'string') {
        console.warn('Loaded bundle uses an inline profileDefinition; the builder only supports named profile references, skipping entry.');
        return;
      }
      const { crname, arch } = parseModelRef(entry.model);
      const displayName = byCrname[crname];
      if (!displayName) {
        console.warn(`Loaded bundle references unknown model "${crname}" (not present in checkpoint_mapping cache); skipping.`);
        return;
      }

      newSelectedModels.push(displayName);

      const avail = availableByDisplayName[displayName];
      const resolvedArch = arch ?? (avail && avail.archs.length === 1 ? avail.archs[0].arch : undefined);
      const archEntry = avail?.archs.find((a) => a.arch === resolvedArch);
      const profile =
        archEntry?.matchingProfiles.find((p) => p.metadata.name === entry.profile) ??
        buildProfileFromCache(entry.profile, modelProfiles);

      newModelStates[displayName] = {
        arch: resolvedArch,
        profileName: entry.profile,
        expanded: false,
        override: entry.batchingConfig ?? (profile ? getEffectiveBatchingConfig(profile) : {}),
        draftForDisplayName: draftCrnameSet.has(crname) ? byCrname[targetCrnameForDraft[crname]] : undefined,
      };
    });

    Object.entries(draftCrnameForTarget).forEach(([targetCrname, draftCrname]) => {
      const targetDisplayName = byCrname[targetCrname];
      const draftDisplayName = byCrname[draftCrname];
      if (targetDisplayName && newModelStates[targetDisplayName]) {
        newModelStates[targetDisplayName].draftChoice = draftDisplayName ?? 'skip';
      }
    });

    setSelection({ selectedModels: newSelectedModels, modelStates: newModelStates });
    setBundleName(parsed.bundleName);
    setValidationResult(null);
    setPendingLoad(null);

    setTimeout(() => {
      isLoadingFromSavedState.current = false;
    }, 100);
    // availableByDisplayName / modelProfiles are read at apply-time only (not meant to re-trigger this effect on every cache tick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLoad, checkpointMapping]);

  // ---------------------------------------------------------------------
  // Selection handlers
  // ---------------------------------------------------------------------

  function applyTopLevelModels(models: string[]) {
    setSelection((prev) => {
      const removed = prev.selectedModels.filter((m) => !models.includes(m));
      let nextSelectedModels = [...models];
      const nextModelStates: Record<string, PerModelState> = { ...prev.modelStates };

      removed.forEach((name) => {
        delete nextModelStates[name];
        Object.keys(nextModelStates).forEach((key) => {
          if (nextModelStates[key].draftForDisplayName === name) {
            delete nextModelStates[key];
            nextSelectedModels = nextSelectedModels.filter((m) => m !== key);
          }
        });
      });

      models.forEach((name) => {
        if (!nextModelStates[name]) {
          nextModelStates[name] = initializeModelState(availableByDisplayName[name]);
        }
      });

      return { selectedModels: nextSelectedModels, modelStates: nextModelStates };
    });
  }

  const handleModelsSelectChange = (event: SelectChangeEvent<string[]>) => {
    const value = event.target.value;
    const models = typeof value === 'string' ? value.split(',') : value;
    applyTopLevelModels(models);
  };

  const handleRemoveModel = (name: string) => {
    applyTopLevelModels(selection.selectedModels.filter((m) => m !== name));
  };

  const handleArchChange = (displayName: string, arch: string) => {
    setSelection((prev) => {
      const avail = availableByDisplayName[displayName];
      if (!avail) return prev;
      const cascaded = cascadeRemoveDraftFor(displayName, prev.selectedModels, prev.modelStates);
      const resolved = resolveAutoProfileState(avail, arch);
      return {
        selectedModels: cascaded.selectedModels,
        modelStates: { ...cascaded.modelStates, [displayName]: resolved },
      };
    });
  };

  const handleProfileSelect = (displayName: string, profile: ModelProfile) => {
    setSelection((prev) => {
      const cascaded = cascadeRemoveDraftFor(displayName, prev.selectedModels, prev.modelStates);
      const existing = cascaded.modelStates[displayName] ?? createEmptyState();
      return {
        selectedModels: cascaded.selectedModels,
        modelStates: {
          ...cascaded.modelStates,
          [displayName]: {
            ...existing,
            profileName: profile.metadata.name,
            expanded: false,
            override: getEffectiveBatchingConfig(profile),
            draftChoice: undefined,
          },
        },
      };
    });
  };

  const handleToggleExpand = (displayName: string) => {
    setSelection((prev) => ({
      ...prev,
      modelStates: {
        ...prev.modelStates,
        [displayName]: { ...prev.modelStates[displayName], expanded: !prev.modelStates[displayName]?.expanded },
      },
    }));
  };

  const handleOverrideChange = (displayName: string, next: BatchingConfig) => {
    setSelection((prev) => ({
      ...prev,
      modelStates: {
        ...prev.modelStates,
        [displayName]: { ...prev.modelStates[displayName], override: next },
      },
    }));
  };

  const handleDraftChoiceChange = (targetDisplayName: string, value: string) => {
    setSelection((prev) => {
      const cascaded = cascadeRemoveDraftFor(targetDisplayName, prev.selectedModels, prev.modelStates);
      let { selectedModels } = cascaded;
      const modelStates = { ...cascaded.modelStates };

      if (value === 'skip') {
        modelStates[targetDisplayName] = { ...modelStates[targetDisplayName], draftChoice: 'skip' };
        return { selectedModels, modelStates };
      }

      modelStates[targetDisplayName] = { ...modelStates[targetDisplayName], draftChoice: value };

      if (!selectedModels.includes(value)) {
        selectedModels = [...selectedModels, value];
      }
      const avail = availableByDisplayName[value];
      const existingState = modelStates[value] ?? initializeModelState(avail);
      modelStates[value] = { ...existingState, draftForDisplayName: targetDisplayName };

      return { selectedModels, modelStates };
    });
  };

  // ---------------------------------------------------------------------
  // Selections -> ModelBundle YAML
  // ---------------------------------------------------------------------

  const modelSelections = useMemo<ModelBundleSelection[] | null>(() => {
    const draftForMap: Record<string, string> = {};
    Object.entries(selection.modelStates).forEach(([name, state]) => {
      if (state.draftChoice && state.draftChoice !== 'skip') {
        const avail = availableByDisplayName[name];
        if (avail) draftForMap[state.draftChoice] = avail.resourceName;
      }
    });

    const selections: ModelBundleSelection[] = [];
    for (const displayName of selection.selectedModels) {
      const avail = availableByDisplayName[displayName];
      const state = selection.modelStates[displayName];
      if (!avail || !state) return null;

      const arch = avail.archs.length === 1 ? avail.archs[0].arch : state.arch;
      if (!arch) return null;
      const archEntry = avail.archs.find((a) => a.arch === arch);
      if (!archEntry) return null;
      const profile = archEntry.matchingProfiles.find((p) => p.metadata.name === state.profileName);
      if (!profile) return null;

      const rawEntry = checkpointMapping[displayName];
      if (!rawEntry) return null;

      const model: Model = {
        metadata: { name: avail.resourceName },
        spec: {
          name: displayName,
          checkpoints: rawEntry.checkpoints,
          metadata: { capabilities: rawEntry.capabilities },
        },
      };

      const sel: ModelBundleSelection = {
        model,
        arch,
        profile,
        batchingConfigOverride: state.override,
      };
      if (draftForMap[displayName]) {
        sel.isDraftFor = draftForMap[displayName];
      }
      selections.push(sel);
    }
    return selections;
  }, [selection, availableByDisplayName, checkpointMapping]);

  useEffect(() => {
    if (isLoadingFromSavedState.current) return;

    if (!modelSelections || modelSelections.length === 0 || !bundleName) {
      setGeneratedYaml('');
      return;
    }

    try {
      setGeneratedYaml(generateModelBundleYaml(bundleName, modelSelections));
    } catch (error) {
      console.error('Failed to generate ModelBundle YAML:', error);
      setGeneratedYaml('');
    }
  }, [modelSelections, bundleName]);

  // Handle copy to clipboard
  const handleCopyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(generatedYaml);
      setCopiedToClipboard(true);
      setTimeout(() => setCopiedToClipboard(false), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  // Handle validation
  const handleValidate = async () => {
    if (!generatedYaml) return;

    setIsValidating(true);
    setValidationResult(null);

    try {
      await fetch('/api/model-selection-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: {
            selectedModels: selection.selectedModels,
            modelStates: selection.modelStates,
            bundleName,
            generatedYaml,
          },
        }),
      });
    } catch (error) {
      console.error('Failed to save state:', error);
    }

    try {
      const response = await fetch('/api/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: generatedYaml }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setValidationResult({
          success: true,
          message: 'Bundle validated and applied successfully!',
          applyOutput: data.applyOutput,
          validationStatus: data.validationStatus,
          bundleName: data.bundleName,
        });
      } else {
        setValidationResult({
          success: false,
          message: data.error || 'Validation failed',
          applyOutput: data.applyOutput || data.stderr || data.stdout || data.message,
        });
      }
    } catch (error) {
      setValidationResult({
        success: false,
        message: 'Failed to connect to validation service',
        applyOutput: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      setIsValidating(false);
    }
  };

  // Handle save button click
  const handleSaveClick = () => {
    setSaveResult(null);
    setSaveDialogOpen(false);
    handleSaveFile(false);
  };

  const handleSaveFile = async (overwrite: boolean) => {
    if (!generatedYaml || !bundleName) return;

    setIsSaving(true);
    setSaveResult(null);

    const fileName = `${bundleName}.yaml`;

    try {
      const endpoint = overwrite ? '/api/save-artifact' : '/api/save-artifact';
      const method = overwrite ? 'PUT' : 'POST';

      const response = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, content: generatedYaml }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setSaveResult({
          success: true,
          message: `Bundle saved successfully to saved_artifacts/${fileName}`,
        });
      } else if (response.status === 409 && data.fileExists) {
        setSaveDialogOpen(true);
      } else {
        setSaveResult({
          success: false,
          message: data.error || 'Failed to save bundle',
        });
      }
    } catch {
      setSaveResult({
        success: false,
        message: 'Failed to connect to save service',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleOverwrite = () => {
    setSaveDialogOpen(false);
    handleSaveFile(true);
  };

  const handleCancelSave = () => {
    setSaveDialogOpen(false);
    setSaveResult(null);
  };

  const handleCreateDeployment = () => {
    const bundleNameToPass = validationResult?.bundleName || bundleName;
    router.push(`/model-deployment?bundle=${encodeURIComponent(bundleNameToPass)}`);
  };

  // Models with a resolved profile, in selection order, for the override editor (Step 3).
  const modelsWithResolvedProfile = useMemo(() => {
    return selection.selectedModels
      .map((displayName) => {
        const avail = availableByDisplayName[displayName];
        const state = selection.modelStates[displayName];
        if (!avail || !state?.profileName) return null;
        const arch = avail.archs.length === 1 ? avail.archs[0].arch : state.arch;
        const archEntry = avail.archs.find((a) => a.arch === arch);
        const profile = archEntry?.matchingProfiles.find((p) => p.metadata.name === state.profileName);
        if (!profile) return null;
        return { displayName, state, profile };
      })
      .filter((entry): entry is { displayName: string; state: PerModelState; profile: ModelProfile } => entry !== null);
  }, [selection, availableByDisplayName]);

  return (
    <Box>
      {/* Documentation Panel */}
      <DocumentationPanel docFile="model-selection.md" />

      {/* No-profile guard (Q4) */}
      {availability.excludedModelNames.length > 0 && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          No matching model profile was found for: {availability.excludedModelNames.join(', ')}. These models cannot be
          added to the bundle.
        </Alert>
      )}

      {/* Step 1: Select Models */}
      <Paper elevation={0} sx={{ p: 3, mb: 3, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
        <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 2 }}>
          1. Select Models
        </Typography>
        <FormControl fullWidth>
          <InputLabel id="model-select-label">Models</InputLabel>
          <Select
            labelId="model-select-label"
            id="model-select"
            multiple
            value={selection.selectedModels}
            onChange={handleModelsSelectChange}
            label="Models"
            renderValue={(selected) => (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {selected.map((value) => (
                  <Chip
                    key={value}
                    label={value}
                    size="small"
                    onDelete={(e) => {
                      e.stopPropagation();
                      handleRemoveModel(value);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                ))}
              </Box>
            )}
          >
            {availableModels.map((model) => (
              <MenuItem key={model.displayName} value={model.displayName}>
                <Checkbox checked={selection.selectedModels.indexOf(model.displayName) > -1} />
                <ListItemText primary={model.displayName} />
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Paper>

      {/* Step 2: List & pick one ModelProfile per model */}
      {selection.selectedModels.length > 0 && (
        <Paper elevation={0} sx={{ p: 3, mb: 3, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 2 }}>
            2. Select Model Profiles
          </Typography>
          {selection.selectedModels
            .filter((displayName) => !selection.modelStates[displayName]?.draftForDisplayName)
            .map((displayName) => {
              const avail = availableByDisplayName[displayName];
              const state = selection.modelStates[displayName];
              if (!avail || !state) return null;

              const resolvedArch = avail.archs.length === 1 ? avail.archs[0].arch : state.arch;
              const archEntry = avail.archs.find((a) => a.arch === resolvedArch);
              const selectedProfile = archEntry?.matchingProfiles.find((p) => p.metadata.name === state.profileName);
              const showSpecDecoding = selectedProfile ? isSpecDecodingProfile(selectedProfile) : false;

              return (
                <Box key={displayName} sx={{ mb: 3 }}>
                  <ModelProfileRow
                    displayName={displayName}
                    avail={avail}
                    rawEntry={checkpointMapping[displayName]}
                    state={state}
                    onArchChange={(arch) => handleArchChange(displayName, arch)}
                    onProfileSelect={(profile) => handleProfileSelect(displayName, profile)}
                    onToggleExpand={() => handleToggleExpand(displayName)}
                  />

                  {showSpecDecoding && (
                    <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                      <Typography variant="body2" color="text.secondary">
                        This profile supports speculative decoding. Choose a draft model:
                      </Typography>
                      <FormControl size="small" sx={{ minWidth: 220 }}>
                        <InputLabel id={`draft-select-label-${displayName}`}>{`Draft model for ${displayName}`}</InputLabel>
                        <Select
                          labelId={`draft-select-label-${displayName}`}
                          label={`Draft model for ${displayName}`}
                          value={state.draftChoice ?? 'skip'}
                          onChange={(e) => handleDraftChoiceChange(displayName, e.target.value)}
                        >
                          <MenuItem value="skip">skip</MenuItem>
                          {availableModels
                            .filter((m) => m.displayName !== displayName)
                            .map((m) => (
                              <MenuItem key={m.displayName} value={m.displayName}>
                                {m.displayName}
                              </MenuItem>
                            ))}
                        </Select>
                      </FormControl>
                    </Box>
                  )}

                  {showSpecDecoding && state.draftChoice && state.draftChoice !== 'skip' && (() => {
                    const draftDisplayName = state.draftChoice;
                    const draftAvail = availableByDisplayName[draftDisplayName];
                    const draftState = selection.modelStates[draftDisplayName];
                    if (!draftAvail || !draftState) return null;
                    return (
                      <Box sx={{ mt: 2 }}>
                        <ModelProfileRow
                          displayName={draftDisplayName}
                          avail={draftAvail}
                          rawEntry={checkpointMapping[draftDisplayName]}
                          state={draftState}
                          isDraftRow
                          onArchChange={(arch) => handleArchChange(draftDisplayName, arch)}
                          onProfileSelect={(profile) => handleProfileSelect(draftDisplayName, profile)}
                          onToggleExpand={() => handleToggleExpand(draftDisplayName)}
                        />
                      </Box>
                    );
                  })()}
                </Box>
              );
            })}
        </Paper>
      )}

      {/* Step 3: Override the selected profile's batching config */}
      {modelsWithResolvedProfile.length > 0 && (
        <Paper elevation={0} sx={{ p: 3, mb: 3, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 2 }}>
            3. Override Batching Configuration
          </Typography>
          {modelsWithResolvedProfile.map(({ displayName, state, profile }, idx) => (
            <Box key={displayName} sx={{ mb: idx < modelsWithResolvedProfile.length - 1 ? 3 : 0 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                {displayName}
              </Typography>
              <BatchingOverrideEditor
                editorKey={`${displayName}:${profile.metadata.name}`}
                override={state.override}
                onChange={(next) => handleOverrideChange(displayName, next)}
              />
            </Box>
          ))}
        </Paper>
      )}

      {/* Step 4: ModelBundle YAML */}
      {modelSelections && modelSelections.length > 0 && (
        <Paper elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 2 }}>
            4. Bundle YAML
          </Typography>

          <Box sx={{ mb: 2 }}>
            <TextField
              id={bundleNameId}
              fullWidth
              label="Bundle Name"
              value={bundleName}
              onChange={(e) => setBundleName(e.target.value)}
              helperText="Edit the bundle name (used for the ModelBundle resource)"
              variant="outlined"
              size="small"
            />
            {bundleName && bundleName !== bundleName.toLowerCase() && (
              <Typography variant="caption" sx={{ color: 'error.main', display: 'block', mt: 0.5 }}>
                Warning: Bundle name should be in lowercase
              </Typography>
            )}
          </Box>

          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                Generated YAML
              </Typography>
              <Tooltip title={copiedToClipboard ? 'Copied!' : 'Copy to clipboard'}>
                <IconButton
                  onClick={handleCopyToClipboard}
                  size="small"
                  disabled={!generatedYaml}
                  sx={{ color: copiedToClipboard ? 'success.main' : 'primary.main' }}
                >
                  <ContentCopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
            <Typography variant="body2" sx={{ mb: 1, color: 'text.secondary' }}>
              Please refer to our{' '}
              <a
                href="https://docs.sambanova.ai/docs/en/sambastack/service-administration/custom-bundle-deployment"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'inherit', textDecoration: 'underline' }}
              >
                documentation
              </a>{' '}
              for an explanation of fields in the YAML.
            </Typography>
            <TextField
              id={generatedYamlId}
              fullWidth
              multiline
              rows={25}
              value={generatedYaml}
              onChange={(e) => setGeneratedYaml(e.target.value)}
              variant="outlined"
              sx={{
                '& .MuiInputBase-root': {
                  fontFamily: 'monospace',
                  fontSize: '0.875rem',
                },
              }}
            />
          </Box>

          {/* Validation Result */}
          {validationResult && (
            <Box sx={{ mt: 2 }}>
              {validationResult.applyOutput && (
                <Box sx={{ mb: 2 }}>
                  <Typography variant="caption" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
                    kubectl apply output:
                  </Typography>
                  <Box
                    component="pre"
                    sx={{
                      p: 1.5,
                      bgcolor: 'rgba(0, 0, 0, 0.05)',
                      borderRadius: 1,
                      fontSize: '0.75rem',
                      overflow: 'auto',
                      maxHeight: '150px',
                    }}
                  >
                    {validationResult.applyOutput}
                  </Box>
                </Box>
              )}

              {validationResult.validationStatus && (
                <Box
                  sx={{
                    p: 2,
                    bgcolor: validationResult.validationStatus.isValid ? 'success.light' : 'error.dark',
                    color: validationResult.validationStatus.isValid ? 'success.contrastText' : 'white',
                    borderRadius: 1,
                  }}
                >
                  <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                    {validationResult.validationStatus.isValid
                      ? 'Validation succeeded!'
                      : 'Validation failed with the following errors:'}
                  </Typography>
                  {!validationResult.validationStatus.isValid && (
                    <Box>
                      {validationResult.validationStatus.legalizerInfo?.errors &&
                      validationResult.validationStatus.legalizerInfo.errors.length > 0 ? (
                        <Box
                          component="pre"
                          sx={{
                            mt: 1,
                            p: 1.5,
                            bgcolor: 'black',
                            color: 'white',
                            borderRadius: 1,
                            fontSize: '0.75rem',
                            overflow: 'auto',
                            maxHeight: '300px',
                            whiteSpace: 'pre-wrap',
                            wordWrap: 'break-word',
                          }}
                        >
                          {validationResult.validationStatus.legalizerInfo.errors.join('\n')}
                        </Box>
                      ) : (
                        <Box
                          component="pre"
                          sx={{
                            mt: 1,
                            p: 1.5,
                            bgcolor: 'black',
                            color: 'white',
                            borderRadius: 1,
                            fontSize: '0.75rem',
                            overflow: 'auto',
                            maxHeight: '300px',
                            whiteSpace: 'pre-wrap',
                            wordWrap: 'break-word',
                          }}
                        >
                          {validationResult.validationStatus.message}
                        </Box>
                      )}
                    </Box>
                  )}
                </Box>
              )}

              {!validationResult.validationStatus && !validationResult.success && (
                <Alert severity="error">
                  <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                    {validationResult.message}
                  </Typography>
                </Alert>
              )}
            </Box>
          )}

          {/* Memory Utilization Gauges */}
          {(() => {
            const utilization = validationResult?.validationStatus?.legalizerInfo?.utilization;
            const parseDDR = utilization?.ddr !== undefined ? parseFloat(utilization.ddr) : NaN;
            const parseHost = utilization?.host !== undefined ? parseFloat(utilization.host) : NaN;

            const Gauge = ({ value, label }: { value: number; label: string }) => {
              const isNaN_ = Number.isNaN(value);
              const pct = isNaN_ ? 0 : Math.min(Math.max(value, 0), 1);
              const displayLabel = isNaN_ ? '—' : `${(value * 100).toFixed(1)}%`;

              return (
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <Box sx={{ opacity: isValidating ? 0.4 : 1, transition: 'opacity 0.3s' }}>
                    <GaugeChart
                      id={`gauge-${label}`}
                      percent={isNaN_ ? 0 : pct}
                      nrOfLevels={2}
                      arcsLength={[0.8, 0.2]}
                      colors={['#2e7d32', '#b71c1c']}
                      arcWidth={0.3}
                      arcPadding={0.02}
                      needleColor="#aaaaaa"
                      needleBaseColor="#aaaaaa"
                      animate={false}
                      hideText={true}
                      style={{ width: 160 }}
                    />
                  </Box>
                  <Typography variant="body2" sx={{ fontWeight: 700, mt: -1, color: pct > 0.8 ? '#ef5350' : '#66bb6a' }}>
                    {displayLabel}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary', textAlign: 'center', fontWeight: 700 }}>
                    {label}
                  </Typography>
                </Box>
              );
            };

            return (
              <Tooltip title="Validate your bundle to refresh memory utilization stats" arrow>
                <Box sx={{ mt: 3, display: 'flex', gap: 4, justifyContent: 'center' }}>
                  <Gauge value={parseDDR} label="DDR Memory Utilization" />
                  <Gauge value={parseHost} label="Host Memory Utilization" />
                </Box>
              </Tooltip>
            );
          })()}

          {/* Save Result */}
          {saveResult && (
            <Box sx={{ mt: 2 }}>
              <Alert severity={saveResult.success ? 'success' : 'error'} onClose={() => setSaveResult(null)}>
                {saveResult.message}
              </Alert>
            </Box>
          )}

          {/* Validate, Save, and Create Deployment Buttons */}
          <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
            <Button
              variant="outlined"
              color="primary"
              size="large"
              onClick={handleValidate}
              disabled={isValidating || !generatedYaml}
              startIcon={isValidating ? <CircularProgress size={20} /> : null}
            >
              {isValidating ? 'Validating...' : 'Validate'}
            </Button>
            <Button
              variant="outlined"
              color="primary"
              size="large"
              onClick={handleSaveClick}
              disabled={isSaving || !generatedYaml || !bundleName}
              startIcon={isSaving ? <CircularProgress size={20} /> : <SaveIcon />}
            >
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
            <Button
              variant="contained"
              color="success"
              size="large"
              onClick={handleCreateDeployment}
              disabled={!validationResult?.validationStatus?.isValid}
              startIcon={<RocketLaunchIcon />}
            >
              Create Deployment
            </Button>
          </Box>
        </Paper>
      )}

      {/* Save Overwrite Confirmation Dialog */}
      <Dialog open={saveDialogOpen} onClose={handleCancelSave}>
        <DialogTitle>File Already Exists</DialogTitle>
        <DialogContent>
          <DialogContentText>
            A file named <strong>{bundleName}.yaml</strong> already exists in saved_artifacts. Do you want to overwrite
            it?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCancelSave} color="primary">
            Cancel
          </Button>
          <Button onClick={handleOverwrite} color="primary" variant="contained">
            Overwrite
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
