/* Optimizer worker: runs one independent search (js/optimizer.js) and reports progress and the result. */
self.window = self;
importScripts("engine.js", "optimizer.js", "autobuild.js");
let D = null;
self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "data") { D = m.data; return; }
  if (m.type !== "run") return;
  const E = self.Engine, O = self.Optimizer;
  const ctx = E.createContext(m.deckState, D);
  const cards = m.cards.map((c) => E.resolveCard(c, D));
  const byUid = new Map(cards.map((c) => [c.uid, c]));
  const initial = m.initial.map((u) => (u ? byUid.get(u) || null : null));
  const templates = (m.templates || []).map((c) => E.resolveCard(c, D));
  const toUids = (p) => p.map((c) => (c ? c.uid : null));
  const toCards = (p) => p.map((c) => (c ? c.card : null));
  let last = 0;
  if (m.chooseCores) {
    const r = self.AutoBuild.searchWithCores({
      D, E, O, deckState: m.deckState, cards, templates, initial, locked: new Set(m.locked), spec: m.spec, budgetMs: m.budgetMs,
      sockets: m.sockets, chooseImplicits: m.chooseImplicits, randomStart: m.randomStart, coreList: m.coreList,
      onBest: (b) => self.postMessage({ type: "progress", uids: toUids(b.place), cards: toCards(b.place), tuple: b.tuple, state: b.state }),
    });
    self.postMessage({ type: "done", uids: toUids(r.place), cards: toCards(r.place), tuple: r.tuple, evals: r.evals, state: r.state });
    return;
  }
  const res = O.search({
    ctx, cards, initial, locked: new Set(m.locked), spec: m.spec, budgetMs: m.budgetMs, templates,
    onBest: (b) => {
      const now = Date.now();
      if (now - last < 400) return;
      last = now;
      self.postMessage({ type: "progress", uids: toUids(b.p), cards: toCards(b.p), tuple: b.t });
    },
  });
  self.postMessage({ type: "done", uids: toUids(res.place), cards: toCards(res.place), tuple: res.tuple, evals: res.evals });
};
