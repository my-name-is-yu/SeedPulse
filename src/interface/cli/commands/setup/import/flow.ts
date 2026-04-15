import * as p from "@clack/prompts";
import type { ProviderConfig } from "../../../../../base/llm/provider-config.js";
import { maskKey } from "../../setup-shared.js";
import { guardCancel } from "../utils.js";
import { detectSetupImportSources } from "./discovery.js";
import type {
  SetupImportItem,
  SetupImportProviderSettings,
  SetupImportSelection,
  SetupImportSource,
  SetupImportUserSettings,
} from "./types.js";

function sourceSummary(sources: SetupImportSource[]): string {
  return sources
    .map((source) => {
      const counts = source.items.reduce<Record<string, number>>((acc, item) => {
        acc[item.kind] = (acc[item.kind] ?? 0) + 1;
        return acc;
      }, {});
      const suffix = Object.entries(counts)
        .map(([kind, count]) => `${kind}: ${count}`)
        .join(", ");
      return `${source.label}\n  root: ${source.rootDir}\n  ${suffix}`;
    })
    .join("\n\n");
}

function providerPreview(settings: SetupImportProviderSettings | undefined): string | undefined {
  if (!settings) return undefined;
  return [
    settings.provider ? `provider=${settings.provider}` : undefined,
    settings.model ? `model=${settings.model}` : undefined,
    settings.adapter ? `adapter=${settings.adapter}` : undefined,
    settings.apiKey ? `api_key=${maskKey(settings.apiKey)}` : undefined,
    settings.baseUrl ? `base_url=${settings.baseUrl}` : undefined,
  ].filter(Boolean).join(", ");
}

function itemPreview(item: SetupImportItem): string {
  const decision = item.decision === "copy_disabled" ? "copy disabled" : item.decision;
  const pluginCompatibility =
    item.kind === "plugin" && item.pluginCompatibility
      ? [
          `compatibility=${item.pluginCompatibility.status}`,
          `permissions=${
            Object.entries(item.pluginCompatibility.permissions)
              .flatMap(([key, value]) => (value ? [key] : []))
              .join(", ") || "none"
          }`,
        ].join(", ")
      : undefined;
  const details = item.kind === "provider"
    ? providerPreview(item.providerSettings)
    : item.kind === "user"
      ? "will replace PulSeed USER.md"
    : item.kind === "telegram"
      ? [
          item.telegramSettings?.botToken ? `bot_token=${maskKey(item.telegramSettings.botToken)}` : undefined,
          item.telegramSettings?.allowedUserIds?.length ? `allowed_users=${item.telegramSettings.allowedUserIds.length}` : undefined,
        ].filter(Boolean).join(", ")
    : item.kind === "plugin"
      ? pluginCompatibility
    : item.reason;
  return `[${item.sourceLabel}] ${item.kind}: ${item.label}\n  ${decision}${details ? ` - ${details}` : ""}`;
}

function preview(sources: SetupImportSource[]): string {
  return sources
    .flatMap((source) => source.items)
    .map(itemPreview)
    .join("\n\n");
}

function mergeProviderSettings(items: SetupImportItem[]): SetupImportProviderSettings | undefined {
  return items.find((item) => item.decision !== "skip" && item.providerSettings)?.providerSettings;
}

function mergeUserSettings(items: SetupImportItem[]): SetupImportUserSettings | undefined {
  return items.find((item) => item.decision !== "skip" && item.userSettings)?.userSettings;
}

function defaultProviderConfigFromImport(
  settings: SetupImportProviderSettings | undefined
): Partial<ProviderConfig> | undefined {
  if (!settings) return undefined;
  return {
    ...(settings.provider ? { provider: settings.provider } : {}),
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.adapter ? { adapter: settings.adapter } : {}),
    ...(settings.apiKey ? { api_key: settings.apiKey } : {}),
    ...(settings.baseUrl ? { base_url: settings.baseUrl } : {}),
    ...(settings.codexCliPath ? { codex_cli_path: settings.codexCliPath } : {}),
    ...(settings.openclaw ? { openclaw: settings.openclaw } : {}),
  };
}

export function providerConfigPatchFromImport(
  settings: SetupImportProviderSettings | undefined
): Partial<ProviderConfig> | undefined {
  return defaultProviderConfigFromImport(settings);
}

export async function stepSetupImport(): Promise<SetupImportSelection | undefined> {
  const detectedSources = detectSetupImportSources();
  if (detectedSources.length === 0) return undefined;

  const choiceSources = [...detectedSources].sort((a, b) => {
    const order: Record<SetupImportSource["id"], number> = { openclaw: 0, hermes: 1 };
    return order[a.id] - order[b.id];
  });

  p.note(sourceSummary(detectedSources), "Existing agent configs found");
  const sourceChoice = guardCancel(
    await p.select({
      message: "Found existing settings!",
      options: [
        ...choiceSources.map((source) => ({
          value: source.id,
          label: source.id === "hermes"
            ? "Migrate Hermes Agent settings"
            : "Migrate OpenClaw settings",
          hint: source.rootDir,
        })),
        {
          value: "skip" as const,
          label: "Do not migrate",
        },
      ],
      initialValue: choiceSources[0]?.id,
    })
  );
  if (sourceChoice === "skip") return undefined;

  const sources = detectedSources.filter((source) => source.id === sourceChoice);
  if (sources.length === 0) return undefined;

  const allItems = sources.flatMap((source) => source.items);
  let items = allItems;
  p.note(preview(sources), "Import preview");

  const selectedItems = items.filter((item) => item.decision !== "skip");
  const providerItems = selectedItems.filter((item) => item.providerSettings);
  if (providerItems.length > 1) {
    const providerChoice = guardCancel(
      await p.select({
        message: "Which provider settings should PulSeed use as setup defaults?",
        options: providerItems.map((item) => ({
          value: item.id,
          label: `${item.sourceLabel}: ${item.label}`,
          hint: providerPreview(item.providerSettings),
        })),
        initialValue: providerItems[0]?.id,
      })
    );
    items = items.map((item) =>
      item.providerSettings && item.id !== providerChoice
        ? { ...item, decision: "skip" as const }
        : item
    );
  }

  const providerSettings = mergeProviderSettings(items);
  const userSettings = mergeUserSettings(items);
  if (providerSettings) {
    p.log.info(
      userSettings
        ? "Imported provider settings and USER.md will be used as defaults. Setup will still ask for Seedy naming."
        : "Imported provider settings will be used as defaults. Seedy naming will still be asked."
    );
  } else if (userSettings) {
    p.log.info("Imported USER.md will be used as defaults. Setup will still ask for Seedy naming.");
  } else {
    p.log.info("Import selected. Seedy naming will still be asked.");
  }

  return { sources, items, providerSettings, userSettings };
}
