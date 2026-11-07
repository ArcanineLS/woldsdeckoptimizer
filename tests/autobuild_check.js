// node tests/autobuild_check.js [seconds] — auto-create on the fixture deck's setup (deck, implicits, cores)
// for each build focus; checks slot rules and pack-rollable cards, and compares with the in-game layout.
const fs = require("fs");
if (!fs.existsSync(__dirname + "/fixtures/mystery_deck.snbt")) {
  console.log("Missing tests/fixtures/mystery_deck.snbt (personal data, not committed). In game click Copy for Optimizer on a deck and save the copied text to that file.");
  process.exit(1);
}
globalThis.window = globalThis;
require("../js/engine.js"); require("../js/deckimport.js"); require("../js/optimizer.js"); require("../js/autobuild.js");
const E = Engine, I = DeckImport, O = Optimizer, A = AutoBuild;
const D = JSON.parse(fs.readFileSync(__dirname + "/../data/game-data.json", "utf8"));
const secs = +process.argv[2] || 4;
let n = 0;
const st = I.toState(I.extractDeckTag(fs.readFileSync(__dirname + "/fixtures/mystery_deck.snbt", "utf8")), D, E, () => "c" + n++);
const ctx = E.createContext({ deckId: st.deckId, layoutEdits: st.layoutEdits, implicits: st.implicits, cores: st.cores }, D);
const byUid = new Map(st.cards.map((c) => [c.uid, E.resolveCard(c, D)]));
const ingame = ctx.layout.slots.map((s) => byUid.get(st.placement[s.k]) || null);
let ok = true;
for (const [fid, f] of Object.entries(A.FOCUS)) {
  if (!f.keys) continue;
  const spec = A.focusSpec(f.keys);
  const raw = A.makeTemplates(f.keys, D, E, ctx);
  const templates = raw.map((c) => E.resolveCard(c, D));
  const res = O.search({ ctx, cards: [], initial: ctx.layout.slots.map(() => null), locked: new Set(), spec, budgetMs: secs * 1000, templates });
  const placed = res.place.filter(Boolean);
  const valid = res.place.every((c, i) => !c || E.canPlace(c, ctx.layout.slots[i], ctx)) && placed.every((c) => D.obtainable[c.entries[0].src.mod]);
  const tot = E.evaluate(ctx, res.place).totals;
  const show = f.keys.map((k) => `${E.attrLabel(k, D)} ${tot[k] == null ? "-" : E.formatValue(k, tot[k], D)}`).join(", ");
  const base = O.tuple(E.evaluate(ctx, ingame, { detail: false }), spec, D).at(-1);
  console.log(`${f.label}: ${raw.length} candidates, ${placed.length}/${ctx.layout.slots.length} slots, score ${res.tuple.at(-1).toFixed(1)} (in-game layout ${base.toFixed(1)}) | ${show}${valid ? "" : " | INVALID"}`);
  if (!valid || placed.length < ctx.layout.slots.length - 2) ok = false;
}
console.log(ok ? "all focuses built valid decks" : "CHECKS FAILED");
if (!ok) process.exit(1);

// Balanced build with core and implicit choice (focus vs Health / Armor / Resistance)
let ok2 = true;
for (const fid of ["ability", "attack", "tank"]) {
  const f = A.FOCUS[fid];
  const spec = A.balanceSpec(f.keys, A.BALANCE.balanced.focus, true);
  const keys = [...new Set([...f.keys, ...A.SURVIVAL])];
  const templates = A.makeTemplates(keys, D, E, ctx).map((c) => E.resolveCard(c, D));
  const deckState = { deckId: st.deckId, layoutEdits: st.layoutEdits, implicits: st.implicits, cores: st.cores };
  const r = A.searchWithCores({ D, E, O, deckState, cards: [], templates, initial: ctx.layout.slots.map(() => null), locked: new Set(),
    spec, budgetMs: secs * 1000, sockets: 2, chooseImplicits: true, randomStart: false });
  const c2 = E.createContext(r.state, D);
  const valid = r.place.every((c, i) => !c || E.canPlace(c, c2.layout.slots[i], c2));
  const tot = E.evaluate(c2, r.place).totals;
  const goals = spec.goals.map((g) => `${E.attrLabel(g.key, D)} ${tot[g.key] == null ? "0" : E.formatValue(g.key, tot[g.key], D)}`).join(", ");
  const names = (list) => (list || []).filter(Boolean).map((c) => (E.coreVariant(D.cores[c.id], c.variant) || {}).name || D.cores[c.id].name || c.id).join(" + ");
  console.log(`balanced ${f.label}: ${goals} | cores ${names(r.state.cores)} | implicits ${names(r.state.implicits)}${valid ? "" : " | INVALID"}`);
  if (!valid || spec.goals.some((g) => !(tot[g.key] > 0))) ok2 = false;
}
console.log(ok2 ? "balanced builds cover every goal" : "BALANCED CHECKS FAILED");
if (!ok2) process.exit(1);
