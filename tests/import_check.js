// node tests/import_check.js — imports the fixture and prints deck totals (compare with the in-game tooltip)
const fs = require("fs");
if (!fs.existsSync(__dirname + "/fixtures/mystery_deck.snbt")) {
  console.log("Missing tests/fixtures/mystery_deck.snbt (personal data, not committed). In game click Copy for Optimizer on a deck and save the copied text to that file.");
  process.exit(1);
}
globalThis.window = globalThis;
require("../js/engine.js"); require("../js/deckimport.js");
const D = JSON.parse(fs.readFileSync(__dirname + "/../data/game-data.json", "utf8"));
const E = globalThis.Engine, I = globalThis.DeckImport;
const txt = fs.readFileSync(__dirname + "/fixtures/mystery_deck.snbt", "utf8");
let n = 0;
const st = I.toState(I.extractDeckTag(txt), D, E, () => "c" + n++);
console.log("deck", st.deckId, "cards", st.cards.length, "implicits", JSON.stringify(st.implicits), "cores", JSON.stringify(st.cores), "edits", JSON.stringify(st.layoutEdits));
console.log("warnings", st.warnings);
const S = { deckId: st.deckId, layoutEdits: st.layoutEdits, implicits: st.implicits, cores: st.cores };
const ctx = E.createContext(S, D);
const byUid = new Map(st.cards.map((c) => [c.uid, E.resolveCard(c, D)]));
const place = ctx.layout.slots.map((s) => byUid.get(st.placement[s.k]) || null);
console.log("placed", place.filter(Boolean).length, "unplaced", Object.keys(st.placement).filter((k) => !ctx.layout.index.has(k)));
const r = E.evaluate(ctx, place);
for (const [k, v] of Object.entries(r.totals)) console.log(k.padEnd(40), typeof v === "object" ? JSON.stringify(v) : E.formatValue(k, v, D));

// Resource card fixture (optional, personal data, not committed): the rolled task must be imported.
const resPath = __dirname + "/fixtures/resource_deck.snbt";
if (fs.existsSync(resPath)) {
  let m = 0;
  const rs = I.toState(I.extractDeckTag(fs.readFileSync(resPath, "utf8")), D, E, () => "r" + m++);
  const tasks = rs.cards.flatMap((c) => c.entries).filter((e) => D.cards[e.mod].type === "task_loot")
    .map((e) => `${e.mod}: ${e.value ?? "?"} ${e.task ? D.tasks.values[e.task.id].text.replace("${target}", e.task.target) : "TASK MISSING"}`);
  console.log("resource fixture:", tasks.join(" | "), rs.warnings.length ? rs.warnings : "");
  if (tasks.some((t) => t.includes("TASK MISSING"))) process.exit(1);
}
