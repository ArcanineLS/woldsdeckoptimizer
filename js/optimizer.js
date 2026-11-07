/*
 * Placement optimizer.
 *
 * Objective (spec = { mode, weights, priority }):
 *   mode "mult":   each card scores its multiplier (scaler count N x efficiency M x greed G; level and
 *                  vault-modifier cards count N), times its attribute weight. Raw totals break ties.
 *   mode "totals": weight x displayed total per attribute (percent attributes in percent points).
 *   priority:      up to three attribute keys, optimized strictly in order (lexicographic): priority 1 is
 *                  maximized first, then priority 2 without lowering priority 1, and so on.
 *
 * Search: staged parallel tempering (replica exchange) over card -> slot assignments, then an exhaustive
 * local polish (every swap, replacement and removal) until no single change improves the result.
 * Runs in Web Workers (js/optworker.js); the same code runs on the main thread as a fallback.
 */
(function (global) {
  "use strict";
  const E = global.Engine;

  // ---------------------------------------------------------------- objective
  function metric(res, k, spec, data) {
    if (spec.mode === "mult") return res.mults[k] || 0;
    const v = res.totals[k];
    const d = v == null ? 0 : E.displayValue(k, v, data);
    // player stat caps (displayed units): anything above the cap does nothing in game
    return spec.caps && spec.caps[k] != null ? Math.min(d, spec.caps[k]) : d;
  }
  /**
   * Balance objective (auto build): goals [{key, weight}]. Score = sum of weight x ln(1 + total), the weighted
   * product of the goals, so no goal can be traded away for a large gain elsewhere.
   */
  function balanceScore(res, spec, data) {
    let s = 0;
    for (const g of spec.goals) s += g.weight * Math.log1p(Math.max(0, metric(res, g.key, { mode: "totals", caps: spec.caps }, data)));
    return s;
  }
  /** Lexicographic score tuple: [priority 1, priority 2, ..., weighted score]. */
  function tuple(res, spec, data) {
    if (spec.mode === "balance") return [balanceScore(res, spec, data)];
    const keys = new Set([...Object.keys(res.totals), ...Object.keys(res.mults)]);
    let base = 0, raw = 0;
    for (const k of keys) {
      const w = spec.weights[k] ?? (spec.defaultWeight ?? 1);
      if (!w) continue;
      base += w * metric(res, k, spec, data);
      if (spec.mode === "mult" && res.totals[k] != null) raw += w * E.displayValue(k, res.totals[k], data);
    }
    const t = (spec.priority || []).map((k) => metric(res, k, spec, data));
    t.push(base + raw * 1e-6);
    return t;
  }
  const tol = (a) => 1e-9 * Math.max(1, Math.abs(a));
  /** -1 if a < b, 0 if equal within tolerance, 1 if a > b (lexicographic). */
  function compare(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] > b[i] + tol(b[i])) return 1;
      if (a[i] < b[i] - tol(b[i])) return -1;
    }
    return 0;
  }
  /** Weighted score for display (no priorities). */
  function score(res, spec, data) {
    const t = tuple(res, Object.assign({}, spec, { priority: [] }), data);
    return t[t.length - 1];
  }

  // ---------------------------------------------------------------- search state helpers
  function makeProblem(opts) {
    const { ctx, cards, initial } = opts;
    const n = ctx.layout.slots.length;
    const locked = opts.locked || new Set();
    const free = [...Array(n).keys()].filter((i) => !locked.has(i));
    const lockedUids = new Set([...locked].map((i) => initial[i] && initial[i].uid).filter(Boolean));
    const movable = cards.filter((c) => !lockedUids.has(c.uid));
    const fits = (rc, i) => !rc || E.canPlace(rc, ctx.layout.slots[i], ctx);
    const evalT = (p) => tuple(E.evaluate(ctx, p, { detail: false }), opts.spec, ctx.data);
    // templates: candidate cards with unlimited copies (auto build); each placement is a fresh clone
    const templates = opts.templates || [];
    let seq = 0;
    const clone = (t) => { const uid = "new-" + Date.now().toString(36) + "-" + (seq++).toString(36); return Object.assign({}, t, { uid, card: Object.assign({}, t.card, { uid }) }); };
    return { ctx, n, locked, free, movable, fits, evalT, spec: opts.spec, templates, clone, polishDeadline: opts.polishDeadline || Infinity };
  }
  const poolOf = (P, p) => { const on = new Set(p.filter(Boolean).map((c) => c.uid)); return P.movable.filter((c) => !on.has(c.uid)); };

  function randomFill(P, base) {
    const p = base.slice();
    const pool = poolOf(P, p).sort(() => Math.random() - 0.5);
    for (const i of P.free.slice().sort(() => Math.random() - 0.5)) {
      if (p[i]) continue;
      const k = pool.findIndex((c) => P.fits(c, i));
      if (k >= 0) { p[i] = pool.splice(k, 1)[0]; continue; }
      if (P.templates.length) {
        const fit = P.templates.filter((t) => P.fits(t, i));
        if (fit.length) p[i] = P.clone(fit[(Math.random() * fit.length) | 0]);
      }
    }
    return p;
  }

  /** One random move on (p, pool); returns an undo function or null if not applicable. */
  function randomMove(P, p, pool) {
    const F = P.free;
    const r = Math.random();
    if (r < 0.55) {
      const a = F[(Math.random() * F.length) | 0], b = F[(Math.random() * F.length) | 0];
      if (a === b || (!p[a] && !p[b]) || !P.fits(p[b], a) || !P.fits(p[a], b)) return null;
      [p[a], p[b]] = [p[b], p[a]];
      return () => { [p[a], p[b]] = [p[b], p[a]]; };
    }
    if (r < 0.92 && P.templates.length && (!pool.length || Math.random() < 0.7)) {
      const a = F[(Math.random() * F.length) | 0];
      const t = P.templates[(Math.random() * P.templates.length) | 0];
      if (!P.fits(t, a)) return null;
      const prev = p[a];
      const backToPool = !!prev && P.movable.includes(prev); // owned cards return to the pool, clones are dropped
      p[a] = P.clone(t);
      if (backToPool) pool.push(prev);
      return () => { p[a] = prev; if (backToPool) pool.pop(); };
    }
    if (r < 0.92 && pool.length) {
      const a = F[(Math.random() * F.length) | 0], pi = (Math.random() * pool.length) | 0, c = pool[pi];
      if (!P.fits(c, a)) return null;
      const prev = p[a];
      p[a] = c;
      if (prev) pool[pi] = prev; else pool.splice(pi, 1);
      return () => { p[a] = prev; if (prev) pool[pi] = c; else pool.splice(pi, 0, c); };
    }
    const a = F[(Math.random() * F.length) | 0];
    if (!p[a]) return null;
    const prev = p[a];
    p[a] = null; pool.push(prev);
    return () => { pool.pop(); p[a] = prev; };
  }

  // ---------------------------------------------------------------- parallel tempering (one stage)
  /**
   * Maximizes component `stage` of the tuple subject to components < stage staying >= floor[...].
   * Returns the best feasible {p, t}.
   */
  function temperStage(P, starts, stage, floor, deadline, stats) {
    const val = (t) => {
      for (let r = 0; r < stage; r++) if (t[r] < floor[r] - tol(floor[r])) return -Infinity;
      return t[stage];
    };
    const K = starts.length;
    const reps = starts.map((p0) => { const p = p0.slice(); const t = P.evalT(p); stats.evals++; return { p, pool: poolOf(P, p), t, f: val(t) }; });
    let best = null;
    for (const R of reps) if (R.f > -Infinity && (!best || compare(R.t, best.t) > 0)) best = { p: R.p.slice(), t: R.t };

    // temperature ladder from the typical size of a move's score change
    let sum = 0, cnt = 0;
    const probe = reps[0];
    for (let i = 0; i < 300 && Date.now() < deadline; i++) {
      const undo = randomMove(P, probe.p, probe.pool);
      if (!undo) continue;
      const f = val(P.evalT(probe.p)); stats.evals++;
      if (f > -Infinity && probe.f > -Infinity && f !== probe.f) { sum += Math.abs(f - probe.f); cnt++; }
      undo();
    }
    const Thi = cnt ? (sum / cnt) * 1.5 : 1;
    const temps = reps.map((_, i) => Thi * Math.pow(1e-4, i / Math.max(1, K - 1)));

    while (Date.now() < deadline) {
      for (let r = 0; r < K; r++) {
        const R = reps[r], T = temps[r];
        for (let m = 0; m < 40; m++) {
          const undo = randomMove(P, R.p, R.pool);
          if (!undo) continue;
          const t = P.evalT(R.p); stats.evals++;
          const f = val(t);
          const d = f - R.f;
          if (f > -Infinity && (d >= 0 || Math.random() < Math.exp(d / T))) {
            R.t = t; R.f = f;
            if (!best || compare(t, best.t) > 0) best = { p: R.p.slice(), t };
          } else undo();
        }
      }
      // replica exchange between neighbouring temperatures
      for (let r = 0; r + 1 < K; r++) {
        const a = reps[r], b = reps[r + 1];
        if (a.f === -Infinity || b.f === -Infinity) continue;
        const x = (b.f - a.f) * (1 / temps[r] - 1 / temps[r + 1]);
        if (x >= 0 || Math.random() < Math.exp(x)) { reps[r] = b; reps[r + 1] = a; }
      }
      if (stats.onBest && best) stats.onBest(best);
    }
    return best;
  }

  // ---------------------------------------------------------------- polish
  /** Exhaustive first-improvement local search until no swap / replacement / removal improves the tuple. */
  function polish(P, p0, stats) {
    const p = p0.slice();
    let cur = P.evalT(p); stats.evals++;
    for (let pass = 0; pass < 500; pass++) {
      let improved = false;
      const F = P.free;
      const tryIt = (apply, undo) => {
        apply();
        const t = P.evalT(p); stats.evals++;
        if (compare(t, cur) > 0) { cur = t; improved = true; return true; }
        undo();
        return false;
      };
      for (let x = 0; x < F.length; x++) for (let y = x + 1; y < F.length; y++) {
        const a = F[x], b = F[y];
        if ((!p[a] && !p[b]) || !P.fits(p[b], a) || !P.fits(p[a], b)) continue;
        const sw = () => { [p[a], p[b]] = [p[b], p[a]]; };
        tryIt(sw, sw);
      }
      for (const a of F) {
        if (Date.now() > P.polishDeadline) break;
        for (const c of poolOf(P, p)) {
          if (!P.fits(c, a)) continue;
          const prev = p[a];
          tryIt(() => { p[a] = c; }, () => { p[a] = prev; });
        }
        for (const t of P.templates) {
          if (!P.fits(t, a)) continue;
          const prev = p[a], c = P.clone(t);
          tryIt(() => { p[a] = c; }, () => { p[a] = prev; });
        }
        if (p[a]) { const prev = p[a]; tryIt(() => { p[a] = null; }, () => { p[a] = prev; }); }
      }
      if (!improved || Date.now() > P.polishDeadline) break;
    }
    return { p, t: cur };
  }

  // ---------------------------------------------------------------- full search
  /**
   * opts: { ctx, cards (resolved), initial (slot -> rc|null), locked: Set(slot), spec, budgetMs,
   *         replicas, onBest({p, t}) }  -> { place, tuple, evals }
   */
  function search(opts) {
    const P = makeProblem(opts);
    const stats = { evals: 0, onBest: opts.onBest || null };
    const stages = (opts.spec.priority || []).length + 1;
    const K = opts.replicas || 6;
    const start = Date.now(), budget = Math.max(200, opts.budgetMs || 5000);
    if (P.templates.length) P.polishDeadline = start + budget * 1.15; // many candidates: cap the polish
    let best = { p: opts.initial.slice(), t: P.evalT(opts.initial) };
    const floor = [];
    for (let s = 0; s < stages; s++) {
      const deadline = start + (budget * 0.92 * (s + 1)) / stages;
      const starts = [best.p];
      for (let r = 1; r < K; r++) starts.push(s === 0 ? randomFill(P, opts.initial.map((x, i) => (P.locked.has(i) ? x : null))) : best.p);
      const got = temperStage(P, starts, s, floor, deadline, stats);
      if (got && compare(got.t, best.t) >= 0) best = got;
      floor[s] = best.t[s];
    }
    best = polish(P, best.p, stats);
    return { place: best.p, tuple: best.t, evals: stats.evals };
  }

  global.Optimizer = { tuple, compare, score, metric, balanceScore, search, polish: (opts) => polish(makeProblem(opts), opts.initial, { evals: 0 }) };
})(typeof window !== "undefined" ? window : self);
