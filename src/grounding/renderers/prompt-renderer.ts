import type { GroundingBundle, GroundingSection } from "../contracts.js";

function renderSection(section: GroundingSection): string {
  return `## ${section.title}\n${section.content}`.trim();
}

export function renderPromptBundle(bundle: GroundingBundle): string {
  return [...bundle.staticSections, ...bundle.dynamicSections]
    .sort((a, b) => a.priority - b.priority)
    .map(renderSection)
    .join("\n\n")
    .trim();
}
