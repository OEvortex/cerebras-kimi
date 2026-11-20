import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const portablePath = (value: string) => value.replaceAll("\\", "/");
const sourceRoots = [
  "app",
  "components",
  "context",
  "features",
  "hooks",
  "lib",
  "shared",
];

function sourceFiles(relativeRoot: string): string[] {
  const start = path.join(root, relativeRoot);
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.(?:ts|tsx)$/.test(entry.name)) result.push(target);
    }
  };
  visit(start);
  return result;
}

const allSources = sourceRoots.flatMap(sourceFiles);

test("browser storage methods stay behind the shared boundary", () => {
  const violations = allSources
    .filter((file) => !portablePath(file).includes("shared/storage/"))
    .filter((file) =>
      /(?:window\.)?(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)/.test(
        fs.readFileSync(file, "utf8"),
      ),
    )
    .map((file) => portablePath(path.relative(root, file)));
  assert.deepEqual(violations, []);
});

test("raw fetch is limited to the shared API client and media preview", () => {
  const allow = new Set([
    "shared/api/client.ts",
    "components/chat/preview/FilePreviewDrawer.tsx",
    // SSE transport and OpenUI components that call external services directly.
    "lib/sse-socket.ts",
    "lib/openui/components/map/use-street-route.ts",
    "lib/openui/components/search-image.tsx",
  ]);
  const violations = allSources
    .filter((file) => /\bfetch\(/.test(fs.readFileSync(file, "utf8")))
    .map((file) => portablePath(path.relative(root, file)))
    .filter((file) => !allow.has(file));
  assert.deepEqual(violations, []);
});

test("source modules cannot import Next route pages", () => {
  const violations = allSources
    .filter((file) =>
      /from\s+["'][^"']*\/page["']/.test(fs.readFileSync(file, "utf8")),
    )
    .map((file) => portablePath(path.relative(root, file)));
  assert.deepEqual(violations, []);
});

test("the canonical tooltip owns every tooltip role and guards import paths", () => {
  const roleOwners = allSources
    .filter((file) => /role=["']tooltip["']/.test(fs.readFileSync(file, "utf8")))
    .map((file) => portablePath(path.relative(root, file)));
  assert.deepEqual(roleOwners.sort(), [
    "shared/ui/Tooltip.tsx",
    "shared/ui/TooltipLayer.tsx",
  ].sort());
  assert.equal(fs.existsSync(path.join(root, "components/common/Tooltip.tsx")), false);
  assert.equal(fs.existsSync(path.join(root, "components/ui/Tooltip.tsx")), false);

  const legacyImports = allSources
    .filter((file) =>
      /@\/components\/(?:common|ui)\/Tooltip/.test(
        fs.readFileSync(file, "utf8"),
      ),
    )
    .map((file) => portablePath(path.relative(root, file)));
  assert.deepEqual(legacyImports, []);
});

test("tracked source contains no editor backups or generated trash", () => {
  const suspicious = execFileSync("git", ["ls-files", "web"], {
    cwd: path.dirname(root),
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .filter(
      (file) =>
        /(?:~|\.bak|\.orig|\.rej)$/.test(file) || file.endsWith("/.DS_Store"),
    );
  assert.deepEqual(suspicious, []);
});
