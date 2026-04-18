import React from "react";
import { Text } from "ink";
import { theme } from "./theme.js";

export function diffLineColor(line: string): string | undefined {
  if (line.startsWith("+") && !line.startsWith("+++")) return theme.success;
  if (line.startsWith("-") && !line.startsWith("---")) return theme.error;
  if (line.startsWith("@@")) return theme.info;
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("---") ||
    line.startsWith("+++")
  ) {
    return theme.warning;
  }
  return undefined;
}

export function DiffLine({ line }: { line: string }) {
  const color = diffLineColor(line);
  return <Text {...(color ? { color } : {})}>{line}</Text>;
}
