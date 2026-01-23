# Contributing to SambaStack Tools

Thank you for your interest in contributing to SambaNova's SambaStack Tools! This document provides guidelines and best practices for contributing to our repository.

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Branch Protection Rules](#branch-protection-rules)
- [Development Workflow](#development-workflow)
- [Code Quality Standards](#code-quality-standards)
- [Pull Request Guidelines](#pull-request-guidelines)
- [Package Owner Responsibilities](#package-owner-responsibilities)

## Overview

The `sambastack-tools` repository contains open-source tools to help accelerate common user workflows on [SambaStack](https://docs.sambanova.ai/docs/en/admin/overview/sambastack-overview), which include the creation and deployment of model bundles. We welcome contributions that improve existing tools or add new functionality.

## Getting Started

1. Create a branch (not a fork) for your contribution
2. Set up your development environment as specified in the README files for each individual tool folder
3. Make your changes following our coding standards
4. Submit a pull request

## Branch Protection Rules

The `main` branch is protected with the following rules:

- Pull requests must be up-to-date with the base branch
- All conversations must be resolved before merging
- At least one admin reviewer approval is required
- All GitHub Actions checks must pass

## Development Workflow

### Branch Naming Conventions

Use the following prefixes for your branches:

- `feature/` for new features (e.g., `feature/bundle-v3`)
- `improvement/` for improvements (e.g., `improvement/handle-private-models`)
- `bugfix/` for bug fixes (e.g., `bugfix/vectorstore`)
- `documentation/` for documentation (e.g., `documentation/tests`)
- `release/` for releases (e.g., `release/v1.0.1`)

### Code Quality Standards

#### Testing Requirements

- All contributions must pass the unit test suite as defined in each tool folder.
- Package owners must maintain up-to-date tests with good coverage
- New SambaStack tools should have unit test coverage that has been reviewed in a tests folder within the module. See the sambawiz tool for an example.

## Pull Request Guidelines

### Opening a PR

1. Use the appropriate prefix in your PR title:
   - `Feature:` for new features
   - `Improvement:` for improvements
   - `Bugfix:` for bug fixes
   - `Documentation:` for documentation
   - `Release:` for releases

2. Include:
   - Informative title following the above conventions
   - Detailed description
   - Appropriate label
   - Self-assignment

### Before Merging

Ensure:
- Branch is up-to-date with main
- All conversations are resolved
- At least one reviewer has approved
- All checks have passed
- Code is formatted and linted
- All tests pass

### After Merging

- Delete your branch

## Package Owner Responsibilities

Package owners must:

1. List dependencies and prerequisites in README files
2. Maintain up-to-date unit tests with good coverage
3. Implement both 'main' and 'github_pull_request' test suites
4. Clear all deprecation warnings
5. Update libraries monthly and coordinate with global dependency updates

## Questions or Issues?
- <a href="https://community.sambanova.ai/latest" target="_blank">,Message us</a> on SambaNova Community <a href="https://community.sambanova.ai/latest" 
- Create an issue on GitHub
- We're happy to help!

---

Note: These contribution guidelines are subject to change. Always refer to the latest version in the repository.