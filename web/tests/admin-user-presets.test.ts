import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const adminApi = readFileSync(
  path.resolve(process.cwd(), "lib/admin-api.ts"),
  "utf8",
);
const usersPage = readFileSync(
  path.resolve(process.cwd(), "app/(admin)/admin/users/page.tsx"),
  "utf8",
);
const grantEditor = readFileSync(
  path.resolve(process.cwd(), "features/multi-user/components/GrantEditor.tsx"),
  "utf8",
);

test("admin user creation sends the selected preset", () => {
  assert.match(
    adminApi,
    /export type AccountPreset = "standard" \| "learner" \| "custom"/,
  );
  assert.match(
    adminApi,
    /body: JSON\.stringify\(\{ username, password, preset \}\)/,
  );
  assert.match(usersPage, /\["standard", "learner", "custom"\] as const/);
  assert.match(usersPage, /aria-pressed=\{createPreset === preset\}/);
});

test("grant editing exposes the server-enforced learning policy controls", () => {
  assert.match(grantEditor, /learning_policy: conservativeLearningPolicy\(\)/);
  assert.match(grantEditor, /allowed_surfaces: \["chat", "reading"\]/);
  assert.match(grantEditor, /toggleReadingMaterial/);
  assert.match(grantEditor, /toggleReadingExtension/);
  assert.match(
    grantEditor,
    /checked=\{grant\.learning_policy\.reading\.allow_upload\}/,
  );
});
