#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import {
  isIntegrationPath,
  isSmokeRelevantPath,
} from "../vitest.patterns.js";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/test-changed.mjs [--dry-run]

Runs the narrowest reasonable docs/test workflow for the current git diff.
- docs changes -> check docs
- infra changes -> build + unit + smoke
- code changes -> related unit/integration tests, plus smoke for runtime-heavy areas
`);
  process.exit(0);
}

function run(cmd, args) {
  const rendered = [cmd, ...args].join(" ");
  console.log(`$ ${rendered}`);
  if (dryRun) {
    return;
  }
  const result = spawnSync(cmd, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function gitLines(args) {
  try {
    const output = execFileSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

function unique(items) {
  return [...new Set(items)];
}

function relative(filePath) {
  return path.relative(process.cwd(), path.resolve(process.cwd(), filePath)).split(path.sep).join("/");
}

function isSourceLike(filePath) {
  return /\.(?:[cm]?js|tsx?|json)$/.test(filePath);
}

function isDocPath(filePath) {
  return filePath.endsWith(".md") || filePath.startsWith("docs/");
}

function isInfraPath(filePath) {
  return (
    filePath === "package.json" ||
    filePath === "vitest.config.ts" ||
    filePath === "vitest.unit.config.ts" ||
    filePath === "vitest.integration.config.ts" ||
    filePath === "vitest.smoke.config.ts" ||
    filePath === "vitest.patterns.js" ||
    filePath === "tsconfig.json" ||
    filePath === "tsconfig.build.json" ||
    filePath === "tsconfig.typecheck.json" ||
    filePath === ".github/workflows/ci.yml" ||
    filePath.startsWith("scripts/")
  );
}

const changedFiles = unique([
  ...gitLines(["diff", "--name-only", "--diff-filter=ACMRD"]),
  ...gitLines(["diff", "--cached", "--name-only", "--diff-filter=ACMRD"]),
  ...gitLines(["ls-files", "--others", "--exclude-standard"]),
]).map(relative);

if (changedFiles.length === 0) {
  console.log("No changed files detected. Running the fast unit lane.");
  run("npm", ["run", "test:unit"]);
  process.exit(0);
}

console.log("Changed files:");
for (const file of changedFiles) {
  console.log(`- ${file}`);
}

const docsTouched = changedFiles.some(isDocPath);
const infraTouched = changedFiles.some(isInfraPath);
const sourceFiles = changedFiles.filter(isSourceLike);
const integrationFiles = sourceFiles.filter(isIntegrationPath);
const unitFiles = sourceFiles.filter((file) => !isIntegrationPath(file));
const smokeFiles = sourceFiles.filter(isSmokeRelevantPath);

if (docsTouched) {
  run("npm", ["run", "check:docs"]);
}

if (infraTouched) {
  console.log("Build/test infrastructure changed. Running build, unit, and smoke lanes.");
  run("npm", ["run", "build"]);
  run("npm", ["run", "test:unit"]);
  run("npm", ["run", "test:smoke"]);
  process.exit(0);
}

if (unitFiles.length > 0) {
  console.log("Running related unit tests.");
  run("npx", ["vitest", "related", "--run", "--config", "vitest.unit.config.ts", ...unitFiles]);
}

if (integrationFiles.length > 0) {
  console.log("Running related integration tests.");
  run("npx", ["vitest", "related", "--run", "--config", "vitest.integration.config.ts", ...integrationFiles]);
}

if (smokeFiles.length > 0 || integrationFiles.length > 0) {
  console.log("Running the smoke lane for runtime-heavy coverage.");
  run("npm", ["run", "test:smoke"]);
}

if (!docsTouched && unitFiles.length === 0 && integrationFiles.length === 0) {
  console.log("No source-like changes detected. Running the smoke lane as a sanity check.");
  run("npm", ["run", "test:smoke"]);
}
