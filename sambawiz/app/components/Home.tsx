'use client';

import { useState, useEffect, useCallback, useId } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Box,
  Typography,
  Paper,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  TextField,
  SelectChangeEvent,
  Button,
  Alert,
  CircularProgress,
  InputAdornment,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Tooltip,
} from '@mui/material';
import { Visibility, VisibilityOff, ContentCopy, Close, Warning } from '@mui/icons-material';
import AppConfigDialog from './AppConfigDialog';
import NoKubeconfigsDialog from './NoKubeconfigsDialog';
import DocumentationPanel from './DocumentationPanel';

interface KubeconfigEntry {
  file: string;
  namespace: string;
  uiDomain?: string;
  apiDomain?: string;
  apiKey?: string;
  enableUpdates?: boolean;
}

export default function Home() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Generate stable IDs for form fields to prevent hydration mismatches
  const namespaceId = useId();
  const apiDomainId = useId();
  const uiDomainId = useId();
  const apiKeyId = useId();
  const keycloakUsernameId = useId();
  const keycloakPasswordId = useId();
  const installYamlId = useId();

  const [selectedEnvironment, setSelectedEnvironment] = useState<string>('');
  const [namespace, setNamespace] = useState<string>('');
  const [apiKey, setApiKey] = useState<string>('');
  const [apiDomain, setApiDomain] = useState<string>('');
  const [uiDomain, setUiDomain] = useState<string>('');
  const [showApiKey, setShowApiKey] = useState<boolean>(false);
  const [environments, setEnvironments] = useState<string[]>([]);
  const [kubeconfigs, setKubeconfigs] = useState<Record<string, KubeconfigEntry>>({});
  const [saving, setSaving] = useState<boolean>(false);
  const [saveSuccess, setSaveSuccess] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [prerequisiteWarning, setPrerequisiteWarning] = useState<string | null>(null);
  const [showPrerequisiteDialog, setShowPrerequisiteDialog] = useState<boolean>(false);
  const [showAppConfigDialog, setShowAppConfigDialog] = useState<boolean>(false);
  const [showNoKubeconfigsDialog, setShowNoKubeconfigsDialog] = useState<boolean>(false);
  const [showApiKeyInstructionsDialog, setShowApiKeyInstructionsDialog] = useState<boolean>(false);
  const [keycloakUsername, setKeycloakUsername] = useState<string>('');
  const [keycloakPassword, setKeycloakPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [loadingCredentials, setLoadingCredentials] = useState<boolean>(false);
  const [credentialsError, setCredentialsError] = useState<string | null>(null);
  const [fullHelmVersion, setFullHelmVersion] = useState<string | null>(null);
  const [helmVersionTooOld, setHelmVersionTooOld] = useState<boolean>(false);
  const [minimumHelmVersion, setMinimumHelmVersion] = useState<string | null>(null);
  const [showInstallDialog, setShowInstallDialog] = useState<boolean>(false);
  const [installYaml, setInstallYaml] = useState<string>('');
  const [installing, setInstalling] = useState<boolean>(false);
  const [installOutput, setInstallOutput] = useState<string>('');
  const [installError, setInstallError] = useState<string | null>(null);
  const [installerLogs, setInstallerLogs] = useState<string>('');
  const [showInstallerLogs, setShowInstallerLogs] = useState<boolean>(false);
  const [enableUpdates, setEnableUpdates] = useState<boolean>(true);
  const [installationComplete, setInstallationComplete] = useState<boolean>(false);
  const [yamlModifiedAfterInstall, setYamlModifiedAfterInstall] = useState<boolean>(false);

  // Check prerequisites on component mount
  useEffect(() => {
    const checkPrerequisites = async () => {
      try {
        // Check kubectl and helm
        const prereqResponse = await fetch('/api/check-prerequisites');
        const prereqData = await prereqResponse.json();

        if (prereqData.success) {
          const missing = [];
          if (!prereqData.prerequisites.kubectl) {
            missing.push('kubectl');
          }
          if (!prereqData.prerequisites.helm) {
            missing.push('helm');
          }

          if (missing.length > 0) {
            setPrerequisiteWarning(
              `The following required tools are not installed: ${missing.join(', ')}. Please install them on your system.`
            );
            setShowPrerequisiteDialog(true);
            return;
          }
        }

        // Check app-config.json
        const configResponse = await fetch('/api/check-app-config');
        const configData = await configResponse.json();

        if (configData.success && (!configData.exists || !configData.valid)) {
          setShowAppConfigDialog(true);
          return;
        }

        // If config exists and is valid, check if we need to auto-populate kubeconfigs
        if (configData.success && configData.exists && configData.valid) {
          const config = configData.config;
          const kubeconfigsEmpty = Object.keys(config.kubeconfigs || {}).length === 0;
          const currentKubeconfigEmpty = !config.currentKubeconfig || config.currentKubeconfig.trim() === '';

          if (kubeconfigsEmpty && currentKubeconfigEmpty) {
            // Check if there are any kubeconfig files in the kubeconfigs directory
            const kubeconfigFilesResponse = await fetch('/api/check-kubeconfig-files');
            const kubeconfigFilesData = await kubeconfigFilesResponse.json();

            if (kubeconfigFilesData.success && !kubeconfigFilesData.hasFiles) {
              // No kubeconfig files found
              setShowNoKubeconfigsDialog(true);
              return;
            }

            // Try to auto-populate if files exist
            if (kubeconfigFilesData.success && kubeconfigFilesData.hasFiles) {
              try {
                const autoPopResponse = await fetch('/api/auto-populate-kubeconfigs', {
                  method: 'POST',
                });
                const autoPopData = await autoPopResponse.json();

                if (autoPopData.success) {
                  // Refresh the page to load the new config
                  window.location.reload();
                }
              } catch (error) {
                console.error('Failed to auto-populate kubeconfigs:', error);
              }
            }
          }
        }
      } catch (error) {
        console.error('Failed to check prerequisites:', error);
      }
    };

    checkPrerequisites();
  }, []);

  // Fetch available kubeconfig files on component mount
  useEffect(() => {
    const fetchEnvironments = async () => {
      try {
        const response = await fetch('/api/environments');
        const data = await response.json();

        if (data.success) {
          setEnvironments(data.environments);
          setKubeconfigs(data.kubeconfigs || {});
          // Set default environment from app-config.json
          if (data.defaultEnvironment) {
            setSelectedEnvironment(data.defaultEnvironment);
          }
          // Set default namespace from app-config.json
          if (data.defaultNamespace) {
            setNamespace(data.defaultNamespace);
          }
          // Set default API key from app-config.json
          if (data.defaultApiKey) {
            setApiKey(data.defaultApiKey);
          }
          // Set default API domain from app-config.json
          if (data.defaultApiDomain) {
            setApiDomain(data.defaultApiDomain);
          }
          // Set default UI domain from app-config.json
          if (data.defaultUiDomain) {
            setUiDomain(data.defaultUiDomain);
          }
          // Set default enableUpdates from app-config.json
          if (data.defaultEnvironment && data.kubeconfigs[data.defaultEnvironment]) {
            const enableUpdatesValue = data.kubeconfigs[data.defaultEnvironment].enableUpdates;
            setEnableUpdates(enableUpdatesValue !== false); // Default to true if not explicitly false
          }
        }
      } catch (error) {
        console.error('Failed to fetch environments:', error);
      }
    };

    fetchEnvironments();
  }, []);

  // Function to fetch helm version
  const fetchHelmVersion = useCallback(async () => {
    try {
      const response = await fetch('/api/kubeconfig-validate');
      const data = await response.json();

      if (data.success && data.fullVersion) {
        setFullHelmVersion(data.fullVersion);
        setHelmVersionTooOld(false);
        setMinimumHelmVersion(null);
      } else if (data.helmVersionError && data.version) {
        setFullHelmVersion(data.version);
        setHelmVersionTooOld(true);
        setMinimumHelmVersion(data.minimumVersion || null);
      } else {
        setFullHelmVersion(null);
        setHelmVersionTooOld(false);
        setMinimumHelmVersion(null);
      }
    } catch (error) {
      console.error('Failed to fetch helm version:', error);
      setFullHelmVersion(null);
    }
  }, []);

  // Fetch helm version on component mount
  useEffect(() => {
    fetchHelmVersion();
  }, [fetchHelmVersion]);

  // Open upgrade dialog if navigated here with ?openUpgrade=true
  useEffect(() => {
    if (searchParams.get('openUpgrade') === 'true') {
      router.replace('/');
      handleOpenInstallDialog();
    }
  }, [searchParams, router]);

  // Auto-refresh installer logs every 3 seconds when enabled
  useEffect(() => {
    if (!showInstallerLogs || installationComplete) {
      if (!showInstallerLogs) {
        setInstallerLogs('');
      }
      return;
    }

    const fetchInstallerLogs = async () => {
      try {
        const response = await fetch('/api/installer-logs?lines=20');
        const data = await response.json();

        if (data.success) {
          setInstallerLogs(data.logs);
          // Check if installation is complete (last line contains "configure_default_ingress")
          const lines = data.logs.trim().split('\n');
          const lastLine = lines[lines.length - 1];
          if (lastLine && lastLine.includes('configure_default_ingress')) {
            setInstallationComplete(true);
            setYamlModifiedAfterInstall(false); // Require YAML modification before next install
          }
        } else {
          setInstallerLogs(`Error: ${data.error || 'Failed to fetch logs'}`);
        }
      } catch (error) {
        console.error('Failed to fetch installer logs:', error);
        setInstallerLogs('Failed to connect to the server');
      }
    };

    // Fetch immediately
    fetchInstallerLogs();

    // Set up interval to fetch every 3 seconds
    const intervalId = setInterval(fetchInstallerLogs, 3000);

    // Cleanup interval on unmount or when showInstallerLogs or installationComplete changes
    return () => clearInterval(intervalId);
  }, [showInstallerLogs, installationComplete]);

  const handleEnvironmentChange = (event: SelectChangeEvent<string>) => {
    const envName = event.target.value;
    setSelectedEnvironment(envName);
    setSaveSuccess(false);
    setSaveError(null);

    // Auto-populate namespace, API key, and domains from kubeconfigs
    if (envName && kubeconfigs[envName]) {
      setNamespace(kubeconfigs[envName].namespace || 'default');
      setApiKey(kubeconfigs[envName].apiKey || '');
      setApiDomain(kubeconfigs[envName].apiDomain || '');
      setUiDomain(kubeconfigs[envName].uiDomain || '');
      const enableUpdatesValue = kubeconfigs[envName].enableUpdates;
      setEnableUpdates(enableUpdatesValue !== false); // Default to true if not explicitly false
    } else {
      setNamespace('default');
      setApiKey('');
      setApiDomain('');
      setUiDomain('');
      setEnableUpdates(true); // Default to true for empty selection
    }
  };

  const handleNamespaceChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setNamespace(event.target.value);
    setSaveSuccess(false);
    setSaveError(null);
  };

  const handleApiKeyChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setApiKey(event.target.value);
    setSaveSuccess(false);
    setSaveError(null);
  };

  const handleApiDomainChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setApiDomain(event.target.value);
    setSaveSuccess(false);
    setSaveError(null);
  };

  const handleUiDomainChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setUiDomain(event.target.value);
    setSaveSuccess(false);
    setSaveError(null);
  };

  const handleToggleShowApiKey = () => {
    setShowApiKey(!showApiKey);
  };

  const handleAddEnvironment = () => {
    router.push('/add-environment');
  };

  const handleGetApiKey = async () => {
    setShowApiKeyInstructionsDialog(true);
    setLoadingCredentials(true);
    setCredentialsError(null);
    setKeycloakUsername('');
    setKeycloakPassword('');
    setShowPassword(false);

    if (!selectedEnvironment) {
      setCredentialsError('Please select an environment first');
      setLoadingCredentials(false);
      return;
    }

    try {
      const response = await fetch('/api/get-keycloak-credentials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          environment: selectedEnvironment,
        }),
      });

      const data = await response.json();

      if (data.success) {
        setKeycloakUsername(data.username);
        setKeycloakPassword(data.password);
      } else {
        setCredentialsError(data.error || 'Failed to retrieve credentials');
      }
    } catch (error) {
      console.error('Error fetching credentials:', error);
      setCredentialsError('Failed to retrieve credentials');
    } finally {
      setLoadingCredentials(false);
    }
  };

  const handleCopyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const handleApply = async () => {
    if (!selectedEnvironment || !namespace) {
      setSaveError('Please select an environment and enter a namespace');
      return;
    }

    // Validate URLs if they are non-empty
    if (apiDomain && apiDomain.trim() !== '') {
      if (!apiDomain.startsWith('https://')) {
        setSaveError('API Domain must start with https://');
        return;
      }
      if (apiDomain.includes(' ')) {
        setSaveError('API Domain cannot contain spaces');
        return;
      }
    }

    if (uiDomain && uiDomain.trim() !== '') {
      if (!uiDomain.startsWith('https://')) {
        setSaveError('UI Domain must start with https://');
        return;
      }
      if (uiDomain.includes(' ')) {
        setSaveError('UI Domain cannot contain spaces');
        return;
      }
    }

    setSaving(true);
    setSaveSuccess(false);
    setSaveError(null);

    try {
      // Check if checkpoint_mapping.json exists
      const checkpointResponse = await fetch('/api/check-checkpoint-mapping');
      const checkpointData = await checkpointResponse.json();

      if (checkpointData.success && !checkpointData.exists) {
        setSaveError('checkpoint_mapping.json file not found in app/data/ folder. Please obtain it from your SambaNova contact and copy it into that folder before applying configuration.');
        setSaving(false);
        return;
      }

      if (!checkpointData.success) {
        setSaveError('Failed to verify checkpoint mapping file. Please try again.');
        setSaving(false);
        return;
      }

      const response = await fetch('/api/update-config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          environment: selectedEnvironment,
          namespace: namespace,
          apiKey: apiKey,
          apiDomain: apiDomain,
          uiDomain: uiDomain,
        }),
      });

      const data = await response.json();

      if (data.success) {
        setSaveSuccess(true);
        // Reload the page after a short delay to refresh the navbar and all app state
        setTimeout(() => {
          window.location.reload();
        }, 1000);
      } else {
        setSaveError(data.error || 'Failed to save configuration');
      }
    } catch (error) {
      console.error('Error saving configuration:', error);
      setSaveError('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleAppConfigCreated = async () => {
    // Refresh the page to load the new config
    window.location.reload();
  };

  const incrementVersion = (version: string): string => {
    const parts = version.split('.');
    const lastPart = parseInt(parts[parts.length - 1], 10);
    parts[parts.length - 1] = (lastPart + 1).toString();
    return parts.join('.');
  };

  const compareVersionStrings = (a: string, b: string): number => {
    const aParts = a.split('.').map(Number);
    const bParts = b.split('.').map(Number);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const diff = (aParts[i] || 0) - (bParts[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  };

  const getNextVersion = (currentVersion: string | null, minVersion: string | null): string => {
    const fallback = '0.3.576';
    if (!currentVersion) return fallback;

    const versionMatch = currentVersion.match(/^(\d+\.\d+\.\d+)/);
    if (!versionMatch) return fallback;

    const incremented = incrementVersion(versionMatch[1]);
    if (minVersion && compareVersionStrings(minVersion, incremented) > 0) {
      return minVersion;
    }
    return incremented;
  };

  const handleOpenInstallDialog = () => {
    // Calculate the next version: max(current + 1, minimumHelmVersion)
    const nextVersion = getNextVersion(fullHelmVersion, minimumHelmVersion);

    // Initialize with YAML containing the next version
    const defaultYaml = `apiVersion: v1
kind: ConfigMap
metadata:
  name: sambastack
  labels:
    sambastack-installer: "true"
data:
  sambastack.yaml: |
    version: ${nextVersion}                     # [CHANGE ME] Helm version of sambastack to install`;
    setInstallYaml(defaultYaml);
    setInstallOutput('');
    setInstallError(null);
    setInstallationComplete(false);
    setYamlModifiedAfterInstall(false); // Reset modification tracking
    setShowInstallDialog(true);
  };

  const handleCloseInstallDialog = useCallback(() => {
    setShowInstallDialog(false);
    setInstallOutput('');
    setInstallError(null);
    setShowInstallerLogs(false);
    setInstallationComplete(false);
    // Force page refresh to update helm version
    window.location.reload();
  }, []);

  const handleInstallYamlChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInstallYaml(event.target.value);
    setYamlModifiedAfterInstall(true); // Mark as modified to enable Install button

    // Reset dialog state when user edits after installation (reload from scratch)
    if (installationComplete) {
      setInstallationComplete(false);
      setShowInstallerLogs(false);
      setInstallOutput('');
      setInstallError(null);
    }
  };

  const handleInstall = async () => {
    // Clear previous installation state including success message
    setInstalling(true);
    setInstallError(null);
    setInstallOutput('');
    setShowInstallerLogs(false);
    setInstallationComplete(false);

    try {
      const response = await fetch('/api/install-sambastack', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          yaml: installYaml,
        }),
      });

      const data = await response.json();

      if (data.success) {
        setInstallOutput(data.output || 'Installation initiated successfully!');
        // Enable installer logs monitoring
        setShowInstallerLogs(true);
      } else {
        setInstallError(data.error || 'Installation failed');
        if (data.stderr) {
          setInstallOutput(data.stderr);
        } else if (data.stdout) {
          setInstallOutput(data.stdout);
        }
      }
    } catch (error) {
      console.error('Error installing SambaStack:', error);
      setInstallError('Failed to install SambaStack');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <>
      {/* Documentation Panel */}
      <DocumentationPanel docFile="home.md" />

      {/* Prerequisite Warning Dialog */}
      <Dialog
        open={showPrerequisiteDialog}
        onClose={() => setShowPrerequisiteDialog(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Prerequisites Missing</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            {prerequisiteWarning}
          </Alert>
          <DialogContentText>
            Please install the required tools and restart the application.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowPrerequisiteDialog(false)} autoFocus>
            OK
          </Button>
        </DialogActions>
      </Dialog>

      {/* App Config Dialog */}
      <AppConfigDialog
        open={showAppConfigDialog}
        onClose={() => setShowAppConfigDialog(false)}
        onConfigCreated={handleAppConfigCreated}
      />

      {/* No Kubeconfigs Dialog */}
      <NoKubeconfigsDialog
        open={showNoKubeconfigsDialog}
        onClose={() => setShowNoKubeconfigsDialog(false)}
      />

      {/* API Key Instructions Dialog */}
      <Dialog
        open={showApiKeyInstructionsDialog}
        onClose={() => setShowApiKeyInstructionsDialog(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>API Key Instructions</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 3 }}>
            Login to the following UI domain using the following credentials to create your API key
          </DialogContentText>

          {/* Loading State */}
          {loadingCredentials && (
            <Box sx={{ display: 'flex', justifyContent: 'center', my: 3 }}>
              <CircularProgress size={40} />
            </Box>
          )}

          {/* Error State */}
          {credentialsError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {credentialsError}
            </Alert>
          )}

          {/* UI Domain */}
          {!loadingCredentials && uiDomain && (
            <Box sx={{ mb: 3 }}>
              <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                UI Domain:
              </Typography>
              <Typography
                component="a"
                href={uiDomain}
                target="_blank"
                rel="noopener noreferrer"
                sx={{
                  color: 'primary.main',
                  textDecoration: 'underline',
                  wordBreak: 'break-all',
                  '&:hover': {
                    color: 'primary.dark',
                  },
                }}
              >
                {uiDomain}
              </Typography>
            </Box>
          )}

          {/* Credentials */}
          {!loadingCredentials && keycloakUsername && keycloakPassword && (
            <Box>
              {/* Username */}
              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                  Username:
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <TextField
                    id={keycloakUsernameId}
                    fullWidth
                    value={keycloakUsername}
                    variant="outlined"
                    size="small"
                    slotProps={{
                      input: {
                        readOnly: true,
                      },
                    }}
                  />
                  <IconButton
                    onClick={() => handleCopyToClipboard(keycloakUsername)}
                    size="small"
                    sx={{ color: 'primary.main' }}
                  >
                    <ContentCopy fontSize="small" />
                  </IconButton>
                </Box>
              </Box>

              {/* Password */}
              <Box sx={{ mb: 2 }}>
                <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                  Password:
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <TextField
                    id={keycloakPasswordId}
                    fullWidth
                    type={showPassword ? 'text' : 'password'}
                    value={keycloakPassword}
                    variant="outlined"
                    size="small"
                    slotProps={{
                      input: {
                        readOnly: true,
                        endAdornment: (
                          <InputAdornment position="end">
                            <IconButton
                              onClick={() => setShowPassword(!showPassword)}
                              edge="end"
                              size="small"
                            >
                              {showPassword ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                            </IconButton>
                          </InputAdornment>
                        ),
                      },
                    }}
                  />
                  <IconButton
                    onClick={() => handleCopyToClipboard(keycloakPassword)}
                    size="small"
                    sx={{ color: 'primary.main' }}
                  >
                    <ContentCopy fontSize="small" />
                  </IconButton>
                </Box>
              </Box>
            </Box>
          )}

          {!loadingCredentials && !uiDomain && (
            <Alert severity="warning">
              Please select an environment with a UI domain configured.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowApiKeyInstructionsDialog(false)} autoFocus>
            Close
          </Button>
        </DialogActions>
      </Dialog>

      {/* Upgrade SambaStack Dialog */}
      <Dialog
        open={showInstallDialog}
        onClose={handleCloseInstallDialog}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Upgrade SambaStack</span>
            <IconButton
              aria-label="close"
              onClick={handleCloseInstallDialog}
              sx={{
                color: (theme) => theme.palette.grey[500],
              }}
            >
              <Close />
            </IconButton>
          </Box>
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2, color: 'text.secondary' }}>
            Install Environment: <Box component="span" sx={{ fontWeight: 600, color: 'primary.main' }}>{selectedEnvironment}</Box>
          </Typography>

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
            <Typography variant="body2" sx={{ color: 'text.primary' }}>
              Please update the SambaStack helm version below to the version you want installed
            </Typography>
            <Tooltip title="Please do not modify anything else unless you know what you are doing." arrow>
              <Warning sx={{ color: 'warning.main', fontSize: '1.2rem' }} />
            </Tooltip>
          </Box>

          <TextField
            id={installYamlId}
            fullWidth
            multiline
            rows={12}
            value={installYaml}
            onChange={handleInstallYamlChange}
            variant="outlined"
            sx={{
              mb: 2,
              '& .MuiInputBase-root': {
                fontFamily: 'monospace',
                fontSize: '0.875rem',
              },
            }}
          />

          {/* Error Message */}
          {installError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {installError}
            </Alert>
          )}

          {/* Output Display */}
          {installOutput && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                Output:
              </Typography>
              <Paper
                elevation={0}
                sx={{
                  p: 2,
                  backgroundColor: 'grey.100',
                  border: '1px solid',
                  borderColor: 'divider',
                  maxHeight: '200px',
                  overflow: 'auto',
                }}
              >
                <Typography
                  component="pre"
                  sx={{
                    fontFamily: 'monospace',
                    fontSize: '0.75rem',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    m: 0,
                  }}
                >
                  {installOutput}
                </Typography>
              </Paper>
            </Box>
          )}

          {/* Installer Logs Display */}
          {showInstallerLogs && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
                Installer Logs:
              </Typography>
              <Box
                sx={{
                  bgcolor: 'black',
                  borderRadius: 1,
                  p: 2,
                  overflowX: 'auto',
                  overflowY: 'auto',
                  minHeight: '200px',
                  maxHeight: '400px',
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
                  {installerLogs || 'Waiting for logs...'}
                </Box>
              </Box>
              {!installationComplete && (
                <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
                  Auto-refreshing every 3 seconds
                </Typography>
              )}
              {installationComplete && (
                <Alert severity="success" sx={{ mt: 2 }}>
                  Installation complete! You may close this dialog now to apply the changes.
                </Alert>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            variant="contained"
            onClick={handleInstall}
            disabled={installing || (showInstallerLogs && !installationComplete) || !installYaml.trim() || (installationComplete && !yamlModifiedAfterInstall)}
            sx={{
              background: '#A2297D',
              '&:hover': {
                background: '#8B2268',
              },
            }}
          >
            {installing ? (
              <>
                <CircularProgress size={20} sx={{ mr: 1, color: 'white' }} />
                Installing...
              </>
            ) : (
              'Install'
            )}
          </Button>
        </DialogActions>
      </Dialog>

      <Box
        sx={{
          minHeight: 'calc(100vh - 100px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          py: 4,
        }}
      >
      {/* Hero Section */}
      <Box
        sx={{
          textAlign: 'center',
          mb: 3,
          maxWidth: '800px',
        }}
      >
        <Typography
          variant="h2"
          component="h1"
          sx={{
            fontWeight: 700,
            mb: 2,
            fontSize: { xs: '2.5rem', md: '3.5rem' },
            background: 'linear-gradient(to right, #A2297D, #4E226B)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}
        >
          SambaWiz
        </Typography>
        <Typography
          variant="h5"
          sx={{
            color: 'text.secondary',
            mb: 3,
            fontWeight: 400,
            fontSize: { xs: '1.1rem', md: '1.5rem' },
          }}
        >
          Your SambaStack Bundle Configuration Wizard
        </Typography>
        <Typography
          variant="body1"
          sx={{
            color: 'text.secondary',
            maxWidth: '600px',
            mx: 'auto',
            lineHeight: 1.7,
          }}
        >
          Create, configure, deploy, and test model bundles with ease!
        </Typography>
      </Box>

      {/* Helm Version Display */}
      {fullHelmVersion && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            mb: 3,
            ml: 1.5,
          }}
        >
          <Typography
            variant="body2"
            sx={{
              color: 'text.secondary',
              fontSize: 'rem',
            }}
          >
            Current SambaStack Helm Version: <Box component="span" sx={{ fontFamily: 'monospace', color: helmVersionTooOld ? 'error.main' : 'primary.main' }}>{fullHelmVersion}</Box>
          </Typography>
          {(helmVersionTooOld || enableUpdates) && (
            <Button
              variant="outlined"
              size="small"
              onClick={handleOpenInstallDialog}
              sx={{
                textTransform: 'none',
                fontWeight: 600,
                borderColor: 'primary.main',
                color: 'primary.main',
                '&:hover': {
                  borderColor: 'primary.dark',
                  backgroundColor: 'rgba(255, 107, 53, 0.05)',
                },
              }}
            >
              Upgrade
            </Button>
          )}
        </Box>
      )}


      {/* Environment Selection Section */}
      <Paper
        elevation={3}
        sx={{
          p: 4,
          maxWidth: '600px',
          width: '100%',
          borderRadius: 3,
          background: 'linear-gradient(135deg, rgba(255, 107, 53, 0.05) 0%, rgba(255, 142, 83, 0.05) 100%)',
          border: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            mb: 3,
          }}
        >
          <Typography
            variant="h6"
            sx={{
              fontWeight: 600,
              color: 'primary.main',
            }}
          >
            Select your SambaStack environment
          </Typography>
          <Button
            variant="outlined"
            size="small"
            onClick={handleAddEnvironment}
            sx={{
              textTransform: 'none',
              fontWeight: 600,
              borderColor: 'primary.main',
              color: 'primary.main',
              '&:hover': {
                borderColor: 'primary.dark',
                backgroundColor: 'rgba(255, 107, 53, 0.05)',
              },
            }}
          >
            Add an Environment
          </Button>
        </Box>
        
        <FormControl fullWidth sx={{ mb: 3 }}>
          <InputLabel id="environment-select-label">Environment</InputLabel>
          <Select
            labelId="environment-select-label"
            id="environment-select"
            value={selectedEnvironment}
            label="Environment"
            onChange={handleEnvironmentChange}
            sx={{
              '& .MuiOutlinedInput-notchedOutline': {
                borderColor: 'divider',
              },
              '&:hover .MuiOutlinedInput-notchedOutline': {
                borderColor: 'primary.main',
              },
            }}
          >
            {environments.length === 0 ? (
              <MenuItem disabled value="">
                No environments available
              </MenuItem>
            ) : (
              environments.map((env) => (
                <MenuItem key={env} value={env}>
                  {env}
                </MenuItem>
              ))
            )}
          </Select>
        </FormControl>        

        <TextField
          id={namespaceId}
          fullWidth
          label="Namespace"
          value={namespace}
          onChange={handleNamespaceChange}
          variant="outlined"
          sx={{
            mb: 3,
            '& .MuiOutlinedInput-root': {
              '& fieldset': {
                borderColor: 'divider',
              },
              '&:hover fieldset': {
                borderColor: 'primary.main',
              },
            },
          }}
        />

        <TextField
          id={apiDomainId}
          fullWidth
          label="API Domain"
          value={apiDomain}
          onChange={handleApiDomainChange}
          variant="outlined"
          sx={{
            mb: 3,
            '& .MuiOutlinedInput-root': {
              '& fieldset': {
                borderColor: 'divider',
              },
              '&:hover fieldset': {
                borderColor: 'primary.main',
              },
            },
          }}
        />

        <TextField
          id={uiDomainId}
          fullWidth
          label="UI Domain"
          value={uiDomain}
          onChange={handleUiDomainChange}
          variant="outlined"
          sx={{
            mb: 3,
            '& .MuiOutlinedInput-root': {
              '& fieldset': {
                borderColor: 'divider',
              },
              '&:hover fieldset': {
                borderColor: 'primary.main',
              },
            },
          }}
        />

        <Box sx={{ mb: 3 }}>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 0.5 }}>
            <Typography
              component="a"
              onClick={handleGetApiKey}
              sx={{
                fontSize: '0.75rem',
                color: 'primary.main',
                cursor: 'pointer',
                textDecoration: 'underline',
                '&:hover': {
                  color: 'primary.dark',
                },
              }}
            >
              Get API Key
            </Typography>
          </Box>
          <TextField
            id={apiKeyId}
            fullWidth
            label="API Key"
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={handleApiKeyChange}
            variant="outlined"
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label="toggle api key visibility"
                      onClick={handleToggleShowApiKey}
                      edge="end"
                    >
                      {showApiKey ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
              inputLabel: {
                shrink: true,
              },
            }}
            sx={{
              '& .MuiOutlinedInput-root': {
                '& fieldset': {
                  borderColor: 'divider',
                },
                '&:hover fieldset': {
                  borderColor: 'primary.main',
                },
              },
            }}
          />
        </Box>

        {/* Success/Error Messages */}
        {saveSuccess && (
          <Alert severity="success" sx={{ mb: 3 }}>
            Configuration saved successfully!
          </Alert>
        )}
        {saveError && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {saveError}
          </Alert>
        )}

        {/* Apply Button */}
        <Button
          fullWidth
          variant="contained"
          size="large"
          onClick={handleApply}
          disabled={saving || !selectedEnvironment || !namespace}
          sx={{
            py: 1.5,
            fontWeight: 600,
            fontSize: '1rem',
            textTransform: 'none',
            background: '#A2297D',
            '&:hover': {
              background: '#8B2268',
            },
            '&:disabled': {
              background: '#ccc',
              color: '#666',
            },
          }}
        >
          {saving ? (
            <>
              <CircularProgress size={20} sx={{ mr: 1, color: 'white' }} />
              Applying...
            </>
          ) : (
            'Apply Configuration'
          )}
        </Button>
      </Paper>

      {/* Footer Info */}
      <Box
        sx={{
          mt: 6,
          textAlign: 'center',
          color: 'text.secondary',
        }}
      >
        <Typography variant="body2" sx={{ fontSize: '0.875rem' }}>
          Ready to build? Use the navigation menu to access the bundle builder and deployment tools.
        </Typography>
      </Box>
      </Box>
    </>
  );
}
