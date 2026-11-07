/* In-game deck import: SNBT parser + CardDeck NBT -> optimizer state.
 * Input: output of tools/kubejs/wdo_deck_export.js ("WDO-DECK {...}"), the item tag SNBT,
 * or `/data get entity @s SelectedItem` output. */
(function () {
  "use strict";

  // ---------------------------------------------------------------- SNBT parser
  function parseSnbt(src) {
    let i = 0;
    const s = src;
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    const err = (m) => { throw new Error(`${m} at position ${i}`); };
    const expect = (c) => { ws(); if (s[i] !== c) err(`Expected "${c}"`); i++; };
    function quoted() {
      const q = s[i++];
      let out = "";
      while (i < s.length && s[i] !== q) {
        if (s[i] === "\\") { i++; out += s[i++]; } else out += s[i++];
      }
      if (s[i] !== q) err("Unterminated string");
      i++;
      return out;
    }
    function bare() {
      const st = i;
      while (i < s.length && /[0-9A-Za-z_\-.+]/.test(s[i])) i++;
      if (st === i) err("Unexpected character");
      return s.slice(st, i);
    }
    function scalar(tok) {
      const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([bslfdBSLFD]?)$/.exec(tok);
      if (m) return Number(m[1]);
      if (tok === "true") return true;
      if (tok === "false") return false;
      return tok;
    }
    function value() {
      ws();
      const c = s[i];
      if (c === "{") {
        i++;
        const o = {};
        ws();
        if (s[i] === "}") { i++; return o; }
        for (;;) {
          ws();
          const k = s[i] === '"' || s[i] === "'" ? quoted() : bare();
          expect(":");
          ws();
          const vs = i;
          o[k] = value();
          // keep the exact text of each card compound: its hash identifies the card item in game
          if (k === "card" && o[k] && typeof o[k] === "object") Object.defineProperty(o[k], "__raw", { value: s.slice(vs, i) });
          ws();
          if (s[i] === ",") { i++; continue; }
          if (s[i] === "}") { i++; return o; }
          err('Expected "," or "}"');
        }
      }
      if (c === "[") {
        i++;
        ws();
        if (/[BIL]/.test(s[i]) && s[i + 1] === ";") i += 2; // typed array
        const a = [];
        ws();
        if (s[i] === "]") { i++; return a; }
        for (;;) {
          a.push(value());
          ws();
          if (s[i] === ",") { i++; continue; }
          if (s[i] === "]") { i++; return a; }
          err('Expected "," or "]"');
        }
      }
      if (c === '"' || c === "'") return quoted();
      return scalar(bare());
    }
    const v = value();
    return v;
  }

  /** Finds the deck tag ({data:{cards,modifiers}, id}) inside pasted text. */
  function extractDeckTag(text) {
    const start = text.indexOf("{");
    if (start < 0) throw new Error("No deck data found. Paste the text copied by the Copy for Optimizer button.");
    let root = parseSnbt(text.slice(start));
    const seen = [root];
    while (seen.length) {
      const o = seen.shift();
      if (o && typeof o === "object") {
        if (o.data && Array.isArray(o.data.cards) && typeof o.id === "string") return o;
        for (const v of Object.values(o)) if (v && typeof v === "object") seen.push(v);
      }
    }
    throw new Error("The pasted data does not contain a card deck.");
  }

  // ---------------------------------------------------------------- mapping
  const forTier = (list, tier) => {
    let best = null;
    for (const e of list || []) if (e.tier <= tier && (!best || e.tier > best.tier)) best = e;
    return best || (list || [])[0] || null;
  };
  const jsonText = (n) => {
    if (!n) return "";
    try { const j = JSON.parse(n); return j.text || ""; } catch (e) { return String(n); }
  };
  const sameSet = (a, b) => (a || []).length === (b || []).length && (a || []).every((x) => (b || []).includes(x));

  function buildIndex(D) {
    const byName = new Map();
    for (const [id, c] of Object.entries(D.cards)) {
      const n = c.name && c.name.text;
      if (!n) continue;
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(id);
    }
    return byName;
  }

  function matchCard(entry, D, byName) {
    const mod = entry.modifier || {};
    const mc = mod.config || {};
    const ok = (id) => {
      const c = D.cards[id];
      if (!c || c.type !== mod.type) return false;
      if (mod.type === "gear") return c.attribute === mc.attribute && (!c.model || !entry.model || c.model === entry.model);
      if (mod.type === "greed") return sameSet(c.targetColorFilter, mc.targetColorFilter) && sameSet(c.targetNeighborTypes, mc.targetNeighborTypes) &&
        sameSet(c.targetGroupFilter, mc.targetGroupFilter);
      return true;
    };
    const named = byName.get(jsonText(entry.name)) || [];
    let hit = named.filter(ok);
    if (!hit.length && mod.type === "gear") {
      hit = Object.keys(D.cards).filter((id) => ok(id));
      // ability/talent/vault-modifier cards share an attribute; narrow by the rolled key
      const key = (v) => v && (v.ability || v.talent || v.modifier);
      const k = key(((mod.values || [])[0] || {}).value);
      if (k && hit.length > 1) {
        const p = hit.filter((id) => {
          const t = (D.cards[id].pool || [])[0] || {};
          return [t.abilityKey, t.talentKey, t.modifier].includes(k);
        });
        if (p.length) hit = p;
      }
    }
    if (!hit.length && mod.type !== "gear") hit = Object.keys(D.cards).filter(ok);
    if (hit.length > 1 && D.obtainable) {
      // same name and attribute (e.g. "Health Card": health / amp_health): prefer cards packs can roll
      const obt = hit.filter((id) => D.obtainable[id]);
      if (obt.length) hit = obt;
    }
    if (hit.length > 1) {
      const groups = new Set(entry.groups || []);
      const strict = hit.filter((id) => (D.cards[id].groups || []).every((g) => groups.has(g)));
      if (strict.length) hit = strict;
    }
    return hit[0] || null;
  }

  function mapFilters(list, tier, isCond) {
    const t = forTier(list, tier);
    if (!t) return [];
    return (t.value || []).map((f) => {
      const o = { color: f.colorFilter || [], group: f.groupFilter || [], tier: f.tierFilter || [], neighbor: f.neighborFilter || [] };
      if (isCond) { o.min = f.minCount != null ? f.minCount : null; o.max = f.maxCount != null ? f.maxCount : null; }
      return o;
    });
  }

  /** Resource card task: match the rolled task to data.tasks (same pool, type, text, target range). */
  function matchTask(entry, cfg, D) {
    const t = (entry.modifier || {}).task;
    if (!t || !D.tasks || !cfg || !cfg.task) return null;
    const pool = D.tasks.pools[String(cfg.task).replace(/^@/, "")] || [];
    const text = jsonText(((t.renderer || {}).tooltip)) || "";
    const counter = t.counter || {};
    const range = ((counter.config || {}).target) || {};
    const cands = pool.filter((id) => D.tasks.values[id] && D.tasks.values[id].type === t.type);
    const byText = cands.filter((id) => D.tasks.values[id].text === text.replace(/\s*\(\$\{current\}\/\$\{target\}\)/, ""));
    const byRange = (byText.length ? byText : cands).filter((id) => {
      const r = D.tasks.values[id].target;
      return r[0] === range.min && r[1] === range.max;
    });
    const id = (byRange[0] || byText[0] || (cands.length === 1 ? cands[0] : null));
    if (!id) return null;
    const target = counter.baseTarget != null ? +counter.baseTarget : counter.target != null ? +counter.target : null;
    return { id, target };
  }

  function entryValue(entry, tier) {
    const mod = entry.modifier || {};
    if (mod.type === "task_loot") { const c = forTier(mod.counts, tier); return c ? +c.count : null; }
    if (mod.type === "greed") { const m = forTier(mod.multipliers, tier); return m ? +m.value : null; }
    const v = forTier(mod.values, tier);
    if (!v) return null;
    const x = v.value;
    if (typeof x === "number") return x;
    if (x && typeof x === "object") {
      if (x.levelChange != null) return +x.levelChange;
      if (x.time != null) return +x.time;
      if (x.count != null) return +x.count;
    }
    return null;
  }

  /** Collects every {x,y} found inside an object (slot-bound core positions). */
  function positions(o, out = []) {
    if (Array.isArray(o)) o.forEach((v) => positions(v, out));
    else if (o && typeof o === "object") {
      if (typeof o.x === "number" && typeof o.y === "number") out.push(o.x + "," + o.y);
      else Object.values(o).forEach((v) => positions(v, out));
    }
    return out;
  }

  const card_raw = (card) => (card && card.__raw) || null;
  /** One card compound (as in the deck export or a card item's "data" tag) -> optimizer card, or null. */
  function cardFromNbt(card, raw, D, E, byName, uid, where, warnings) {
    const tier = card.tier || 1;
    const entries = [];
    for (const en of card.entries || []) {
      const id = matchCard(en, D, byName);
      if (!id) { warnings.push(`Card "${jsonText(en.name) || "?"}" ${where} not recognized.`); continue; }
      const cfg = D.cards[id];
      const own = new Set(cfg.groups || []);
      const e = {
        mod: id,
        colors: (en.colors || []).slice(),
        extraGroups: (en.groups || []).filter((g) => !own.has(g)),
        scaler: { filters: en.scaler ? mapFilters(en.scaler.filters, tier, false) : [] },
        condition: { filters: en.condition ? mapFilters(en.condition.filters, tier, true) : [] },
      };
      const v = entryValue(en, tier);
      if (v != null) e.value = v;
      if (cfg.type === "task_loot") {
        const task = matchTask(en, cfg, D);
        if (task) e.task = task;
        else warnings.push(`Task of "${jsonText(en.name) || cfg.name.text}" ${where} not recognized; choose it with Edit.`);
      }
      entries.push(e);
    }
    if (!entries.length) return null;
    return { uid: uid(), tier, entries, fp: raw ? hash(raw) : undefined };
  }
  /** One deck modifier compound -> owned core { id, variant, value }, or null (implicits / unknown cores). */
  function coreFromNbt(m, D, E) {
    if (!m || m.type === "implicit" || !D.cores[m.id]) return null;
    const variant = (m.config && m.config.selectedRoll) || "base";
    return { id: m.id, variant: E.coreVariant(D.cores[m.id], variant) ? variant : "base", value: +m.modifier_value };
  }
  /**
   * Collection export ("WDO-COLL 1", lines "K|C <TAB> count <TAB> SNBT") -> { cards: [{card, count}], cores: [{core, count, fp}], warnings }.
   */
  function parseCollection(text, D, E, uid) {
    const lines = String(text).replace(/\r/g, "").split("\n");
    const head = lines.findIndex((l) => l.trim().startsWith("WDO-COLL"));
    if (head < 0) throw new Error("No collection data found. In game click Copy Collection and paste the copied text.");
    const byName = buildIndex(D);
    const cards = [], cores = [], warnings = [];
    let bad = 0;
    for (const line of lines.slice(head + 1)) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) { bad++; continue; }
      const kind = parts[0].trim(), count = Math.max(1, parseInt(parts[1], 10) || 1), raw = parts.slice(2).join("\t").trim();
      let obj;
      try { obj = parseSnbt(raw); } catch (e) { bad++; continue; }
      if (kind === "K") {
        const c = cardFromNbt(obj, raw, D, E, byName, uid, "in the collection", warnings);
        if (c) cards.push({ card: c, count });
      } else if (kind === "C") {
        const core = coreFromNbt(obj, D, E);
        if (core) cores.push({ core, count, fp: hash(raw) });
        else if (obj && obj.type !== "implicit") warnings.push(`Unknown core "${obj.name || obj.id}" skipped.`);
      }
    }
    if (bad) warnings.push(`${bad} line(s) could not be read.`);
    return { cards, cores, warnings };
  }

  /** Converts a deck tag to optimizer state fragments. */
  function toState(tag, D, E, uid) {
    const warnings = [];
    const deckId = tag.id;
    const deck = D.decks[deckId];
    if (!deck) throw new Error(`Unknown deck "${deckId}".`);
    const byName = buildIndex(D);
    const data = tag.data;
    const rows = deck.layout[0].value;
    const baseAt = (x, y) => (rows[y] || "")[x];

    // cores and implicits
    const implicits = [], cores = [];
    for (const m of data.modifiers || []) {
      if (m.type === "implicit") {
        const w = m.wrappedModifier || {};
        if (D.cores[w.id]) implicits.push({ id: w.id, value: +w.modifier_value });
        else warnings.push(`Unknown implicit "${w.id || m.id}" skipped.`);
        continue;
      }
      const base = coreFromNbt(m, D, E);
      if (!base) { warnings.push(`Unknown core "${m.name || m.id}" skipped.`); continue; }
      const c = Object.assign(base, { slots: [] });
      const pos = positions(Object.assign({}, m, { config: undefined }));
      if (pos.length) c.slots = [...new Set(pos)];
      cores.push(c);
    }

    // cards
    const cards = [], placement = {}, layoutEdits = {};
    const groupCore = cores.find((c) => D.cores[c.id].type === "create_group_slots");
    const createCore = cores.find((c) => D.cores[c.id].type === "create_slots");
    for (const slot of data.cards || []) {
      const p = slot.pos || {};
      const k = E.key(p.x, p.y);
      const arcane = (p.groups || []).includes("Arcane");
      const base = baseAt(p.x, p.y);
      if (base !== "O" && base !== "A") {
        if (createCore) { if (!createCore.slots.includes(k)) createCore.slots.push(k); }
        else layoutEdits[k] = arcane ? "A" : "O";
      }
      if (arcane && base === "O") {
        if (groupCore) { if (!groupCore.slots.includes(k)) groupCore.slots.push(k); }
        else layoutEdits[k] = "A";
      }
      const c = cardFromNbt(slot.card || {}, card_raw(slot.card), D, E, byName, uid, "at " + k, warnings);
      if (!c) continue;
      cards.push(c);
      placement[k] = c.uid;
    }
    const sockets = typeof data.socketCount === "number" ? data.socketCount : null;
    return { deckId, implicits, cores, cards, placement, layoutEdits, sockets, warnings };
  }

  // ---------------------------------------------------------------- layout plan (site -> game)
  /** FNV-1a over UTF-16 code units; same code in tools/kubejs/wdo_deck_export.js. */
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8);
  }
  /**
   * Builds "WDO-PLAN 3 x,y=fingerprint~name;..." describing the target layout by card identity.
   * The fingerprint is the hash of the card's SNBT, identical to the card item's "data" tag in game,
   * so the script finds each card wherever it is (deck or inventory) and works out the moves itself.
   * Cards without a fingerprint (added by hand on the site) are counted in `manual`.
   */
  function buildPlan(cards, placement, nameOf) {
    const byUid = new Map(cards.map((c) => [c.uid, c]));
    const parts = [];
    let manual = 0;
    for (const [k, u] of Object.entries(placement)) {
      const c = byUid.get(u);
      if (!c) continue;
      if (!c.fp) { manual++; continue; }
      parts.push(`${k}=${c.fp}~${encodeURIComponent(nameOf(c))}`);
    }
    return { text: `WDO-PLAN 3 ${parts.join(";")}`, cards: parts.length, manual };
  }

  window.DeckImport = { parseSnbt, extractDeckTag, toState, buildPlan, hash, parseCollection };
})();
