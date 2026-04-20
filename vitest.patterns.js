import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const fullInclude = [
  "src/**/__tests__/**/*.test.ts",
  "plugins/**/__tests__/**/*.test.ts",
  "examples/**/__tests__/**/*.test.ts",
  "tests/e2e/**/*.test.ts",
  "tests/regression/**/*.test.ts",
  "tests/test_*.ts",
];

export const integrationInclude = [
  "src/runtime/**/*.test.ts",
  "src/platform/soil/**/*.test.ts",
  "src/platform/dream/**/*.test.ts",
  "src/interface/tui/**/*.test.ts",
  "src/interface/chat/__tests__/chat-schedule-integration.test.ts",
  "src/interface/cli/__tests__/cli-daemon-*.test.ts",
  "src/interface/cli/__tests__/cli-runner-integration.test.ts",
  "src/tools/schedule/**/*.test.ts",
  "src/runtime/schedule/**/*.test.ts",
  "tests/e2e/**/*.test.ts",
  "examples/plugins/sqlite-datasource/**/*.test.ts",
];

export const smokeInclude = [
  "src/runtime/__tests__/daemon-runner.test.ts",
  "src/runtime/__tests__/loop-supervisor.test.ts",
  "src/runtime/__tests__/schedule-engine.test.ts",
  "src/runtime/__tests__/watchdog.test.ts",
  "src/runtime/queue/__tests__/journal-backed-queue.test.ts",
  "src/platform/soil/__tests__/sqlite-repository.test.ts",
  "src/interface/cli/__tests__/cli-runner-integration.test.ts",
  "src/interface/tui/__tests__/test-entry.test.ts",
];

export const integrationPathPrefixes = [
  "src/runtime/",
  "src/platform/soil/",
  "src/platform/dream/",
  "src/interface/tui/",
  "src/tools/schedule/",
  "tests/e2e/",
  "examples/plugins/sqlite-datasource/",
];

export const integrationPathPatterns = [
  /^src\/runtime\/schedule\//,
  /^src\/interface\/chat\/__tests__\/chat-schedule-integration\.test\.ts$/,
  /^src\/interface\/cli\/__tests__\/cli-daemon-.*\.test\.ts$/,
  /^src\/interface\/cli\/__tests__\/cli-runner-integration\.test\.ts$/,
];

export const smokePathPatterns = [
  /^src\/runtime\/__tests__\/daemon-runner\.test\.ts$/,
  /^src\/runtime\/__tests__\/loop-supervisor\.test\.ts$/,
  /^src\/runtime\/__tests__\/schedule-engine\.test\.ts$/,
  /^src\/runtime\/__tests__\/watchdog\.test\.ts$/,
  /^src\/runtime\/queue\/__tests__\/journal-backed-queue\.test\.ts$/,
  /^src\/platform\/soil\/__tests__\/sqlite-repository\.test\.ts$/,
  /^src\/interface\/cli\/__tests__\/cli-runner-integration\.test\.ts$/,
  /^src\/interface\/tui\/__tests__\/test-entry\.test\.ts$/,
];

export const sharedCoverage = {
  provider: "v8",
  include: ["src/**/*.ts"],
  exclude: ["src/types/**", "src/tui/**"],
  reporter: ["text", "text-summary", "json", "html"],
  reportsDirectory: "coverage",
};

const dirname = path.dirname(fileURLToPath(import.meta.url));

export const sharedResolve = {
  alias: {
    pulseed: path.resolve(dirname, "src/index.ts"),
  },
};

function normalize(filePath) {
  return filePath.split(path.sep).join("/");
}

export function isIntegrationPath(filePath) {
  const normalized = normalize(filePath);
  return (
    integrationPathPrefixes.some((prefix) => normalized.startsWith(prefix)) ||
    integrationPathPatterns.some((pattern) => pattern.test(normalized))
  );
}

export function isSmokeRelevantPath(filePath) {
  const normalized = normalize(filePath);
  return smokePathPatterns.some((pattern) => pattern.test(normalized));
}
