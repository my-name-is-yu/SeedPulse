// ─── SplashScreen ───
//
// Full-terminal splash screen shown on TUI startup.
// Displays the Seedy pixel art mascot centered with the product name and version.
// Auto-dismisses after 2000 ms or on any key press.

import React from "react";
import { Box, Text, useInput } from "ink";
import { ShimmerText } from "./shimmer-text.js";
import { SEEDY_PIXEL } from "./seedy-art.js";

interface SplashScreenProps {
  cols: number;
  rows: number;
  version: string;
  onDone: () => void;
}

export function SplashScreen({ cols, rows, version, onDone }: SplashScreenProps) {
  // Auto-dismiss after 2000ms
  React.useEffect(() => {
    const timer = setTimeout(onDone, 2000);
    return () => clearTimeout(timer);
  }, [onDone]);

  // Dismiss on any key press
  useInput(() => { onDone(); });

  // SEEDY_PIXEL is 9 chars wide, 5 lines tall
  // Content block: art (5) + gap (1) + title (1) + version (1) = 8 lines
  const artHeight = 5;
  const titleLine = "SeedPulse";
  const totalContentHeight = artHeight + 1 + 1 + 1; // art + gap + title + version
  const topPad = Math.max(0, Math.floor((rows - totalContentHeight) / 2));

  return (
    <Box flexDirection="column" height={rows} width={cols} alignItems="center">
      <Box height={topPad} />
      <Text>{SEEDY_PIXEL}</Text>
      <Box height={1} />
      <ShimmerText>{titleLine}</ShimmerText>
      <Text dimColor>{version}</Text>
    </Box>
  );
}
