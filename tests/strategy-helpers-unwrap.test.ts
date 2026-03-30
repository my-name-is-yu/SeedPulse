import { describe, it, expect } from "vitest";
import { unwrapStrategyResponse } from "../src/strategy/strategy-helpers.js";

describe("unwrapStrategyResponse", () => {
  it("passes through a bare array unchanged", () => {
    const arr = [{ hypothesis: "test" }];
    expect(unwrapStrategyResponse(arr)).toBe(arr);
  });

  it("unwraps { candidates: [...] }", () => {
    const arr = [1, 2, 3];
    expect(unwrapStrategyResponse({ candidates: arr })).toBe(arr);
  });

  it("unwraps { strategies: [...] }", () => {
    const arr = [{ hypothesis: "a" }];
    expect(unwrapStrategyResponse({ strategies: arr })).toBe(arr);
  });

  it("unwraps { data: [...] }", () => {
    const arr = ["x"];
    expect(unwrapStrategyResponse({ data: arr })).toBe(arr);
  });

  it("unwraps { results: [...] }", () => {
    const arr = [42];
    expect(unwrapStrategyResponse({ results: arr })).toBe(arr);
  });

  it("unwraps { items: [...] }", () => {
    const arr = [{ id: 1 }];
    expect(unwrapStrategyResponse({ items: arr })).toBe(arr);
  });

  it("unwraps a single-key object whose value is an array", () => {
    const arr = ["a", "b"];
    expect(unwrapStrategyResponse({ someUnknownKey: arr })).toBe(arr);
  });

  it("does NOT unwrap a multi-key object", () => {
    const obj = { a: [1], b: [2] };
    expect(unwrapStrategyResponse(obj)).toBe(obj);
  });

  it("passes through null unchanged", () => {
    expect(unwrapStrategyResponse(null)).toBeNull();
  });

  it("passes through undefined unchanged", () => {
    expect(unwrapStrategyResponse(undefined)).toBeUndefined();
  });

  it("passes through a string unchanged", () => {
    expect(unwrapStrategyResponse("hello")).toBe("hello");
  });

  it("passes through a number unchanged", () => {
    expect(unwrapStrategyResponse(42)).toBe(42);
  });

  it("does NOT unwrap when known key value is not an array", () => {
    const obj = { candidates: "not-an-array" };
    expect(unwrapStrategyResponse(obj)).toBe(obj);
  });
});
