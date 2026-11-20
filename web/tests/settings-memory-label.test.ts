import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const readWebFile = (...parts: string[]) =>
  readFileSync(path.join(process.cwd(), ...parts), "utf8");

test("runtime RAM and long-term memory use distinct labels", () => {
  const usage = readWebFile("components", "settings", "MemoryUsageItem.tsx");
  assert.match(usage, /"System memory"/);
});
