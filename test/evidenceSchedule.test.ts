import assert from "node:assert/strict";
import test from "node:test";
import {
	firstFridayOfMonth,
	isFirstFriday1000,
	msUntilNextFirstFriday1000,
	nextFirstFriday1000,
} from "../src/evidenceSchedule.ts";

test("first Friday of known 2026 months lands on the right day at 10:00", () => {
	// computed independently: Jan 2, Feb 6, Mar 6, Apr 3, May 1, Jun 5,
	// Jul 3, Aug 7, Sep 4, Oct 2, Nov 6, Dec 4 (all Fridays).
	const expected = [2, 6, 6, 3, 1, 5, 3, 7, 4, 2, 6, 4];
	for (let month = 0; month < 12; month++) {
		const d = firstFridayOfMonth(2026, month);
		assert.equal(d.getDate(), expected[month], `2026-${month + 1}`);
		assert.equal(d.getDay(), 5, "is a Friday");
		assert.equal(d.getHours(), 10);
		assert.equal(d.getMinutes(), 0);
	}
});

test("nextFirstFriday1000 returns the current month's run when still ahead", () => {
	// Aug 7 2026 is the first Friday; before it (Aug 1) the next run is Aug 7.
	const from = new Date(2026, 7, 1, 9, 0, 0);
	const next = nextFirstFriday1000(from);
	assert.equal(next.getDate(), 7);
	assert.equal(next.getMonth(), 7);
	assert.equal(next.getHours(), 10);
});

test("nextFirstFriday1000 rolls to the next month once the run has passed", () => {
	// after Aug 7 10:00, the next run is Sep 4.
	const from = new Date(2026, 7, 7, 10, 0, 1);
	const next = nextFirstFriday1000(from);
	assert.equal(next.getDate(), 4);
	assert.equal(next.getMonth(), 8);
	assert.equal(next.getHours(), 10);
});

test("nextFirstFriday1000 rolls across the year boundary", () => {
	const from = new Date(2026, 11, 4, 11, 0, 0); // after Dec 4 2026 run
	const next = nextFirstFriday1000(from);
	assert.equal(next.getFullYear(), 2027);
	assert.equal(next.getMonth(), 0);
	assert.equal(next.getDay(), 5);
});

test("isFirstFriday1000 is true on the day from 10:00, false before", () => {
	// Aug 7 2026 is the first Friday.
	assert.equal(isFirstFriday1000(new Date(2026, 7, 7, 10, 0, 0)), true);
	assert.equal(isFirstFriday1000(new Date(2026, 7, 7, 9, 59, 59)), false);
	// Aug 14 2026 is a Friday but not the FIRST Friday.
	assert.equal(isFirstFriday1000(new Date(2026, 7, 14, 10, 0, 0)), false);
});

test("msUntilNextFirstFriday1000 is never negative", () => {
	for (const [y, m, d] of [
		[2026, 0, 1],
		[2026, 7, 7],
		[2026, 11, 31],
	] as const) {
		assert.ok(msUntilNextFirstFriday1000(new Date(y, m, d)) >= 0);
	}
});
