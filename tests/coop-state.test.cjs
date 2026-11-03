"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../coop-state.js");

const round = () => ({
  id: "test-round-123456", step: 1, crystal: "amethyst", species: "wisp", shiny: false,
  stone: 0, target: 24, hollow: [0.5, 0.5],
  cracks: Array.from({ length: 3 }, () => ({ pts: [[0.2, 0.2], [0.4, 0.4], [0.5, 0.5]],
    cornerAt: [0, 2], branches: [{ at: 1, pts: [[0.4, 0.4], [0.45, 0.35]] }], knots: [], passes: 1 })),
  web: { impact: [0.5, 0.45],
    rays: [{ crack: 0 }, { after: 0, pts: [[0.5, 0.4], [0.55, 0.3]] }, { crack: 1 }, { crack: 2 }],
    hoops: [{ a: 1, ia: 1, b: 2, ib: 1, pts: [[0.4, 0.4], [0.5, 0.38], [0.55, 0.3]] }] },
});
const state = () => ({
  round: "test-round-123456", seq: 1, phase: "cracking", clock: 2, t: 0, acc: { sum: 5, n: 1 },
  hollowFound: false, chipsTapped: 0,
  cracks: Array.from({ length: 3 }, () => ({ cov: [true, false, false], knots: [], done: false, pass: 0 })),
  matte: null,
});

test("maps the same normalized point into different egg layouts", () => {
  const phone = { ex0: 20, ey0: 40, ew: 200, eh: 256 };
  const tablet = { ex0: 80, ey0: 100, ew: 400, eh: 512 };
  assert.deepEqual(S.normalisePoint(120, 168, phone), [0.5, 0.5]);
  assert.deepEqual(S.projectPoint([0.5, 0.5], tablet), [280, 356]);
});
test("accepts a bounded shared egg and matching progress", () => {
  assert.equal(S.validRound(round()), true);
  assert.equal(S.validState(state(), round()), true);
});
for (const [label, change] of [
  ["unsupported difficulty", r => { r.step = 24; }],
  ["invalid round id", r => { r.id = "<script>"; }],
  ["too many cracks", r => { r.cracks = Array(9).fill(r.cracks[0]); }],
  ["oversized point list", r => { r.cracks[0].pts = Array(101).fill([0.5, 0.5]); }],
  ["out-of-bounds geometry", r => { r.hollow = [-5, 0]; }],
  ["non-finite geometry", r => { r.cracks[0].pts[0][0] = NaN; }],
  ["invalid knot index", r => { r.cracks[0].knots = [99]; }],
  ["invalid corner index", r => { r.cracks[0].cornerAt = [0, 99]; }],
  ["invalid branch anchor", r => { r.cracks[0].branches[0].at = 99; }],
  ["oversized branch geometry", r => { r.cracks[0].branches[0].pts = Array(5).fill([0.4, 0.4]); }],
  ["branch detached from crack", r => { r.cracks[0].branches[0].pts[0] = [0, 0]; }],
  ["invalid pass count", r => { r.cracks[0].passes = 100; }],
  ["invalid species id", r => { r.species = "<img src=x>"; }],
  ["missing impact web", r => { delete r.web; }],
  ["out-of-bounds impact", r => { r.web.impact = [3, 3]; }],
  ["crack missing from the web", r => { r.web.rays = r.web.rays.filter(x => x.crack !== 2); }],
  ["crack used twice in the web", r => { r.web.rays[2].crack = 0; }],
  ["short ray waiting on no crack", r => { r.web.rays[1].after = 9; }],
  ["hoop on a missing ray", r => { r.web.hoops[0].b = 9; }],
  ["hoop past the end of its ray", r => { r.web.hoops[0].ia = 50; }],
  ["oversized hoop", r => { r.web.hoops[0].pts = Array(41).fill([0.4, 0.4]); }],
  ["too many hoops", r => { r.web.hoops = Array(65).fill(r.web.hoops[0]); }],
]) test(`rejects ${label}`, () => { const r = round(); change(r); assert.equal(S.validRound(r), false); });
test("accepts impact-web cracks, which have no corners or branches", () => {
  const r = round();
  r.cracks.forEach(c => { c.cornerAt = []; c.branches = []; });
  assert.equal(S.validRound(r), true);
});
test("accepts the engine's degenerate single-point crack without inventing geometry", () => {
  const r = round();
  r.cracks[0] = { pts: [[0.5, 0.5]], cornerAt: [0], branches: [], knots: [], passes: 1 };
  assert.equal(S.validRound(r), true);
});
for (const [label, change] of [
  ["wrong round", s => { s.round = "different-round"; }],
  ["invalid sequence", s => { s.seq = -1; }],
  ["non-finite clock", s => { s.clock = Infinity; }],
  ["unknown phase", s => { s.phase = "restoreSave"; }],
  ["wrong coverage shape", s => { s.cracks[0].cov = [true]; }],
  ["non-boolean coverage", s => { s.cracks[0].cov[0] = "yes"; }],
  ["invalid pass", s => { s.cracks[0].pass = 2; }],
  ["premature hatch", s => { s.phase = "open"; }],
  ["impossible accuracy", s => { s.acc = { n: 1, sum: 10000 }; }],
  ["unexpected polish", s => { s.matte = { hits: [0], shine: 0 }; }],
]) test(`rejects ${label}`, () => { const s = state(); change(s); assert.equal(S.validState(s, round()), false); });

test("validates complete hatches and bounded polish data", () => {
  const r = round(), s = state();
  s.phase = "open";
  s.cracks.forEach(c => { c.done = true; c.cov.fill(true); });
  s.matte = { hits: [3, 3, 0], shine: 2 / 3 };
  assert.equal(S.validState(s, r), true);
  s.matte.hits = Array(513).fill(3);
  assert.equal(S.validState(s, r), false);
});
test("accepts the final shine rounding only after a sufficiently polished face", () => {
  const r = round(), s = state();
  s.phase = "gleam";
  s.cracks.forEach(c => { c.done = true; c.cov.fill(true); });
  s.matte = { hits: [...Array(9).fill(3), 0], shine: 1 };
  assert.equal(S.validState(s, r), true);
  s.matte = { hits: [0], shine: 1 };
  assert.equal(S.validState(s, r), false);
});
test("remote actions are round-scoped and cannot call arbitrary game functions", () => {
  const id = round().id;
  assert.equal(S.validInput({ round: id, seq: 1, kind: "down", point: [0.5, 0.5] }, id), true);
  assert.equal(S.validInput({ round: id, seq: 2, kind: "cancel" }, id), true);
  assert.equal(S.validInput({ round: id, seq: 3, kind: "finish" }, id), true);
  assert.equal(S.validInput({ round: "old-round-12345", seq: 4, kind: "down", point: [0.5, 0.5] }, id), false);
  assert.equal(S.validInput({ round: id, seq: 5, kind: "restoreFromCode" }, id), false);
  assert.equal(S.validInput({ round: id, seq: 6, kind: "move", point: [1e20, 0] }, id), false);
  assert.equal(S.validInput({ round: id, seq: 7, kind: "move", point: [null, 0] }, id), false);
});
