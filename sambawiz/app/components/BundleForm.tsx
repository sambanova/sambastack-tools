'use client';

import { useState, useMemo, useEffect, useId, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  TriangleAlert,
  Copy,
  Trash2,
  Wrench,
  Save,
  Rocket,
  HelpCircle,
  Loader2,
} from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Field, FieldLabel, FieldGroup, FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { PefConfigs, PefMapping, CheckpointMapping, ConfigSelection } from '../types/bundle';
import { generateBundleYaml } from '../utils/bundle-yaml-generator';
import DocumentationPanel from './DocumentationPanel';

import pefConfigsData from '../data/pef_configs.json';
import pefMappingData from '../data/pef_mapping.json';

const pefConfigs: PefConfigs = pefConfigsData;
const pefMapping: PefMapping = pefMappingData;

function getPefConfigEntries(pefName: string): import('../types/bundle').PefConfig[] {
  const config = pefConfigs[pefName];
  if (!config) return [];
  return Array.isArray(config) ? config : [config];
}

function getPefConfigForSsBs(
  pefName: string,
  ss: string,
  bs: string
): import('../types/bundle').PefConfig | undefined {
  return getPefConfigEntries(pefName).find((e) => e.ss === ss && e.bs === bs);
}

interface ModelConfig {
  ss: string;
  bs: string;
}

export default function BundleForm() {
  const router = useRouter();
  const bundleNameId = useId();
  const generatedYamlId = useId();

  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [selectedConfigs, setSelectedConfigs] = useState<ConfigSelection[]>([]);
  const [bundleName, setBundleName] = useState<string>('bundle1');
  const [generatedYaml, setGeneratedYaml] = useState<string>('');
  const [isValidating, setIsValidating] = useState<boolean>(false);
  const [draftModels, setDraftModels] = useState<{ [modelName: string]: string }>({});
  const [copiedToClipboard, setCopiedToClipboard] = useState<boolean>(false);
  const [checkpointsDir, setCheckpointsDir] = useState<string>('');
  const [validationResult, setValidationResult] = useState<{
    success: boolean;
    message: string;
    applyOutput?: string;
    validationStatus?: { reason: string; message: string; isValid: boolean };
    bundleName?: string;
  } | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  const [checkpointMapping, setCheckpointMapping] = useState<CheckpointMapping>({});

  const isLoadingFromSavedState = useRef<boolean>(false);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const response = await fetch('/api/environments');
        const data = await response.json();
        if (data.success && data.checkpointsDir) setCheckpointsDir(data.checkpointsDir);
      } catch (error) {
        console.error('Failed to fetch checkpoints directory:', error);
      }
    };

    const loadSavedState = async () => {
      try {
        const response = await fetch('/api/bundle-builder-state');
        const data = await response.json();
        if (data.success && data.state) {
          isLoadingFromSavedState.current = true;
          setSelectedModels(data.state.selectedModels || []);
          setSelectedConfigs(data.state.selectedConfigs || []);
          setBundleName(data.state.bundleName || 'bundle1');
          setGeneratedYaml(data.state.generatedYaml || '');
          setDraftModels(data.state.draftModels || {});
          setTimeout(() => { isLoadingFromSavedState.current = false; }, 100);
        }
      } catch (error) {
        console.error('Failed to load saved state:', error);
        isLoadingFromSavedState.current = false;
      }
    };

    const handleLoadBundleState = (event: Event) => {
      const customEvent = event as CustomEvent;
      const { bundleName, selectedModels, selectedConfigs, draftModels } = customEvent.detail;
      setBundleName(bundleName);
      setSelectedModels(selectedModels);
      setSelectedConfigs(selectedConfigs);
      setDraftModels(draftModels);
      setValidationResult(null);
    };

    window.addEventListener('loadBundleState', handleLoadBundleState);
    fetchConfig();
    loadSavedState();
    return () => window.removeEventListener('loadBundleState', handleLoadBundleState);
  }, []);

  useEffect(() => {
    const loadCheckpointMapping = async () => {
      try {
        const response = await fetch('/api/checkpoint-mapping');
        const result = await response.json();
        if (result.success && result.data) {
          setCheckpointMapping(result.data);
        } else {
          console.warn('checkpoint_mapping.json not found, using empty mapping');
          setCheckpointMapping({});
        }
      } catch (error) {
        console.warn('Failed to load checkpoint_mapping.json:', error);
        setCheckpointMapping({});
      }
    };
    loadCheckpointMapping();
  }, []);

  const availableModels = useMemo(() => {
    const checkpointKeys = Object.keys(checkpointMapping).filter(
      (key) => checkpointMapping[key]?.path !== ''
    );
    const pefMappingKeys = Object.keys(pefMapping).filter((key) => pefMapping[key].length > 0);
    return checkpointKeys.filter((key) => pefMappingKeys.includes(key)).sort();
  }, [checkpointMapping]);

  const modelSupportsSpeculativeDecoding = useMemo(() => {
    const sdSupport: { [modelName: string]: boolean } = {};
    selectedModels.forEach((modelName) => {
      const pefs = pefMapping[modelName] || [];
      const allConfigsSupportSD =
        pefs.length > 0 &&
        pefs.every((pefName) => {
          const parts = pefName.split('-');
          return parts.some((part) => /^sd\d+$/.test(part));
        });
      sdSupport[modelName] = allConfigsSupportSD;
    });
    return sdSupport;
  }, [selectedModels]);

  const modelConfigurations = useMemo(() => {
    const configs: { [modelName: string]: ModelConfig[] } = {};
    selectedModels.forEach((modelName) => {
      const pefs = pefMapping[modelName] || [];
      const configSet = new Set<string>();
      pefs.forEach((pefName) => {
        getPefConfigEntries(pefName).forEach((config) => {
          configSet.add(`${config.ss}|${config.bs}`);
        });
      });
      configs[modelName] = Array.from(configSet)
        .map((key) => {
          const [ss, bs] = key.split('|');
          return { ss, bs };
        })
        .sort((a, b) => {
          const ssA = parseInt(a.ss);
          const ssB = parseInt(b.ss);
          if (ssA !== ssB) return ssA - ssB;
          return parseInt(a.bs) - parseInt(b.bs);
        });
    });
    return configs;
  }, [selectedModels]);

  const handleModelToggle = (model: string, isChecked: boolean) => {
    const newModels = isChecked
      ? [...selectedModels, model]
      : selectedModels.filter((m) => m !== model);
    setSelectedModels(newModels);
    if (!isChecked) {
      setSelectedConfigs((prev) => prev.filter((c) => c.modelName !== model));
      setDraftModels((prev) => {
        const updated = { ...prev };
        delete updated[model];
        return updated;
      });
    }
  };

  const handleDraftModelChange = (targetModel: string, draftModel: string) => {
    setDraftModels((prev) => ({ ...prev, [targetModel]: draftModel }));

    if (draftModel !== 'skip' && !selectedModels.includes(draftModel)) {
      setSelectedModels((prev) => [...prev, draftModel]);
    }

    if (draftModel !== 'skip') {
      const targetConfigs = selectedConfigs.filter((config) => config.modelName === targetModel);
      if (targetConfigs.length > 0) {
        const draftPefs = pefMapping[draftModel] || [];
        const newDraftConfigs: ConfigSelection[] = [];
        targetConfigs.forEach((targetConfig) => {
          const draftConfigExists = selectedConfigs.some(
            (config) =>
              config.modelName === draftModel &&
              config.ss === targetConfig.ss &&
              config.bs === targetConfig.bs
          );
          if (!draftConfigExists) {
            const matchingDraftPef = draftPefs.find((pefName) =>
              getPefConfigEntries(pefName).some(
                (config) => config.ss === targetConfig.ss && config.bs === targetConfig.bs
              )
            );
            if (matchingDraftPef) {
              newDraftConfigs.push({
                modelName: draftModel,
                ss: targetConfig.ss,
                bs: targetConfig.bs,
                pefName: matchingDraftPef,
              });
            }
          }
        });
        if (newDraftConfigs.length > 0) {
          setSelectedConfigs((prev) => [...prev, ...newDraftConfigs]);
        }
      }
    }
  };

  const handleConfigToggle = (modelName: string, ss: string, bs: string) => {
    const pefs = pefMapping[modelName] || [];
    const matchingPef = pefs.find((pefName) =>
      getPefConfigEntries(pefName).some((config) => config.ss === ss && config.bs === bs)
    );
    if (!matchingPef) return;

    const existingIndex = selectedConfigs.findIndex(
      (config) => config.modelName === modelName && config.ss === ss && config.bs === bs
    );

    if (existingIndex >= 0) {
      setSelectedConfigs((prev) => prev.filter((_, i) => i !== existingIndex));
    } else {
      const newConfigs: ConfigSelection[] = [{ modelName, ss, bs, pefName: matchingPef }];
      const draftModel = draftModels[modelName];
      if (draftModel && draftModel !== 'skip') {
        const draftPefs = pefMapping[draftModel] || [];
        const matchingDraftPef = draftPefs.find((pefName) =>
          getPefConfigEntries(pefName).some((config) => config.ss === ss && config.bs === bs)
        );
        if (matchingDraftPef) {
          const draftConfigExists = selectedConfigs.some(
            (config) => config.modelName === draftModel && config.ss === ss && config.bs === bs
          );
          if (!draftConfigExists) {
            newConfigs.push({ modelName: draftModel, ss, bs, pefName: matchingDraftPef });
          }
        }
      }
      setSelectedConfigs((prev) => [...prev, ...newConfigs]);
    }
  };

  const isConfigSelected = (modelName: string, ss: string, bs: string): boolean => {
    return selectedConfigs.some(
      (config) => config.modelName === modelName && config.ss === ss && config.bs === bs
    );
  };

  const handleSelectAllConfigs = (modelName: string) => {
    const configs = modelConfigurations[modelName] || [];
    const allSelected = configs.every((config) =>
      isConfigSelected(modelName, config.ss, config.bs)
    );

    if (allSelected) {
      setSelectedConfigs((prev) => prev.filter((config) => config.modelName !== modelName));
    } else {
      const newConfigs = configs
        .filter((config) => !isConfigSelected(modelName, config.ss, config.bs))
        .map((config) => {
          const pefs = pefMapping[modelName] || [];
          const matchingPef = pefs.find((pefName) =>
            getPefConfigEntries(pefName).some((e) => e.ss === config.ss && e.bs === config.bs)
          );
          return matchingPef
            ? { modelName, ss: config.ss, bs: config.bs, pefName: matchingPef }
            : null;
        })
        .filter((config): config is ConfigSelection => config !== null);
      setSelectedConfigs((prev) => [...prev, ...newConfigs]);
    }
  };

  const areAllConfigsSelected = (modelName: string): boolean => {
    const configs = modelConfigurations[modelName] || [];
    if (configs.length === 0) return false;
    return configs.every((config) => isConfigSelected(modelName, config.ss, config.bs));
  };

  const selectedPefsByModel = useMemo(() => {
    const grouped: { [modelName: string]: string[] } = {};
    selectedConfigs.forEach((config) => {
      if (!grouped[config.modelName]) grouped[config.modelName] = [];
      grouped[config.modelName].push(config.pefName);
    });
    return grouped;
  }, [selectedConfigs]);

  const pefHasDraftModelConfig = (modelName: string, ss: string, bs: string): boolean => {
    const draftModel = draftModels[modelName];
    if (!draftModel || draftModel === 'skip') return true;
    return selectedConfigs.some(
      (config) => config.modelName === draftModel && config.ss === ss && config.bs === bs
    );
  };

  const draftConfigExistsButNotSelected = (
    modelName: string,
    ss: string,
    bs: string
  ): boolean => {
    const draftModel = draftModels[modelName];
    if (!draftModel || draftModel === 'skip') return false;
    const draftPefs = pefMapping[draftModel] || [];
    const matchingDraftPef = draftPefs.find((draftPefName) =>
      getPefConfigEntries(draftPefName).some(
        (config) => config.ss === ss && config.bs === bs
      )
    );
    if (!matchingDraftPef) return false;
    return !selectedConfigs.some(
      (config) => config.modelName === draftModel && config.ss === ss && config.bs === bs
    );
  };

  useEffect(() => {
    if (isLoadingFromSavedState.current) return;
    if (selectedConfigs.length === 0 || !bundleName) {
      setGeneratedYaml('');
      return;
    }
    const yaml = generateBundleYaml(
      selectedConfigs,
      checkpointMapping,
      pefConfigs,
      bundleName,
      checkpointsDir,
      draftModels
    );
    setGeneratedYaml(yaml);
  }, [selectedConfigs, bundleName, draftModels, checkpointsDir, checkpointMapping]);

  const handleCopyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(generatedYaml);
      setCopiedToClipboard(true);
      setTimeout(() => setCopiedToClipboard(false), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  const handleRemovePefConfig = (modelName: string, ss: string, bs: string) => {
    setSelectedConfigs((prev) =>
      prev.filter(
        (config) =>
          !(config.modelName === modelName && config.ss === ss && config.bs === bs)
      )
    );
  };

  const handleAddMissingDraftConfig = (modelName: string, ss: string, bs: string) => {
    const draftModel = draftModels[modelName];
    if (!draftModel || draftModel === 'skip') return;
    const draftPefs = pefMapping[draftModel] || [];
    const matchingDraftPef = draftPefs.find((draftPefName) =>
      getPefConfigEntries(draftPefName).some(
        (config) => config.ss === ss && config.bs === bs
      )
    );
    if (matchingDraftPef) {
      const draftConfigExists = selectedConfigs.some(
        (config) =>
          config.modelName === draftModel && config.ss === ss && config.bs === bs
      );
      if (!draftConfigExists) {
        setSelectedConfigs((prev) => [
          ...prev,
          { modelName: draftModel, ss, bs, pefName: matchingDraftPef },
        ]);
      }
    }
  };

  const handleValidate = async () => {
    if (!generatedYaml) return;
    setIsValidating(true);
    setValidationResult(null);
    try {
      await fetch('/api/bundle-builder-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          state: { selectedModels, selectedConfigs, bundleName, generatedYaml, draftModels },
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
      const response = await fetch('/api/save-artifact', {
        method: overwrite ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, content: generatedYaml }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setSaveResult({ success: true, message: `Bundle saved to saved_artifacts/${fileName}` });
      } else if (response.status === 409 && data.fileExists) {
        setSaveDialogOpen(true);
      } else {
        setSaveResult({ success: false, message: data.error || 'Failed to save bundle' });
      }
    } catch {
      setSaveResult({ success: false, message: 'Failed to connect to save service' });
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
    router.push(`/bundle-deployment?bundle=${encodeURIComponent(bundleNameToPass)}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <DocumentationPanel docFile="bundle-builder.md" />

      {/* Section 1: Select Models */}
      <Card>
        <CardHeader>
          <CardTitle>1. Select Models</CardTitle>
        </CardHeader>
        <CardContent>
          {availableModels.length === 0 ? (
            <Alert>
              <AlertDescription>
                No models available. Please configure your checkpoint directory on the Home page.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {availableModels.map((model) => (
                <label
                  key={model}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg border p-2.5 hover:bg-accent has-data-checked:border-primary/40 has-data-checked:bg-primary/5"
                >
                  <Checkbox
                    checked={selectedModels.includes(model)}
                    onCheckedChange={(checked) =>
                      handleModelToggle(model, checked === true)
                    }
                  />
                  <span className="truncate text-sm font-medium">{model}</span>
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section 2: Select Configurations */}
      {selectedModels.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-1.5">
              <CardTitle>2. Select Configurations</CardTitle>
              <Tooltip>
                <TooltipTrigger>
                  <HelpCircle className="size-4 cursor-help text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  A larger sequence size (SS) supports longer context prompts. A larger batch size
                  (BS) supports high concurrency. It is recommended to have a mix of configurations
                  with small and large SS and BS to support lower latency for big and small
                  workloads.
                </TooltipContent>
              </Tooltip>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {selectedModels.map((modelName, idx) => (
              <div key={modelName}>
                <p className="mb-2 text-sm font-semibold">{modelName}</p>

                {modelSupportsSpeculativeDecoding[modelName] && (
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      Supports speculative decoding. Draft model:
                    </span>
                    <Select
                      value={draftModels[modelName] || 'skip'}
                      onValueChange={(value) => value && handleDraftModelChange(modelName, value)}
                    >
                      <SelectTrigger className="w-48">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          <SelectItem value="skip">skip</SelectItem>
                          {availableModels
                            .filter((model) => model !== modelName)
                            .map((model) => (
                              <SelectItem key={model} value={model}>
                                {model}
                              </SelectItem>
                            ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Tooltip>
                      <TooltipTrigger>
                        <HelpCircle className="size-4 cursor-help text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        The draft model should be much smaller than this target model and should
                        ideally be trained on similar data.
                      </TooltipContent>
                    </Tooltip>
                  </div>
                )}

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-16">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={
                              (areAllConfigsSelected(modelName)
                                ? true
                                : selectedConfigs.some((c) => c.modelName === modelName)
                                  ? 'mixed'
                                  : false) as boolean
                            }
                            onCheckedChange={() => handleSelectAllConfigs(modelName)}
                          />
                          <span className="text-xs font-semibold">All</span>
                        </div>
                      </TableHead>
                      <TableHead className="font-semibold">Sequence Length (SS)</TableHead>
                      <TableHead className="font-semibold">Batch Size (BS)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {modelConfigurations[modelName]?.map((config) => (
                      <TableRow
                        key={`${config.ss}-${config.bs}`}
                        className="cursor-pointer"
                        onClick={() => handleConfigToggle(modelName, config.ss, config.bs)}
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={isConfigSelected(modelName, config.ss, config.bs)}
                            onCheckedChange={() =>
                              handleConfigToggle(modelName, config.ss, config.bs)
                            }
                          />
                        </TableCell>
                        <TableCell>{config.ss}</TableCell>
                        <TableCell>{config.bs}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>

                {idx < selectedModels.length - 1 && <Separator className="mt-4" />}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Section 3: Selected PEFs */}
      {selectedConfigs.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-1.5">
              <CardTitle>3. Selected PEFs</CardTitle>
              <Tooltip>
                <TooltipTrigger>
                  <HelpCircle className="size-4 cursor-help text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  SambaNova&apos;s AI stack will run the following Processor Executable Format
                  (PEF) files that are referenced by your selected model configurations.
                </TooltipContent>
              </Tooltip>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {Object.keys(selectedPefsByModel).map((modelName) => {
              const modelSelectedConfigs = selectedConfigs.filter(
                (c) => c.modelName === modelName
              );
              const dytPefNames = [
                ...new Set(
                  modelSelectedConfigs
                    .filter((c) => c.pefName.toLowerCase().includes('dyt'))
                    .map((c) => c.pefName)
                ),
              ];
              const nonDytConfigs = modelSelectedConfigs.filter(
                (c) => !c.pefName.toLowerCase().includes('dyt')
              );
              return (
                <div key={modelName}>
                  <p className="mb-1 text-sm font-semibold text-muted-foreground">{modelName}</p>
                  <ul className="ml-4 flex list-disc flex-col gap-1">
                    {dytPefNames.map((pefName) => {
                      const firstConfig = modelSelectedConfigs.find(
                        (c) => c.pefName === pefName
                      );
                      const version = firstConfig
                        ? getPefConfigForSsBs(pefName, firstConfig.ss, firstConfig.bs)
                            ?.latestVersion || '1'
                        : '1';
                      return (
                        <li key={pefName} className="flex items-center gap-1.5">
                          <span className="font-mono text-sm">
                            {pefName}:{version}
                          </span>
                        </li>
                      );
                    })}
                    {nonDytConfigs.map((config) => {
                      const version =
                        getPefConfigForSsBs(config.pefName, config.ss, config.bs)
                          ?.latestVersion || '1';
                      const hasDraftConfig = pefHasDraftModelConfig(
                        modelName,
                        config.ss,
                        config.bs
                      );
                      const canFixDraftConfig = draftConfigExistsButNotSelected(
                        modelName,
                        config.ss,
                        config.bs
                      );
                      return (
                        <li
                          key={`${config.pefName}-${config.ss}-${config.bs}`}
                          className="flex items-center gap-1.5"
                        >
                          <span className="font-mono text-sm">
                            {config.pefName}:{version}
                          </span>
                          {!hasDraftConfig && (
                            <>
                              <Tooltip>
                                <TooltipTrigger>
                                  <TriangleAlert className="size-4 text-amber-500" />
                                </TooltipTrigger>
                                <TooltipContent>
                                  No draft model assigned to this PEF for speculative decoding
                                </TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger
                                  className="rounded p-1 hover:bg-accent"
                                  onClick={() =>
                                    handleRemovePefConfig(modelName, config.ss, config.bs)
                                  }
                                >
                                  <Trash2 className="size-3.5 text-destructive" />
                                </TooltipTrigger>
                                <TooltipContent>Remove this config</TooltipContent>
                              </Tooltip>
                              {canFixDraftConfig && (
                                <Tooltip>
                                  <TooltipTrigger
                                    className="rounded p-1 hover:bg-accent"
                                    onClick={() =>
                                      handleAddMissingDraftConfig(modelName, config.ss, config.bs)
                                    }
                                  >
                                    <Wrench className="size-3.5 text-primary" />
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Add missing draft model configuration
                                  </TooltipContent>
                                </Tooltip>
                              )}
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* Section 4: Bundle YAML */}
      {selectedConfigs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>4. Bundle YAML</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={bundleNameId}>Bundle Name</FieldLabel>
                <Input
                  id={bundleNameId}
                  value={bundleName}
                  onChange={(e) => setBundleName(e.target.value)}
                />
                <FieldDescription>
                  Edit the bundle name (used for bt-* and b-* resources)
                </FieldDescription>
              </Field>
            </FieldGroup>

            {bundleName && bundleName !== bundleName.toLowerCase() && (
              <p className="text-xs text-destructive">
                Warning: Bundle name should be in lowercase
              </p>
            )}

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">Generated YAML</p>
                <Tooltip>
                  <TooltipTrigger
                    className={cn('rounded p-1 hover:bg-accent', copiedToClipboard && 'text-green-600')}
                    onClick={handleCopyToClipboard}
                    disabled={!generatedYaml}
                  >
                    <Copy className="size-4" />
                  </TooltipTrigger>
                  <TooltipContent>{copiedToClipboard ? 'Copied!' : 'Copy to clipboard'}</TooltipContent>
                </Tooltip>
              </div>
              <p className="text-sm text-muted-foreground">
                Please refer to our{' '}
                <a
                  href="https://docs.sambanova.ai/docs/en/admin/administration/custom-bundle-deployment"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  documentation
                </a>{' '}
                for an explanation of fields in the YAML.
              </p>
              <Textarea
                id={generatedYamlId}
                rows={25}
                value={generatedYaml}
                onChange={(e) => setGeneratedYaml(e.target.value)}
                className="font-mono text-sm"
              />
            </div>

            {/* Validation Result */}
            {validationResult && (
              <div className="flex flex-col gap-3">
                {validationResult.applyOutput && (
                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-semibold">kubectl apply output:</p>
                    <pre className="max-h-36 overflow-auto rounded-lg bg-muted p-2 font-mono text-xs">
                      {validationResult.applyOutput}
                    </pre>
                  </div>
                )}

                {validationResult.validationStatus && (
                  <div
                    className={cn(
                      'rounded-lg p-3',
                      validationResult.validationStatus.isValid
                        ? 'bg-green-500/10 text-green-700'
                        : 'bg-destructive/10 text-destructive'
                    )}
                  >
                    <p className="text-sm font-semibold">
                      {validationResult.validationStatus.isValid
                        ? 'Validation succeeded!'
                        : 'Validation failed with the following errors:'}
                    </p>
                    {!validationResult.validationStatus.isValid && (
                      <pre className="mt-2 max-h-72 overflow-auto rounded bg-black p-2 font-mono text-xs text-white whitespace-pre-wrap break-words">
                        {validationResult.validationStatus.message}
                      </pre>
                    )}
                  </div>
                )}

                {!validationResult.validationStatus && !validationResult.success && (
                  <Alert variant="destructive">
                    <AlertDescription className="font-semibold">
                      {validationResult.message}
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}

            {/* Save Result */}
            {saveResult && (
              <Alert
                variant={saveResult.success ? 'default' : 'destructive'}
                className={cn(saveResult.success && 'border-green-500/50 bg-green-500/10')}
              >
                <AlertDescription className={cn(saveResult.success && 'text-green-700')}>
                  {saveResult.message}
                </AlertDescription>
              </Alert>
            )}

            {/* Action Buttons */}
            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                size="lg"
                onClick={handleValidate}
                disabled={isValidating || !generatedYaml}
              >
                {isValidating && (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                )}
                {isValidating ? 'Validating...' : 'Validate'}
              </Button>
              <Button
                variant="outline"
                size="lg"
                onClick={handleSaveClick}
                disabled={isSaving || !generatedYaml || !bundleName}
              >
                {isSaving ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <Save data-icon="inline-start" />
                )}
                {isSaving ? 'Saving...' : 'Save'}
              </Button>
              <Button
                size="lg"
                onClick={handleCreateDeployment}
                disabled={!validationResult?.validationStatus?.isValid}
                className="bg-green-600 text-white hover:bg-green-700"
              >
                <Rocket data-icon="inline-start" />
                Create Deployment
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Save Overwrite Dialog */}
      <Dialog
        open={saveDialogOpen}
        onOpenChange={(open) => {
          if (!open) handleCancelSave();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>File Already Exists</DialogTitle>
            <DialogDescription>
              A file named <strong>{bundleName}.yaml</strong> already exists in saved_artifacts.
              Do you want to overwrite it?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelSave}>
              Cancel
            </Button>
            <Button onClick={handleOverwrite}>Overwrite</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
