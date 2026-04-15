# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in PulSeed, please report it responsibly.

**Preferred:** Use GitHub's [private security advisory](https://github.com/my-name-is-yu/PulSeed/security/advisories) feature for coordinated disclosure before any public announcement.

**Email:** security@pulseed.dev

When reporting, please include:
- A description of the vulnerability
- Steps to reproduce (if applicable)
- Potential impact
- Suggested fix (if available)

Do not open a public GitHub issue for security vulnerabilities.

**Response timeline:**
- Initial acknowledgment: within 48 hours
- Triage and severity assessment: within 7 days
- Resolution or mitigation plan: within 30 days
- Credit to the reporter upon release (unless you prefer anonymity)

---

## Scope

The following are **in scope** for security reports:

- **Core orchestrator** (`src/` — CoreLoop, GoalNegotiator, TaskLifecycle, SessionManager, and related modules)
- **CLI** (`src/cli/` — `pulseed` command and all subcommands)
- **Built-in plugins / adapters** (`src/adapters/` — claude-code-cli, claude-api, openai-codex, github-issue, shell/file-existence data sources)
- **State persistence layer** (access to and handling of `~/.pulseed/` state files)
- **EthicsGate** — approval gate bypass or circumvention

The following are **out of scope:**

- Vulnerabilities in LLM providers (OpenAI, Anthropic) — report those directly to the respective vendor
- Third-party plugins not distributed with PulSeed
- The user's own API key management practices
- OS-level sandbox escapes from the user's own machine
- Social engineering attacks

---

## Security Model

PulSeed is a local-first orchestrator. Its trust boundaries are as follows:

### LLM Calls
PulSeed calls external LLM APIs (OpenAI, Anthropic) for goal decomposition, observation, and task generation. API keys are read from environment variables or `~/.pulseed/provider.json`. All LLM responses are treated as untrusted input: they pass through a Zod schema validation and sanitization pipeline before any data is acted upon. Errors in this pipeline are always logged — they are never silently swallowed.

### Agent Execution
PulSeed has two task execution families:

- Native `agent_loop` execution runs PulSeed's bounded tool-using runtime. When `agent_loop.worktree.enabled` is configured, task execution happens in a detached git worktree and can preserve or clean up that worktree according to the configured policy.
- Supported CLI adapters such as Claude Code CLI and OpenAI Codex CLI spawn subprocesses. They can run through the local process backend or through the configured Docker terminal backend. The Docker backend mounts the task cwd into the container and defaults container networking to `none`.

Git worktrees isolate repository changes from the primary checkout, but they are not an OS privilege boundary. The local process backend runs with the user's OS privileges. Docker provides a stronger process and network boundary for supported CLI adapters, but its protection depends on the Docker image, volume configuration, and host Docker setup.

The EthicsGate (L1) provides a software-level safety check — evaluating proposed actions against mechanical rules and, for ambiguous cases, an LLM judgment — but this is not a substitute for a host-level sandbox when running untrusted work.

Irreversible actions (file deletion, external API mutations, state modifications) always require explicit human approval, regardless of trust score or confidence level. PulSeed never executes these directly; it delegates and verifies.

### Trust Scoring
PulSeed maintains an asymmetric trust score per agent (range `[-100, +100]`). The penalty for failure (−10) is significantly larger than the reward for success (+3). This prevents unwarranted autonomy after a few good runs. High trust does not bypass the approval requirement for irreversible actions.

### File Access
All persistent state is stored under `~/.pulseed/`. This directory may contain goal definitions, observation history, session logs, strategy state, and plugin code. It is readable by any process running as the same OS user.

### Plugin Loading
Plugins are loaded dynamically from `~/.pulseed/plugins/`. A malicious or compromised plugin in this directory executes with full user privileges. PulSeed does not verify plugin signatures or perform source code validation. Only install plugins from sources you trust.

---

## Known Considerations

### API Key Storage
API keys for LLM providers may be stored in `~/.pulseed/provider.json` or passed via environment variables. PulSeed does not encrypt keys at rest. Recommended practices:
- Set restrictive permissions on the config file: `chmod 600 ~/.pulseed/provider.json`
- Do not commit `~/.pulseed/provider.json` or `.env` files containing keys to version control
- Rotate keys regularly

### Agent Execution Sandbox Limitations
The EthicsGate performs rule-based and LLM-based checks on proposed agent actions before execution. It operates entirely in software and cannot guarantee prevention against a sufficiently crafted prompt or a compromised LLM response.

Worktree isolation helps keep native `agent_loop` file changes out of the primary checkout, but a process running in that worktree still has the privileges granted to the PulSeed process and its tools. Docker terminal backends give supported CLI adapters a configurable process and network boundary, but only for those subprocess-backed adapters.

Users running PulSeed against untrusted goals, in shared environments, or automating high-risk tasks should use Docker-backed CLI adapters, run PulSeed itself inside a container, or use a VM for additional isolation.

### LLM Prompt Injection
PulSeed passes user-supplied goal descriptions and observed state into LLM prompts. A maliciously crafted goal string could attempt to manipulate LLM output (prompt injection). All LLM responses are validated through a schema pipeline, which reduces the blast radius, but does not eliminate the risk entirely. Review goals before executing the core loop.

### State Directory Permissions
The `~/.pulseed/` directory is created with the user's default umask. On multi-user systems, verify that the directory is not world-readable (`chmod 700 ~/.pulseed`).
