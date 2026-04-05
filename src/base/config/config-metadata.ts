// Re-export from tool-metadata for backward compatibility.
// New code should import from tool-metadata.ts directly.
export {
  ConfigKeyMeta,
  CONFIG_METADATA,
  buildConfigKeyDescription,
  buildConfigToolDescription,
} from "./tool-metadata.js";
