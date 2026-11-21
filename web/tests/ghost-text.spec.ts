import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { TinyTokenizer } from "@/lib/ghost-text/tiny-tokenizer";
import { ghostTextEnabled, setGhostTextEnabled } from "@/lib/ghost-text/enabled";
import { finalizeSuggestion } from "@/lib/ghost-text/suggestion";

const tokenizerJson = JSON.parse(
  readFileSync(resolve(__dirname, "../public/tinynext/tokenizer.json"), "utf-8"),
);

describe("ghost text tokenizer", () => {
  it("encodes text into known ids and round-trips", () => {
    const tokenizer = new TinyTokenizer(tokenizerJson);
    const ids = tokenizer.encode("the quick brown fox jumps");
    expect(ids.length).toBeGreaterThan(4);
    expect(ids.every((id) => id >= 0 && id < 8192)).toBe(true);
    expect(tokenizer.decode(ids)).toBe("the quick brown fox jumps");
  });

  it("encodes special FIM tokens by their exact ids", () => {
    const tokenizer = new TinyTokenizer(tokenizerJson);
    expect(tokenizer.encode("<|pre|>")).toEqual([1]);
    expect(tokenizer.encode("<|suf|>")).toEqual([2]);
    expect(tokenizer.encode("<|mid|>")).toEqual([3]);
  });

  it("is enabled by default unless explicitly turned off", () => {
    window.localStorage.removeItem("deeptutor.ghostText");
    expect(ghostTextEnabled()).toBe(true);
    setGhostTextEnabled(false);
    expect(ghostTextEnabled()).toBe(false);
    setGhostTextEnabled(true);
  });
});

describe("ghost text suggestion", () => {
  it("keeps the whole continuation instead of cutting at the last space", () => {
    // Regression: the old whole-word trim turned " the capital of France." into
    // "" whenever the model stopped before another space.
    expect(finalizeSuggestion(" the capital of France.")).toBe(" the capital of France.");
    expect(finalizeSuggestion(" the following")).toBe(" the following");
    // Leading space is kept: it is the real gap after the caret.
    expect(finalizeSuggestion(" molecules")).toBe(" molecules");
  });

  it("drops trailing whitespace and too-short fragments", () => {
    expect(finalizeSuggestion(" the  ")).toBe(" the");
    expect(finalizeSuggestion(" the")).toBe(" the");
    expect(finalizeSuggestion("")).toBe("");
    expect(finalizeSuggestion(" a")).toBe("");
    expect(finalizeSuggestion("  ")).toBe("");
  });
});
