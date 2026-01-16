import { getAvailableModels } from '../model-availability';
import type { CheckpointMapping, PefMapping, PefConfigs } from '../../types/bundle';

describe('getAvailableModels', () => {
  it('should return models that exist in all three mappings', () => {
    const checkpointMapping: CheckpointMapping = {
      'Model-A': { path: 'path/to/model-a', resource_name: 'model-a' },
      'Model-B': { path: 'path/to/model-b', resource_name: 'model-b' },
    };

    const pefMapping: PefMapping = {
      'Model-A': ['model-a-ss4k-bs1', 'model-a-ss8k-bs1'],
      'Model-B': ['model-b-ss4k-bs1'],
    };

    const pefConfigs: PefConfigs = {
      'model-a-ss4k-bs1': { ss: '4k', bs: '1', latestVersion: '1' },
      'model-a-ss8k-bs1': { ss: '8k', bs: '1', latestVersion: '1' },
      'model-b-ss4k-bs1': { ss: '4k', bs: '1', latestVersion: '1' },
    };

    const result = getAvailableModels(checkpointMapping, pefMapping, pefConfigs);
    expect(result).toEqual(['Model-A', 'Model-B']);
  });

  it('should filter out models with empty checkpoint path', () => {
    const checkpointMapping: CheckpointMapping = {
      'Model-A': { path: '', resource_name: 'model-a' },
      'Model-B': { path: 'path/to/model-b', resource_name: 'model-b' },
    };

    const pefMapping: PefMapping = {
      'Model-A': ['model-a-ss4k-bs1'],
      'Model-B': ['model-b-ss4k-bs1'],
    };

    const pefConfigs: PefConfigs = {
      'model-a-ss4k-bs1': { ss: '4k', bs: '1', latestVersion: '1' },
      'model-b-ss4k-bs1': { ss: '4k', bs: '1', latestVersion: '1' },
    };

    const result = getAvailableModels(checkpointMapping, pefMapping, pefConfigs);
    expect(result).toEqual(['Model-B']);
  });

  it('should filter out models with empty pef mapping array', () => {
    const checkpointMapping: CheckpointMapping = {
      'Model-A': { path: 'path/to/model-a', resource_name: 'model-a' },
      'Model-B': { path: 'path/to/model-b', resource_name: 'model-b' },
    };

    const pefMapping: PefMapping = {
      'Model-A': [],
      'Model-B': ['model-b-ss4k-bs1'],
    };

    const pefConfigs: PefConfigs = {
      'model-b-ss4k-bs1': { ss: '4k', bs: '1', latestVersion: '1' },
    };

    const result = getAvailableModels(checkpointMapping, pefMapping, pefConfigs);
    expect(result).toEqual(['Model-B']);
  });

  it('should filter out models not in checkpoint mapping', () => {
    const checkpointMapping: CheckpointMapping = {
      'Model-B': { path: 'path/to/model-b', resource_name: 'model-b' },
    };

    const pefMapping: PefMapping = {
      'Model-A': ['model-a-ss4k-bs1'],
      'Model-B': ['model-b-ss4k-bs1'],
    };

    const pefConfigs: PefConfigs = {
      'model-a-ss4k-bs1': { ss: '4k', bs: '1', latestVersion: '1' },
      'model-b-ss4k-bs1': { ss: '4k', bs: '1', latestVersion: '1' },
    };

    const result = getAvailableModels(checkpointMapping, pefMapping, pefConfigs);
    expect(result).toEqual(['Model-B']);
  });

  it('should filter out models not in pef mapping', () => {
    const checkpointMapping: CheckpointMapping = {
      'Model-A': { path: 'path/to/model-a', resource_name: 'model-a' },
      'Model-B': { path: 'path/to/model-b', resource_name: 'model-b' },
    };

    const pefMapping: PefMapping = {
      'Model-B': ['model-b-ss4k-bs1'],
    };

    const pefConfigs: PefConfigs = {
      'model-b-ss4k-bs1': { ss: '4k', bs: '1', latestVersion: '1' },
    };

    const result = getAvailableModels(checkpointMapping, pefMapping, pefConfigs);
    expect(result).toEqual(['Model-B']);
  });

  it('should filter out models with no available PEF configs (dynamic check)', () => {
    const checkpointMapping: CheckpointMapping = {
      'Model-A': { path: 'path/to/model-a', resource_name: 'model-a' },
      'Model-B': { path: 'path/to/model-b', resource_name: 'model-b' },
    };

    const pefMapping: PefMapping = {
      'Model-A': ['model-a-ss4k-bs1', 'model-a-ss8k-bs1'],
      'Model-B': ['model-b-ss4k-bs1'],
    };

    const pefConfigs: PefConfigs = {
      // Model-A's PEF configs are missing
      'model-b-ss4k-bs1': { ss: '4k', bs: '1', latestVersion: '1' },
    };

    const result = getAvailableModels(checkpointMapping, pefMapping, pefConfigs);
    expect(result).toEqual(['Model-B']);
  });

  it('should include model if at least one PEF config is available', () => {
    const checkpointMapping: CheckpointMapping = {
      'Model-A': { path: 'path/to/model-a', resource_name: 'model-a' },
    };

    const pefMapping: PefMapping = {
      'Model-A': ['model-a-ss4k-bs1', 'model-a-ss8k-bs1', 'model-a-ss16k-bs1'],
    };

    const pefConfigs: PefConfigs = {
      // Only one of the three PEF configs is available
      'model-a-ss8k-bs1': { ss: '8k', bs: '1', latestVersion: '1' },
    };

    const result = getAvailableModels(checkpointMapping, pefMapping, pefConfigs);
    expect(result).toEqual(['Model-A']);
  });

  it('should return sorted array', () => {
    const checkpointMapping: CheckpointMapping = {
      'Zebra-Model': { path: 'path/to/zebra', resource_name: 'zebra' },
      'Alpha-Model': { path: 'path/to/alpha', resource_name: 'alpha' },
      'Beta-Model': { path: 'path/to/beta', resource_name: 'beta' },
    };

    const pefMapping: PefMapping = {
      'Zebra-Model': ['zebra-ss4k-bs1'],
      'Alpha-Model': ['alpha-ss4k-bs1'],
      'Beta-Model': ['beta-ss4k-bs1'],
    };

    const pefConfigs: PefConfigs = {
      'zebra-ss4k-bs1': { ss: '4k', bs: '1', latestVersion: '1' },
      'alpha-ss4k-bs1': { ss: '4k', bs: '1', latestVersion: '1' },
      'beta-ss4k-bs1': { ss: '4k', bs: '1', latestVersion: '1' },
    };

    const result = getAvailableModels(checkpointMapping, pefMapping, pefConfigs);
    expect(result).toEqual(['Alpha-Model', 'Beta-Model', 'Zebra-Model']);
  });

  it('should return empty array when no models are available', () => {
    const checkpointMapping: CheckpointMapping = {};
    const pefMapping: PefMapping = {};
    const pefConfigs: PefConfigs = {};

    const result = getAvailableModels(checkpointMapping, pefMapping, pefConfigs);
    expect(result).toEqual([]);
  });
});
