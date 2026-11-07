// node tests/plan_check.js — runs the KubeJS Apply Layout logic (plan v3) against a mock deck menu.
// Cards carry their real item data (the card SNBT from the export), the player has a 36-slot inventory,
// identical cards do not swap (vanilla PICKUP), and the server answers each click by bumping the state id.
const fs = require("fs");
if (!fs.existsSync(__dirname + "/fixtures/mystery_deck.snbt")) {
  console.log("Missing tests/fixtures/mystery_deck.snbt (personal data, not committed). In game click Copy for Optimizer on a deck and save the copied text to that file.");
  process.exit(1);
}
globalThis.window = globalThis;
require("../js/engine.js"); require("../js/deckimport.js");
const I = globalThis.DeckImport;
const D = JSON.parse(fs.readFileSync(__dirname + "/../data/game-data.json", "utf8"));
const txt = fs.readFileSync(__dirname + "/fixtures/mystery_deck.snbt", "utf8");
let n = 0;
const st = I.toState(I.extractDeckTag(txt), D, globalThis.Engine, () => "c" + n++);
const raws = I.extractDeckTag(txt).data.cards.map((s) => s.card.__raw);
const nameOf = (c) => D.cards[c.entries[0].mod].name.text;
const keys = D.decks.mystery.layout[0].value.flatMap((r, y) => [...r].map((ch, x) => (ch === "O" || ch === "A") ? [x + "," + y, ch] : null)).filter(Boolean);
const arcane = new Set(keys.filter((k) => k[1] === "A").map((k) => k[0]));
const items = st.cards.map((c, i) => ({ uid: c.uid, fp: c.fp, raw: raws[i], arc: c.entries[0].mod === "arcane" }));
if (items.some((it) => I.hash(it.raw) !== it.fp)) throw new Error("fingerprint mismatch");

// ---- mock game
let clipboard = "", carried = null, said = "", clicks = 0, stateId = 0, rejectAt = -1;
const deck = keys.map(([k], i) => ({ k, index: i, item: null }));
const invSlots = Array.from({ length: 36 }, (_, j) => ({ index: deck.length + j, item: null }));
const all = [...deck, ...invSlots];
const stackOf = (it) => ({
  item: it, copy: () => stackOf(it), isEmpty: () => it == null,
  getHoverName: () => ({ getString: () => "Card" }),
  getTag: () => (it ? { get: (k) => (k === "data" ? { toString: () => it.raw } : null), toString: () => `{data:${it.raw}}` } : null),
});
const slotApi = (s) => ({
  index: s.index, getContainerSlot: () => s.index, hasItem: () => s.item != null, getItem: () => stackOf(s.item),
  mayPlace: (stk) => !!stk.item && (s.k == null || arcane.has(s.k) === stk.item.arc),
});
const menu = {
  containerId: 7,
  getCarried: () => stackOf(carried),
  getStateId: () => stateId,
  getContainer: () => ({ getSlotMapping: () => ({ entrySet: () => { const a = deck.map((s) => ({ getKey: () => s.index, getValue: () => ({ x: +s.k.split(",")[0], y: +s.k.split(",")[1] }) })); let i = 0; return { iterator: () => ({ hasNext: () => i < a.length, next: () => a[i++] }) }; } }) }),
  getCardSlots: () => ({ size: () => deck.length, get: (i) => slotApi(deck[i]) }),
  getPlayerSlots: () => ({ size: () => invSlots.length, get: (i) => slotApi(invSlots[i]) }),
  getSlot: (i) => slotApi(all[i]),
  getDeckStack: () => ({ isEmpty: () => false, getTag: () => ({ toString: () => "{}" }) }),
};
const screenObj = { getMenu: () => menu };
const mc = {
  screen: screenObj,
  player: { displayClientMessage: (t) => (said = t.s) },
  keyboardHandler: { getClipboard: () => clipboard, setClipboard: (s) => (clipboard = s) },
  getSoundManager: () => null,
  gameMode: { handleInventoryMouseClick: (cid, i, btn, type) => {
    clicks++;
    if (clicks === rejectAt) return; // server rejects this click (no answer)
    const s = all[i];
    if (type === "QUICK_MOVE") {
      const free = invSlots.find((x) => !x.item);
      if (s.item && free) { free.item = s.item; s.item = null; stateId++; }
      return;
    }
    if (carried && s.k != null && arcane.has(s.k) !== carried.arc) return; // DeckSlot.mayPlace
    if (carried && s.item && carried.fp === s.item.fp) return; // identical cards: vanilla does nothing
    [carried, s.item] = [s.item, carried];
    stateId++;
  } },
};
const src = fs.readFileSync(__dirname + "/../tools/kubejs/wdo_deck_export.js", "utf8");
const java = (name) => ({
  "net.minecraft.client.Minecraft": { getInstance: () => mc },
  "net.minecraft.network.chat.TextComponent": function (s) { this.s = s; },
  "net.minecraft.world.inventory.ClickType": { PICKUP: "PICKUP", QUICK_MOVE: "QUICK_MOVE" },
  "net.minecraft.world.item.ItemStack": { matches: (a, b) => (a.item ? a.item.fp : null) === (b.item ? b.item.fp : null) },
}[name] || function () {});
const handlers = {};
globalThis.console.info = () => {};
const api = new Function("java", "onForgeEvent", src + "\nreturn { wdoApply, wdoHash, queued: () => wdoQueue };")(java, (nm, fn) => (handlers[nm] = fn));
if (api.wdoHash(raws[0]) !== I.hash(raws[0])) throw new Error("script hash differs from site hash");
const tick = handlers["net.minecraftforge.event.TickEvent$ClientTickEvent"];
function apply() {
  api.wdoApply(screenObj, { setMessage: () => {} });
  let t = 0;
  while (api.queued() && t < 5000) { tick({ phase: "END" }); t++; }
  return t;
}

// ---- helpers
function reset() {
  all.forEach((s) => (s.item = null)); carried = null;
  st.cards.forEach((c, i) => (deck.find((s) => s.k === Object.keys(st.placement).find((k) => st.placement[k] === c.uid)).item = items[i]));
}
function randomPlacement() {
  const normal = keys.filter((k) => k[1] === "O").map((k) => k[0]).sort(() => Math.random() - 0.5);
  const p = {};
  for (const c of st.cards) {
    if (Math.random() < 0.1) continue;
    if (c.entries[0].mod === "arcane") { p["3,2"] = c.uid; continue; }
    const k = normal.pop(); if (k) p[k] = c.uid;
  }
  return p;
}
const fpOfUid = new Map(st.cards.map((c) => [c.uid, c.fp]));
const deckMatches = (p) => deck.every((s) => (s.item ? s.item.fp : undefined) === (p[s.k] ? fpOfUid.get(p[s.k]) : undefined)) && carried == null;
const cardCount = () => all.filter((s) => s.item).length + (carried ? 1 : 0);

// 1. repeated layouts; removed cards go to the inventory and come back in later layouts
let fails = 0, runs = 0, maxTicks = 0, c0 = clicks;
for (let t = 0; t < 60; t++) {
  reset();
  for (let cycle = 0; cycle < 5; cycle++) {
    const p = randomPlacement();
    clipboard = I.buildPlan(st.cards, p, nameOf).text;
    maxTicks = Math.max(maxTicks, apply()); runs++;
    if (!deckMatches(p) || cardCount() !== items.length) { fails++; if (fails < 4) console.log("FAIL cycle", cycle, said); break; }
  }
}
console.log(fails ? `${fails} failures` : `${runs} layouts applied correctly (cards pulled back from inventory)`, `| avg ${((clicks - c0) / runs).toFixed(1)} clicks, max ${maxTicks} ticks`);

// 2. deck rearranged by hand in game: still applies correctly
reset();
const a = deck.find((s) => s.k === "0,0"), b = deck.find((s) => s.k === "0,2");
[a.item, b.item] = [b.item, a.item];
let p = randomPlacement();
clipboard = I.buildPlan(st.cards, p, nameOf).text;
apply();
const handOk = deckMatches(p);
console.log(handOk ? "deck changed by hand: applied correctly" : "HAND-CHANGED DECK FAILED", "|", said);

// 3. a card that is nowhere: everything else applied, name reported
reset();
p = randomPlacement();
const gone = Object.keys(p).find((k) => k !== "3,2");
const goneUid = p[gone];
for (const s of all) if (s.item && s.item.uid === goneUid) s.item = null;
clipboard = I.buildPlan(st.cards, p, nameOf).text;
apply();
const p2 = Object.assign({}, p); delete p2[gone];
const missOk = deckMatches(p2) && said.includes("Not found");
console.log(missOk ? "missing card reported, rest applied:" : "MISSING CARD FAILED:", said);

// 4. server rejects one click: stops, cursor empty, no card lost
let recoverFails = 0, stopped = 0;
for (let t = 0; t < 100; t++) {
  reset();
  const before = cardCount();
  clipboard = I.buildPlan(st.cards, randomPlacement(), nameOf).text;
  rejectAt = clicks + 2 + Math.floor(Math.random() * 12);
  apply();
  if (said.startsWith("Apply Layout")) stopped++;
  rejectAt = -1;
  if (carried != null || cardCount() !== before) { recoverFails++; if (recoverFails < 3) console.log("RECOVER FAIL", said); }
}
console.log(recoverFails ? `${recoverFails} recovery failures` : `100 rejected-click runs: ${stopped} stopped, cursor empty, no card lost`);

// 5. deck export on the clipboard instead of a layout
clipboard = "WDO-DECK {}"; apply();
console.log("export on clipboard:", said);
if (fails || !handOk || !missOk || recoverFails || stopped < 95) process.exit(1);
