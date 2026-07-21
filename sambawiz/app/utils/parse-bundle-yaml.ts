import yaml from 'js-yaml';
import type { ModelConfigEntry, SpecDecodingPair } from '@/app/types/bundle';

/**
 * V3 `ModelBundle` parser (Q9 — V3-only, no backwards compatibility with V2
 * `BundleTemplate`/`Bundle` input). Replaces the old
 * `parseBundleYamlContent`, which parsed `kind: BundleTemplate` documents.
 */

interface YamlModelBundleDocument {
  kind?: string;
  metadata?: {
    name?: string;
  };
  spec?: {
    modelConfigs?: unknown;
    specDecodingPairs?: unknown;
  };
}

export interface ParsedModelBundleState {
  bundleName: string;
  modelConfigs: ModelConfigEntry[];
  specDecodingPairs: SpecDecodingPair[];
}

export type ParseError = { error: string };

/**
 * Splits a `modelConfigs[].model` ref (`<crname>[:<arch>][:<version>]`) back
 * into its parts. Exposed as a small ref helper alongside the generator's
 * `formatModelRef`, for any future UI that wants to reconstruct selection
 * state from a loaded bundle.
 */
export function parseModelRef(ref: string): { crname: string; arch?: string; version?: string } {
  const parts = ref.split(':');
  if (parts.length >= 3) {
    return { crname: parts[0], arch: parts[1], version: parts.slice(2).join(':') };
  }
  if (parts.length === 2) {
    return { crname: parts[0], version: parts[1] };
  }
  return { crname: parts[0] };
}

function isModelConfigEntry(value: unknown): value is ModelConfigEntry {
  return typeof value === 'object' && value !== null && typeof (value as { model?: unknown }).model === 'string';
}

function isSpecDecodingPair(value: unknown): value is SpecDecodingPair {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { target?: unknown }).target === 'string' &&
    typeof (value as { draft?: unknown }).draft === 'string'
  );
}

export function parseModelBundleYamlContent(yamlContent: string): ParsedModelBundleState | ParseError {
  let documents: Array<Record<string, unknown>>;
  try {
    documents = yaml.loadAll(yamlContent) as Array<Record<string, unknown>>;
  } catch (err) {
    return { error: `Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}` };
  }

  const modelBundle = documents.find((doc) => doc?.kind === 'ModelBundle') as
    | YamlModelBundleDocument
    | undefined;

  if (!modelBundle) {
    return { error: 'Unsupported YAML structure: expecting a document with "kind: ModelBundle"' };
  }

  const bundleName = modelBundle.metadata?.name;
  if (!bundleName) {
    return { error: 'Unsupported YAML structure: expecting "metadata.name" in ModelBundle' };
  }

  const rawModelConfigs = modelBundle.spec?.modelConfigs;
  if (!Array.isArray(rawModelConfigs) || rawModelConfigs.length === 0) {
    return { error: 'Unsupported YAML structure: expecting a non-empty "spec.modelConfigs" array in ModelBundle' };
  }

  const modelConfigs: ModelConfigEntry[] = [];
  for (let i = 0; i < rawModelConfigs.length; i++) {
    const entry = rawModelConfigs[i];
    if (!isModelConfigEntry(entry)) {
      return { error: `Unsupported YAML structure: expecting a "model" string at "spec.modelConfigs[${i}]"` };
    }

    const hasProfile = typeof entry.profile === 'string';
    const hasProfileDefinition = entry.profileDefinition !== undefined && entry.profileDefinition !== null;
    if (hasProfile === hasProfileDefinition) {
      return {
        error: `Unsupported YAML structure: expecting exactly one of "profile" or "profileDefinition" at "spec.modelConfigs[${i}]" (model "${entry.model}")`,
      };
    }

    modelConfigs.push(entry);
  }

  const rawSpecDecodingPairs = modelBundle.spec?.specDecodingPairs;
  const specDecodingPairs: SpecDecodingPair[] = [];
  if (rawSpecDecodingPairs !== undefined) {
    if (!Array.isArray(rawSpecDecodingPairs)) {
      return { error: 'Unsupported YAML structure: expecting "spec.specDecodingPairs" to be an array' };
    }
    for (let i = 0; i < rawSpecDecodingPairs.length; i++) {
      const pair = rawSpecDecodingPairs[i];
      if (!isSpecDecodingPair(pair)) {
        return {
          error: `Unsupported YAML structure: expecting "target" and "draft" strings at "spec.specDecodingPairs[${i}]"`,
        };
      }
      specDecodingPairs.push(pair);
    }
  }

  return {
    bundleName,
    modelConfigs,
    specDecodingPairs,
  };
}
