import type { RepetitivePatternResult, StallTaskHistoryEntry } from "../stall-detector.js";

const REPETITIVE_WINDOW = 3;
const SIMILARITY_THRESHOLD = 0.8;
const NO_CHANGE_PATTERNS = ["no changes made", "no modifications", "nothing to change", "no action taken"];

function stringSimilarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const getBigrams = (value: string): string[] => {
    const bigrams: string[] = [];
    for (let index = 0; index < value.length - 1; index += 1) {
      bigrams.push(value.slice(index, index + 2));
    }
    return bigrams;
  };

  const bigramsA = getBigrams(a);
  const bigramsB = getBigrams(b);
  if (bigramsA.length === 0 || bigramsB.length === 0) {
    return 0;
  }

  const counts = new Map<string, number>();
  for (const bigram of bigramsB) {
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }

  let intersection = 0;
  for (const bigram of bigramsA) {
    const count = counts.get(bigram) ?? 0;
    if (count > 0) {
      intersection += 1;
      counts.set(bigram, count - 1);
    }
  }

  return (2 * intersection) / (bigramsA.length + bigramsB.length);
}

export function detectRepetitivePatterns(taskHistory: StallTaskHistoryEntry[]): RepetitivePatternResult {
  if (taskHistory.length < REPETITIVE_WINDOW) {
    return { isRepetitive: false, pattern: null, confidence: 0 };
  }

  const recent = taskHistory.slice(-REPETITIVE_WINDOW);
  const outputs = recent.map((entry) => entry.output);

  const noChangeCount = recent.filter((entry) =>
    NO_CHANGE_PATTERNS.some((pattern) => entry.output.toLowerCase().includes(pattern))
  ).length;
  if (noChangeCount >= REPETITIVE_WINDOW) {
    return { isRepetitive: true, pattern: "no_change", confidence: 0.95 };
  }

  const strategyIds = recent.map((entry) => entry.strategy_id);
  const allSameStrategy = strategyIds[0] !== null && strategyIds.every((strategyId) => strategyId === strategyIds[0]);
  if (allSameStrategy) {
    const similarity01 = stringSimilarity(outputs[0], outputs[1]);
    const similarity12 = stringSimilarity(outputs[1], outputs[2]);
    const averageSimilarity = (similarity01 + similarity12) / 2;
    if (averageSimilarity >= SIMILARITY_THRESHOLD) {
      return { isRepetitive: true, pattern: "identical_actions", confidence: averageSimilarity };
    }
  }

  if (taskHistory.length >= 4) {
    const last4 = taskHistory.slice(-4);
    const outputs4 = last4.map((entry) => entry.output);
    const similarity02 = stringSimilarity(outputs4[0], outputs4[2]);
    const similarity13 = stringSimilarity(outputs4[1], outputs4[3]);
    const similarity01 = stringSimilarity(outputs4[0], outputs4[1]);
    if (
      similarity02 >= SIMILARITY_THRESHOLD &&
      similarity13 >= SIMILARITY_THRESHOLD &&
      similarity01 < SIMILARITY_THRESHOLD
    ) {
      return {
        isRepetitive: true,
        pattern: "oscillating",
        confidence: Math.min(similarity02, similarity13),
      };
    }
  }

  return { isRepetitive: false, pattern: null, confidence: 0 };
}

