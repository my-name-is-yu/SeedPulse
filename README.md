<div align="center">

<img src="assets/seedy.png" alt="Seedy - PulSeed mascot" width="120" />

# PulSeed

Goal-driven orchestration for long-running work.

[![Website](https://img.shields.io/badge/Website-pulseed.dev-blue?style=flat-square)](https://pulseed.dev)
[![CI](https://img.shields.io/github/actions/workflow/status/my-name-is-yu/PulSeed/ci.yml?branch=main&label=CI&style=flat-square)](https://github.com/my-name-is-yu/PulSeed/actions/workflows/ci.yml)
[![Publish](https://img.shields.io/github/actions/workflow/status/my-name-is-yu/PulSeed/publish.yml?label=Publish&style=flat-square)](https://github.com/my-name-is-yu/PulSeed/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/pulseed.svg?style=flat-square)](https://www.npmjs.com/package/pulseed)
[![npm downloads](https://img.shields.io/npm/dm/pulseed.svg?style=flat-square)](https://www.npmjs.com/package/pulseed)
[![Node.js >=20](https://img.shields.io/badge/node-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Security Policy](https://img.shields.io/badge/security-policy-brightgreen.svg?style=flat-square)](SECURITY.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)

</div>

PulSeed is an AI agent orchestrator for goals that need more than one chat turn.

Naming note: `PulSeed` is the product name, and `pulseed` is the CLI and npm package name.

## Quick Start

1. Install Node.js 20 or newer.
2. Install the CLI:

```bash
npm install -g pulseed
```

3. Start PulSeed:

```bash
pulseed
```

Then describe what you want in natural language, such as "Increase test coverage to 90%."

## Current Architecture

PulSeed uses two layers:

- `CoreLoop` keeps a goal moving, checks progress, and decides whether to continue, refine, verify, or stop
- `AgentLoop` handles bounded tool-using work such as task execution, chat turns, and selected runtime phases

State, reports, schedules, and local memory live under `~/.pulseed/`.

Security boundary: PulSeed uses approval gates and verification around delegated work.
Native `agent_loop` task execution can use isolated git worktrees, and supported
CLI adapters can be wrapped with a Docker terminal backend. These reduce blast
radius, but local backends and plugins still run with the user's privileges. See
[Security](SECURITY.md).

## Main Command

```bash
pulseed
```

PulSeed is designed so the primary workflow can happen through natural language.
Use the lower-level CLI commands only when you need scriptable or diagnostic control.

## Docs

- [Getting Started](docs/getting-started.md)
- [Docs Index](docs/index.md)
- [Mechanism](docs/mechanism.md)
- [Runtime](docs/runtime.md)
- [Configuration](docs/configuration.md)
- [Architecture Map](docs/architecture-map.md)

## Release

Run releases from a clean, up-to-date `main` branch:

```bash
npm run release -- 0.4.9
```

The script updates the package version, runs release verification including
docs, typecheck, boundary lint, full tests, production audit, and an npm pack
dry run, pushes `main`, then pushes the matching `v*` tag. The tag push triggers
GitHub Actions to publish to npm through Trusted Publishing.

## License

MIT
