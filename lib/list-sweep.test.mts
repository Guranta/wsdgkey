import assert from "node:assert/strict";
import test from "node:test";
import { beginSweepTick, finishSweepTick, judgeListPage, readExplicitTotal, type SweepBook } from "./list-sweep.ts";

test("explicit totals are finite non-negative integers only", () => {
  assert.equal(readExplicitTotal(0), 0);
  assert.equal(readExplicitTotal(1812), 1812);
  assert.equal(readExplicitTotal("20"), 20);
  for (const value of [undefined, null, "", " ", "20.5", 1.5, Number.NaN, Number.POSITIVE_INFINITY, -1, {}, []]) {
    assert.equal(readExplicitTotal(value), null, JSON.stringify(value));
  }
});

test("a page finishes only when the unique ids match one agreed total and nothing failed", () => {
  assert.equal(judgeListPage({ explicitTotal: 0, agreedTotal: null, itemCount: 0, uniqueIds: 0 }).verdict, "complete");
  assert.equal(judgeListPage({ explicitTotal: 3, agreedTotal: 3, itemCount: 3, uniqueIds: 3 }).verdict, "complete");
  assert.equal(judgeListPage({ explicitTotal: 1812, agreedTotal: 1812, itemCount: 20, uniqueIds: 20 }).verdict, "continue");
  assert.equal(judgeListPage({ explicitTotal: null, agreedTotal: null, itemCount: 20, uniqueIds: 20 }).verdict, "abort");
  assert.equal(judgeListPage({ explicitTotal: 100, agreedTotal: 100, itemCount: 0, uniqueIds: 40 }).verdict, "abort");
  assert.equal(judgeListPage({ explicitTotal: 40, agreedTotal: null, itemCount: 5, uniqueIds: 5 }).verdict, "abort");
  assert.equal(judgeListPage({ explicitTotal: 10, agreedTotal: 10, itemCount: 20, uniqueIds: 20 }).verdict, "abort");
  assert.equal(judgeListPage({ explicitTotal: 80, agreedTotal: 100, itemCount: 20, uniqueIds: 40 }).verdict, "abort");
  assert.equal(
    judgeListPage({ explicitTotal: 1, agreedTotal: 1, itemCount: 1, uniqueIds: 1, errored: true }).verdict,
    "abort",
  );
});

test("an in-progress sweep is not reset by the 5-minute interval and runs past page 100", () => {
  const interval = 300_000;
  let book: SweepBook = { lastListSync: 5_000_000, pages: new Map([["gw", 90]]) };
  let now = 5_000_000;
  let lastPage = 90;
  for (let i = 0; i < 20; i += 1) {
    now += interval;
    const step = beginSweepTick(book, now, interval, ["gw"]);
    book = step.book;
    assert.equal(step.next?.id, "gw");
    assert.equal(step.next?.page, 90 + i);
    lastPage = step.next?.page ?? 0;
    book = finishSweepTick(book, "gw", false);
  }
  assert.ok(lastPage > 100);
  assert.equal(book.pages.get("gw"), 110);

  let fair: SweepBook = { lastListSync: 0, pages: new Map() };
  let at = 1_000_000;
  let first = beginSweepTick(fair, at, interval, ["a", "b"]);
  fair = first.book;
  assert.equal(first.next?.id, "a");
  assert.equal(first.next?.page, 1);
  fair = finishSweepTick(fair, "a", false);
  at += 15_000;
  first = beginSweepTick(fair, at, interval, ["a", "b"]);
  fair = first.book;
  assert.equal(first.next?.id, "b");
  assert.equal(first.next?.page, 1);
  fair = finishSweepTick(fair, "b", false);
  at += interval;
  first = beginSweepTick(fair, at, interval, ["a", "b"]);
  fair = first.book;
  assert.equal(first.next?.page, 2);
  assert.notEqual(first.next?.page, 1);

  const dropped = beginSweepTick({ lastListSync: at, pages: new Map([["gone", 7]]) }, at + 1_000, interval, []);
  assert.equal(dropped.next, null);
  assert.equal(dropped.book.pages.size, 0);
});
