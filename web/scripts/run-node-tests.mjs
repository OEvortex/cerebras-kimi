import { readdirSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, "..");
const distRoot = path.join(webRoot, "dist", "node-tests");
const testRoot = path.join(distRoot, "tests");

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: webRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function collectFiles(dir, suffix, skipDirs = new Set()) {
  const entries = readdirSync(dir)
    .map((name) => path.join(dir, name))
    .sort((a, b) => a.localeCompare(b));
  const files = [];
  for (const entry of entries) {
    const base = path.basename(entry);
    if (skipDirs.has(base)) continue;
    const stats = statSync(entry);
    if (stats.isDirectory()) {
      files.push(...collectFiles(entry, suffix, skipDirs));
      continue;
    }
    if (entry.endsWith(suffix) && !entry.endsWith(".d.ts")) {
      files.push(entry);
    }
  }
  return files;
}

rmSync(distRoot, { recursive: true, force: true });

const sourceDirs = [
  "tests",
  "app",
  "components",
  "context",
  "contracts",
  "features",
  "hooks",
  "lib",
  "shared",
  "src",
];
const tsFiles = sourceDirs.flatMap((dir) => {
  const full = path.join(webRoot, dir);
  try {
    return statSync(full).isDirectory() ? collectFiles(full, ".ts") : [];
  } catch {
    return [];
  }
});

await build({
  entryPoints: tsFiles,
  outdir: distRoot,
  outbase: webRoot,
  format: "cjs",
  platform: "node",
  target: "node20",
  bundle: false,
  logLevel: "silent",
});

const testFiles = collectFiles(testRoot, ".test.js");
if (testFiles.length === 0) {
  console.error("No compiled node tests found.");
  process.exit(1);
}

run(process.execPath, [
  "-r",
  "./scripts/register-node-test-aliases.cjs",
  "--test",
  ...testFiles,
]);
