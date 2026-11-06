import assert from "node:assert/strict";
import { test } from "node:test";
import { cardReducer, changedSlides, deckEditDetails, initialCard, type CardEvent, type CardState } from "./deckProposal.ts";

const run = (events: CardEvent[], from: CardState = initialCard) => events.reduce(cardReducer("p1"), from);

test("deck_edit details parse, and malformed ones do not", () => {
  const d = deckEditDetails({ deck_id: "d", path: "/a/方案.pptx", proposal_id: "p1", revision: 3, slides: [{ index: 2, slide_id: "s3", status: "moved" }, { index: 0, slide_id: "s1", status: "weird" }, { index: 1, slide_id: "s2", status: "unchanged" }] });
  assert.ok(d);
  assert.deepEqual(changedSlides(d).map((s) => [s.index, s.status]), [[0, "changed"], [2, "moved"]]);
  assert.equal(deckEditDetails({ deck_id: "d" }), null);
  assert.equal(deckEditDetails(undefined), null);
});

test("accepting from the card", () => {
  const busy = run([{ type: "start", action: "accept" }]);
  assert.equal(busy.busy, "accept");
  // A second press while waiting changes nothing.
  assert.equal(run([{ type: "start", action: "reject" }], busy), busy);
  assert.equal(run([{ type: "accepted", applied: true }], busy).status, "accepted");
});

test("an accept that did not apply leaves it pending and stale", () => {
  const s = run([{ type: "start", action: "accept" }, { type: "accepted", applied: false }]);
  assert.deepEqual([s.status, s.stale, s.busy], ["pending", true, null]);
});

test("rejecting, and a reject that found it already decided", () => {
  assert.equal(run([{ type: "start", action: "reject" }, { type: "rejected", rejected: true }]).status, "rejected");
  assert.equal(run([{ type: "start", action: "reject" }, { type: "rejected", rejected: false }]).status, "handled");
});

test("a failure keeps it pending with the message", () => {
  const s = run([{ type: "start", action: "accept" }, { type: "failed", message: "x" }]);
  assert.deepEqual([s.status, s.busy, s.error], ["pending", null, "x"]);
});

test("a refetch learns of decisions made in the editor", () => {
  assert.equal(run([{ type: "listed", proposals: [{ id: "p1", status: "pending" }] }]).status, "pending");
  assert.equal(run([{ type: "listed", proposals: [{ id: "other", status: "pending" }] }]).status, "handled");
  assert.equal(run([{ type: "listed", proposals: [{ id: "p1", status: "accepted" }] }]).status, "accepted");
  assert.equal(run([{ type: "listed", proposals: [{ id: "p1", status: "rejected" }] }]).status, "rejected");
});

test("what the card decided itself is not overridden by a refetch", () => {
  const s = run([{ type: "start", action: "accept" }, { type: "accepted", applied: true }, { type: "listed", proposals: [] }]);
  assert.equal(s.status, "accepted");
  // handled, then seen pending again (an undo in the editor): pending.
  assert.equal(run([{ type: "listed", proposals: [] }, { type: "listed", proposals: [{ id: "p1", status: "pending" }] }]).status, "pending");
});
