# Home Page

## Overview

The Home page is the landing page of SambaWiz where you configure your SambaStack environment. It allows you to select a Kubernetes environment, specify a namespace, and set up API credentials for accessing deployed models.

## What Happens on This Page

1. **Environment Selection**: Choose from pre-configured Kubernetes environments stored in `app-config.json`
2. **Namespace Configuration**: Specify the namespace where your bundles and deployments will be created
3. **API Configuration**: Set up API domain, UI domain, and API key for accessing deployed models
4. **Air-gapped clusters**: Nothing to set here. The local/NFS checkpoint mount (`spec.storage`) is set per deployment on the Model Deployment page with the **Air-gapped deployment** checkbox
5. **Prerequisites Check**: Automatically validates that required tools (kubectl, helm) are installed

## kubectl/helm Commands Used

This page validates your environment configuration using the following commands:

### 1. Helm List (Validation)
```bash
helm list -n <namespace> -o json
```
**Purpose**: Validates that the kubeconfig is working and checks the SambaStack helm chart version
**When**: Automatically when the page loads
**Namespace**: Uses the currently selected namespace from your configuration

### 2. Get Keycloak Credentials (Optional)
```bash
kubectl -n <namespace> get secret keycloak-initial-admin -o go-template='username: {{.data.username | base64decode}}{{"\n"}}password: {{.data.password | base64decode}}{{"\n"}}'
```
**Purpose**: Retrieves Keycloak admin username and password for API key generation
**When**: When you click "Get API Key"
**Namespace**: Uses the currently selected namespace from your configuration

## Configuration Storage

All configuration changes are saved to `app-config.json` in the root directory with the following structure:
- `currentKubeconfig`: Active environment name
- `kubeconfigs`: Object containing environment configurations
  - `file`: Path to kubeconfig YAML file
  - `namespace`: Kubernetes namespace
  - `apiKey`: API key for model inference
  - `apiDomain`: API endpoint domain
  - `uiDomain`: UI dashboard domain
  - `storage` *(air-gapped, CLI only)*: `hostPath` mount(s) the CLI adds as `spec.storage` to the deployments it generates. Not edited or used by the web UI, and applying settings here leaves it as it is.
