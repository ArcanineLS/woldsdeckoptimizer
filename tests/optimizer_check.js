// node tests/optimizer_check.js [seconds per run] — optimizer quality and correctness on the fixture deck.
// Checks: valid layouts (no duplicates, slot rules), local optimality after polish, strict priorities,
// and how often independent runs reach the same result.
const fs = require("fs");
if (!fs.existsSync(__dirname + "/fixtures/mystery_deck.snbt")) {
  console.log("Missing tests/fixtures/mystery_deck.snbt (personal data, not committed). In game click Copy for Optimizer on a deck and save the copied text to that file.");
  process.exit(1);
}
globalThis.window = globalThis;
require("../js/engine.js"); require("../js/deckimport.js"); require("../js/optimizer.js");
const E = Engine, I = DeckImport, O = Optimizer;
const D = JSON.parse(fs.readFileSync(__dirname + "/../data/game-data.json", "utf8"));
const secs = +process.argv[2] || 2;
let n = 0;
const st = I.toState(I.extractDeckTag(fs.readFileSync(__dirname + "/fixtures/mystery_deck.snbt", "utf8")), D, E, () => "c" + n++);
const ctx = E.createContext({ deckId: st.deckId, layoutEdits: st.layoutEdits, implicits: st.implicits, cores: st.cores }, D);
const cards = st.cards.map((c) => E.resolveCard(c, D));
const byUid = new Map(cards.map((c) => [c.uid, c]));
const initial = ctx.layout.slots.map((s) => byUid.get(st.placement[s.k]) || null);
const weights = {}; // all 1
const run = (spec) => O.search({ ctx, cards, initial, locked: new Set(), spec, budgetMs: secs * 1000 });
const valid = (p) => {
  const u = p.filter(Boolean).map((c) => c.uid);
  return new Set(u).size === u.length && p.every((c, i) => !c || E.canPlace(c, ctx.layout.slots[i], ctx));
};
const localOpt = (p, spec) => {
  const t = O.tuple(E.evaluate(ctx, p, { detail: false }), spec, D);
  const q = O.polish({ ctx, cards, initial: p, locked: new Set(), spec });
  return O.compare(q.t, t) === 0;
};
const fmt = (t) => t.map((x) => Math.round(x * 1000) / 1000).join(" / ");
let ok = true;

const specMult = { mode: "mult", weights, priority: [] };
const start = O.tuple(E.evaluate(ctx, initial, { detail: false }), specMult, D);
console.log("in-game layout, multiplier score:", fmt(start));
const runs = [];
for (let r = 0; r < 4; r++) runs.push(run(specMult));
runs.sort((a, b) => O.compare(b.tuple, a.tuple));
const agree = runs.filter((r) => O.compare(r.tuple, runs[0].tuple) === 0).length;
console.log(`multiplier score, 4 runs x ${secs}s:`, runs.map((r) => fmt(r.tuple)).join(" | "), `| ${agree}/4 agree | ${(runs[0].evals / secs / 1000).toFixed(0)}k evals/s`);
for (const r of runs) { if (!valid(r.place)) { ok = false; console.log("INVALID LAYOUT"); } }
if (!localOpt(runs[0].place, specMult)) { ok = false; console.log("NOT LOCALLY OPTIMAL"); }
if (O.compare(runs[0].tuple, start) < 0) { ok = false; console.log("WORSE THAN START"); }

// strict priority: Increased Ability Power first. Priority-1 value must equal the best found when optimizing it alone.
const k1 = "the_vault:ability_power_percent", k2 = "the_vault:ability_power";
const alone = run({ mode: "mult", weights: Object.fromEntries([...new Set([...Object.keys(E.evaluate(ctx, initial).mults)])].map((k) => [k, k === k1 ? 1 : 0])), priority: [] });
const pri = run({ mode: "mult", weights, priority: [k1, k2] });
const aloneK1 = O.metric(E.evaluate(ctx, alone.place, { detail: false }), k1, { mode: "mult" }, D);
console.log("priority 1 alone:", fmt([aloneK1]), "| with priorities [1, 2, rest]:", fmt(pri.tuple));
if (pri.tuple[0] < aloneK1 - 1e-6) { ok = false; console.log("PRIORITY 1 NOT MAXIMIZED"); }
if (!valid(pri.place)) { ok = false; console.log("INVALID LAYOUT (priority)"); }

// totals mode still works
const tot = run({ mode: "totals", weights, priority: [] });
console.log("totals mode score:", fmt(tot.tuple), "| in-game layout:", fmt(O.tuple(E.evaluate(ctx, initial, { detail: false }), { mode: "totals", weights, priority: [] }, D)));
if (!valid(tot.place)) { ok = false; console.log("INVALID LAYOUT (totals)"); }
console.log(ok ? "all checks passed" : "CHECKS FAILED");
if (!ok) process.exit(1);
