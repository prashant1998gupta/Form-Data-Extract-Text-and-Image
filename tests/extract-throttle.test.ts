import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { admitReaderScan, resetReaderThrottle, scansPerMinute, DEFAULT_SCANS_PER_MINUTE } from "../lib/extract/throttle.ts";

/**
 * The per-instance spend bound. The claim it enforces is exactly "at most N
 * scans in any 60 s"; these tests pin that sentence, the sliding window, and
 * the one decision that could silently undo it: a malformed environment value
 * must fall back to the DEFAULT, never to unlimited — failing open on a spend
 * bound because of a typo would be the wrong default.
 */

beforeEach(() => resetReaderThrottle());

test("admits up to the limit in a window, then refuses", () => {
  const at = 1_000_000;
  assert.equal(admitReaderScan({ scansPerMinute: 2, now: at }), true);
  assert.equal(admitReaderScan({ scansPerMinute: 2, now: at + 1 }), true);
  assert.equal(admitReaderScan({ scansPerMinute: 2, now: at + 2 }), false);
});

test("the window slides — an old scan ages out and frees a slot", () => {
  const at = 1_000_000;
  assert.equal(admitReaderScan({ scansPerMinute: 1, now: at }), true);
  assert.equal(admitReaderScan({ scansPerMinute: 1, now: at + 59_999 }), false);
  assert.equal(admitReaderScan({ scansPerMinute: 1, now: at + 60_000 }), true);
});

test("zero disables the bound", () => {
  for (let i = 0; i < 50; i += 1) {
    assert.equal(admitReaderScan({ scansPerMinute: 0, now: 1_000_000 + i }), true);
  }
});

test("the environment value parses, and malformed values fall back to the default — never to unlimited", () => {
  assert.equal(scansPerMinute({}), DEFAULT_SCANS_PER_MINUTE);
  assert.equal(scansPerMinute({ FORMLINK_MAX_SCANS_PER_MINUTE: "25" }), 25);
  assert.equal(scansPerMinute({ FORMLINK_MAX_SCANS_PER_MINUTE: "0" }), 0);
  assert.equal(scansPerMinute({ FORMLINK_MAX_SCANS_PER_MINUTE: "lots" }), DEFAULT_SCANS_PER_MINUTE);
  assert.equal(scansPerMinute({ FORMLINK_MAX_SCANS_PER_MINUTE: "-5" }), DEFAULT_SCANS_PER_MINUTE);
  assert.equal(scansPerMinute({ FORMLINK_MAX_SCANS_PER_MINUTE: "Infinity" }), DEFAULT_SCANS_PER_MINUTE);
});
