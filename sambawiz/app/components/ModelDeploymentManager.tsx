'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Box,
  Paper,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Button,
  Alert,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  TextField,
  SelectChangeEvent,
  Collapse,
  IconButton,
  LinearProgress,
  Radio,
  RadioGroup,
  FormControlLabel,
  Checkbox,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import RocketLaunchIcon from '@mui/icons-material/RocketLaunch';
import SaveIcon from '@mui/icons-material/Save';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import Tooltip from '@mui/material/Tooltip';
import yaml from 'js-yaml';
import DocumentationPanel from './DocumentationPanel';
import { arePodNamesShortened } from '../utils/pod-name-limits';

/**
 * A deployed `ModelDeployment` CR summary, as returned by
 * `/api/model-deployment`. A deployment is either bundle-based (`bundle`, from
 * `spec.bundle`) or model-based (`model`, the referenced Model CR's display
 * name `spec.name` — resolved server-side since model-based deployments leave
 * `spec.bundle` empty).
 */
interface ModelDeploymentSummary {
  name: string;
  namespace: string;
  bundle: string;
  model?: string;
  creationTimestamp: string;
  status?: {
    conditions?: Array<{
      type: string;
      status: string;
      reason: string;
      message: string;
    }>;
  };
}

/**
 * A `ModelBundle` CR summary, as returned by `/api/model-bundles` — just
 * enough for the bundle picker (no `template`/`models` — those were V2
 * `Bundle` fields; v3 combines profiles via `modelConfigs`).
 */
interface ModelBundleSummary {
  name: string;
  namespace: string;
  creationTimestamp: string;
  isValid: boolean;
  validationReason: string;
  validationMessage: string;
  modelConfigs: Array<{ model: string; profile?: string }>;
}

interface PodStatusInfo {
  ready: number;
  total: number;
  status: string;
}

/**
 * The `ModelProfile` feature (`spec.features[]`) that gates prompt caching.
 * A deployment supports prompt caching when its selected profile — or, for a
 * bundle, any of the profiles its `modelConfigs` reference — lists this feature.
 */
const PROMPT_CACHING_FEATURE = 'prompt_caching';

/**
 * The `engineConfig.env_vars` that turn on prompt (KV) caching. Injected into
 * the deployment YAML's `spec.engineConfig` when the "Enable prompt caching"
 * box is checked. String values (not booleans) so they serialize as quoted
 * `"true"`, matching what the engine expects.
 */
const PROMPT_CACHING_ENV_VARS = {
  ENABLE_KV_CACHE_MANAGER: 'true',
  KV_CACHE_INCLUDE_STATS_IN_RESPONSE: 'true',
} as const;

/**
 * The features cache served by `/api/model-profiles` (the `model_profiles.json`
 * cache), keyed by ModelProfile `metadata.name`. Only `features` is needed here.
 */
type ModelProfileFeatures = Record<string, { features?: string[] }>;

/**
 * Determines the deployment status of a bundle based on its cache and default pod status.
 *
 * @param cachePod - The cache pod status information, or null if not found
 * @param defaultPod - The default pod status information, or null if not found
 * @returns "Deployed" if both pods are fully ready, "Deploying" if pods exist but not ready, "Not Deployed" if pods don't exist
 */
export function getBundleDeploymentStatus(
  cachePod: PodStatusInfo | null,
  defaultPod: PodStatusInfo | null
): "Deployed" | "Deploying" | "Not Deployed" {
  // If both pods are not found, the bundle is not deployed
  if (!cachePod && !defaultPod) {
    return "Not Deployed";
  }

  // If either pod exists but is not ready, the bundle is deploying
  if (cachePod && cachePod.ready < cachePod.total) {
    return "Deploying";
  }

  if (defaultPod && defaultPod.ready < defaultPod.total) {
    return "Deploying";
  }

  // If we have at least one pod and it's ready, check if both are ready
  const cacheReady = cachePod ? cachePod.ready === cachePod.total : false;
  const defaultReady = defaultPod ? defaultPod.ready === defaultPod.total : false;

  // Both pods are ready - fully deployed
  if (cacheReady && defaultReady) {
    return "Deployed";
  }

  // At least one pod exists but the other doesn't, or is not ready yet
  return "Deploying";
}

/**
 * Whether a status/logs probe error message indicates the expected pods are
 * genuinely not running (so the deployment should be reported as failed).
 *
 * A "not found" / "no resources" / "command failed" message normally means the
 * pods could not be scheduled or were deleted. The one important exception is a
 * logs probe that fails only because a container is still starting up
 * ("PodInitializing" / "ContainerCreating" — e.g. `container "inf" ... is
 * waiting to start: PodInitializing`). That is the normal early state of a fresh
 * deployment, not a failure, so it is explicitly excluded. Genuine failures such
 * as CrashLoopBackOff, ImagePullBackOff or "not found" are still reported.
 *
 * @param msg - The probe error message, or null when the probe succeeded
 */
export function isPodProbeFailure(msg: string | null): boolean {
  if (!msg) return false;
  if (/podinitializing|containercreating/i.test(msg)) return false;
  return /not\s*found|no resources|command failed/i.test(msg);
}

export default function ModelDeploymentManager() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // Model-source query params. When BOTH are present the page deploys a single
  // model + named profile inline (`spec.models`) instead of referencing a
  // ModelBundle CR. `modelPath` is a "<ModelCRname>[:<arch>][:<version>]" ref and
  // `profileName` is a ModelProfile's metadata.name. The Model Selection page
  // will later redirect here with these set.
  const modelPath = searchParams.get('modelPath');
  const profileName = searchParams.get('profileName');
  const hasModelParams = Boolean(modelPath && profileName);

  // Section 2 source selector: deploy an individual "model" (+ profile) or a
  // "bundle". Defaults to "model" only when both model params are present.
  const [deployMode, setDeployMode] = useState<'model' | 'bundle'>(
    hasModelParams ? 'model' : 'bundle'
  );
  // One-time reminder shown when arriving from the Model Selection page's
  // "Create Deployment" (model+profile) flow, before the user deploys.
  const [showModelDeployNotice, setShowModelDeployNotice] = useState<boolean>(false);
  const [bundleDeployments, setBundleDeployments] = useState<ModelDeploymentSummary[]>([]);
  const [deploymentToDelete, setDeploymentToDelete] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState<boolean>(false);
  const [deleting, setDeleting] = useState<boolean>(false);

  // Section 2: Deploy a Model Bundle
  const [validBundles, setValidBundles] = useState<ModelBundleSummary[]>([]);
  const [selectedBundle, setSelectedBundle] = useState<string>('');
  const [deploymentName, setDeploymentName] = useState<string>('');
  const [loadingBundles, setLoadingBundles] = useState<boolean>(false);
  const [deploymentYaml, setDeploymentYaml] = useState<string>('');
  // ModelProfile features (from /api/model-profiles), used to decide whether the
  // current model/bundle supports prompt caching. `enablePromptCaching` is the
  // "Enable prompt caching" checkbox; it resets on each new model/bundle
  // selection and injects `engineConfig.env_vars` into the YAML when checked.
  const [modelProfileFeatures, setModelProfileFeatures] = useState<ModelProfileFeatures>({});
  const [enablePromptCaching, setEnablePromptCaching] = useState<boolean>(false);
  const [copiedYaml, setCopiedYaml] = useState<boolean>(false);
  const [deploying, setDeploying] = useState<boolean>(false);
  const [deploymentResult, setDeploymentResult] = useState<{
    success: boolean;
    message: string;
    output?: string;
  } | null>(null);
  // Operator-derived pod names previewed in the long-name warning. The operator
  // truncates+hashes long names using server-only crypto, so these are resolved
  // by /api/predicted-pod-names rather than computed in the client bundle.
  const [predictedPodNames, setPredictedPodNames] = useState<{ cache: string; default: string } | null>(null);

  // Section 3: Check Deployment Status
  const [podLogs, setPodLogs] = useState<string>('');
  const [podLogsError, setPodLogsError] = useState<string | null>(null);
  const [defaultPodLogs, setDefaultPodLogs] = useState<string>('');
  const [defaultPodLogsError, setDefaultPodLogsError] = useState<string | null>(null);
  const [monitoredDeployment, setMonitoredDeployment] = useState<string>('');
  const [showCacheLogs, setShowCacheLogs] = useState<boolean>(false);
  const [showDefaultLogs, setShowDefaultLogs] = useState<boolean>(false);
  const [podStatus, setPodStatus] = useState<{
    cachePod: { ready: number; total: number; status: string } | null;
    defaultPod: { ready: number; total: number; status: string } | null;
  }>({ cachePod: null, defaultPod: null });
  const [podStatusError, setPodStatusError] = useState<string | null>(null);
  // Actual operator-derived pod names for the monitored deployment. The operator
  // truncates+hashes long names, so these can differ from `inf-<name>-...`.
  // Resolved server-side and returned by /api/pod-status.
  const [podNames, setPodNames] = useState<{ cache: string; default: string } | null>(null);
  const [allDeploymentStatuses, setAllDeploymentStatuses] = useState<Record<string, {
    cachePod: PodStatusInfo | null;
    defaultPod: PodStatusInfo | null;
  }>>({});
  // Names of deployments just kicked off via the Deploy button — shown as "Deploying"
  // in Section 1 until kubectl actually reports their pods.
  const [pendingDeployingNames, setPendingDeployingNames] = useState<Set<string>>(new Set());

  // Save functionality
  const [saveDialogOpen, setSaveDialogOpen] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);

  // Resolve the operator's shortened pod names for the long-name warning. Only
  // fetch when the name is actually long enough to be truncated, and debounce so
  // we don't hit the endpoint on every keystroke.
  useEffect(() => {
    if (!arePodNamesShortened(deploymentName)) {
      setPredictedPodNames(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/predicted-pod-names?deploymentName=${encodeURIComponent(deploymentName)}`
        );
        const data = await response.json();
        if (!cancelled && data.success && data.podNames) {
          setPredictedPodNames(data.podNames);
        }
      } catch {
        if (!cancelled) setPredictedPodNames(null);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deploymentName]);

  // Fetch pod status for all deployments
  const fetchAllDeploymentStatuses = async (deployments: ModelDeploymentSummary[]) => {
    const statuses: Record<string, {
      cachePod: PodStatusInfo | null;
      defaultPod: PodStatusInfo | null;
    }> = {};

    // Fetch status for each deployment in parallel
    await Promise.all(
      deployments.map(async (deployment) => {
        try {
          const response = await fetch(`/api/pod-status?deploymentName=${deployment.name}`);
          const data = await response.json();

          if (data.success) {
            statuses[deployment.name] = data.podStatus;
          } else {
            statuses[deployment.name] = { cachePod: null, defaultPod: null };
          }
        } catch {
          statuses[deployment.name] = { cachePod: null, defaultPod: null };
        }
      })
    );

    setAllDeploymentStatuses(statuses);
  };

  // Fetch model deployments (always a fresh kubectl call — never cached)
  const fetchBundleDeployments = async () => {
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const response = await fetch('/api/model-deployment');
      const data = await response.json();

      if (data.success) {
        setBundleDeployments(data.bundleDeployments);
        // Fetch pod statuses for all deployments
        await fetchAllDeploymentStatuses(data.bundleDeployments);
      } else {
        setError(data.error || 'Failed to fetch model deployments');
      }
    } catch (err) {
      setError('Failed to connect to the server');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // Load model deployments on mount
  useEffect(() => {
    fetchBundleDeployments();
    fetchBundles();
    fetchModelProfileFeatures();
    // Skip loading saved state if a bundle (or a model+profile) is specified in
    // the URL query params — those drive the form instead of the saved state.
    if (!searchParams.get('bundle') && !hasModelParams) {
      loadSavedState();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load saved state from backend
  const loadSavedState = async () => {
    try {
      const response = await fetch('/api/model-deployment-state');
      const data = await response.json();
      if (data.success && data.state) {
        // Restore the saved state
        setSelectedBundle(data.state.selectedBundle || '');
        setDeploymentName(data.state.deploymentName || '');
        setDeploymentYaml(data.state.deploymentYaml || '');
        setMonitoredDeployment(data.state.monitoredDeployment || '');
        // Reflect prompt caching if the restored YAML already carries the env var.
        setEnablePromptCaching(
          (data.state.deploymentYaml || '').includes('ENABLE_KV_CACHE_MANAGER')
        );
      }
    } catch (error) {
      console.error('Failed to load saved deployment state:', error);
    }
  };

  // Handle query parameter for pre-selecting a bundle
  useEffect(() => {
    const bundleParam = searchParams.get('bundle');
    if (bundleParam && validBundles.length > 0) {
      // Check if the bundle from the query parameter exists in valid bundles
      const bundleExists = validBundles.some((bundle) => bundle.name === bundleParam);
      if (bundleExists) {
        // Reset section 3 (hide it by clearing monitoredDeployment)
        setMonitoredDeployment('');

        // Reset section 2 based on the bundle in the query string
        setSelectedBundle(bundleParam);

        // Auto-suggest deployment name
        let suggestedName = '';
        if (bundleParam.startsWith('b-')) {
          suggestedName = bundleParam.replace('b-', 'md-');
        } else {
          suggestedName = `md-${bundleParam}`;
        }
        setDeploymentName(suggestedName);

        // New selection → prompt caching starts unchecked.
        setEnablePromptCaching(false);

        // Generate YAML
        const yaml = generateDeploymentYaml(bundleParam, suggestedName);
        setDeploymentYaml(yaml);

        // Clear deployment result to start fresh
        setDeploymentResult(null);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, validBundles]);

  // Handle query params for deploying an individual model + profile. When both
  // `modelPath` and `profileName` are present, generate a `spec.models` inline
  // deployment (no ModelBundle CR) and default the source selector to "model".
  useEffect(() => {
    if (modelPath && profileName) {
      // Reset section 3 (hide it by clearing monitoredDeployment)
      setMonitoredDeployment('');

      setDeployMode('model');

      // Auto-suggest deployment name from the model CR name (strip any
      // ":arch"/":version" suffix), e.g. "md-minimax-m2-7".
      const suggestedName = deriveModelDeploymentName(modelPath);
      setDeploymentName(suggestedName);

      // New selection → prompt caching starts unchecked.
      setEnablePromptCaching(false);

      // Generate YAML
      setDeploymentYaml(
        generateModelDeploymentYaml(modelPath, profileName, suggestedName)
      );

      // Clear deployment result to start fresh
      setDeploymentResult(null);

      // Remind the user to check for active deployments and review the YAML
      // before deploying this model+profile.
      setShowModelDeployNotice(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelPath, profileName]);

  // Returns next poll delay based on how long the last fetch took:
  // elapsed < 6s → 6s, elapsed < 12s → 12s, else 24s
  const adaptiveDelay = (elapsedMs: number) => {
    if (elapsedMs < 6000) return 6000;
    if (elapsedMs < 12000) return 12000;
    return 24000;
  };

  // Auto-refresh cache pod logs with adaptive back-off
  useEffect(() => {
    if (!monitoredDeployment) {
      setPodLogs('');
      setPodLogsError(null);
      return;
    }

    const active = { current: true };
    let timeoutId: ReturnType<typeof setTimeout>;

    const run = async () => {
      if (!active.current) return;
      const start = Date.now();
      try {
        // Let the server resolve the actual (possibly truncated+hashed) pod name.
        const response = await fetch(`/api/pod-logs?deploymentName=${monitoredDeployment}&type=cache&lines=5`);
        const data = await response.json();
        if (data.success) {
          setPodLogs(data.logs);
          setPodLogsError(null);
        } else {
          setPodLogsError(data.message || 'Failed to fetch logs');
        }
      } catch {
        setPodLogsError('Failed to connect to the server');
      }
      if (active.current) {
        timeoutId = setTimeout(run, adaptiveDelay(Date.now() - start));
      }
    };

    run();
    return () => {
      active.current = false;
      clearTimeout(timeoutId);
    };
  }, [monitoredDeployment]);

  // Auto-refresh default pod logs with adaptive back-off
  useEffect(() => {
    if (!monitoredDeployment) {
      setDefaultPodLogs('');
      setDefaultPodLogsError(null);
      return;
    }

    const active = { current: true };
    let timeoutId: ReturnType<typeof setTimeout>;

    const run = async () => {
      if (!active.current) return;
      const container = 'inf';
      const start = Date.now();
      try {
        const response = await fetch(`/api/pod-logs?deploymentName=${monitoredDeployment}&type=default&lines=5&container=${container}`);
        const data = await response.json();
        if (data.success) {
          const logs = data.logs.trim();
          const lastWord = logs.split(/\s+/).pop();
          if (lastWord === 'PodInitializing') {
            setDefaultPodLogs('Pod Initializing... Waiting to show logs');
          } else {
            setDefaultPodLogs(logs);
          }
          setDefaultPodLogsError(null);
        } else {
          setDefaultPodLogsError(data.message || 'Failed to fetch logs');
        }
      } catch {
        setDefaultPodLogsError('Failed to connect to the server');
      }
      if (active.current) {
        timeoutId = setTimeout(run, adaptiveDelay(Date.now() - start));
      }
    };

    run();
    return () => {
      active.current = false;
      clearTimeout(timeoutId);
    };
  }, [monitoredDeployment]);

  // Track which deployment we've already auto-refreshed Section 1 for, to avoid re-firing
  const completedRefreshRef = useRef<string>('');

  // Once kubectl reports pods for a pending deployment, drop the optimistic override
  useEffect(() => {
    setPendingDeployingNames((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set(prev);
      for (const name of prev) {
        const info = allDeploymentStatuses[name];
        if (info && (info.cachePod || info.defaultPod)) {
          next.delete(name);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [allDeploymentStatuses]);

  // When the monitored deployment becomes fully ready, auto-refresh Section 1 once
  useEffect(() => {
    if (!monitoredDeployment) {
      completedRefreshRef.current = '';
      return;
    }
    const { cachePod, defaultPod } = podStatus;
    if (
      cachePod &&
      defaultPod &&
      cachePod.ready === cachePod.total &&
      defaultPod.ready === defaultPod.total &&
      completedRefreshRef.current !== monitoredDeployment
    ) {
      completedRefreshRef.current = monitoredDeployment;
      fetchBundleDeployments();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [podStatus, monitoredDeployment]);

  // Auto-refresh pod status with adaptive back-off
  useEffect(() => {
    if (!monitoredDeployment) {
      setPodStatus({ cachePod: null, defaultPod: null });
      setPodStatusError(null);
      setPodNames(null);
      return;
    }

    const active = { current: true };
    let timeoutId: ReturnType<typeof setTimeout>;

    const run = async () => {
      if (!active.current) return;
      const start = Date.now();
      try {
        const response = await fetch(`/api/pod-status?deploymentName=${monitoredDeployment}`);
        const data = await response.json();
        // The route returns the resolved pod names regardless of success, so the
        // UI can display the real (possibly truncated+hashed) names.
        if (data.podNames) setPodNames(data.podNames);
        if (data.success) {
          setPodStatus(data.podStatus);
          setPodStatusError(null);
        } else {
          // kubectl failed (e.g. cluster unreachable / auth). Drop any stale
          // status so the UI can't keep reporting pods as ready, and surface
          // the error in the overall status instead.
          setPodStatus({ cachePod: null, defaultPod: null });
          setPodStatusError(data.stderr || data.message || data.error || 'Failed to fetch pod status');
        }
      } catch (err) {
        console.error('Failed to fetch pod status:', err);
        setPodStatus({ cachePod: null, defaultPod: null });
        setPodStatusError('Failed to connect to the server');
      }
      if (active.current) {
        timeoutId = setTimeout(run, adaptiveDelay(Date.now() - start));
      }
    };

    run();
    return () => {
      active.current = false;
      clearTimeout(timeoutId);
    };
  }, [monitoredDeployment]);

  // Fetch bundles (always a fresh kubectl call — never cached)
  const fetchBundles = async () => {
    setLoadingBundles(true);

    try {
      const response = await fetch('/api/model-bundles');
      const data = await response.json();

      if (data.success) {
        // Filter to only valid bundles
        const valid = data.bundles.filter((b: ModelBundleSummary) => b.isValid);
        setValidBundles(valid);
      } else {
        console.error('Failed to fetch bundles:', data.error);
      }
    } catch (err) {
      console.error('Failed to connect to the server', err);
    } finally {
      setLoadingBundles(false);
    }
  };

  // Fetch the ModelProfile features cache (used to decide prompt-caching
  // support). Missing/empty cache is fine — the checkbox just stays hidden.
  const fetchModelProfileFeatures = async () => {
    try {
      const response = await fetch('/api/model-profiles');
      const data = await response.json();
      if (data.success && data.data && typeof data.data === 'object') {
        setModelProfileFeatures(data.data as ModelProfileFeatures);
      }
    } catch (err) {
      console.error('Failed to fetch model profiles:', err);
    }
  };

  // A ModelProfile supports prompt caching when its `features` includes
  // `prompt_caching` (see the ModelProfile example in the deployment docs).
  const profileHasPromptCaching = (profile?: string): boolean =>
    Boolean(profile && modelProfileFeatures[profile]?.features?.includes(PROMPT_CACHING_FEATURE));

  // Whether the currently-selected model/bundle supports prompt caching, which
  // gates the "Enable prompt caching" checkbox. In "model" mode we check the
  // single selected profile; in "bundle" mode, any profile the bundle references.
  const promptCachingAvailable = useMemo(() => {
    if (deployMode === 'model') {
      return profileHasPromptCaching(profileName || undefined);
    }
    const bundle = validBundles.find((b) => b.name === selectedBundle);
    return Boolean(bundle?.modelConfigs?.some((mc) => profileHasPromptCaching(mc.profile)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deployMode, profileName, selectedBundle, validBundles, modelProfileFeatures]);

  /**
   * Parse `deploymentYaml` and add or remove the prompt-caching
   * `engineConfig.env_vars` (see PROMPT_CACHING_ENV_VARS), preserving any other
   * edits the user has made. Used when the checkbox is toggled so we don't
   * regenerate the whole document (and lose those edits). `env_vars` is written
   * first within `engineConfig` for readability; when disabling, only the two
   * caching vars are removed (and `env_vars` is dropped if that empties it).
   */
  const applyPromptCaching = (yamlStr: string, enabled: boolean): string => {
    if (!yamlStr.trim()) return yamlStr;
    try {
      const doc = yaml.load(yamlStr) as { spec?: { engineConfig?: Record<string, unknown> } };
      if (!doc || typeof doc !== 'object') return yamlStr;
      doc.spec = doc.spec || {};
      const engineConfig = { ...(doc.spec.engineConfig || {}) };
      const existingEnv = { ...(engineConfig.env_vars as Record<string, string> | undefined) };

      if (enabled) {
        // Keep any user-added env vars; ensure the caching vars are set to ours.
        engineConfig.env_vars = { ...existingEnv, ...PROMPT_CACHING_ENV_VARS };
      } else {
        delete existingEnv.ENABLE_KV_CACHE_MANAGER;
        delete existingEnv.KV_CACHE_INCLUDE_STATS_IN_RESPONSE;
        if (Object.keys(existingEnv).length > 0) {
          engineConfig.env_vars = existingEnv;
        } else {
          delete engineConfig.env_vars;
        }
      }

      // Rebuild engineConfig with env_vars first (if present), then the rest.
      const { env_vars, ...restEngineConfig } = engineConfig;
      doc.spec.engineConfig = {
        ...(env_vars ? { env_vars } : {}),
        ...restEngineConfig,
      };
      return yaml.dump(doc, { lineWidth: -1, quotingType: '"' }).trimEnd();
    } catch {
      return yamlStr;
    }
  };

  // Toggle prompt caching: flip the checkbox and patch the current YAML in place.
  const handleTogglePromptCaching = (checked: boolean) => {
    setEnablePromptCaching(checked);
    setDeploymentYaml((current) => applyPromptCaching(current, checked));
  };

  /**
   * Generate a `ModelDeployment` document (replaces the old hand-built
   * `BundleDeployment` template-literal string). Serialized with `js-yaml`'s
   * `dump()` rather than manual indentation.
   *
   * Per v3plan.md Q6, SambaWiz always references the bundle by name
   * (`spec.bundle`) — never inline `spec.models`. All other deployment
   * knobs (`groups`, `owner`, `secretNames`, `engineConfig`, etc.) carry
   * over unchanged from the V2 `BundleDeployment` defaults.
   */
  // Build the `spec.engineConfig`, prepending the prompt-caching env vars when
  // requested (env_vars first for readability, then the default startupTimeout).
  const buildEngineConfig = (withPromptCaching: boolean) => ({
    ...(withPromptCaching ? { env_vars: { ...PROMPT_CACHING_ENV_VARS } } : {}),
    startupTimeout: 7200,
  });

  const generateDeploymentYaml = (
    bundleName: string,
    deploymentName: string,
    withPromptCaching = false
  ): string => {
    const modelDeployment = {
      apiVersion: 'sambanova.ai/v1alpha1',
      kind: 'ModelDeployment',
      metadata: {
        name: deploymentName,
      },
      spec: {
        bundle: bundleName,
        groups: [
          {
            minReplicas: 1,
            name: 'default',
            qosList: ['free'],
          },
        ],
        owner: 'no-reply@sambanova.ai',
        secretNames: ['sambanova-artifact-reader'],
        engineConfig: buildEngineConfig(withPromptCaching),
      },
    };

    return yaml.dump(modelDeployment, { lineWidth: -1, quotingType: '"' }).trimEnd();
  };

  /**
   * Derive a deployment name from a model ref. Strips the optional
   * ":arch"/":version" suffix from "<ModelCRname>[:<arch>][:<version>]" and
   * prefixes "md-", e.g. "minimax-m2-7:minimax-m2p5:1" → "md-minimax-m2-7".
   */
  const deriveModelDeploymentName = (modelRef: string): string => {
    const crname = modelRef.split(':')[0];
    return `md-${crname}`.toLowerCase();
  };

  /**
   * Generate a `ModelDeployment` document that inlines a single model + named
   * profile via `spec.models` (rather than referencing a ModelBundle CR).
   * `modelRef` is a "<ModelCRname>[:<arch>][:<version>]" ref and `profile` is a
   * ModelProfile's metadata.name. All other deployment knobs match the
   * bundle-based `generateDeploymentYaml`.
   */
  const generateModelDeploymentYaml = (
    modelRef: string,
    profile: string,
    deploymentName: string,
    withPromptCaching = false
  ): string => {
    const modelDeployment = {
      apiVersion: 'sambanova.ai/v1alpha1',
      kind: 'ModelDeployment',
      metadata: {
        name: deploymentName,
      },
      spec: {
        models: {
          modelConfigs: [
            {
              model: modelRef,
              profile: profile,
            },
          ],
        },
        groups: [
          {
            minReplicas: 1,
            name: 'default',
            qosList: ['free'],
          },
        ],
        owner: 'no-reply@sambanova.ai',
        secretNames: ['sambanova-artifact-reader'],
        engineConfig: buildEngineConfig(withPromptCaching),
      },
    };

    return yaml.dump(modelDeployment, { lineWidth: -1, quotingType: '"' }).trimEnd();
  };

  /**
   * Handle the source selector (radio) between "model" and "bundle". Selecting
   * "model" without both model params in the URL sends the user to the Model
   * Selection page to pick a model + profile (which will redirect back here
   * with `modelPath` and `profileName` set).
   */
  const handleDeployModeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const mode = event.target.value as 'model' | 'bundle';

    if (mode === 'model' && !hasModelParams) {
      router.push('/model-selection');
      return;
    }

    setDeployMode(mode);
    // Switching source → prompt caching starts unchecked.
    setEnablePromptCaching(false);

    if (mode === 'model' && modelPath && profileName) {
      const suggestedName = deriveModelDeploymentName(modelPath);
      setDeploymentName(suggestedName);
      setDeploymentYaml(
        generateModelDeploymentYaml(modelPath, profileName, suggestedName)
      );
    }
  };

  // Handle bundle selection
  const handleBundleChange = (event: SelectChangeEvent<string>) => {
    const bundleName = event.target.value;
    setSelectedBundle(bundleName);

    // New selection → prompt caching starts unchecked.
    setEnablePromptCaching(false);

    // Auto-suggest deployment name
    let suggestedName = '';
    if (bundleName) {
      if (bundleName.startsWith('b-')) {
        suggestedName = bundleName.replace('b-', 'md-');
      } else {
        suggestedName = `md-${bundleName}`;
      }
      setDeploymentName(suggestedName);

      // Generate YAML
      const yaml = generateDeploymentYaml(bundleName, suggestedName);
      setDeploymentYaml(yaml);
    } else {
      setDeploymentName('');
      setDeploymentYaml('');
    }
  };

  // Handle deployment name change
  const handleDeploymentNameChange = (newName: string) => {
    setDeploymentName(newName);

    // Regenerate YAML with new deployment name, preserving the prompt-caching
    // choice (only meaningful when the selection actually supports it).
    const withPromptCaching = enablePromptCaching && promptCachingAvailable;
    if (deployMode === 'model' && modelPath && profileName && newName) {
      setDeploymentYaml(
        generateModelDeploymentYaml(modelPath, profileName, newName, withPromptCaching)
      );
    } else if (selectedBundle && newName) {
      const yaml = generateDeploymentYaml(selectedBundle, newName, withPromptCaching);
      setDeploymentYaml(yaml);
    }
  };

  // Handle copy YAML to clipboard
  const handleCopyYaml = async () => {
    try {
      await navigator.clipboard.writeText(deploymentYaml);
      setCopiedYaml(true);
      setTimeout(() => setCopiedYaml(false), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  // Handle deploy
  const handleDeploy = async () => {
    if (!deploymentYaml) return;

    setDeploying(true);
    setDeploymentResult(null);

    // Save the current state before deploying
    try {
      await fetch('/api/model-deployment-state', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state: {
            selectedBundle,
            deploymentName,
            deploymentYaml,
            monitoredDeployment: deploymentName, // Set this to the deployment name we're about to deploy
          },
        }),
      });
    } catch (error) {
      console.error('Failed to save deployment state:', error);
      // Continue with deployment even if state save fails
    }

    try {
      const response = await fetch('/api/deploy-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: deploymentYaml }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setDeploymentResult({
          success: true,
          message: 'Model deployment applied successfully!',
          output: data.output,
        });
        // Set the monitored deployment to start log monitoring
        setMonitoredDeployment(deploymentName);
        // Mark as pending so Section 1 shows "Deploying" even before pods are visible
        setPendingDeployingNames((prev) => {
          const next = new Set(prev);
          next.add(deploymentName);
          return next;
        });
        // Refresh the model deployments list
        await fetchBundleDeployments();
      } else {
        setDeploymentResult({
          success: false,
          message: data.error || 'Deployment failed',
          output: data.stderr || data.stdout || data.message || '',
        });
      }
    } catch (err) {
      setDeploymentResult({
        success: false,
        message: 'Failed to connect to deployment service',
        output: err instanceof Error ? err.message : 'Unknown error',
      });
    } finally {
      setDeploying(false);
    }
  };

  // Open delete confirmation dialog for a specific deployment
  const handleDeleteClick = (name: string) => {
    setDeploymentToDelete(name);
    setDeleteDialogOpen(true);
  };

  // Close delete confirmation dialog
  const handleDeleteCancel = () => {
    setDeleteDialogOpen(false);
    setDeploymentToDelete(null);
  };

  // Confirm deletion
  const handleDeleteConfirm = async () => {
    if (!deploymentToDelete) return;

    setDeleteDialogOpen(false);
    setDeleting(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const response = await fetch('/api/model-deployment', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: deploymentToDelete }),
      });

      const data = await response.json();

      if (data.success) {
        setSuccessMessage(`Successfully deleted ${deploymentToDelete}`);
        // If the deleted deployment is being monitored, clear it
        if (monitoredDeployment === deploymentToDelete) {
          setMonitoredDeployment('');
        }
        // Clear playground state if it references the deleted deployment
        try {
          const stateResponse = await fetch('/api/playground-state');
          const stateData = await stateResponse.json();
          if (stateData.success && stateData.state?.selectedDeployment === deploymentToDelete) {
            await fetch('/api/playground-state', { method: 'DELETE' });
          }
        } catch {
          // Non-critical — ignore errors
        }
      } else {
        setError(`Failed to delete ${deploymentToDelete}: ${data.error}`);
      }

      // Refresh the list
      await fetchBundleDeployments();
    } catch (err) {
      setError('Failed to delete model deployment');
      console.error(err);
    } finally {
      setDeleting(false);
      setDeploymentToDelete(null);
    }
  };

  // Handle status button click
  const handleStatusClick = (name: string) => {
    setMonitoredDeployment(name);
  };

  // Get deployment status display using pod status
  const getStatusDisplay = (deployment: ModelDeploymentSummary) => {
    const podStatusInfo = allDeploymentStatuses[deployment.name];

    if (!podStatusInfo) {
      return { text: 'Loading...', color: 'text.secondary' };
    }

    const status = getBundleDeploymentStatus(
      podStatusInfo.cachePod,
      podStatusInfo.defaultPod
    );

    // If we just kicked off this deployment, pods may not be visible yet —
    // surface "Deploying" instead of "Not Deployed" until kubectl catches up.
    if (status === 'Not Deployed' && pendingDeployingNames.has(deployment.name)) {
      return { text: 'Deploying', color: 'warning.main' };
    }

    switch (status) {
      case 'Deployed':
        return { text: 'Deployed', color: 'success.main' };
      case 'Deploying':
        return { text: 'Deploying', color: 'warning.main' };
      case 'Not Deployed':
        return { text: 'Not Deployed', color: 'text.secondary' };
      default:
        return { text: 'Unknown', color: 'text.secondary' };
    }
  };

  // Handle save button click
  const handleSaveClick = () => {
    setSaveResult(null);
    setSaveDialogOpen(false);
    handleSaveFile(false);
  };

  // Handle save file
  const handleSaveFile = async (overwrite: boolean) => {
    if (!deploymentYaml || !deploymentName) return;

    setIsSaving(true);
    setSaveResult(null);

    const fileName = `${deploymentName}.yaml`;

    try {
      const endpoint = '/api/save-artifact';
      const method = overwrite ? 'PUT' : 'POST';

      const response = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, content: deploymentYaml }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        setSaveResult({
          success: true,
          message: `Model deployment saved successfully to saved_artifacts/${fileName}`,
        });
      } else if (response.status === 409 && data.fileExists) {
        // File exists, show overwrite dialog
        setSaveDialogOpen(true);
      } else {
        setSaveResult({
          success: false,
          message: data.error || 'Failed to save model deployment',
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

  // Handle overwrite confirmation
  const handleOverwrite = () => {
    setSaveDialogOpen(false);
    handleSaveFile(true);
  };

  // Handle cancel save
  const handleCancelSave = () => {
    setSaveDialogOpen(false);
    setSaveResult(null);
  };

  // Shared editor (deployment name + generated YAML + results + actions), used
  // by both the "model" and "bundle" source modes once a source is selected.
  const deploymentEditor = (
    <Box>
      <TextField
        fullWidth
        label="Deployment Name"
        value={deploymentName}
        onChange={(e) => handleDeploymentNameChange(e.target.value)}
        helperText="Enter the name for this model deployment (e.g., md-your-bundle-name)"
        variant="outlined"
        sx={{ mb: 3 }}
      />
      {deploymentName && deploymentName !== deploymentName.toLowerCase() && (
        <Typography variant="caption" sx={{ color: 'error.main', display: 'block', mt: -2, mb: 2 }}>
          Warning: Deployment name should be in lowercase
        </Typography>
      )}
      {arePodNamesShortened(deploymentName) && (
        <Typography variant="caption" sx={{ color: 'warning.main', display: 'block', mt: -2, mb: 2 }}>
          Warning: This name is long enough that the operator will shorten the pod
          names (truncate + hash) to satisfy Kubernetes naming limits. The deployment
          name itself is unchanged, but the pod names will be shortened as follows:
          {(() => {
            if (!predictedPodNames) return ' (resolving…)';
            // Only surface pods the operator actually shortened — compare
            // the resolved name against the naive `inf-<name>-…` form.
            const shortened = [
              { label: 'cache', name: predictedPodNames.cache, naive: `inf-${deploymentName}-cache-0` },
              { label: 'default', name: predictedPodNames.default, naive: `inf-${deploymentName}-q-default-n-0` },
            ].filter((pod) => pod.name !== pod.naive);
            return shortened.map((pod) => (
              <span key={pod.label} style={{ display: 'block', fontFamily: 'monospace' }}>
                {pod.label}: {pod.name}
              </span>
            ));
          })()}
        </Typography>
      )}

      {/* Prompt caching — only offered when the selected model/bundle's
          profile(s) advertise the `prompt_caching` feature. Checking it injects
          the KV-cache env vars into the deployment's engineConfig. */}
      {promptCachingAvailable && (
        <FormControlLabel
          sx={{ mb: 1 }}
          control={
            <Checkbox
              checked={enablePromptCaching}
              onChange={(e) => handleTogglePromptCaching(e.target.checked)}
            />
          }
          label="Enable prompt caching"
        />
      )}

      {/* Generated YAML */}
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            Generated YAML
          </Typography>
          <Button
            startIcon={<ContentCopyIcon />}
            onClick={handleCopyYaml}
            size="small"
            disabled={!deploymentYaml}
            sx={{
              color: copiedYaml ? 'success.main' : 'primary.main',
            }}
          >
            {copiedYaml ? 'Copied!' : 'Copy'}
          </Button>
        </Box>
        <Typography variant="body2" sx={{ mb: 1, color: 'text.secondary' }}>
          Feel free to edit the YAML below as needed or use it as-is
        </Typography>
        <TextField
          fullWidth
          multiline
          rows={15}
          value={deploymentYaml}
          onChange={(e) => setDeploymentYaml(e.target.value)}
          variant="outlined"
          sx={{
            '& .MuiInputBase-root': {
              fontFamily: 'monospace',
              fontSize: '0.875rem',
            },
          }}
        />
      </Box>

      {/* Deployment Result */}
      {deploymentResult && (
        <Box sx={{ mt: 2 }}>
          <Alert
            severity={deploymentResult.success ? 'success' : 'error'}
            onClose={() => setDeploymentResult(null)}
          >
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: deploymentResult.output ? 1 : 0 }}>
              {deploymentResult.message}
            </Typography>
            {deploymentResult.output && (
              <Box
                component="pre"
                sx={{
                  mt: 1,
                  p: 1.5,
                  bgcolor: 'rgba(0, 0, 0, 0.05)',
                  borderRadius: 1,
                  fontSize: '0.75rem',
                  overflow: 'auto',
                  maxHeight: '150px',
                }}
              >
                {deploymentResult.output}
              </Box>
            )}
          </Alert>
        </Box>
      )}

      {/* Save Result */}
      {saveResult && (
        <Box sx={{ mt: 2 }}>
          <Alert
            severity={saveResult.success ? 'success' : 'error'}
            onClose={() => setSaveResult(null)}
          >
            {saveResult.message}
          </Alert>
        </Box>
      )}

      {/* Save and Deploy Buttons */}
      <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
        <Button
          variant="outlined"
          color="primary"
          size="large"
          onClick={handleSaveClick}
          disabled={isSaving || !deploymentYaml || !deploymentName}
          startIcon={isSaving ? <CircularProgress size={20} /> : <SaveIcon />}
        >
          {isSaving ? 'Saving...' : 'Save'}
        </Button>
        <Button
          variant="contained"
          color="primary"
          size="large"
          startIcon={deploying ? <CircularProgress size={20} color="inherit" /> : <RocketLaunchIcon />}
          onClick={handleDeploy}
          disabled={deploying || !deploymentYaml}
        >
          {deploying ? 'Deploying...' : 'Deploy'}
        </Button>
      </Box>
    </Box>
  );

  return (
    <Box>
      {/* Documentation Panel */}
      <DocumentationPanel docFile="model-deployment.md" />

      {/* Section 1: Check for existing Model Deployments */}
      <Paper elevation={0} sx={{ p: 3, mb: 3, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            1. Check for existing Model Deployments
          </Typography>
          <Button
            variant="outlined"
            startIcon={<RefreshIcon />}
            onClick={fetchBundleDeployments}
            disabled={loading || deleting}
          >
            Refresh
          </Button>
        </Box>

        {/* Success/Error Messages */}
        {successMessage && (
          <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccessMessage(null)}>
            {successMessage}
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}

        {/* Loading State */}
        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        )}

        {/* Empty State */}
        {!loading && bundleDeployments.length === 0 && (
          <Alert severity="info">
            No model deployments found in the namespace
          </Alert>
        )}

        {/* Model Deployments Table */}
        {!loading && bundleDeployments.length > 0 && (
          <TableContainer>
            <Table size="small" sx={{ border: '1px solid', borderColor: 'divider' }}>
              <TableHead>
                <TableRow sx={{ bgcolor: 'grey.50' }}>
                  <TableCell sx={{ fontWeight: 600 }}>Name</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Model / Bundle</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Status</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Created</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {bundleDeployments.map((deployment) => {
                  const status = getStatusDisplay(deployment);
                  return (
                    <TableRow key={deployment.name} hover>
                      <TableCell>{deployment.name}</TableCell>
                      <TableCell>{deployment.bundle || deployment.model || '—'}</TableCell>
                      <TableCell>
                        <Typography sx={{ color: status.color, fontWeight: 500 }}>
                          {status.text}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {new Date(deployment.creationTimestamp).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Box sx={{ display: 'flex', gap: 1 }}>
                          <Button
                            variant="outlined"
                            size="small"
                            onClick={() => handleStatusClick(deployment.name)}
                          >
                            Status
                          </Button>
                          <Button
                            variant="outlined"
                            color="error"
                            size="small"
                            onClick={() => handleDeleteClick(deployment.name)}
                            disabled={deleting}
                          >
                            Delete
                          </Button>
                        </Box>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      {/* Section 2: Deploy a Model Bundle */}
      <Paper elevation={0} sx={{ p: 3, mb: 3, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
        <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 2 }}>
          2. Deploy a Model/Bundle
        </Typography>

        {/* Source selector — deploy an individual model (+ profile) or a bundle. */}
        <RadioGroup
          row
          aria-label="deployment source"
          value={deployMode}
          onChange={handleDeployModeChange}
          sx={{ mb: 2 }}
        >
          <FormControlLabel value="model" control={<Radio />} label="Model" />
          <FormControlLabel value="bundle" control={<Radio />} label="Model Bundle" />
        </RadioGroup>

        {/* Model mode: deploy a single model + named profile inline (spec.models). */}
        {deployMode === 'model' && (
          hasModelParams ? (
            <Box>
              <Box sx={{ mb: 2 }}>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  Deploying model{' '}
                  <Box component="span" sx={{ fontFamily: 'monospace', color: 'text.primary' }}>
                    {modelPath}
                  </Box>{' '}
                  with profile{' '}
                  <Box component="span" sx={{ fontFamily: 'monospace', color: 'text.primary' }}>
                    {profileName}
                  </Box>
                  .
                </Typography>
              </Box>
              {deploymentEditor}
            </Box>
          ) : (
            <Alert severity="info">
              Select a model and profile on the Model Selection page to deploy an individual model.
            </Alert>
          )
        )}

        {/* Bundle mode: reference an existing ModelBundle CR by name (spec.bundle). */}
        {deployMode === 'bundle' && (
          <>
            {/* Loading State */}
            {loadingBundles && (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                <CircularProgress />
              </Box>
            )}

            {/* Empty State */}
            {!loadingBundles && validBundles.length === 0 && (
              <Alert severity="info">
                No valid model bundles found. Please create and validate a model bundle first.
              </Alert>
            )}

            {/* Bundle Selection Form */}
            {!loadingBundles && validBundles.length > 0 && (
              <Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 2 }}>
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    Select a valid model bundle to deploy
                  </Typography>
                  <Tooltip
                    title="Only model bundles for which validation succeeded are listed here. If you would like to deploy a different model bundle or if you want to see which models/configurations are available in one of the listed model bundles, please use the 'load' feature at the top of the Model Selection page and select 'Remote Environment' as the source."
                    arrow
                  >
                    <HelpOutlineIcon sx={{ fontSize: 16, color: 'text.secondary', cursor: 'help' }} />
                  </Tooltip>
                </Box>

                {/* Bundle Dropdown */}
                <FormControl fullWidth sx={{ mb: 3 }}>
                  <InputLabel id="bundle-select-label">Model Bundle</InputLabel>
                  <Select
                    labelId="bundle-select-label"
                    id="bundle-select"
                    value={selectedBundle}
                    onChange={handleBundleChange}
                    label="Model Bundle"
                  >
                    {validBundles.map((bundle) => (
                      <MenuItem key={bundle.name} value={bundle.name}>
                        {bundle.name}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                {/* Deployment Name + generated YAML + actions */}
                {selectedBundle && deploymentEditor}
              </Box>
            )}
          </>
        )}
      </Paper>

      {/* Section 3: Check Deployment Status */}
      {monitoredDeployment && (
        <Paper elevation={0} sx={{ p: 3, mb: 3, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
          <Typography variant="h6" gutterBottom sx={{ fontWeight: 600, mb: 3 }}>
            3. Check Deployment Status
          </Typography>

          <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 2 }}>
            Pod Status
          </Typography>

          {/* Cache Pod Status */}
          <Box sx={{ mb: 4 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  Cache Pod
                </Typography>
                {podStatus.cachePod && (
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>
                    ({podNames?.cache ?? `inf-${monitoredDeployment}-cache-0`})
                  </Typography>
                )}
              </Box>
              {podStatus.cachePod && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
                    {podStatus.cachePod.ready}/{podStatus.cachePod.total}
                  </Typography>
                  {podStatus.cachePod.ready === podStatus.cachePod.total ? (
                    <CheckCircleIcon sx={{ color: 'success.main', fontSize: 20 }} />
                  ) : (
                    <CircularProgress size={16} />
                  )}
                </Box>
              )}
            </Box>
            {podStatus.cachePod ? (
              <Box>
                <LinearProgress
                  variant="determinate"
                  value={(podStatus.cachePod.ready / podStatus.cachePod.total) * 100}
                  sx={{
                    height: 8,
                    borderRadius: 1,
                    bgcolor: 'grey.200',
                    '& .MuiLinearProgress-bar': {
                      bgcolor: podStatus.cachePod.ready === podStatus.cachePod.total ? 'success.main' : 'primary.main'
                    }
                  }}
                />
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5, mb: 2 }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    Status: {podStatus.cachePod.status}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {Math.round((podStatus.cachePod.ready / podStatus.cachePod.total) * 100)}%
                  </Typography>
                </Box>
              </Box>
            ) : (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <CircularProgress size={16} />
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  Waiting for pod...
                </Typography>
              </Box>
            )}

            {/* Cache Pod Logs Collapsible */}
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                cursor: 'pointer',
                '&:hover': { bgcolor: 'action.hover' },
                p: 1,
                borderRadius: 1,
                mb: 1,
              }}
              onClick={() => setShowCacheLogs(!showCacheLogs)}
            >
              <IconButton size="small" sx={{ mr: 1 }}>
                {showCacheLogs ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              </IconButton>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                Show logs (last 5 lines)
              </Typography>
            </Box>

            <Collapse in={showCacheLogs}>
              <Box sx={{ pl: 2 }}>
                <Typography variant="body2" sx={{ mb: 2, color: 'text.secondary', fontFamily: 'monospace', fontSize: '0.875rem' }}>
                  Monitoring: {podNames?.cache ?? `inf-${monitoredDeployment}-cache-0`}
                </Typography>

                {podLogsError ? (
                  <Alert severity="error" sx={{ mb: 2 }}>
                    {podLogsError}
                  </Alert>
                ) : (
                  <Box
                    sx={{
                      bgcolor: 'black',
                      borderRadius: 1,
                      p: 2,
                      overflowX: 'auto',
                      overflowY: 'auto',
                      minHeight: '120px',
                      maxHeight: '300px',
                      maxWidth: 'calc(100vw - 350px)',
                    }}
                  >
                    <Box
                      component="pre"
                      sx={{
                        m: 0,
                        color: 'white',
                        fontSize: '0.875rem',
                        fontFamily: 'monospace',
                        whiteSpace: 'pre',
                      }}
                    >
                      {podLogs || 'Waiting for logs...'}
                    </Box>
                  </Box>
                )}

                <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
                  Auto-refreshing every 3 seconds
                </Typography>
              </Box>
            </Collapse>
          </Box>

          {/* Default Pod Status */}
          <Box sx={{ mb: 4 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 500 }}>
                  Default Pod
                </Typography>
                {podStatus.defaultPod && (
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>
                    ({podNames?.default ?? `inf-${monitoredDeployment}-q-default-n-0`})
                  </Typography>
                )}
              </Box>
              {podStatus.defaultPod && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
                    {podStatus.defaultPod.ready}/{podStatus.defaultPod.total}
                  </Typography>
                  {podStatus.defaultPod.ready === podStatus.defaultPod.total ? (
                    <CheckCircleIcon sx={{ color: 'success.main', fontSize: 20 }} />
                  ) : (
                    <CircularProgress size={16} />
                  )}
                </Box>
              )}
            </Box>
            {podStatus.defaultPod ? (
              <Box>
                <LinearProgress
                  variant="determinate"
                  value={(podStatus.defaultPod.ready / podStatus.defaultPod.total) * 100}
                  sx={{
                    height: 8,
                    borderRadius: 1,
                    bgcolor: 'grey.200',
                    '& .MuiLinearProgress-bar': {
                      bgcolor: podStatus.defaultPod.ready === podStatus.defaultPod.total ? 'success.main' : 'primary.main'
                    }
                  }}
                />
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5, mb: 2 }}>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    Status: {podStatus.defaultPod.status}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {Math.round((podStatus.defaultPod.ready / podStatus.defaultPod.total) * 100)}%
                  </Typography>
                </Box>
              </Box>
            ) : (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <CircularProgress size={16} />
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  Waiting for pod...
                </Typography>
              </Box>
            )}

            {/* Default Pod Logs Collapsible */}
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                cursor: 'pointer',
                '&:hover': { bgcolor: 'action.hover' },
                p: 1,
                borderRadius: 1,
                mb: 1,
              }}
              onClick={() => setShowDefaultLogs(!showDefaultLogs)}
            >
              <IconButton size="small" sx={{ mr: 1 }}>
                {showDefaultLogs ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              </IconButton>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                Show logs (last 5 lines)
              </Typography>
            </Box>

            <Collapse in={showDefaultLogs}>
              <Box sx={{ pl: 2 }}>
                <Typography variant="body2" sx={{ mb: 2, color: 'text.secondary', fontFamily: 'monospace', fontSize: '0.875rem' }}>
                  Monitoring: {podNames?.default ?? `inf-${monitoredDeployment}-q-default-n-0`} (container: inf)
                </Typography>

                {defaultPodLogsError ? (
                  <Alert severity="error" sx={{ mb: 2 }}>
                    {defaultPodLogsError}
                  </Alert>
                ) : (
                  <Box
                    sx={{
                      bgcolor: 'black',
                      borderRadius: 1,
                      p: 2,
                      overflowX: 'auto',
                      overflowY: 'auto',
                      minHeight: '120px',
                      maxHeight: '300px',
                      maxWidth: 'calc(100vw - 350px)',
                    }}
                  >
                    <Box
                      component="pre"
                      sx={{
                        m: 0,
                        color: 'white',
                        fontSize: '0.875rem',
                        fontFamily: 'monospace',
                        whiteSpace: 'pre',
                      }}
                    >
                      {defaultPodLogs || 'Waiting for logs...'}
                    </Box>
                  </Box>
                )}

                <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
                  Auto-refreshing every 3 seconds
                </Typography>
              </Box>
            </Collapse>
          </Box>

          {/* Overall Status */}
          {(() => {
            const bothReady =
              !!podStatus.cachePod &&
              !!podStatus.defaultPod &&
              podStatus.cachePod.ready === podStatus.cachePod.total &&
              podStatus.defaultPod.ready === podStatus.defaultPod.total;

            // A probe error means the expected pods are not actually running
            // (e.g. nothing could be scheduled because no hosts were free) — never
            // report success in that case. A logs probe that fails only because a
            // container is still starting up ("PodInitializing" / "ContainerCreating")
            // is the normal early state of a fresh deployment and is not a failure
            // (see isPodProbeFailure).
            const hasError =
              isPodProbeFailure(podStatusError) ||
              isPodProbeFailure(podLogsError) ||
              isPodProbeFailure(defaultPodLogsError);

            if (bothReady && !hasError) {
              return (
                <Box sx={{ p: 2, bgcolor: 'grey.50', borderRadius: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CheckCircleIcon sx={{ color: 'success.main' }} />
                    <Typography variant="body2" sx={{ fontWeight: 600, color: 'success.main' }}>
                      Deployment Complete! All pods are ready.
                    </Typography>
                  </Box>
                </Box>
              );
            }

            if (hasError) {
              return (
                <Alert severity="error">
                  Deployment failed: the expected pods are not running. Expand the
                  pod logs above for details.
                </Alert>
              );
            }

            return (
              <Box sx={{ p: 2, bgcolor: 'grey.50', borderRadius: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <CircularProgress size={20} />
                  <Typography variant="body2" sx={{ fontWeight: 500, color: 'text.secondary' }}>
                    Deployment in progress... Waiting for all pods to be ready.
                  </Typography>
                </Box>
              </Box>
            );
          })()}
        </Paper>
      )}

      {/* Save Overwrite Confirmation Dialog */}
      <Dialog open={saveDialogOpen} onClose={handleCancelSave}>
        <DialogTitle>File Already Exists</DialogTitle>
        <DialogContent>
          <DialogContentText>
            A file named <strong>{deploymentName}.yaml</strong> already exists in saved_artifacts.
            Do you want to overwrite it?
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

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteDialogOpen}
        onClose={handleDeleteCancel}
      >
        <DialogTitle>Confirm Deletion</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete the model deployment: <strong>{deploymentToDelete}</strong>?
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDeleteCancel} color="primary">
            Cancel
          </Button>
          <Button onClick={handleDeleteConfirm} color="error" variant="contained">
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Model+profile deploy reminder (shown when arriving from Model Selection) */}
      <Dialog
        open={showModelDeployNotice}
        onClose={() => setShowModelDeployNotice(false)}
      >
        <DialogTitle>Before you deploy</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Confirm that no deployments are currently active and review the model
            deployment settings in the YAML.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowModelDeployNotice(false)} color="primary" variant="contained">
            Got it
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
