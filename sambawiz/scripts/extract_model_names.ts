#!/usr/bin/env ts-node

/**
 * Extract Model Names Script
 *
 * This script fetches all models from the Kubernetes cluster and adds missing entries
 * to app/data/checkpoint_mapping.json with empty path values.
 *
 * Usage:
 *   npx tsx scripts/extract_model_names.ts
 *
 * Requirements:
 *   - app-config.json must exist with valid currentKubeconfig and namespace
 *   - kubectl must be configured and accessible
 *   - User must have permissions to access the cluster
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface KubectlModel {
  metadata: {
    name: string;
  };
  spec: {
    name: string;
  };
}

interface KubectlOutput {
  items: KubectlModel[];
}

interface CheckpointMapping {
  [key: string]: {
    path: string;
    resource_name: string;
  };
}

interface AppConfig {
  currentKubeconfig: string;
  kubeconfigs: {
    [key: string]: {
      file: string;
      namespace: string;
    };
  };
}

async function main() {
  try {
    // Read app-config.json to get the namespace
    const appConfigPath = path.join(__dirname, '..', 'app-config.json');

    if (!fs.existsSync(appConfigPath)) {
      console.error('Error: app-config.json not found. Please create it first.');
      process.exit(1);
    }

    const appConfigContent = fs.readFileSync(appConfigPath, 'utf-8');
    const appConfig: AppConfig = JSON.parse(appConfigContent);

    const currentEnv = appConfig.currentKubeconfig;
    if (!currentEnv || !appConfig.kubeconfigs[currentEnv]) {
      console.error(`Error: Current environment "${currentEnv}" not found in kubeconfigs.`);
      process.exit(1);
    }

    const namespace = appConfig.kubeconfigs[currentEnv].namespace;
    const kubeconfigFile = appConfig.kubeconfigs[currentEnv].file;
    const kubeconfigPath = path.join(__dirname, '..', kubeconfigFile);

    if (!fs.existsSync(kubeconfigPath)) {
      console.error(`Error: Kubeconfig file not found at ${kubeconfigPath}`);
      process.exit(1);
    }

    console.log(`Using environment: ${currentEnv}`);
    console.log(`Using namespace: ${namespace}`);
    console.log(`Using kubeconfig: ${kubeconfigFile}`);

    // Execute kubectl command to get models
    console.log('\nFetching models from Kubernetes cluster...');
    const kubectlCommand = `kubectl --kubeconfig="${kubeconfigPath}" -n ${namespace} get models -o json`;
    const output = execSync(kubectlCommand, { encoding: 'utf-8' });

    const kubectlData: KubectlOutput = JSON.parse(output);

    if (!kubectlData.items || kubectlData.items.length === 0) {
      console.log('No models found in the cluster.');
      return;
    }

    console.log(`Found ${kubectlData.items.length} model(s) in the cluster.`);

    // Read existing checkpoint_mapping.json
    const checkpointMappingPath = path.join(__dirname, '..', 'app', 'data', 'checkpoint_mapping.json');
    let checkpointMapping: CheckpointMapping = {};

    if (fs.existsSync(checkpointMappingPath)) {
      const checkpointMappingContent = fs.readFileSync(checkpointMappingPath, 'utf-8');
      checkpointMapping = JSON.parse(checkpointMappingContent);
      console.log('Loaded existing checkpoint_mapping.json');
    } else {
      console.log('checkpoint_mapping.json not found. Creating new file.');
    }

    // Add missing models to checkpoint_mapping
    let addedCount = 0;
    let skippedCount = 0;

    for (const model of kubectlData.items) {
      const modelName = model.spec.name;
      const resourceName = model.metadata.name;

      if (!checkpointMapping[modelName]) {
        checkpointMapping[modelName] = {
          path: '',
          resource_name: resourceName
        };
        console.log(`✓ Added: ${modelName} (resource: ${resourceName})`);
        addedCount++;
      } else {
        console.log(`- Skipped (already exists): ${modelName}`);
        skippedCount++;
      }
    }

    // Write updated checkpoint_mapping back to file
    fs.writeFileSync(
      checkpointMappingPath,
      JSON.stringify(checkpointMapping, null, 2) + '\n',
      'utf-8'
    );

    console.log('\n=== Summary ===');
    console.log(`Total models in cluster: ${kubectlData.items.length}`);
    console.log(`Added to checkpoint_mapping.json: ${addedCount}`);
    console.log(`Skipped (already exists): ${skippedCount}`);
    console.log(`\ncheckpoint_mapping.json updated successfully!`);

  } catch (error) {
    if (error instanceof Error) {
      console.error('Error:', error.message);
    } else {
      console.error('An unexpected error occurred:', error);
    }
    process.exit(1);
  }
}

main();
