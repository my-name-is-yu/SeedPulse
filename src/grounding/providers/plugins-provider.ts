import * as path from "node:path";
import type { GroundingProvider } from "../contracts.js";
import { listDirectoryNames, makeSection, makeSource, resolveHomeDir } from "./helpers.js";

export const pluginsProvider: GroundingProvider = {
  key: "plugins",
  kind: "dynamic",
  async build(context) {
    let plugins: string[] = [];
    const homeDir = resolveHomeDir(context.request.homeDir ?? context.deps.stateManager?.getBaseDir?.());
    const pluginsDir = path.join(homeDir, "plugins");

    if (context.deps.pluginLoader) {
      try {
        const loaded = await context.deps.pluginLoader.loadAll();
        plugins = loaded
          .filter((plugin) => plugin.enabled !== false)
          .map((plugin) => plugin.name)
          .sort((a, b) => a.localeCompare(b));
      } catch (error) {
        context.warnings.push(`plugins provider failed to load plugin metadata: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (plugins.length === 0) {
      plugins = (await listDirectoryNames(pluginsDir)).sort((a, b) => a.localeCompare(b));
    }

    return makeSection(
      "plugins",
      `Installed: ${plugins.length > 0 ? plugins.join(", ") : "none"}`,
      [
        makeSource("plugins", "plugins directory", {
          type: plugins.length > 0 ? "file" : "none",
          path: pluginsDir,
          trusted: true,
          accepted: true,
        }),
      ],
      { title: "Installed Plugins" },
    );
  },
};
