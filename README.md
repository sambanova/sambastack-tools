<a href="https://sambanova.ai/">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./images/light-logo.png" height="100">
  <img alt="SambaNova logo" src="./images/dark-logo.png" height="100">
</picture>
</a>

# SambaStack Tools

## Overview

The `sambastack-tools` repository contains open-source tools designed to accelerate common user workflows on [SambaStack](https://docs.sambanova.ai/docs/en/admin/overview/sambastack-overview). These tools simplify and streamline tasks such as the creation and deployment of model bundles, helping administrators and developers work more efficiently with SambaStack environments.

## Available Tools

<table style="width: 100%;">
<thead>
<tr>
<th width="20%">Name</th>
<th width="60%">Description</th>
<th width="20%">Type</th>
</tr>
</thead>

<tbody>

<tr>
<td width="20%"><a href="sambawiz/README.md">SambaWiz</a></td>
<td width="60%">A GUI wizard that accelerates the creation and deployment of model bundles on SambaStack. Provides an intuitive interface for selecting models, configuring PEF settings, generating Kubernetes manifests, and deploying bundles to your cluster.</td>
<td width="20%">Web Application</td>
</tr>

</tbody>
</table>

## Getting Started

To use the tools in this repository, you will need access to a SambaStack environment. Learn more about SambaStack and contact SambaNova at [https://sambanova.ai/products/sambastack](https://sambanova.ai/products/sambastack) to sign up for a hosted, on-premise, or air-gapped instance of SambaStack.

Once you have access to a SambaStack environment:

1. Navigate to the folder containing the tool you want to use
2. Follow the installation and setup instructions in that tool's README
3. Each tool has its own prerequisites and configuration requirements

For example, to use SambaWiz:
```bash
cd sambawiz
# Follow the instructions in sambawiz/README.md
```

## Contributing

We welcome contributions that improve existing tools or add new functionality. Please see [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines on:

- Development workflow
- Branch protection rules
- Code quality standards
- Pull request guidelines
- Package owner responsibilities

## Questions or Issues?

- [Message us](https://community.sambanova.ai/latest) on SambaNova Community
- Create an issue on GitHub
- We're happy to help!

## License

This project is licensed under the Apache License, Version 2.0. See the LICENSE file for details.
