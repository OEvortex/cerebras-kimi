import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { isMasteryDraftSessionReady } from "../lib/mastery-study-route";

const base = {
  guard: {
    routeKey: "topic-a:new",
    previousSessionId: "session-old",
  },
  routeKey: "topic-a:new",
  masteryPathId: "topic-a",
  pathId: "topic-a",
};

test("a stale previous session cannot bounce a new-study route backwards", () => {
  assert.equal(
    isMasteryDraftSessionReady({ ...base, sessionId: "session-old" }),
    false,
  );
});

test("the backend-bound draft session is promoted into the route", () => {
  assert.equal(
    isMasteryDraftSessionReady({ ...base, sessionId: "session-new" }),
    true,
  );
});

test("a route or topic switch invalidates an older draft guard", () => {
  assert.equal(
    isMasteryDraftSessionReady({
      ...base,
      routeKey: "topic-b:new",
      sessionId: "session-new",
    }),
    false,
  );
  assert.equal(
    isMasteryDraftSessionReady({
      ...base,
      masteryPathId: "topic-b",
      sessionId: "session-new",
    }),
    false,
  );
});

test("an unbound draft stays on the sessionless study route", () => {
  assert.equal(isMasteryDraftSessionReady({ ...base, sessionId: null }), false);
});

test("legacy /mastery/.../study URLs permanently redirect to /sessions", () => {
  const source = readFileSync(
    path.resolve(process.cwd(), "src/router/redirects.ts"),
    "utf8",
  );
  assert.match(source, /path: "\/mastery\/\$pathId\/study"/);
  assert.match(
    source,
    /\/learning\/mastery\/\$\{params\.pathId\}\/sessions\$\{location\.searchStr\}/,
  );
  assert.match(source, /path: "\/mastery\/\$pathId\/study\/\$sessionId"/);
  assert.match(
    source,
    /\/learning\/mastery\/\$\{params\.pathId\}\/sessions\/\$\{params\.sessionId\}\$\{location\.searchStr\}/,
  );
});
