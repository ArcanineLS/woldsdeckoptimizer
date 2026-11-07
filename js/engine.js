/*
 * Deck evaluation engine.
 * Mirrors iskallia.vault.core.card.CardDeck#getSnapshotAttributes (Vault Hunters 3.21.6)
 * with the Wold's Vaults 0.34.1 mixins applied (MixinCardDeck, MixinCardEntry,
 * MixinCardScaler, CardPosMixin). See README.md for the full formula reference.
 */
(function (global) {
  "use strict";

  const COLORS = ["GREEN", "BLUE", "YELLOW", "RED"]; // CardEntry.Color declaration order
  const VH_NEIGHBORS = ["ROW", "COLUMN", "DIAGONAL", "ADJACENT", "SURROUNDING", "ABOVE", "BELOW", "LEFT", "RIGHT"];
  const LEVEL_ATTRS = { "the_vault:added_ability_level": "ability", "the_vault:added_talent_level": "talent" };
  const VMOD_ATTR = "the_vault:random_vault_modifier";

  const key = (x, y) => x + "," + y;

  // ---------------------------------------------------------------- roll helpers
  function rollMid(r) {
    if (!r) return 0;
    if (r.type === "constant" || r.count !== undefined) return +r.count;
    const min = +r.min, max = +(r.max ?? r.min);
    if (min === max) return min;
    let v = (min + max) / 2;
    if (r.step) v = min + Math.round((v - min) / r.step) * r.step;
    return v;
  }
  function rollRange(r) {
    if (!r) return [0, 0];
    if (r.type === "constant" || r.count !== undefined) return [+r.count, +r.count];
    return [+r.min, +(r.max ?? r.min)];
  }
  /** CardEntry.getForTier: entry with the largest tier key <= tier. */
  function forTier(list, tier, tierKey = "tier") {
    let best = null;
    for (const e of list || []) if (e[tierKey] <= tier && (!best || e[tierKey] > best[tierKey])) best = e;
    return best || (list && list[0]) || null;
  }

  // ---------------------------------------------------------------- deck geometry
  /**
   * Build slot geometry from layout rows. 'O' = slot, 'A' = Arcane slot, other = none.
   * extra: { "x,y": "O"|"A"|"X" } overrides (Construction / Arcane cores, manual edits).
   */
  function buildLayout(rows, extra) {
    const cells = new Map();
    rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === "O" || ch === "A") cells.set(key(x, y), ch); }));
    for (const [k, v] of Object.entries(extra || {})) {
      if (v === "O" || v === "A") cells.set(k, v); else cells.delete(k);
    }
    const slots = [];
    for (const [k, ch] of cells) {
      const [x, y] = k.split(",").map(Number);
      slots.push({ x, y, k, arcane: ch === "A" });
    }
    slots.sort((a, b) => a.y - b.y || a.x - b.x);
    const index = new Map(slots.map((s, i) => [s.k, i]));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of slots) { minX = Math.min(minX, s.x); minY = Math.min(minY, s.y); maxX = Math.max(maxX, s.x); maxY = Math.max(maxY, s.y); }
    if (!slots.length) minX = minY = maxX = maxY = 0;
    const at = (x, y) => index.has(key(x, y)) ? index.get(key(x, y)) : -1;
    const uniq = (arr) => [...new Set(arr.filter((i) => i >= 0))];

    // VH CardNeighborType (CardPosMixin: equality by x,y so Arcane slots are visible)
    const vh = {}, wv = {};
    for (const t of VH_NEIGHBORS) vh[t] = [];
    for (const t of ["ORTHOGONAL", "DIAGONAL", "SURROUNDING", "WITHIN_TWO", "STARCROSS"]) wv[t] = [];
    slots.forEach((s, i) => {
      const { x, y } = s;
      vh.ROW[i] = slots.map((o, j) => (o.y === y ? j : -1)).filter((j) => j >= 0);
      vh.COLUMN[i] = slots.map((o, j) => (o.x === x ? j : -1)).filter((j) => j >= 0);
      const diag = [];
      for (let d = 1; ; d++) {
        const pts = [[x + d, y + d], [x - d, y + d], [x + d, y - d], [x - d, y - d]];
        const inside = pts.filter(([px, py]) => px >= minX && px <= maxX && py >= minY && py <= maxY);
        if (!inside.length) break;
        inside.forEach(([px, py]) => diag.push(at(px, py)));
      }
      vh.DIAGONAL[i] = uniq(diag);
      vh.ADJACENT[i] = uniq([at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)]);
      vh.SURROUNDING[i] = uniq([...vh.ADJACENT[i], at(x + 1, y + 1), at(x - 1, y + 1), at(x + 1, y - 1), at(x - 1, y - 1)]);
      vh.ABOVE[i] = uniq([at(x, y - 1)]);
      vh.BELOW[i] = uniq([at(x, y + 1)]);
      vh.LEFT[i] = uniq([at(x - 1, y)]);
      vh.RIGHT[i] = uniq([at(x + 1, y)]);
      // Wold's AdjacencyBonusDeckModifier.Type regions (self excluded)
      wv.ORTHOGONAL[i] = vh.ADJACENT[i];
      wv.DIAGONAL[i] = uniq([at(x + 1, y + 1), at(x - 1, y + 1), at(x + 1, y - 1), at(x - 1, y - 1)]);
      wv.SURROUNDING[i] = vh.SURROUNDING[i];
      const w2 = [];
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) if (dx || dy) w2.push(at(x + dx, y + dy));
      wv.WITHIN_TWO[i] = uniq(w2);
      wv.STARCROSS[i] = uniq([...vh.ADJACENT[i], at(x + 2, y), at(x - 2, y), at(x, y + 2), at(x, y - 2), ...wv.DIAGONAL[i]]);
    });
    const wvRegion = (type, i) => {
      if (wv[type]) return wv[type][i];
      if (vh[type]) return vh[type][i].filter((j) => j !== i);
      return [];
    };
    return { slots, index, at, vh, wvRegion, minX, minY, maxX, maxY };
  }

  // ---------------------------------------------------------------- card helpers
  /** Normalises a user card into the shape the engine evaluates. */
  function resolveCard(card, data) {
    const entries = card.entries.map((e) => {
      const cfg = data.cards[e.mod] || { type: "dummy", groups: [], name: { text: e.mod } };
      const groups = new Set([...(cfg.groups || []), ...(e.extraGroups || [])]);
      return { src: e, cfg, groups, colors: new Set(e.colors || []) };
    });
    const groups = new Set();
    entries.forEach((e) => e.groups.forEach((g) => groups.add(g)));
    let firstColor = null;
    for (const e of entries) {
      const c = COLORS.find((c) => e.colors.has(c));
      if (c) { firstColor = c; break; }
    }
    return { card, uid: card.uid, tier: card.tier || 1, entries, groups, firstColor };
  }

  function frameFor(rc) {
    const tier = Math.min(5, Math.max(1, rc.tier));
    const colors = COLORS.filter((c) => rc.entries.some((e) => e.colors.has(c))).map((c) => c.toLowerCase());
    const c = (rc.firstColor || "GREEN").toLowerCase();
    if (rc.entries.some((e) => e.cfg.type === "greed")) return "greed";
    if (rc.groups.has("Wild")) return (colors.length ? colors.join("_") + "_" : "") + "wild";
    if (rc.groups.has("Arcane")) return c + "_arcane";
    if (rc.groups.has("Temporal")) return `${c}_temporal_${tier}`;
    if (rc.groups.has("Resource")) return c + "_resource";
    if (rc.groups.has("Evolution")) return `${c}_evolution_${tier}`;
    return `${c}_${tier}`;
  }

  /** DeckSlot.mayPlace (+ Wold's Nitwit placement mixin). */
  function canPlace(rc, slot, ctx) {
    if (!rc) return true;
    const arc = rc.groups.has("Arcane");
    if (ctx.nitwit) return !arc;
    return slot.arcane ? arc : !arc;
  }

  // ---------------------------------------------------------------- core resolution
  /** Flattens implicit + socketed cores; applies CardDeck.addModifier "keep best" rule. */
  function resolveCores(deckState, data) {
    const list = [];
    const push = (id, value, implicit, inst) => {
      const cfg = data.cores[id];
      if (!cfg) return;
      list.push({ id, cfg, type: cfg.type, v: +value, implicit, inst });
    };
    for (const imp of deckState.implicits || []) if (imp && imp.id) push(imp.id, imp.value, true, imp);
    const best = new Map();
    for (const c of deckState.cores || []) {
      const prev = best.get(c.id);
      if (!prev || +c.value > +prev.value) best.set(c.id, c);
    }
    for (const c of best.values()) push(c.id, c.value, false, c);
    return list;
  }

  /** Lesser / greater roll variant (stored as modifierValues, slotRolls or bountyRolls). */
  function coreVariant(cfg, variant) {
    if (!variant || variant === "base") return null;
    for (const k of ["modifierValues", "slotRolls", "bountyRolls"]) if (cfg[k] && cfg[k][variant]) return cfg[k][variant];
    return null;
  }
  function coreVariants(cfg) {
    const set = new Set();
    for (const k of ["modifierValues", "slotRolls", "bountyRolls"]) Object.keys(cfg[k] || {}).forEach((v) => set.add(v));
    return set;
  }
  function coreValueRange(cfg, variant) {
    const vc = coreVariant(cfg, variant);
    return rollRange(vc && vc.value ? vc.value : cfg.modifierValue);
  }
  function coreDefault(cfg, variant) {
    const vc = coreVariant(cfg, variant);
    return rollMid(vc && vc.value ? vc.value : cfg.modifierValue);
  }
  function coreSlotRange(cfg, variant) {
    const vc = coreVariant(cfg, variant);
    return rollRange((vc && vc.slotRoll) || cfg.slotRoll);
  }

  // ---------------------------------------------------------------- evaluation
  /**
   * ctx = createContext(deckState, data). placement: array (slot index -> resolved card | null).
   * Returns { totals, perSlot } where totals maps attribute key -> number / object.
   */
  function createContext(deckState, data) {
    const deck = data.decks[deckState.deckId];
    const cores = resolveCores(deckState, data);
    // Construction (create_slots) adds chosen cells as slots; Arcane core (create_group_slots) converts chosen slots.
    const edits = Object.assign({}, deckState.layoutEdits);
    for (const c of cores) {
      if (c.type === "create_slots") for (const k of c.inst.slots || []) if (edits[k] !== "A") edits[k] = "O";
      if (c.type === "create_group_slots" && c.cfg.groupName === "Arcane") for (const k of c.inst.slots || []) edits[k] = "A";
    }
    const layout = buildLayout(deck ? deck.layout[0].value : [], edits);
    const slotSets = new Map(); // core inst -> Set(slot index) for slot / arcane_slot_boost cores
    for (const c of cores) {
      if (c.type === "slot" || c.type === "arcane_slot_boost") {
        slotSets.set(c, new Set((c.inst.slots || []).map((k) => layout.index.get(k)).filter((i) => i !== undefined)));
      }
    }
    const scalerBonus = cores.filter((c) => c.type === "card_neighbor_scaler_bonus");
    const arcaneLevel = cores.find((c) => c.type === "arcane_level") || null;
    const arcaneSlot = cores.find((c) => c.type === "arcane_slot_boost" && !c.implicit) || null;
    const temporalTime = cores.some((c) => c.type === "temporal_time" && c.implicit) || !!arcaneLevel;
    const nitwit = cores.some((c) => c.type === "no_arcane_efficiency");
    return { data, deck, layout, cores, slotSets, scalerBonus, arcaneLevel, arcaneSlot, temporalTime, nitwit, posCache: new Map() };
  }

  /** Slot indices a scaler / condition filter looks at (cached per context: geometry only). */
  function filterPositions(ctx, place, i, neighborFilter, includeSelfWhenNull) {
    const ck = i + "|" + (neighborFilter && neighborFilter.length ? neighborFilter.join(",") : "") + "|" + (includeSelfWhenNull ? 1 : 0);
    let hit = ctx.posCache.get(ck);
    if (!hit) { hit = filterPositionsRaw(ctx, i, neighborFilter, includeSelfWhenNull); ctx.posCache.set(ck, hit); }
    return hit;
  }
  function filterPositionsRaw(ctx, i, neighborFilter, includeSelfWhenNull) {
    const L = ctx.layout;
    if (!neighborFilter || !neighborFilter.length) {
      const all = L.slots.map((_, j) => j);
      return includeSelfWhenNull ? all : all.filter((j) => j !== i);
    }
    const set = new Set();
    for (const t of neighborFilter) for (const j of (L.vh[t] ? L.vh[t][i] : [])) set.add(j);
    return [...set];
  }

  /** Count matching CardEntry objects (CardScaler / CardCondition filter semantics). */
  function countEntries(ctx, place, positions, f) {
    let n = 0;
    for (const j of positions) {
      const rc = place[j];
      if (!rc) continue;
      if (f.tier && f.tier.length && !f.tier.includes(rc.tier)) continue;
      for (const e of rc.entries) {
        if (f.color && f.color.length && !f.color.some((c) => e.colors.has(c))) continue;
        if (f.group && f.group.length && !f.group.some((g) => e.groups.has(g))) continue;
        n++;
      }
    }
    return n;
  }

  function scalerFrequency(ctx, place, i, scaler) {
    let N = 0;
    for (const f of scaler.filters || []) {
      const pos = filterPositions(ctx, place, i, f.neighbor, false);
      let n = countEntries(ctx, place, pos, f);
      // MixinCardScaler.multiplyTotalWithFrequencyBonus
      if (f.neighbor && f.neighbor.length) {
        let bonus = 0;
        for (const c of ctx.scalerBonus) {
          const valid = c.cfg.validNeighborTypes || [];
          if (f.neighbor.every((t) => valid.includes(t))) bonus += Math.round(c.v);
        }
        if (bonus > 0) n *= bonus;
      }
      N += n;
    }
    return N;
  }

  function conditionPasses(ctx, place, i, cond) {
    for (const f of cond.filters || []) {
      const pos = filterPositions(ctx, place, i, f.neighbor, true);
      const n = countEntries(ctx, place, pos, f);
      if (f.min != null && f.min !== "" && n < +f.min) return false;
      if (f.max != null && f.max !== "" && n > +f.max) return false;
    }
    return true;
  }

  /** Deck-wide aggregates used by efficiency cores (computed once per evaluation). */
  function deckAggregates(ctx, place) {
    const colors = new Set(), groupUnion = new Set(), groupCount = new Map();
    let filled = 0, nonFoil = 0;
    for (const rc of place) {
      if (!rc) continue;
      filled++;
      if (!rc.groups.has("Foil")) nonFoil++;
      rc.entries.forEach((e) => e.colors.forEach((c) => colors.add(c)));
      rc.groups.forEach((g) => { groupUnion.add(g); groupCount.set(g, (groupCount.get(g) || 0) + 1); });
    }
    return { colors, groupUnion, groupCount, filled, nonFoil, empty: place.length - filled, dominance: new Map() };
  }

  function dominantGroup(agg, cfg) {
    const k = cfg.mode + "|" + (cfg.excludedGroups || []).join(",");
    if (agg.dominance.has(k)) return agg.dominance.get(k);
    const ex = new Set(cfg.excludedGroups || []);
    const list = [...agg.groupCount].filter(([g]) => !ex.has(g)).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    let pick = null;
    if (list.length) {
      if (cfg.mode === "MINORITY") {
        const min = Math.min(...list.map((e) => e[1]));
        pick = list.find((e) => e[1] === min)[0];
      } else pick = list[0][0];
    }
    agg.dominance.set(k, pick);
    return pick;
  }

  function chainLength(ctx, place, i) {
    const c = place[i].firstColor;
    const seen = new Set([i]), stack = [i];
    while (stack.length) {
      const j = stack.pop();
      for (const n of ctx.layout.vh.ADJACENT[j]) {
        if (!seen.has(n) && place[n] && place[n].firstColor === c) { seen.add(n); stack.push(n); }
      }
    }
    return seen.size;
  }

  /** Individual deck-modifier value m_i for a card at slot i. Returns {add, mul}. */
  function coreTerm(ctx, place, agg, i, rc, c) {
    const v = c.v, cfg = c.cfg, slot = ctx.layout.slots[i];
    const reqG = cfg.requiredGroups || [], reqC = cfg.requiredColors || [];
    switch (c.type) {
      case "stat_efficiency": return rc.groups.has("Stat") ? 1 + v * agg.colors.size : 1;
      case "non_foil_efficiency": return rc.groups.has("Stat") || rc.groups.has("Evolution") ? 1 + v * agg.nonFoil : 1;
      case "global": {
        if (reqG.length && !reqG.every((g) => rc.groups.has(g))) return 1;
        if (reqC.length && !reqC.includes(rc.firstColor)) return 1;
        return 1 + v;
      }
      case "slot": {
        if (!ctx.slotSets.get(c).has(i)) return 1;
        if (reqG.length && !reqG.some((g) => rc.groups.has(g))) return 1;
        if (reqC.length && !reqC.includes(rc.firstColor)) return 1;
        return 1 + v;
      }
      case "empty_slot_efficiency": return 1 + v * agg.empty;
      case "no_arcane_efficiency": return slot.arcane ? 1 + v : 1;
      case "group_adjacency_efficiency": {
        let n = 0;
        for (const j of ctx.layout.wvRegion(cfg.adjacencyType || "ORTHOGONAL", i)) {
          const o = place[j];
          if (!o) continue;
          for (const g of o.groups) if ((cfg.requiredGroups || ["Arcane"]).includes(g)) n++;
        }
        return n === 0 ? 1 : 1 + (cfg.forEachAdjacent ? n * v : v);
      }
      case "color_mismatch_adjacency": {
        if (!rc.firstColor) return 1;
        let n = 0;
        for (const j of ctx.layout.wvRegion(cfg.adjacencyType || "ORTHOGONAL", i)) {
          const o = place[j];
          if (o && o.firstColor && o.firstColor !== rc.firstColor) n++;
        }
        return n === 0 ? 1 : 1 + (cfg.forEachAdjacent ? n * v : v);
      }
      case "chain_reaction": return rc.firstColor ? 1 + v * Math.max(0, chainLength(ctx, place, i) - 1) : 1;
      case "unique_group_bonus": return rc.groups.has("Stat") ? 1 + v * agg.groupUnion.size : 1;
      case "dominance_boost": {
        const g = dominantGroup(agg, cfg);
        return g && rc.groups.has(g) ? 1 + v : 1;
      }
      case "group_synergy": {
        if ((cfg.boostGroups || []).length) return 1; // unreachable branch in 0.34.1 bytecode
        let S = 0;
        for (const o of place) if (o) for (const g of o.groups) if ((cfg.synergyGroups || []).includes(g)) S++;
        return S > 0 ? 1 + (cfg.forEveryCardInGroup ? S * v : v) : 1;
      }
      case "group_synergy_multiplier": {
        const N = agg.groupCount.get(cfg.groupName) || 0;
        return N ? Math.pow(1 + v, N) : 1;
      }
      case "row_height_bonus": {
        const L = ctx.layout;
        const k = cfg.bottomToTop ? L.maxY - slot.y + 1 : slot.y - L.minY + 1;
        return 1 + v * k;
      }
      case "symmetry_balance": {
        if (!rc.firstColor) return { mul: 1 };
        const L = ctx.layout;
        const axisOk = (mx, my) => {
          if (mx === slot.x && my === slot.y) return true;
          const j = L.at(mx, my);
          return j >= 0 && place[j] && place[j].firstColor === rc.firstColor;
        };
        const h = axisOk(L.maxX - (slot.x - L.minX), slot.y);
        const vv = axisOk(slot.x, L.maxY - (slot.y - L.minY));
        const ax = cfg.symmetryAxis || "HORIZONTAL";
        const ok = ax === "BOTH" ? h && vv : ax === "VERTICAL" ? vv : h;
        return { mul: ok ? v : 1 };
      }
      default: return 1;
    }
  }

  function efficiency(ctx, place, agg, i, rc) {
    let add = 1, mul = 1;
    const parts = [];
    for (const c of ctx.cores) {
      const r = coreTerm(ctx, place, agg, i, rc, c);
      if (typeof r === "object") { mul *= r.mul; if (r.mul !== 1) parts.push({ c, mul: r.mul }); }
      else { add += r - 1; if (r !== 1) parts.push({ c, add: r - 1 }); }
    }
    return { M: add * mul, parts };
  }

  /** CardDeck.getGreedMultiplier for every slot in one pass: G[i] = max(1, sum of greed multipliers on i). */
  function greedAll(ctx, place) {
    const sum = new Array(place.length).fill(0);
    const src = new Array(place.length).fill(null);
    place.forEach((o, q) => {
      if (!o) return;
      for (const e of o.entries) {
        if (e.cfg.type !== "greed") continue;
        const m = e.src.value != null ? +e.src.value : +(forTier(e.cfg.multiplierPool, o.tier) || { roll: 1 }).roll;
        if (!(m > 1)) continue;
        const cf = e.cfg.targetColorFilter || [], gf = e.cfg.targetGroupFilter || [];
        const seen = new Set();
        for (const t of e.cfg.targetNeighborTypes || []) for (const j of ctx.layout.vh[t] ? ctx.layout.vh[t][q] : []) {
          if (seen.has(j)) continue;
          seen.add(j);
          const rc = place[j];
          if (!rc) continue;
          if (cf.length && !rc.entries.some((te) => cf.some((c) => te.colors.has(c)))) continue;
          if (gf.length && !rc.entries.some((te) => gf.some((g) => te.groups.has(g)))) continue;
          sum[j] += m;
          (src[j] || (src[j] = [])).push({ from: q, m });
        }
      }
    });
    return { G: sum.map((s) => Math.max(1, s)), src };
  }

  function addTotal(totals, k, v) { totals[k] = (totals[k] || 0) + v; }

  function evaluate(ctx, place, opts) {
    const detail = !opts || opts.detail !== false;
    const agg = deckAggregates(ctx, place);
    const greed = greedAll(ctx, place);
    const totals = {};
    // mults[k]: sum over cards of their multiplier (scaler count N x efficiency M x greed G; levels and
    // vault-modifier durations are not multiplied by M and G in game, so they count N). Unit-free.
    const mults = {};
    const perSlot = detail ? new Array(place.length).fill(null) : null;
    const attrs = ctx.data.attributes;

    place.forEach((rc, i) => {
      if (!rc) return;
      const eff = efficiency(ctx, place, agg, i, rc);
      const G = greed.G[i];
      const f = eff.M * G;
      const info = detail ? { M: eff.M, G, parts: eff.parts, greed: greed.src[i] || [], entries: [] } : null;
      const slotArcane = ctx.layout.slots[i].arcane;

      for (const e of rc.entries) {
        const cfg = e.cfg, src = e.src;
        const ei = detail ? { N: 1, cond: true, out: [] } : null;
        if (detail) info.entries.push(ei);
        if (cfg.type !== "gear" && cfg.type !== "task_loot") continue;
        if (src.condition && src.condition.filters && src.condition.filters.length && !conditionPasses(ctx, place, i, src.condition)) {
          if (ei) ei.cond = false;
          continue;
        }
        if (ctx.nitwit && e.groups.has("Arcane")) { if (ei) ei.disabled = true; continue; }

        if (cfg.type === "task_loot") {
          const cnt = src.value != null ? +src.value : rollMid((forTier(cfg.count, rc.tier) || {}).roll);
          const itemId = ((cfg.loot || [])[0] || {}).item?.id || src.mod;
          addTotal(totals, "loot:" + itemId, cnt);
          addTotal(mults, "loot:" + itemId, 1);
          if (ei) ei.out.push({ k: "loot:" + itemId, v: cnt });
          continue;
        }

        const attr = cfg.attribute;
        const tierRoll = forTier(cfg.pool, rc.tier) || {};
        let N = src.scaler && src.scaler.filters && src.scaler.filters.length ? scalerFrequency(ctx, place, i, src.scaler) : 1;

        if (LEVEL_ATTRS[attr]) {
          const kind = LEVEL_ATTRS[attr];
          const name = kind === "ability" ? tierRoll.abilityKey : tierRoll.talentKey;
          let lv = src.value != null ? +src.value : +(tierRoll.levelChange || 0);
          const k = kind + ":" + name;
          if (kind === "ability" && ctx.arcaneSlot && slotArcane && e.groups.has("Arcane") &&
              ctx.slotSets.get(ctx.arcaneSlot).has(i)) {
            // ArcaneSlotDeckModifier: single instance, scaler bypassed
            const out = lv + Math.round(ctx.arcaneSlot.v);
            addTotal(totals, k, out);
            addTotal(mults, k, 1);
            if (ei) { ei.N = 1; ei.out.push({ k, v: out }); }
            continue;
          }
          if (kind === "ability" && ctx.arcaneLevel) lv += Math.round(ctx.arcaneLevel.v);
          if (N > 0) { addTotal(totals, k, lv * N); addTotal(mults, k, N); }
          if (ei) { ei.N = N; if (N > 0) ei.out.push({ k, v: lv * N }); }
          continue;
        }

        if (attr === VMOD_ATTR) {
          const k = "vmod:" + (tierRoll.modifier || src.mod);
          let time = src.value != null ? +src.value : rollMid(tierRoll.time);
          if (ctx.temporalTime) time *= 3;
          const count = +(tierRoll.count || 1);
          if (N > 0) {
            const cur = totals[k] || { count: 0, time: 0 };
            cur.count += count * N; cur.time += time * N;
            totals[k] = cur;
            addTotal(mults, k, N);
          }
          if (ei) { ei.N = N; if (N > 0) ei.out.push({ k, v: time * N, count: count * N }); }
          continue;
        }

        const base = src.value != null ? +src.value : rollMid(tierRoll);
        const type = (attrs[attr] || {}).type;
        let one = base * f;
        if (type === "int" || type === "long") one = Math.trunc(one);
        if (N > 0) { addTotal(totals, attr, one * N); addTotal(mults, attr, N * f); }
        if (ei) { ei.N = N; ei.base = base; ei.mult = N * f; if (N > 0) ei.out.push({ k: attr, v: one * N }); }
      }
      if (detail) perSlot[i] = info;
    });
    return { totals, mults, perSlot, agg };
  }

  // ---------------------------------------------------------------- formatting
  function attrLabel(k, data) {
    if (k.startsWith("ability:")) return "Ability Level: " + k.slice(8).replace(/_/g, " ");
    if (k.startsWith("talent:")) return "Talent Level: " + k.slice(7).replace(/_/g, " ");
    if (k.startsWith("vmod:")) return "Vault Modifier: " + prettyId(k.slice(5));
    if (k.startsWith("loot:")) return "Resource: " + itemName(k.slice(5), data);
    const a = data.attributes[k];
    if (!a || !a.name) return prettyId(k);
    if (a.reader === "increasedReader") return "Increased " + a.name;
    if (a.reader === "percentageReader") return a.name + " (%)";
    return a.name;
  }
  /** In-game item name (pack language overrides, e.g. Woldium), else a prettified id. */
  function itemName(id, data) {
    return (data && data.itemNames && data.itemNames[id]) || prettyId(id);
  }
  function prettyId(id) {
    return id.replace(/^[a-z_]+:/, "").split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
  function isPercent(k, data) {
    const a = data.attributes[k];
    return !!a && (a.reader === "percentageReader" || a.reader === "increasedReader");
  }
  /** Value in display units (percent attributes x100). */
  function displayValue(k, v, data) {
    if (v && typeof v === "object") return v.time / 20; // vault modifier: seconds
    return isPercent(k, data) ? v * 100 : v;
  }
  function formatValue(k, v, data) {
    if (v && typeof v === "object") return `${v.count}x, ${fmtNum(v.time / 20)}s`;
    const a = data.attributes[k];
    const sign = v >= 0 ? "+" : "";
    if (isPercent(k, data)) return sign + fmtNum(v * 100) + "%";
    if (a && (a.type === "int" || a.reader === "addedRoundedDecimalReader")) return sign + (a.type === "int" ? v : fmtNum(Math.round(v * 10) / 10));
    return sign + fmtNum(v);
  }
  function fmtNum(n) {
    const r = Math.round(n * 1000) / 1000;
    return Number.isInteger(r) ? String(r) : r.toFixed(r * 100 % 1 === 0 ? 2 : 3).replace(/0+$/, "").replace(/\.$/, "");
  }

  global.Engine = {
    COLORS, VH_NEIGHBORS, LEVEL_ATTRS, VMOD_ATTR, key,
    rollMid, rollRange, forTier, buildLayout, resolveCard, frameFor, canPlace,
    resolveCores, coreVariant, coreVariants, coreValueRange, coreDefault, coreSlotRange, createContext, evaluate,
    attrLabel, prettyId, itemName, isPercent, displayValue, formatValue, fmtNum,
  };
})(typeof window !== "undefined" ? window : globalThis);
