/* Shared, bounded wire shapes. No DOM, storage or network side effects. */
(function (root) {
  "use strict";
  const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
  const number = (x, min, max) => Number.isFinite(x) && x >= min && x <= max;
  const integer = (x, min, max) => Number.isSafeInteger(x) && x >= min && x <= max;
  const identifier = x => typeof x === "string" && /^[a-zA-Z0-9_-]{12,80}$/.test(x);
  const catalogId = x => typeof x === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(x);
  const point = (x, margin = 0) => Array.isArray(x) && x.length === 2 && x.every(n => number(n, -margin, 1 + margin));
  const phases = ["entering", "cracking", "ready", "opening", "polish", "gleam", "open"];

  function validRound(r) {
    if (!object(r) || !identifier(r.id) || ![1, 4, 8].includes(r.step) ||
        !catalogId(r.crystal) || !catalogId(r.species) || typeof r.shiny !== "boolean" ||
        !integer(r.stone, 0, 63) || !number(r.target, 1, 300) || !point(r.hollow) ||
        !Array.isArray(r.cracks) || r.cracks.length !== (r.step === 8 ? 4 : 3)) return false;
    return r.cracks.every(c => object(c) && Array.isArray(c.pts) && c.pts.length >= 1 &&
      c.pts.length <= 100 && c.pts.every(p => point(p)) && integer(c.passes, 1, 2) &&
      Array.isArray(c.knots) && c.knots.length <= 2 && new Set(c.knots).size === c.knots.length &&
      c.knots.every(i => integer(i, 0, c.pts.length - 1)) &&
      Array.isArray(c.cornerAt) && c.cornerAt.length <= c.pts.length &&
      c.cornerAt.every((n, i) => integer(n, 0, c.pts.length - 1) && (!i || n > c.cornerAt[i - 1])) &&
      Array.isArray(c.branches) && c.branches.length <= 32 && c.branches.every(b =>
        object(b) && integer(b.at, 0, c.pts.length - 1) && Array.isArray(b.pts) &&
        b.pts.length >= 2 && b.pts.length <= 4 && b.pts.every(p => point(p)) &&
        b.pts[0].every((n, j) => Math.abs(n - c.pts[b.at][j]) < 1e-6))) && validWeb(r.web, r.cracks);
  }

  // The impact web: every traced crack is one ray; short rays wait for a traced one; hoops join two rays.
  function validWeb(w, cracks) {
    if (!object(w) || !point(w.impact) || !Array.isArray(w.rays) || w.rays.length < cracks.length ||
        w.rays.length > 16 || !Array.isArray(w.hoops) || w.hoops.length > 64) return false;
    const used = new Set();
    const rayPts = w.rays.map(ray => {
      if (!object(ray)) return null;
      if (ray.crack !== undefined) {
        if (!integer(ray.crack, 0, cracks.length - 1) || used.has(ray.crack)) return null;
        used.add(ray.crack);
        return cracks[ray.crack].pts;
      }
      const ok = integer(ray.after, 0, cracks.length - 1) && Array.isArray(ray.pts) && ray.pts.length <= 100 && ray.pts.every(p => point(p));
      return ok ? ray.pts : null;
    });
    if (rayPts.some(p => !p) || used.size !== cracks.length) return false;
    return w.hoops.every(h => object(h) && integer(h.a, 0, w.rays.length - 1) && integer(h.b, 0, w.rays.length - 1) &&
      integer(h.ia, 0, rayPts[h.a].length - 1) && integer(h.ib, 0, rayPts[h.b].length - 1) &&
      Array.isArray(h.pts) && h.pts.length >= 2 && h.pts.length <= 40 && h.pts.every(p => point(p)));
  }

  function validState(s, r) {
    if (!validRound(r) || !object(s) || s.round !== r.id || !integer(s.seq, 0, 1e9) ||
        !phases.includes(s.phase) || !number(s.clock, 0, 86400) || !number(s.t, 0, 86400) ||
        !object(s.acc) || !integer(s.acc.n, 0, 1e9) || !number(s.acc.sum, 0, 60 * s.acc.n) ||
        typeof s.hollowFound !== "boolean" || !integer(s.chipsTapped, 0, 1e7) ||
        !Array.isArray(s.cracks) || s.cracks.length !== r.cracks.length) return false;
    const complete = phases.indexOf(s.phase) >= phases.indexOf("ready");
    if (!s.cracks.every((c, i) => {
      const base = r.cracks[i];
      return object(c) && Array.isArray(c.cov) && c.cov.length === base.pts.length &&
        c.cov.every(v => typeof v === "boolean") && typeof c.done === "boolean" &&
        integer(c.pass, 0, base.passes - 1) && Array.isArray(c.knots) &&
        c.knots.length === base.knots.length && c.knots.every(v => typeof v === "boolean") &&
        (!c.done || (c.cov.every(Boolean) && c.knots.every(Boolean) && c.pass === base.passes - 1)) &&
        (!complete || c.done);
    })) return false;
    const polished = phases.indexOf(s.phase) >= phases.indexOf("polish");
    if (!polished) return s.matte === null;
    const m = s.matte;
    if (!object(m) || !Array.isArray(m.hits) || m.hits.length < 1 || m.hits.length > 512 ||
        !m.hits.every(n => integer(n, 0, 3)) || !number(m.shine, 0, 1)) return false;
    const fraction = m.hits.filter(n => n === 3).length / m.hits.length;
    return Math.abs(m.shine - fraction) < 1e-6 ||
      (["gleam", "open"].includes(s.phase) && m.shine === 1 && fraction >= 0.9);
  }

  function validInput(p, round) {
    if (!object(p) || p.round !== round || !identifier(round) || !integer(p.seq, 0, 1e9) ||
        !["down", "move", "up", "cancel", "finish"].includes(p.kind)) return false;
    return ["cancel", "finish"].includes(p.kind) || point(p.point, 1);
  }
  const normalisePoint = (x, y, l) => [(x - l.ex0) / l.ew, (y - l.ey0) / l.eh];
  const projectPoint = (p, l) => [l.ex0 + p[0] * l.ew, l.ey0 + p[1] * l.eh];
  const api = { validRound, validState, validInput, normalisePoint, projectPoint };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HatchstoneCoopState = api;
})(typeof globalThis === "object" ? globalThis : this);
