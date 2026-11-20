import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { normalizeMathMarkup } from "@/lib/latex-normalize";
it("dbg", () => {
  const out = normalizeMathMarkup("Suppose $f(x)$, and at $x=2$ the value approaches $5$.");
  writeFileSync("/tmp/norm-out.txt", out);
});
