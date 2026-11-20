import test from "node:test";
import assert from "node:assert/strict";

import { resolveResponseLanguage } from "../context/app-shell-storage";
import { normalizeLanguage } from "../context/languages";
import { formatDate, formatTime, getLocale } from "../lib/datetime";

test("only English is a supported interface locale", () => {
  for (const raw of ["en", "en-US", "en_US", "english", "xx"]) {
    assert.equal(normalizeLanguage(raw), "en");
  }
});

test("the response language is English", () => {
  assert.equal(resolveResponseLanguage("en", "en"), "en");
  assert.equal(resolveResponseLanguage("klingon", "en"), "en");
});

test("missing response language falls back to the English interface", () => {
  assert.equal(resolveResponseLanguage(null, "en"), "en");
  assert.equal(resolveResponseLanguage(undefined, "en"), "en");
});

test("dates and times use the English locale", () => {
  const date = new Date("2026-03-05T14:05:00Z");
  assert.equal(getLocale("en"), "en-US");
  assert.equal(formatDate(date, "en", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  }), "March 5, 2026");
  assert.equal(formatTime(date, "en", {
    hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  }), "02:05 PM");
});
