// ─── ChangeDetector ───
//
// Detects changes in probe results using three modes:
//   threshold: numeric value exceeds a threshold
//   diff:      JSON representation changed vs last baseline
//   presence:  result is non-null and non-empty

export interface ChangeResult {
  changed: boolean;
  details: string;
}

export function detectChange(
  mode: "threshold" | "diff" | "presence",
  currentResult: unknown,
  baselines: unknown[],
  thresholdValue?: number
): ChangeResult {
  switch (mode) {
    case "threshold": {
      const num = Number(currentResult);
      if (isNaN(num) || typeof num !== "number") {
        // Surface misconfiguration: non-numeric result cannot be evaluated against a threshold.
        // Return changed: true so the issue is visible rather than silently ignored.
        return { changed: true, details: "non-numeric result cannot be evaluated against threshold" };
      }
      if (thresholdValue === undefined) {
        // Surface misconfiguration: threshold mode requires threshold_value to be set.
        return { changed: true, details: "non-numeric result cannot be evaluated against threshold" };
      }
      const changed = num > thresholdValue;
      return {
        changed,
        details: changed
          ? `threshold exceeded: ${num} > ${thresholdValue}`
          : `threshold ok: ${num} <= ${thresholdValue}`,
      };
    }

    case "diff": {
      if (baselines.length === 0) {
        return { changed: false, details: "diff: no baseline to compare" };
      }
      const lastBaseline = baselines[baselines.length - 1];
      const current = JSON.stringify(currentResult);
      const last = JSON.stringify(lastBaseline);
      const changed = current !== last;
      return {
        changed,
        details: changed ? "diff: result changed from last baseline" : "diff: result unchanged",
      };
    }

    case "presence": {
      const changed =
        currentResult !== null &&
        currentResult !== undefined &&
        currentResult !== "" &&
        !(Array.isArray(currentResult) && currentResult.length === 0);
      return {
        changed,
        details: changed ? "presence: non-empty result detected" : "presence: empty result",
      };
    }
  }
}
