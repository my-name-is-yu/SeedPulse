# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Motiva — AI agent orchestrator that gives existing agents "motivation." Instead of being a plugin inside an agent, Motiva sits above agents and drives them: selecting goals, spawning agent sessions, observing results, and judging completion. Motiva doesn't think — it makes agents think.

## Status

Architecture pivot complete. Redesign phase — no implementation code yet. Previous PoC (Hooks-based plugin) archived in `archive/`.

## Core Concept

- 4-element model: Goal (with thresholds) → Current State (observation + confidence) → Gap → Constraints
- Orchestrator loop: goal → spawn agent session → observe results → update state → next task (NEVER STOP)
- Adapter pattern: agent-agnostic (Claude Code CLI, Claude API, custom adapters)
- Motiva calls LLMs (for goal decomposition, observation) — it is the caller, not the callee

## Tech Stack

- Node.js 18+, TypeScript 5.3+
- Will need LLM SDK (Anthropic SDK etc.) — TBD during implementation
- State persistence: file-based JSON

## Build & Test

No implementation code yet. When available:
```bash
npm install
npm run build
npx vitest run
```

## Key Documents

- `vision.md` — why Motiva exists, what world it creates
- `concept.md` — core mechanisms (4-element model, orchestration, scoring, satisficing, stall detection, trust)
- `memory/impl-research-*.md` — integration/delivery/adoption research

## Key Constraints

- Evidence-based progress observation (never count tool calls as progress)
- Irreversible actions always require human approval regardless of trust/confidence
- Trust balance: asymmetric (failure penalty > success reward)
- Satisficing: stop when "good enough," don't pursue perfection
