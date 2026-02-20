import type { CheckpointMapping, PefMapping, PefConfigs } from '../../types/bundle';

/**
 * Mock data for testing
 */

export const mockCheckpointMapping: CheckpointMapping = {
  'Meta-Llama-3.1-8B-Instruct': {
    path: '/checkpoints/llama-3.1-8b',
    resource_name: 'meta-llama-3-1-8b-instruct',
  },
  'Meta-Llama-3.1-70B-Instruct': {
    path: '/checkpoints/llama-3.1-70b',
    resource_name: 'meta-llama-3-1-70b-instruct',
  },
  'Qwen2.5-72B-Instruct': {
    path: '/checkpoints/qwen2.5-72b',
    resource_name: 'qwen2-5-72b-instruct',
  },
  'Llama-4-Maverick-17B-128E-Instruct': {
    path: '/checkpoints/llama-4-maverick',
    resource_name: 'llama-4-maverick-17b-128e-instruct',
    vision_embedding_checkpoint: '/checkpoints/llama-4-maverick-vision',
  },
};

export const mockPefMapping: PefMapping = {
  'Meta-Llama-3.1-8B-Instruct': [
    'COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss1024',
    'COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss2048',
    'COE_Meta-Llama-3-1-8B-Instruct_32k_bs16_ss1024',
  ],
  'Meta-Llama-3.1-70B-Instruct': [
    'COE_Meta-Llama-3-1-70B-Instruct_32k_bs1_ss1024',
    'COE_Meta-Llama-3-1-70B-Instruct_32k_bs1_ss2048',
    'COE_Meta-Llama-3-1-70B-Instruct_32k_bs16_ss1024',
  ],
  'Qwen2.5-72B-Instruct': [
    'COE_Qwen2-5-72B-Instruct_131k_bs1_ss4096',
    'COE_Qwen2-5-72B-Instruct_131k_bs16_ss4096',
  ],
  'Llama-4-Maverick-17B-128E-Instruct': [
    'llama-4-maverick-ss8192-bs1',
  ],
};

export const mockPefConfigs: PefConfigs = {
  'COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss1024': {
    ss: '4k',
    bs: '1',
    latestVersion: '1',
  },
  'COE_Meta-Llama-3-1-8B-Instruct_32k_bs1_ss2048': {
    ss: '8k',
    bs: '1',
    latestVersion: '1',
  },
  'COE_Meta-Llama-3-1-8B-Instruct_32k_bs16_ss1024': {
    ss: '4k',
    bs: '16',
    latestVersion: '1',
  },
  'COE_Meta-Llama-3-1-70B-Instruct_32k_bs1_ss1024': {
    ss: '4k',
    bs: '1',
    latestVersion: '1',
  },
  'COE_Meta-Llama-3-1-70B-Instruct_32k_bs1_ss2048': {
    ss: '8k',
    bs: '1',
    latestVersion: '1',
  },
  'COE_Meta-Llama-3-1-70B-Instruct_32k_bs16_ss1024': {
    ss: '4k',
    bs: '16',
    latestVersion: '1',
  },
  'COE_Qwen2-5-72B-Instruct_131k_bs1_ss4096': {
    ss: '4096',
    bs: '1',
    latestVersion: '1',
  },
  'COE_Qwen2-5-72B-Instruct_131k_bs16_ss4096': {
    ss: '4096',
    bs: '16',
    latestVersion: '1',
  },
  'llama-4-maverick-ss8192-bs1': {
    ss: '8k',
    bs: '1',
    latestVersion: '1',
  },
};

export const mockEnvironments = {
  environments: ['dev', 'staging', 'production'],
  currentEnvironment: 'dev',
  namespace: 'default',
  checkpointsDir: 'gs://my-bucket/checkpoints/',
};

export const mockBundleList = [
  { name: 'b-llama-bundle', template: 'bt-llama-bundle' },
  { name: 'b-qwen-bundle', template: 'bt-qwen-bundle' },
];

export const mockDeploymentList = [
  { name: 'llama-deployment', bundle: 'b-llama-bundle' },
  { name: 'qwen-deployment', bundle: 'b-qwen-bundle' },
];

export const mockPodStatus = {
  'llama-deployment': {
    cachePod: { ready: 1, total: 1, status: 'Running' },
    defaultPod: { ready: 1, total: 1, status: 'Running' },
  },
  'qwen-deployment': {
    cachePod: { ready: 0, total: 1, status: 'Pending' },
    defaultPod: { ready: 1, total: 1, status: 'Running' },
  },
};

export const mockDeploymentModels = {
  'llama-deployment': ['Meta-Llama-3.1-8B-Instruct'],
  'qwen-deployment': ['Qwen2.5-72B-Instruct'],
};

export const mockPodLogs = `2024-01-15 10:00:00 INFO Starting service
2024-01-15 10:00:01 INFO Loaded model successfully
2024-01-15 10:00:02 INFO Ready to serve requests`;

export const mockValidateResponse = {
  valid: true,
  errors: [],
  warnings: [],
};

export const mockPrerequisites = {
  kubectl: { installed: true, version: 'v1.28.0' },
  helm: { installed: true, version: 'v3.12.0' },
  kubeconfig: { valid: true, context: 'dev-cluster' },
};

export const mockKeycloakCredentials = {
  username: 'admin',
  password: 'admin123',
  url: 'https://keycloak.example.com',
};

// Mock kubectl responses
export const mockKubectlGetBundles = JSON.stringify({
  items: mockBundleList,
});

export const mockKubectlGetDeployments = JSON.stringify({
  items: mockDeploymentList,
});

export const mockKubectlGetPods = JSON.stringify({
  items: [
    {
      metadata: { name: 'llama-deployment-cache-0', labels: { deployment: 'llama-deployment' } },
      status: { phase: 'Running', containerStatuses: [{ ready: true }] },
    },
    {
      metadata: { name: 'llama-deployment-default-0', labels: { deployment: 'llama-deployment' } },
      status: { phase: 'Running', containerStatuses: [{ ready: true }] },
    },
  ],
});
