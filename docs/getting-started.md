# Getting Started

This is the shortest path from install to a first goal run.

## 1. Install

PulSeed supports Node.js 22 or 24.

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/my-name-is-yu/PulSeed/main/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/my-name-is-yu/PulSeed/main/scripts/install.ps1 | iex
```

On Windows, the installer attempts Node.js bootstrap via `winget` when Node.js/npm are missing.

Reproducible alternative (pin to a release tag):

```bash
curl -fsSL https://raw.githubusercontent.com/my-name-is-yu/PulSeed/refs/tags/<tag>/scripts/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/my-name-is-yu/PulSeed/refs/tags/<tag>/scripts/install.ps1 | iex
```

Fallback:

```bash
npm install -g pulseed
```

If global npm install fails with `EACCES`/`EPERM`, use a user-local npm path:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
npm install -g pulseed
```

```powershell
$prefix = "$HOME\.npm-global"
npm config set prefix $prefix
$env:Path = "$prefix;$env:Path"
[Environment]::SetEnvironmentVariable("Path", "$prefix;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
npm install -g pulseed
```

Optional installer flags (for example, fixed version or dry run):

```bash
curl -fsSL https://raw.githubusercontent.com/my-name-is-yu/PulSeed/main/scripts/install.sh | bash -s -- --version x.y.z --dry-run
```

```powershell
$installer = irm https://raw.githubusercontent.com/my-name-is-yu/PulSeed/main/scripts/install.ps1
& ([ScriptBlock]::Create($installer)) -Version x.y.z -DryRun
```

## 2. Start PulSeed

Run:

```bash
pulseed
```

PulSeed will guide setup when needed. It writes local state under `~/.pulseed/`, including provider selection, goals, tasks, reports, runtime data, schedules, memory, and Soil projections.

## 3. Work in natural language

Describe what you want PulSeed to do:

- "Increase test coverage to 90%."
- "Show me the current progress."
- "Run the next useful step."
- "Keep this goal moving in the background."

The default public path is `pulseed` plus natural language. Lower-level subcommands exist for automation, debugging, and compatibility, but they are not the main getting-started flow.

## 4. What runs where

- `CoreLoop` handles goal-level control, including continuation, refinement, verification, and completion checks
- `AgentLoop` handles bounded tool use for tasks, chat, and runtime phases that need a short-lived executor
- Local state lives under `~/.pulseed/`

## Next Docs

- [Docs Index](index.md)
- [Mechanism](mechanism.md)
- [Runtime](runtime.md)
- [Configuration](configuration.md)
- [Architecture Map](architecture-map.md)
