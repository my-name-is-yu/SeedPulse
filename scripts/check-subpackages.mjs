#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const verifyAll = args.has("--all");
const changedBase = process.argv.find((value, index) => process.argv[index - 1] === "--base") ?? resolveDefaultBase();

const packageDirs = [
  "plugins/discord-bot",
  "plugins/signal-bridge",
  "plugins/slack-notifier",
  "plugins/telegram-bot",
  "plugins/whatsapp-webhook",
  "examples/plugins/jira-datasource",
  "examples/plugins/mysql-datasource",
  "examples/plugins/pagerduty-notifier",
  "examples/plugins/postgres-datasource",
  "examples/plugins/sqlite-datasource",
  "examples/plugins/sse-datasource",
  "examples/plugins/websocket-datasource",
];

const changedFiles = verifyAll ? [] : gitChangedFiles(changedBase);
const targets = verifyAll
  ? packageDirs
  : packageDirs.filter((dir) => changedFiles.some((file) => file === dir || file.startsWith(`${dir}/`)));

if (targets.length === 0) {
  console.log("No changed subpackages detected.");
  process.exit(0);
}

console.log(`Verifying ${targets.length} subpackage(s):`);
for (const target of targets) {
  console.log(`- ${target}`);
}

for (const dir of targets) {
  verifyBuild(dir);
  verifyTests(dir);
}

console.log("Subpackage verification passed.");

function gitChangedFiles(base) {
  const result = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    fail(`Unable to resolve changed files against ${base}.`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function resolveDefaultBase() {
  for (const candidate of ["origin/main", "HEAD~1"]) {
    const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", candidate], {
      stdio: "ignore",
    });
    if (result.status === 0) {
      return candidate;
    }
  }
  return "HEAD";
}

function verifyBuild(dir) {
  const tsconfigPath = path.join(dir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    fail(`Missing tsconfig.json for ${dir}`);
  }
  run("npx", ["tsc", "--project", tsconfigPath, "--pretty", "false"]);
}

function verifyTests(dir) {
  const pkgPath = path.join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  if (!pkg.scripts || typeof pkg.scripts.test !== "string") {
    return;
  }
  run("npx", ["vitest", "run", dir]);
}

function run(command, commandArgs) {
  const rendered = [command, ...commandArgs].join(" ");
  console.log(`$ ${rendered}`);
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
