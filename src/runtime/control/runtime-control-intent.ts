import type { RuntimeControlOperationKind } from "../store/runtime-operation-schemas.js";

export interface RuntimeControlIntent {
  kind: RuntimeControlOperationKind;
  reason: string;
}

const RESTART_TERMS = [/再起動/, /リスタート/i, /\brestart\b/i];
const RUNTIME_TERMS = [/pulseed/i, /daemon/i, /gateway/i, /runtime/i, /自身/, /自分/];
const EXPLANATION_TERMS = [/設計/, /説明/, /教えて/, /どう/, /\bexplain\b/i, /\bhow\b/i, /\bwhy\b/i];

function anyMatch(input: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(input));
}

export function recognizeRuntimeControlIntent(input: string): RuntimeControlIntent | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (anyMatch(trimmed, EXPLANATION_TERMS)) return null;
  if (!anyMatch(trimmed, RUNTIME_TERMS)) return null;

  if (anyMatch(trimmed, RESTART_TERMS)) {
    if (/gateway/i.test(trimmed)) {
      return { kind: "restart_gateway", reason: trimmed };
    }
    return { kind: "restart_daemon", reason: trimmed };
  }

  return null;
}
