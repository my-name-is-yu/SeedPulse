import React, { useState, useEffect } from "react";
import { Text } from "ink";

/**
 * Checkerboard braille spinner — 4-phase animation using Unicode braille grid.
 * Ported from https://github.com/gunnargray-dev/unicode-animations
 */

const frames = ["⢕⢕⢕", "⡪⡪⡪", "⢊⠔⡡", "⡡⢊⠔"];
const interval = 250;

export function CheckerboardSpinner(): React.ReactElement {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev === frames.length - 1 ? 0 : prev + 1));
    }, interval);
    return () => clearInterval(timer);
  }, []);

  return <Text>{frames[frame]}</Text>;
}
