/*
 * Auto build: candidate cards for a build focus.
 * Candidates are obtainable cards (data.obtainable) at max tier with the best value roll, in every color,
 * with every scaler roll the packs allow (data.cardRolls) and the most lenient required condition.
 * The optimizer may place any number of copies of each candidate (js/optimizer.js `templates`).
 */
(function (global) {
  "use strict";

  /**
   * Build focus presets: attributes in strict priority order (the first is maximized, the next ones break
   * ties without lowering it). Auto build scores deck totals, so a card's base value counts, not only its
   * multiplier.
   */
  const FOCUS = {
    ability: { label: "Ability Power", keys: ["the_vault:ability_power_percent", "the_vault:ability_power", "the_vault:cooldown_reduction"] },
    attack: { label: "Attack Damage", keys: ["the_vault:damage_increase", "the_vault:attack_damage", "the_vault:attack_speed_percent"] },
    tank: { label: "Tank (Health, Armor, Resistance)", keys: ["the_vault:health_percentile", "the_vault:armor_percentile", "the_vault:resistance"] },
    mana: { label: "Mana", keys: ["the_vault:mana_additive_percentile", "the_vault:mana_regen", "the_vault:mana_additive"] },
    loot: { label: "Loot (Quantity, Rarity, Copiously)", keys: ["the_vault:item_quantity", "the_vault:item_rarity", "the_vault:copiously"] },
    custom: { label: "Custom…", keys: null },
  };
  /**
   * Base player stat caps in displayed units (AttributeLimitHelper, VH 3.21.6): Resistance 50% and Cooldown
   * Reduction 80% (gear with a cap attribute can raise them up to 95%). Deck totals above the cap are wasted.
   */
  const CAPS = { "the_vault:resistance": 50, "the_vault:cooldown_reduction": 80 };
  /** Survivability: always balanced against the focus. */
  const SURVIVAL = ["the_vault:health_percentile", "the_vault:armor_percentile", "the_vault:resistance"];
  const BALANCE = { offense: { label: "Offense first (70 / 30)", focus: 0.7 }, balanced: { label: "Balanced (50 / 50)", focus: 0.5 }, survival: { label: "Survival first (30 / 70)", focus: 0.3 } };
  /**
   * Balanced objective: goals = focus attribute(s) + Health, Armor, Resistance. Score = sum of weight x ln(1 + total),
   * i.e. the weighted product of the goals: neglecting any goal costs a lot, so the best layout balances them.
   * The focus gets the balance share, survivability the rest (split over its three attributes).
   */
  function balanceSpec(focusKeys, focusShare, mainFirst) {
    const surv = SURVIVAL.filter((k) => !focusKeys.includes(k));
    const fShare = surv.length ? focusShare : 1;
    // presets: the main attribute gets 60% of the focus share, the others split the rest; Custom: equal shares
    const fw = (i) => (mainFirst && focusKeys.length > 1 ? (i === 0 ? 0.6 : 0.4 / (focusKeys.length - 1)) : 1 / focusKeys.length);
    const goals = focusKeys.map((k, i) => ({ key: k, weight: fShare * fw(i) }))
      .concat(surv.map((k) => ({ key: k, weight: (1 - fShare) / surv.length })));
    const weights = {};
    goals.forEach((g) => (weights[g.key] = 1));
    return { mode: "balance", goals, weights, defaultWeight: 0, priority: [], caps: CAPS };
  }
  /** Optimizer objective for a focus: deck totals, strict priorities, other attributes ignored. */
  function focusSpec(keys) {
    const weights = {};
    keys.forEach((k) => (weights[k] = 1));
    return { mode: "totals", weights, defaultWeight: 0, priority: keys.slice(), caps: CAPS }; // plain object: sent to workers
  }
  const COLORS = ["GREEN", "BLUE", "YELLOW", "RED"];

  /** Card type (same precedence as the card frame); Greed cards are their own type. */
  const CARD_TYPES = ["Evolution", "Stat", "Knack", "Temporal", "Arcane", "Resource", "Greed"];
  function cardType(cfg) {
    if (cfg.type === "greed") return "Greed";
    const g = new Set(cfg.groups || []);
    for (const t of ["Arcane", "Temporal", "Resource", "Evolution", "Knack", "Stat"]) if (g.has(t)) return t;
    return "Other";
  }
  /** Attribute key a card produces (as in the statistics table): attribute, ability:/talent: level, vmod:, loot:. */
  function outputKey(cfg, E) {
    if (cfg.type === "task_loot") return "loot:" + ((((cfg.loot || [])[0] || {}).item || {}).id || "");
    if (cfg.type !== "gear") return null;
    const t = (cfg.pool || [])[0] || {};
    if (cfg.attribute === "the_vault:added_ability_level") return "ability:" + t.abilityKey;
    if (cfg.attribute === "the_vault:added_talent_level") return "talent:" + t.talentKey;
    if (cfg.attribute === E.VMOD_ATTR) return "vmod:" + t.modifier;
    return cfg.attribute;
  }
  function bestValue(cfg, tier, E) {
    if (cfg.type === "greed") return +((E.forTier(cfg.multiplierPool, tier) || {}).roll || 1);
    if (cfg.type === "task_loot") return E.rollRange((E.forTier(cfg.count, tier) || {}).roll)[1];
    const t = E.forTier(cfg.pool, tier) || {};
    if (E.LEVEL_ATTRS[cfg.attribute]) return +(t.levelChange || 1);
    if (cfg.attribute === E.VMOD_ATTR) return E.rollRange(t.time)[1];
    return t.max != null ? +t.max : E.rollMid(t);
  }

  /** Every scaler filter the packs can roll (one filter), preferring "any" where a field allows it. */
  function scalerVariants(opt) {
    if (!opt) return [];
    const pick = (fk) => (opt[fk] || [""]).includes("") ? [[]] : (opt[fk] || []).map((v) => [fk === "tier" ? +v : v]);
    const out = [];
    for (const neighbor of pick("neighbor")) for (const color of pick("color")) for (const group of pick("group")) for (const tier of pick("tier")) {
      out.push({ neighbor, color, group, tier });
    }
    return out;
  }
  /** The most lenient condition the packs can roll (fewest required cards, widest filters). */
  function lenientCondition(opt) {
    const any = (fk) => ((opt[fk] || [""]).includes("") ? [] : [(opt[fk] || [])[0]]);
    const f = { neighbor: any("neighbor"), color: any("color"), group: any("group"), tier: [] };
    if (opt.min && (!opt.minOptional || !opt.max)) f.min = opt.min[0]; else f.min = null;
    f.max = opt.max && (!opt.maxOptional || f.min == null) ? opt.max[1] : null;
    return f;
  }

  /**
   * Candidate cards (raw card objects, uid "tpl-*") for focus attribute keys.
   * ctx: engine context of the current deck (decides Foil variants and Arcane slot fillers).
   */
  /**
   * Same-color scaling: every scaler / condition filter that names colors must name only the card's own color(s).
   * Filters without a color (any color) and cards without such lines are allowed.
   */
  function sameColorOk(colors, filters) {
    return (filters || []).every((f) => !(f.color || []).length || (f.color || []).every((c) => colors.includes(c)));
  }
  function makeTemplates(keys, D, E, ctx, types, sameColor, oneColor, anyGreed) {
    const allowType = (cfg) => !types || types.includes(cardType(cfg));
    const want = new Set(keys);
    const obt = D.obtainable || {};
    const foilHelps = ctx.cores.some((c) => (c.cfg.requiredGroups || []).includes("Foil") || (c.cfg.synergyGroups || []).includes("Foil"));
    const hasArcane = ctx.layout.slots.some((s) => s.arcane) && !ctx.nitwit;
    const out = [];
    let n = 0;
    const push = (cid, tier, colors, extraGroups, value, scaler, condition) => {
      out.push({
        uid: "tpl-" + n++, tier, planned: true,
        entries: [{ mod: cid, colors, extraGroups, value, scaler: { filters: scaler ? [scaler] : [] }, condition: { filters: condition ? [condition] : [] } }],
      });
    };
    for (const cid of Object.keys(obt)) {
      const cfg = D.cards[cid];
      if (!cfg) continue;
      const rolls = (D.cardRolls || {})[cid] || {};
      const tier = cfg.maxTier || 1;
      if (!allowType(cfg)) continue;
      const isFocus = (cfg.type === "gear" || cfg.type === "task_loot") && want.has(outputKey(cfg, E));
      const isGreed = cfg.type === "greed";
      // one representative Arcane card per color fills Arcane slots (its identity does not change the score)
      const isArcaneFiller = hasArcane && cid === "arcane" && !isFocus;
      if (!isFocus && !isGreed && !isArcaneFiller) continue;
      const value = bestValue(cfg, tier, E);
      let colorSets = cfg.colors && cfg.colors.length ? [cfg.colors.slice()] : COLORS.map((c) => [c]);
      if (oneColor && !(anyGreed && cfg.type === "greed")) colorSets = colorSets.filter((cs) => cs.length === 1 && cs[0] === oneColor); // single-color deck
      if (!colorSets.length) continue;
      const groupSets = [[]].concat(foilHelps && rolls.foil && !(cfg.groups || []).includes("Foil") ? [["Foil"]] : []);
      const scalers = rolls.scaler ? scalerVariants(rolls.scaler) : [];
      const scalerChoices = rolls.scalerRequired ? scalers : [null, ...scalers];
      const condition = rolls.conditionRequired && rolls.condition ? lenientCondition(rolls.condition) : null;
      for (const colors of colorSets) for (const extra of groupSets) {
        if (isGreed || isArcaneFiller) { push(cid, tier, colors, extra, value, null, null); continue; }
        for (const sc of scalerChoices) {
          if (sameColor && sc && !sameColorOk(colors, [sc])) continue;
          push(cid, tier, colors, extra, value, sc, condition && sameColor && !sameColorOk(colors, [condition]) ? { ...condition, color: [] } : condition);
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- cores and implicits
  // Cores whose effect needs hand-picked slots, or that do not change attribute totals, are not chosen.
  const SKIP_CORE_TYPES = new Set(["slot", "arcane_slot_boost", "create_slots", "create_group_slots", "bounty",
    "resource_requirement", "resource_double", "dummy", "implicit"]);
  /** Socketable cores at their best variant and top roll. */
  function coreCandidates(D, E) {
    const out = [];
    for (const [id, cfg] of Object.entries(D.cores)) {
      if (/_deck$/.test(id) || SKIP_CORE_TYPES.has(cfg.type)) continue;
      const vs = E.coreVariants(cfg);
      const variant = vs.has("greater") ? "greater" : "base";
      out.push({ id, variant, value: E.coreValueRange(cfg, variant)[1], slots: [] });
    }
    return out;
  }
  /** Mystery Deck implicit pool (implicits that need slot choices are left out). */
  function implicitCandidates(D, E) {
    return (D.corePools.card_deck_implicits || []).map((p) => p.value)
      .filter((id) => D.cores[id] && !SKIP_CORE_TYPES.has(D.cores[id].type))
      .map((id) => ({ id, value: E.coreDefault(D.cores[id]) }));
  }

  /**
   * Card search with core / implicit choice: alternate (place cards) and (best core per socket, best implicit
   * per implicit slot for the Mystery Deck, with the cards fixed). Runs in a worker.
   * o: { D, E, O, deckState, cards (resolved), templates (resolved), initial, locked, spec, budgetMs,
   *      sockets, chooseImplicits, randomStart, onBest }
   */
  function searchWithCores(o) {
    const { D, E, O } = o;
    const state = JSON.parse(JSON.stringify(o.deckState));
    // owned cores (Build from collection) or every socketable core at its best roll
    const cores = o.coreList ? o.coreList.filter((c) => D.cores[c.id] && !SKIP_CORE_TYPES.has(D.cores[c.id].type)) : coreCandidates(D, E);
    const imps = o.chooseImplicits ? implicitCandidates(D, E) : [];
    if (o.coreList) state.cores = (state.cores || []).filter((c) => c.owned && cores.some((x) => x.owned === c.owned));
    const pickRandom = (list, n) => list.slice().sort(() => Math.random() - 0.5).slice(0, n);
    if (o.randomStart) {
      state.cores = pickRandom(cores, o.sockets).map((c) => ({ ...c }));
      if (o.chooseImplicits) state.implicits = pickRandom(imps, 2).map((c) => ({ ...c }));
    }
    state.cores = (state.cores || []).slice(0, o.sockets);
    // fill every socket (and both Mystery implicit slots) so the ascent only replaces choices
    for (const c of pickRandom(cores.filter((c) => !state.cores.some((x) => x.id === c.id)), Math.max(0, o.sockets - state.cores.length))) {
      if (!state.cores.some((x) => x.id === c.id)) state.cores.push({ ...c });
    }
    if (o.chooseImplicits) {
      state.implicits = (state.implicits || []).filter(Boolean).slice(0, 2);
      for (const c of pickRandom(imps.filter((c) => !state.implicits.some((x) => x.id === c.id)), 2 - state.implicits.length)) state.implicits.push({ ...c });
    }
    const score = (st, place) => {
      const ctx = E.createContext(st, D);
      if (place.some((c, i) => c && !E.canPlace(c, ctx.layout.slots[i], ctx))) return null;
      return O.tuple(E.evaluate(ctx, place, { detail: false }), o.spec, D);
    };
    const ascend = (place) => {
      let cur = score(state, place);
      for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        for (let i = 0; i < state.cores.length; i++) {
          for (const c of cores) {
            if (state.cores.some((x, j) => j !== i && (x.id === c.id || (c.owned && x.owned === c.owned)))) continue;
            const prev = state.cores[i];
            state.cores[i] = { ...c };
            const t = score(state, place);
            if (t && (!cur || O.compare(t, cur) > 0)) { cur = t; changed = true; } else state.cores[i] = prev;
          }
        }
        for (let i = 0; i < (o.chooseImplicits ? 2 : 0); i++) {
          for (const c of imps) {
            if (state.implicits.some((x, j) => x && j !== i && x.id === c.id)) continue;
            const prev = state.implicits[i];
            state.implicits[i] = { ...c };
            const t = score(state, place);
            if (t && (!cur || O.compare(t, cur) > 0)) { cur = t; changed = true; } else state.implicits[i] = prev;
          }
        }
        if (!changed) break;
      }
    };
    const rounds = 3, start = Date.now();
    let initial = o.initial, best = null;
    for (let r = 0; r < rounds; r++) {
      const left = o.budgetMs - (Date.now() - start);
      if (left < 150 && best) break;
      const ctx = E.createContext(state, D);
      // cards that no longer fit the slot rules of the new implicits are taken out before the next search
      initial = initial.map((c, i) => (c && E.canPlace(c, ctx.layout.slots[i], ctx) ? c : null));
      const res = O.search({ ctx, cards: o.cards, initial, locked: o.locked, spec: o.spec, budgetMs: Math.max(150, left / (rounds - r)), templates: o.templates });
      best = { place: res.place, tuple: res.tuple, evals: (best ? best.evals : 0) + res.evals, state: JSON.parse(JSON.stringify(state)) };
      if (o.onBest) o.onBest(best);
      if (r < rounds - 1) { ascend(res.place); initial = res.place; }
    }
    return best;
  }

  global.AutoBuild = { FOCUS, BALANCE, SURVIVAL, CAPS, CARD_TYPES, cardType, outputKey, sameColorOk, makeTemplates, focusSpec, balanceSpec, coreCandidates, implicitCandidates, searchWithCores };
})(typeof window !== "undefined" ? window : self);
