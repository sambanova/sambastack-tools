import { parseModelBundleYamlContent, parseModelRef, type ParsedModelBundleState } from '../parse-bundle-yaml';
import { generateModelBundleYaml, type ModelBundleSelection } from '../bundle-yaml-generator';
import {
  mockSingleArchModel,
  mockMultiArchModel,
  mockHighInteractivityProfile,
  mockSpecDecodingTargetModel,
  mockSpecDecodingDraftModel,
  mockSpecDecodingTargetProfile,
  mockSpecDecodingDraftProfile,
} from './v3-mock-data';

describe('parse-bundle-yaml', () => {
  describe('parseModelRef', () => {
    it('parses a bare crname:version ref', () => {
      expect(parseModelRef('e5-mistral-7b-instruct:1')).toEqual({
        crname: 'e5-mistral-7b-instruct',
        version: '1',
      });
    });

    it('parses a crname:arch:version ref', () => {
      expect(parseModelRef('llama-4-maverick-17b-128e-instruct:llama-4-maverick:1')).toEqual({
        crname: 'llama-4-maverick-17b-128e-instruct',
        arch: 'llama-4-maverick',
        version: '1',
      });
    });

    it('parses a bare crname (no version/arch), as used in specDecodingPairs', () => {
      expect(parseModelRef('meta-llama-3-3-70b-instruct')).toEqual({
        crname: 'meta-llama-3-3-70b-instruct',
      });
    });
  });

  describe('parseModelBundleYamlContent', () => {
    it('rejects non-ModelBundle input (e.g. V2 BundleTemplate)', () => {
      const v2Yaml = `apiVersion: sambanova.ai/v1alpha1
kind: BundleTemplate
metadata:
  name: bt-my-bundle
spec:
  models:
    some-model:
      experts:
        8k:
          configs:
          - pef: some-pef:1
`;
      const result = parseModelBundleYamlContent(v2Yaml);
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toMatch(/kind: ModelBundle/);
    });

    it('rejects a ModelBundle with an empty modelConfigs array', () => {
      const emptyYaml = `apiVersion: sambanova.ai/v1alpha1
kind: ModelBundle
metadata:
  name: empty-bundle
spec:
  modelConfigs: []
`;
      const result = parseModelBundleYamlContent(emptyYaml);
      expect(result).toHaveProperty('error');
    });

    it('rejects a modelConfigs entry with both profile and profileDefinition', () => {
      const badYaml = `apiVersion: sambanova.ai/v1alpha1
kind: ModelBundle
metadata:
  name: bad-bundle
spec:
  modelConfigs:
  - model: some-model:1
    profile: some-profile
    profileDefinition:
      model_arch: some-arch
`;
      const result = parseModelBundleYamlContent(badYaml);
      expect(result).toHaveProperty('error');
    });

    it('rejects a modelConfigs entry with neither profile nor profileDefinition', () => {
      const badYaml = `apiVersion: sambanova.ai/v1alpha1
kind: ModelBundle
metadata:
  name: bad-bundle
spec:
  modelConfigs:
  - model: some-model:1
`;
      const result = parseModelBundleYamlContent(badYaml);
      expect(result).toHaveProperty('error');
    });

    it('round-trips a generated single-model ModelBundle', () => {
      const selections: ModelBundleSelection[] = [
        { model: mockSingleArchModel, arch: 'e5-mistral', profile: mockHighInteractivityProfile },
      ];
      const yamlStr = generateModelBundleYaml('round-trip-bundle', selections);
      const parsed = parseModelBundleYamlContent(yamlStr) as ParsedModelBundleState;

      expect(parsed.bundleName).toBe('round-trip-bundle');
      expect(parsed.modelConfigs).toHaveLength(1);
      expect(parsed.modelConfigs[0].model).toBe('e5-mistral-7b-instruct:1');
      expect(parsed.modelConfigs[0].profile).toBe('gpt-oss-fp8-dyt');
      // mockSingleArchModel is an embedding model, so generation adds is_default:true to the
      // smallest tier (8k) per Q2 — the only divergence from the profile default. Every tier's
      // batch sizes still match the default, so generation collapses each to the '*' sentinel.
      expect(parsed.modelConfigs[0].batchingConfig).toEqual({
        '8k': { batch_sizes: '*', is_default: true },
        '32k': { batch_sizes: '*' },
        '64k': { batch_sizes: '*' },
        '128k': { batch_sizes: '*' },
      });
      expect(parsed.specDecodingPairs).toEqual([]);
    });

    it('round-trips a multi-arch model ref', () => {
      const selections: ModelBundleSelection[] = [
        { model: mockMultiArchModel, arch: 'llama-4-maverick-v2', profile: mockHighInteractivityProfile },
      ];
      const yamlStr = generateModelBundleYaml('multi-arch-bundle', selections);
      const parsed = parseModelBundleYamlContent(yamlStr) as ParsedModelBundleState;

      expect(parsed.modelConfigs[0].model).toBe('llama-4-maverick-17b-128e-instruct:llama-4-maverick-v2:1');
      expect(parseModelRef(parsed.modelConfigs[0].model)).toEqual({
        crname: 'llama-4-maverick-17b-128e-instruct',
        arch: 'llama-4-maverick-v2',
        version: '1',
      });
    });

    it('round-trips a full spec-decoding bundle (target + draft, specDecodingPairs, routable:false)', () => {
      const selections: ModelBundleSelection[] = [
        {
          model: mockSpecDecodingDraftModel,
          arch: 'llama-3p2-1b',
          profile: mockSpecDecodingDraftProfile,
          isDraftFor: mockSpecDecodingTargetModel.metadata.name,
        },
        {
          model: mockSpecDecodingTargetModel,
          arch: 'llama-3p3-70b',
          profile: mockSpecDecodingTargetProfile,
        },
      ];
      const yamlStr = generateModelBundleYaml('spec-decode-round-trip', selections);
      const parsed = parseModelBundleYamlContent(yamlStr) as ParsedModelBundleState;

      expect(parsed.bundleName).toBe('spec-decode-round-trip');
      expect(parsed.modelConfigs).toHaveLength(2);
      expect(parsed.specDecodingPairs).toEqual([
        { draft: 'meta-llama-3-2-1b-instruct', target: 'meta-llama-3-3-70b-instruct' },
      ]);
      expect(parsed.specDecodingPairs[0]).not.toHaveProperty('experts');

      const draftEntry = parsed.modelConfigs.find((c) => c.model.startsWith('meta-llama-3-2-1b-instruct'));
      expect(draftEntry?.modelSettings).toEqual({ routable: false });

      const targetEntry = parsed.modelConfigs.find((c) => c.model.startsWith('meta-llama-3-3-70b-instruct'));
      expect(targetEntry?.modelSettings).toBeUndefined();
    });
  });
});
