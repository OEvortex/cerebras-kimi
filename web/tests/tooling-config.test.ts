import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const webRoot = process.cwd();

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.resolve(webRoot, relativePath), "utf8"),
  ) as Record<string, unknown>;
}

test("TypeScript includes canonical source roots and no named build output", () => {
  const tsconfig = readJson("tsconfig.json");
  const include = tsconfig.include as string[];

  for (const root of [
    "app",
    "components",
    "context",
    "features",
    "hooks",
    "lib",
    "shared",
    "contracts",
    "scripts",
  ]) {
    assert.ok(
      include.some((entry) => entry.startsWith(`${root}/`)),
      `missing explicit ${root} include`,
    );
  }

  assert.equal(include.includes("**/*.ts"), false);
  assert.equal(include.includes("**/*.tsx"), false);
  assert.equal(
    include.some((entry) => /^\.next[^/]*\//.test(entry)),
    false,
    "Next.js build output must not enter typecheck",
  );
});

test("package exposes deterministic frontend checks", () => {
  const packageJson = readJson("package.json");
  const scripts = packageJson.scripts as Record<string, string>;

  assert.equal(scripts.typecheck, "node ./scripts/typecheck.mjs");
  assert.equal(
    scripts["check:fast"],
    "bun run contracts:check && bun run architecture:check && bun run typecheck && bun run test:node && bun run test:unit && bun run lint",
  );
  assert.equal(
    scripts.check,
    "bun run check:fast && bun run build && bun run perf:check",
  );
  assert.match(scripts["test:e2e:critical"], /critical-turns/);
  assert.match(scripts["test:e2e:multi-worker"], /multi-worker-turns-desktop/);
});

test("tracked frontend files contain no generated or backup artifacts", () => {
  const result = spawnSync("git", ["ls-files", "--", "web"], {
    cwd: path.resolve(webRoot, ".."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const forbidden = result.stdout
    .split("\n")
    .filter(Boolean)
    .filter((file) =>
      /(?:\.orig$|\.DS_Store$|(?:^|\/)\.next[^/]*(?:\/|$)|(?:^|\/)tmp\/|\.tsbuildinfo$)/.test(
        file,
      ),
    );

  assert.deepEqual(forbidden, []);
});
