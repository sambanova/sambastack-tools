export interface PefConfig {
  ss: string;
  bs: string;
  latestVersion: string;
}

export interface PefConfigs {
  [pefName: string]: PefConfig | PefConfig[];
}

export interface PefMapping {
  [modelName: string]: string[];
}

export interface CheckpointMapping {
  [modelName: string]: {
    path: string;
    resource_name: string;
    vision_embedding_checkpoint?: string;
  };
}

export interface ConfigSelection {
  modelName: string;
  ss: string;
  bs: string;
  pefName: string;
}
