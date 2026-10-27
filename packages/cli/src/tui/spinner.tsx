// Animated braille spinner (M25-B3) for busy tool lines: frames advance every
// ~100ms while the line is mounted, with a trailing elapsed-seconds counter
// anchored to the mount timestamp. The interval is cleared on unmount so a
// flushed line cannot leak ticks into a dead tree.
import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { T } from "./theme.js";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const SPINNER_INTERVAL_MS = 100;

export function Spinner(): React.JSX.Element {
  const [tick, setTick] = useState(0);
  const [startedAt] = useState(() => Date.now());
  const [elapsedS, setElapsedS] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setTick((t) => (t + 1) % SPINNER_FRAMES.length);
      setElapsedS(Math.floor((Date.now() - startedAt) / 1000));
    }, SPINNER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [startedAt]);

  const frame = SPINNER_FRAMES[tick] ?? SPINNER_FRAMES[0];
  return <Text color={T.accent}>{`${frame} (${elapsedS}s)`}</Text>;
}
