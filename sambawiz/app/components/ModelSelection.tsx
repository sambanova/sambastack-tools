'use client';

import { useState, useMemo, useEffect, useRef, Fragment } from 'react';
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
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  Collapse,
  RadioGroup,
  FormControlLabel,
  Radio,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import SaveIcon from '@mui/icons-material/Save';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
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
  formatModelRefLatest,
  parseTierKey,
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
  /** Advanced Options "Swappable" toggle. Defaults to true (undefined is treated as true); only `false` is emitted to the YAML. */
  swappable?: boolean;
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

/**
 * A profile uses prompt caching when its `spec.features` include
 * `prompt_caching`. Such profiles can only be deployed on their own (a
 * single-model bundle), so they're disabled once more than one model is
 * selected.
 */
function hasPromptCaching(profile: ModelProfile): boolean {
  return profile.spec.features?.includes('prompt_caching') ?? false;
}

/** Tooltip shown on a prompt_caching profile tile that's disabled because the bundle has more than one model. */
const PROMPT_CACHING_DISABLED_MESSAGE =
  'Profiles with prompt caching can only be deployed on their own (a single-model bundle). Remove the other selected models to choose this profile.';

/** A single profile card tile: display name (never metadata.name), effective batching tiers, and features. */
function ProfileCard({
  profile,
  siblingProfiles,
  selected,
  disabled = false,
  disabledTooltip,
  onSelect,
}: {
  profile: ModelProfile;
  siblingProfiles: ModelProfile[];
  selected: boolean;
  disabled?: boolean;
  disabledTooltip?: string;
  onSelect: () => void;
}) {
  const title = getDisplayName(profile, siblingProfiles);
  const batching = getEffectiveBatchingConfig(profile);
  // Sequence-length tiers, largest first, each reduced to its max supported batch size for a
  // compact "Context : Max Batch Size" summary. '*' means every batch size is supported.
  const tierRows = Object.entries(batching)
    .sort(([a], [b]) => parseTierKey(b) - parseTierKey(a))
    .map(([tier, cfg]) => {
      const maxBatchSize =
        cfg.batch_sizes === '*'
          ? 'All'
          : Array.isArray(cfg.batch_sizes) && cfg.batch_sizes.length > 0
            ? Math.max(...cfg.batch_sizes)
            : '—';
      return { tier, maxBatchSize };
    });
  const features = profile.spec.features ?? [];

  const card = (
    <Card
      variant="outlined"
      onClick={disabled ? undefined : onSelect}
      data-testid={`profile-card-${profile.metadata.name}`}
      aria-disabled={disabled || undefined}
      sx={{
        minWidth: 220,
        maxWidth: 260,
        flex: '0 0 auto',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
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
          {tierRows.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              No batching config
            </Typography>
          ) : (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'auto auto', columnGap: 2, rowGap: 0.25 }}>
              <Typography variant="caption" sx={{ fontWeight: 700 }}>
                Context
              </Typography>
              <Typography variant="caption" sx={{ fontWeight: 700, textAlign: 'right' }}>
                Max Batch Size
              </Typography>
              {tierRows.map(({ tier, maxBatchSize }) => (
                <Fragment key={tier}>
                  <Typography variant="caption">{tier}</Typography>
                  <Typography variant="caption" sx={{ textAlign: 'right' }}>
                    {maxBatchSize}
                  </Typography>
                </Fragment>
              ))}
            </Box>
          )}
        </Box>
        <Typography variant="caption" color="text.secondary">
          <Box component="span" sx={{ fontWeight: 700 }}>
            Special Features:
          </Box>{' '}
          {features.length === 0 ? 'none' : features.join(', ')}
        </Typography>
      </CardContent>
    </Card>
  );

  // When disabled, wrap in a Tooltip explaining the restriction. The Card keeps
  // pointer events (only its onClick is dropped), so hover still surfaces the tip.
  return disabled && disabledTooltip ? <Tooltip title={disabledTooltip}>{card}</Tooltip> : card;
}

/** Fixed batch-size columns for the override grid (plus a leading "All" column). */
const BATCH_COLUMNS = [1, 2, 4, 8, 16, 32, 64];

/**
 * Editable batching-config override for a single model, rendered as a checkbox grid.
 *
 * Rows are the profile's context-length tiers; columns are "All" + the batch-size columns up to
 * the largest batch size the profile supports anywhere (columns beyond that max are dropped, e.g.
 * a profile whose highest supported batch size is 32 never shows 64). A cell is supported only
 * when that batch size is supported for the tier by the profile (`universe` — the profile's
 * effective config, which is the complete universe of supported tiers × batch sizes); unsupported
 * cells render blank (no disabled checkbox). "All" reflects/controls every supported cell in its
 * row: checking it selects all supported (stored as `'*'`), and it auto-checks when every
 * supported cell is checked. The current selection lives in `override` and flows to the
 * generator; `is_default` is never exposed (auto-derived by the generator).
 */
function BatchingOverrideEditor({
  universe,
  override,
  onChange,
}: {
  universe: BatchingConfig;
  override: BatchingConfig;
  onChange: (next: BatchingConfig) => void;
}) {
  // Rows are ordered by descending context length (e.g. 192k, 128k, …, 8k).
  const tiers = Object.keys(universe).sort((a, b) => parseTierKey(b) - parseTierKey(a));

  if (tiers.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        This profile has no batching configuration to override.
      </Typography>
    );
  }

  // Batch sizes the profile supports for a tier, restricted to the fixed columns.
  const supportedFor = (tier: string): number[] => {
    const bs = universe[tier]?.batch_sizes;
    if (bs === '*' || bs === undefined) return [...BATCH_COLUMNS];
    return BATCH_COLUMNS.filter((c) => bs.includes(c));
  };

  // Largest batch size supported anywhere in this profile; columns beyond it are dropped entirely.
  const maxSupported = tiers.reduce((max, tier) => {
    const supported = supportedFor(tier);
    return supported.length > 0 ? Math.max(max, ...supported) : max;
  }, 0);
  const columns = BATCH_COLUMNS.filter((c) => c <= maxSupported);

  const setTier = (tier: string, batch_sizes: BatchingConfig[string]['batch_sizes']) => {
    onChange({ ...override, [tier]: { batch_sizes } });
  };

  return (
    <Table size="small" sx={{ width: 'auto', '& td, & th': { border: 0, px: 1, py: 0.25 } }}>
      <TableHead>
        <TableRow>
          <TableCell sx={{ fontWeight: 600 }}>Context</TableCell>
          <TableCell align="center" sx={{ fontWeight: 600 }}>All batch sizes</TableCell>
          {columns.map((c) => (
            <TableCell key={c} align="center" sx={{ fontWeight: 600 }}>{c}</TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {tiers.map((tier) => {
          const supported = supportedFor(tier);
          const bs = override[tier]?.batch_sizes;
          const isChecked = (c: number) => bs === '*' || (Array.isArray(bs) && bs.includes(c));
          const allChecked = supported.length > 0 && supported.every(isChecked);

          const toggleAll = (checked: boolean) => setTier(tier, checked ? '*' : []);

          const toggleCell = (c: number, checked: boolean) => {
            const current: number[] = bs === '*' ? [...supported] : Array.isArray(bs) ? [...bs] : [];
            const next = checked
              ? Array.from(new Set([...current, c])).sort((a, b) => a - b)
              : current.filter((x) => x !== c);
            // Collapse to '*' when every supported batch size is selected (All auto-checks).
            setTier(tier, supported.length > 0 && supported.every((s) => next.includes(s)) ? '*' : next);
          };

          return (
            <TableRow key={tier}>
              <TableCell sx={{ fontWeight: 600 }}>{tier}</TableCell>
              <TableCell align="center">
                <Checkbox
                  size="small"
                  checked={allChecked}
                  onChange={(e) => toggleAll(e.target.checked)}
                  inputProps={{ 'aria-label': `All batch sizes for ${tier}` }}
                />
              </TableCell>
              {columns.map((c) => {
                const enabled = supported.includes(c);
                return (
                  <TableCell key={c} align="center">
                    {enabled && (
                      <Checkbox
                        size="small"
                        checked={isChecked(c)}
                        onChange={(e) => toggleCell(c, e.target.checked)}
                        inputProps={{ 'aria-label': `Batch size ${c} for ${tier}` }}
                      />
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** One expandable row of profile card tiles for a single model (fixed header, horizontal-scroll tiles, single-select, collapse-on-select). Used for both top-level selections and spec-decoding draft models (rendered nested/indented). */
function ModelProfileRow({
  displayName,
  avail,
  rawEntry,
  state,
  isDraftRow,
  multiModelSelected,
  onArchChange,
  onProfileSelect,
  onToggleExpand,
}: {
  displayName: string;
  avail: AvailableModel;
  rawEntry: CheckpointMappingV3[string] | undefined;
  state: PerModelState;
  isDraftRow?: boolean;
  /** When more than one model is in the bundle, prompt_caching profiles are disabled (they can only deploy singly). */
  multiModelSelected: boolean;
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
          {matchingProfiles.map((profile) => {
            // prompt_caching profiles deploy only as a single-model bundle, so
            // they're greyed out (with an explanatory tooltip) once the bundle
            // holds more than one model.
            const disabled = multiModelSelected && hasPromptCaching(profile);
            return (
              <ProfileCard
                key={profile.metadata.name}
                profile={profile}
                siblingProfiles={matchingProfiles}
                selected={state.profileName === profile.metadata.name}
                disabled={disabled}
                disabledTooltip={disabled ? PROMPT_CACHING_DISABLED_MESSAGE : undefined}
                onSelect={() => onProfileSelect(profile)}
              />
            );
          })}
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
  // Optional checkpoint version pins from app-config.json `checkpoint_overrides`,
  // keyed by model display name. When set for a model, its ref uses this version
  // instead of the latest.
  const [checkpointOverrides, setCheckpointOverrides] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<BuilderSelectionState>({ selectedModels: [], modelStates: {} });
  const [bundleName, setBundleName] = useState<string>('bundle1');
  const [generatedYaml, setGeneratedYaml] = useState<string>('');
  const [isValidating, setIsValidating] = useState<boolean>(false);
  const [copiedToClipboard, setCopiedToClipboard] = useState<boolean>(false);
  const [overrideExpanded, setOverrideExpanded] = useState<boolean>(false);
  // Single-model flow: once a (non-spec-decoding) profile is picked we offer
  // "Deploy Model" (quick model+profile deploy) and "Advanced Settings". Clicking
  // "Advanced Settings" flips this and reveals Steps 3 & 4 (forcing the bundle
  // route). Ephemeral by design — never persisted to model-selection-state, so a
  // page refresh returns to the quick buttons; reset whenever the top-level model
  // selection changes.
  const [advancedMode, setAdvancedMode] = useState<boolean>(false);
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
        setCheckpointOverrides(result.checkpointOverrides ?? {});
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
      // Loading an existing bundle is inherently a bundle-route action — keep
      // Steps 3 & 4 (and the loaded YAML) visible even for a single-model bundle,
      // rather than collapsing into the single-model quick-deploy buttons.
      setAdvancedMode(true);
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
        swappable: entry.modelSettings?.swappable,
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
    // Changing the top-level model selection exits Advanced Settings (back to the
    // quick "Deploy Model" / "Advanced Settings" choice for single-model flows).
    setAdvancedMode(false);
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

  const handleSwappableChange = (displayName: string, swappable: boolean) => {
    setSelection((prev) => ({
      ...prev,
      modelStates: {
        ...prev.modelStates,
        [displayName]: { ...prev.modelStates[displayName], swappable },
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
        swappable: state.swappable,
        versionOverride: checkpointOverrides[displayName],
      };
      if (draftForMap[displayName]) {
        sel.isDraftFor = draftForMap[displayName];
      }
      selections.push(sel);
    }
    return selections;
  }, [selection, availableByDisplayName, checkpointMapping, checkpointOverrides]);

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

  // Top-level models (excluding nested spec-decoding draft entries) drive the
  // single- vs multi-model branch.
  const topLevelModels = selection.selectedModels.filter(
    (displayName) => !selection.modelStates[displayName]?.draftForDisplayName
  );
  const isSingleModel = topLevelModels.length === 1;

  // The bundle holds more than one model (multiple top-level selections, or a
  // spec-decoding target + its draft). prompt_caching profiles can't be part of
  // a multi-model bundle, so their tiles are disabled in this case.
  const multiModelSelected = selection.selectedModels.length > 1;

  // The single top-level model's fully-resolved selection (arch + profile), or
  // null until a profile is picked. `modelSelections` is null until every
  // selection resolves, and the top-level entry is the one without `isDraftFor`.
  const singleModelSelection = useMemo(
    () => (isSingleModel && modelSelections ? modelSelections.find((s) => !s.isDraftFor) ?? null : null),
    [isSingleModel, modelSelections]
  );
  const singleIsSpecDecoding = singleModelSelection
    ? isSpecDecodingProfile(singleModelSelection.profile)
    : false;

  // Quick-deploy buttons show for a single, non-spec-decoding model with a
  // resolved profile. Spec-decoding needs a target+draft pair, which the inline
  // single model+profile deployment can't express, so it's forced to the bundle
  // route (Steps 3 & 4). Steps 3 & 4 also show for multi-model or once the user
  // opts into Advanced Settings.
  const quickDeployAvailable = isSingleModel && !!singleModelSelection && !singleIsSpecDecoding;
  const showAdvancedSteps = advancedMode || !isSingleModel || singleIsSpecDecoding;

  // Quick "Deploy Model": hand the model ref + profile name to the Model
  // Deployment page, which generates the inline `spec.models` deployment.
  const handleDeployModel = () => {
    if (!singleModelSelection) return;
    const modelPath = formatModelRefLatest(
      singleModelSelection.model,
      singleModelSelection.arch,
      singleModelSelection.versionOverride
    );
    const profileName = singleModelSelection.profile.metadata.name;
    router.push(
      `/model-deployment?modelPath=${encodeURIComponent(modelPath)}&profileName=${encodeURIComponent(profileName)}`
    );
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
                {/* Model capabilities (e.g. text, vision) shown to the right of the name. */}
                {model.capabilities.length > 0 && (
                  <Box sx={{ display: 'flex', gap: 0.5, ml: 2, flexShrink: 0 }}>
                    {model.capabilities.map((capability) => (
                      <Chip key={capability} label={capability} size="small" variant="outlined" />
                    ))}
                  </Box>
                )}
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
                    multiModelSelected={multiModelSelected}
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
                          multiModelSelected={multiModelSelected}
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

          {/* Single-model action bar: quick model+profile deploy, or drop into
              Advanced Settings (Steps 3 & 4, the bundle route). */}
          {quickDeployAvailable && !advancedMode && (
            <Box sx={{ mt: 1, display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
              <Button
                variant="outlined"
                color="primary"
                size="large"
                onClick={() => setAdvancedMode(true)}
              >
                Advanced Settings
              </Button>
              <Button
                variant="contained"
                color="primary"
                size="large"
                startIcon={<RocketLaunchIcon />}
                onClick={handleDeployModel}
              >
                Create Deployment
              </Button>
            </Box>
          )}
        </Paper>
      )}

      {/* Step 3: Advanced Options — per-model batching-config override + swappable (optional, collapsed by default) */}
      {showAdvancedSteps && modelsWithResolvedProfile.length > 0 && (
        <Paper elevation={0} sx={{ p: 3, mb: 3, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
          <Box
            onClick={() => setOverrideExpanded((v) => !v)}
            sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
          >
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              3. Advanced Options
            </Typography>
            <IconButton
              size="small"
              aria-label={overrideExpanded ? 'Collapse advanced options' : 'Expand advanced options'}
              aria-expanded={overrideExpanded}
              onClick={(e) => { e.stopPropagation(); setOverrideExpanded((v) => !v); }}
            >
              <ExpandMoreIcon sx={{ transform: overrideExpanded ? 'rotate(180deg)' : 'none', transition: '0.2s' }} />
            </IconButton>
          </Box>
          <Collapse in={overrideExpanded} unmountOnExit>
            <Box sx={{ mt: 2 }}>
              {modelsWithResolvedProfile.map(({ displayName, state, profile }, idx) => (
                <Box key={displayName} sx={{ mb: idx < modelsWithResolvedProfile.length - 1 ? 4 : 0 }}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
                    {displayName}
                  </Typography>

                  {/* Subsection: Override Batching Config */}
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                      Override Batching Config
                    </Typography>
                    <Tooltip title="Choose from supported context lengths and batch sizes. If all batch sizes for a context length are unselected, then the context length will be removed from the deployment and the next higher context length with be used to service requests.">
                      <HelpOutlineIcon fontSize="small" sx={{ color: 'text.secondary', cursor: 'help' }} />
                    </Tooltip>
                  </Box>
                  <BatchingOverrideEditor
                    universe={getEffectiveBatchingConfig(profile)}
                    override={state.override}
                    onChange={(next) => handleOverrideChange(displayName, next)}
                  />

                  {/* Subsection: Swappable (default True; only emitted to the YAML when set to False) */}
                  <Box sx={{ mt: 2 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                        Swappable
                      </Typography>
                      <Tooltip title="Choose whether you would like this model to be swapped out for other models in the bundle when required or always keep it resident in high-bandwidth memory to avoid switching latencies.">
                        <HelpOutlineIcon fontSize="small" sx={{ color: 'text.secondary', cursor: 'help' }} />
                      </Tooltip>
                    </Box>
                    <RadioGroup
                      row
                      value={state.swappable === false ? 'false' : 'true'}
                      onChange={(e) => handleSwappableChange(displayName, e.target.value === 'true')}
                    >
                      <FormControlLabel value="true" control={<Radio size="small" />} label="True" />
                      <FormControlLabel value="false" control={<Radio size="small" />} label="False" />
                    </RadioGroup>
                  </Box>
                </Box>
              ))}
            </Box>
          </Collapse>
        </Paper>
      )}

      {/* Step 4: ModelBundle YAML */}
      {showAdvancedSteps && modelSelections && modelSelections.length > 0 && (
        <Paper elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 2 }}>
            4. Save & Validate Selections
          </Typography>

          <Box sx={{ mb: 2 }}>
            <TextField
              id={bundleNameId}
              fullWidth
              label="Bundle Name"
              value={bundleName}
              onChange={(e) => setBundleName(e.target.value)}
              helperText="The bundle name will be used to save your selections in a YAML file"
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
