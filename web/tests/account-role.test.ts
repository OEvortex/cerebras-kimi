import assert from "node:assert/strict";
import test from "node:test";

import { accountRoleLabelKey } from "../lib/account-role";

test("all account roles retain distinct display labels", () => {
  assert.equal(accountRoleLabelKey("admin"), "Admin");
  assert.equal(accountRoleLabelKey("teacher"), "Teacher");
  assert.equal(accountRoleLabelKey("student"), "Student");
  assert.equal(accountRoleLabelKey("user"), "User");
});
