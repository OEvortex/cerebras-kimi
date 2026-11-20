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
const authRouter = readFileSync(
  path.resolve(process.cwd(), "..", "deeptutor", "api", "routers", "auth.py"),
  "utf8",
);

test("admin API exposes row-oriented user import and batch deletion", () => {
  assert.match(adminApi, /apiUrl\("\/api\/auth\/users\/import"\)/);
  assert.match(adminApi, /body\.append\("file", file\)/);
  assert.match(adminApi, /interface UserImportResult/);
  assert.match(adminApi, /apiUrl\("\/api\/auth\/users\/batch-delete"\)/);
  assert.match(adminApi, /JSON\.stringify\(\{ usernames \}\)/);
});

test("users page wires CSV import and multi-select deletion", () => {
  assert.match(usersPage, /showImportDialog/);
  assert.match(usersPage, /accept="\.csv,text\/csv"/);
  assert.match(usersPage, /type="checkbox"/);
  assert.match(usersPage, /disabled=\{isSelf\}/);
  assert.match(usersPage, /setShowBatchDeleteConfirm\(true\)/);
  assert.match(usersPage, /colSpan=\{5\}/);
});

test("batch import cannot provision administrators", () => {
  assert.match(authRouter, /fieldnames != expected/);
  assert.match(authRouter, /if role != "user":/);
  assert.match(authRouter, /Only non-admin users can be provisioned/);
});
