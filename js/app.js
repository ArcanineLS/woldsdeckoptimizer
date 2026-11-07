/* UI controller for the deck optimizer. */
(function () {
  "use strict";
  const E = window.Engine, O = window.Optimizer;
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(c));
    return n;
  };
  /** parent.append() without null / false children (DOM append would print them as text, e.g. "null"). */
  const add = (parent, ...kids) => parent.append(...kids.flat().filter((k) => k != null && k !== false));
  const STORE = "wdo.state.v1";
  const GROUPS_EXTRA = ["Foil", "Shiny", "Deluxe"];
  const VARIANTS = ["lesser", "base", "greater"];
  /** Cores whose slots are chosen manually on the grid. */
  const SLOT_PICK = {
    slot: { noun: "Empowered Slots", hint: "Click normal slots on the deck to mark them as empowered." },
    arcane_slot_boost: { noun: "Arcane Slots", hint: "Click Arcane slots on the deck to boost them." },
    create_group_slots: { noun: "Arcane Slots", hint: "Click slots on the deck to convert them into Arcane slots. Click again to revert." },
    create_slots: { noun: "New Slots", hint: "Click empty cells next to the deck to add card slots. Click again to remove." },
  };

  let D = null;          // game data
  let S = null;          // persisted state
  let ctx = null;        // engine context
  let resolved = new Map(); // uid -> resolved card
  let lastEval = null;
  let selectedSlot = null;
  let pickingCore = null;  // core instance whose slots are being assigned

  // ------------------------------------------------------------------ state
  const uid = () => Math.random().toString(36).slice(2, 10);
  function defaultState() {
    return { v: 1, deckId: "starter", layoutEdits: {}, implicits: null, cores: [], cards: [], ownedCores: [], placement: {}, locked: [], weights: {} };
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) { /* storage unavailable */ }
  }
  // ---- saved decks (browser local storage): [{ id, name, savedAt, state }]
  const SAVES = "wdo.saved.v1";
  function readSaves() {
    try { const v = JSON.parse(localStorage.getItem(SAVES) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function writeSaves(list) {
    try { localStorage.setItem(SAVES, JSON.stringify(list)); return true; } catch (e) { return false; }
  }
  function loadLocal() {
    try { const s = localStorage.getItem(STORE); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  async function encodeShare(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let out = bytes, tag = "j";
    if (window.CompressionStream) {
      const cs = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
      out = new Uint8Array(await new Response(cs).arrayBuffer()); tag = "z";
    }
    let bin = ""; out.forEach((b) => (bin += String.fromCharCode(b)));
    return tag + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function decodeShare(str) {
    const tag = str[0], b64 = str.slice(1).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64); const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    if (tag === "z") {
      const ds = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return JSON.parse(await new Response(ds).text());
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // ------------------------------------------------------------------ helpers
  const cardName = (id) => (D.cards[id] && D.cards[id].name && D.cards[id].name.text) || E.prettyId(id);
  const deckOf = () => D.decks[S.deckId];
  function implicitDefaults(deckId) {
    const d = D.decks[deckId];
    if (!d || !d.implicit || !D.cores[d.implicit]) return [];
    return [{ id: d.implicit, value: E.coreDefault(D.cores[d.implicit]) }];
  }
  function socketCount() {
    if (S.sockets != null) return S.sockets; // rolled value from an imported deck
    const d = deckOf();
    return d && d.socketCount ? E.rollMid(d.socketCount) : 0;
  }
  function entryKey(e) {
    const cfg = D.cards[e.mod];
    if (!cfg) return null;
    if (cfg.type === "task_loot") return "loot:" + (((cfg.loot || [])[0] || {}).item || {}).id;
    if (cfg.type !== "gear") return null;
    const t = (cfg.pool || [])[0] || {};
    if (cfg.attribute === "the_vault:added_ability_level") return "ability:" + t.abilityKey;
    if (cfg.attribute === "the_vault:added_talent_level") return "talent:" + t.talentKey;
    if (cfg.attribute === E.VMOD_ATTR) return "vmod:" + t.modifier;
    return cfg.attribute;
  }
  function cardImg(rc, cls = "card-img") {
    const frame = D.frames[E.frameFor(rc)] || D.frames["green_1"];
    const icon = rc.entries[0] && rc.entries[0].cfg.icon;
    return el("div", { class: cls + " px" },
      el("img", { class: "frame", src: frame, alt: "", draggable: "false" }),
      icon ? el("img", { class: "icon", src: icon, alt: "", draggable: "false" }) : null);
  }
  /** Cards without an icon model (Greed, Wild) render as their frame in game. */
  function frameIcon(id, cfg) {
    const colors = cfg.type === "greed" ? [] : (cfg.colors && cfg.colors.length ? cfg.colors : null);
    const rc = E.resolveCard({ uid: id, tier: 1, entries: [{ mod: id, colors: colors || ["GREEN"], extraGroups: [] }] }, D);
    return D.frames[E.frameFor(rc)] || null;
  }
  const colorDots =(colors) => (colors || []).map((c) => el("span", { class: "dot c-" + c, title: c }));
  const hex = (n) => n == null ? null : "#" + (n >>> 0).toString(16).padStart(6, "0").slice(-6);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  function rebuild() {
    resolved = new Map(S.cards.map((c) => [c.uid, E.resolveCard(c, D)]));
    ctx = E.createContext(S, D);
    // drop placements that no longer map to a slot / card / valid slot type
    for (const [k, u] of Object.entries(S.placement)) {
      const i = ctx.layout.index.get(k);
      const rc = resolved.get(u);
      if (i === undefined || !rc || !E.canPlace(rc, ctx.layout.slots[i], ctx)) delete S.placement[k];
    }
  }
  function placeArray() {
    return ctx.layout.slots.map((s) => resolved.get(S.placement[s.k]) || null);
  }
  function placedUids() { return new Set(Object.values(S.placement)); }

  // ------------------------------------------------------------------ icon picker
  function picker(host, { items, value, onChange, placeholder, groups }) {
    host.innerHTML = "";
    host.className = "picker";
    const cur = items.find((i) => i.id === value);
    const btn = el("button", {
      type: "button", class: "picker-btn",
      onmouseenter: cur && cur.desc ? (e) => showTip(e, el("div", {}, el("div", { class: "h" }, cur.label), el("div", { class: "l" }, cur.desc))) : null,
      onmousemove: cur && cur.desc ? moveTip : null, onmouseleave: hideTip,
    },
      cur && cur.icon ? el("img", { class: "px", src: cur.icon, alt: "" }) : null,
      el("span", {}, cur ? cur.label : placeholder || "Select…"),
      cur && cur.sub ? el("span", { class: "sub" }, cur.sub) : null);
    host.append(btn);
    let pop = null;
    const close = () => { if (pop) { hideTip(); pop.remove(); pop = null; document.removeEventListener("mousedown", outside); } };
    const outside = (e) => { if (!host.contains(e.target)) close(); };
    btn.addEventListener("click", () => {
      if (pop) return close();
      const input = el("input", { type: "search", placeholder: "Search…" });
      const list = el("div", { class: "picker-list" });
      pop = el("div", { class: "picker-pop" }, input, list);
      host.append(pop);
      let active = 0, shown = [];
      const render = () => {
        const words = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
        shown = items.filter((i) => {
          const hay = (i.label + " " + (i.sub || "") + " " + i.id + " " + (i.group || "")).toLowerCase();
          return words.every((w) => hay.includes(w));
        });
        if (groups) {
          const order = new Map(groups.map((g, n) => [g.id, n]));
          shown.sort((a, b) => (order.get(a.group) ?? 99) - (order.get(b.group) ?? 99));
        }
        list.innerHTML = "";
        let lastGroup = null;
        shown.forEach((i, n) => {
          if (groups && i.group !== lastGroup) {
            lastGroup = i.group;
            const g = groups.find((x) => x.id === i.group) || { label: i.group || "Other" };
            list.append(el("div", { class: "picker-group" }, g.icon ? el("img", { class: "px", src: g.icon, alt: "" }) : null, g.label));
          }
          list.append(el("div", {
          class: "picker-item" + (n === active ? " active" : ""), onmousedown: (e) => { e.preventDefault(); hideTip(); choose(i); },
          onmouseenter: i.desc ? (e) => showTipBeside(e.currentTarget, el("div", {}, el("div", { class: "h" }, i.label), el("div", { class: "l" }, i.desc))) : null,
          onmouseleave: i.desc ? hideTip : null,
        }, i.icon ? el("img", { class: "px", src: i.icon, alt: "" }) : el("span", { style: "width:24px" }), el("span", {}, i.label), i.sub ? el("span", { class: "sub" }, i.sub) : null));
        });
        const act = list.querySelector(".picker-item.active");
        if (act && document.activeElement === input) act.scrollIntoView({ block: "nearest" });
      };
      const choose = (i) => { close(); onChange(i.id); };
      input.addEventListener("input", () => { active = 0; render(); });
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown") { active = Math.min(shown.length - 1, active + 1); render(); e.preventDefault(); }
        else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); render(); e.preventDefault(); }
        else if (e.key === "Enter") { if (shown[active]) choose(shown[active]); e.preventDefault(); }
        else if (e.key === "Escape") close();
      });
      render();
      input.focus();
      setTimeout(() => document.addEventListener("mousedown", outside));
    });
  }

  // ------------------------------------------------------------------ deck panel
  function renderDeckPanel() {
    const decks = Object.entries(D.decks).map(([id, d]) => {
      const slots = d.layout[0].value.join("").replace(/[^OA]/g, "").length;
      const arc = d.layout[0].value.join("").replace(/[^A]/g, "").length;
      const imp = d.implicit && D.cores[d.implicit];
      return {
        id, label: d.name, icon: d.icon, sub: `${slots} Slots${arc ? ` · ${arc} Arcane` : ""}`,
        desc: imp ? "Implicit: " + describeCore(imp, E.coreDefault(imp)) : id === "mystery" ? "Implicit: Two random deck modifiers" : "No implicit modifier",
      };
    }).sort((a, b) => a.label.localeCompare(b.label));
    picker($("#deck-picker"), {
      items: decks, value: S.deckId, onChange: (id) => {
        S.deckId = id; S.layoutEdits = {}; S.implicits = null; S.placement = {}; S.locked = []; S.sockets = null;
        refreshAll();
      },
    });
    const d = deckOf();
    const ess = d.essence ? E.rollMid(d.essence) : 0;
    $("#deck-info").textContent = `Sockets: ${socketCount()} · Essence: ${ess} · ID: ${S.deckId}`;

    // implicit
    const box = $("#implicit-box");
    box.innerHTML = "";
    if (S.deckId === "mystery") {
      const pool = (D.corePools.card_deck_implicits || []).map((p) => p.value).filter((id) => D.cores[id]);
      const items = [{ id: "", label: "None", sub: "Clear" }, ...pool.map((id) => {
        const cfg = D.cores[id];
        const deckId = Object.keys(D.decks).find((k) => D.decks[k].implicit === id);
        return { id, label: cfg.name || id, icon: deckId ? D.decks[deckId].icon : null, desc: describeCore(cfg, E.coreDefault(cfg)) };
      }).sort((a, b) => a.label.localeCompare(b.label))];
      for (let n = 0; n < 2; n++) {
        const cur = (S.implicits || [])[n];
        const host = el("div");
        box.append(host);
        picker(host, {
          items, value: cur ? cur.id : null, placeholder: `Implicit ${n + 1}…`, onChange: (id) => {
            const arr = (S.implicits || []).slice();
            arr[n] = id ? { id, value: E.coreDefault(D.cores[id]) } : null;
            S.implicits = [arr[0] || null, arr[1] || null];
            refreshAll();
          },
        });
      }
    }
    // effects of the chosen implicits, together in one box under the pickers
    const effects = (S.implicits || []).filter((imp) => imp && D.cores[imp.id]);
    if (effects.length) {
      box.append(el("div", { class: "implicit-box" }, ...effects.map((imp) => {
        const cfg = D.cores[imp.id];
        return el("div", {},
          el("div", { class: "implicit-name" }, "Implicit: " + (cfg.name || imp.id)),
          el("div", { class: "note" }, describeCore(cfg, imp.value)));
      })));
    }
    box.hidden = !box.children.length;
    $("#layout-note").hidden = !$("#layout-edit").checked;
  }

  function fmtPct(v) { return E.fmtNum(v * 100) + "%"; }
  const SMALL = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "if", "in", "into", "of", "on", "or", "per", "the", "to", "with"]);
  /** Title case in the style of Vault Hunters tooltips; leaves numbers/symbols untouched. */
  function titleCase(s) {
    return String(s).split(" ").map((w, i) => {
      if (i > 0 && SMALL.has(w)) return w;
      return w.replace(/^([("']?)([a-z])/, (m, p, ch) => p + ch.toUpperCase());
    }).join(" ");
  }
  function adjText(t) {
    const k = "deck.woldsvaults.adjacency_type_" + String(t || "orthogonal").toLowerCase();
    return D.lang[k] || String(t).toLowerCase();
  }
  const slotText = (cfg, variant) => {
    const [a, b] = E.coreSlotRange(cfg, variant);
    return a === b ? String(a) : `${a}-${b}`;
  };
  const plural = (n, w) => (String(n) === "1" ? w : w + "s");
  function describeCore(cfg, v, variant) {
    return titleCase(describeCoreRaw(cfg, v, variant));
  }
  function describeCoreRaw(cfg, v, variant) {
    const vc = E.coreVariant(cfg, variant) || {};
    const reqG = vc.requiredGroups || cfg.requiredGroups || [], reqC = vc.requiredColors || cfg.requiredColors || [];
    const g = reqG.join(" + "), c = reqC.map(cap).join("/");
    const n = slotText(cfg, variant);
    switch (cfg.type) {
      case "stat_efficiency": return `+${fmtPct(v)} Stat card efficiency per unique card color in the deck`;
      case "non_foil_efficiency": return `+${fmtPct(v)} Stat/Evolution card efficiency per non-Foil card in the deck`;
      case "global": return `+${fmtPct(v)} card efficiency for ${[c, g].filter(Boolean).join(" ") || "all"} cards`;
      case "slot": return `+${fmtPct(v)} card efficiency for ${reqG.join("/") || "all"} cards in ${n} empowered ${plural(n, "slot")}`;
      case "resource_requirement": return `Resource card task requirements reduced by ${fmtPct(v)}`;
      case "resource_double": return `${fmtPct(v)} chance to duplicate Resource card loot`;
      case "bounty": return `Increases crate tier when enough Resource cards are in the deck`;
      case "empty_slot_efficiency": return `+${fmtPct(v)} ${D.lang["deck.woldsvaults.void_modifier"] || "increased card efficiency per empty card slot"}`;
      case "no_arcane_efficiency": return `+${fmtPct(v)} increased card efficiency inside Arcane slots (Arcane slots may only hold non-Arcane cards)`;
      case "group_adjacency_efficiency": {
        const per = cfg.forEachAdjacent ? `per ${adjText(cfg.adjacencyType)}` : `when ${adjText(cfg.adjacencyType)} to at least one`;
        return `+${fmtPct(v)} increased card efficiency ${per} ${reqG.join("/")} card`;
      }
      case "color_mismatch_adjacency": return `+${fmtPct(v)} card efficiency ${cfg.forEachAdjacent ? "per" : "if any"} ${adjText(cfg.adjacencyType)} card with a different color`;
      case "chain_reaction": return `+${fmtPct(v)} card efficiency per matching connected color link`;
      case "unique_group_bonus": return `+${fmtPct(v)} Stat card efficiency per unique card group`;
      case "dominance_boost": return `+${fmtPct(v)} card efficiency to cards with the ${cfg.mode === "MINORITY" ? "least" : "most"} dominant group (excludes ${(cfg.excludedGroups || []).join(", ")})`;
      case "group_synergy": return `+${fmtPct(v)} card efficiency ${cfg.forEveryCardInGroup ? "for every" : "with any"} ${(cfg.synergyGroups || []).join("/")} card in the deck`;
      case "group_synergy_multiplier": return `card efficiency ×(1 + ${E.fmtNum(v)})^N, N = ${cfg.groupName} cards in the deck`;
      case "row_height_bonus": return `+${fmtPct(v)} card efficiency per row from the ${cfg.bottomToTop ? "bottom" : "top"} of the deck`;
      case "symmetry_balance": return `×${E.fmtNum(v)} card efficiency if color-mirrored (${(cfg.symmetryAxis || "horizontal").toLowerCase()} axis)`;
      case "card_neighbor_scaler_bonus": { const k = Math.round(v) - 1; return `cards that scale with ${(cfg.validNeighborTypes || []).map(cap).join("/")} count cards ${k} additional ${plural(k, "time")}`; }
      case "arcane_level": return `Arcane cards have +${Math.round(v)} ability ${plural(Math.round(v), "level")}`;
      case "arcane_slot_boost": return `Arcane cards in ${n} chosen Arcane ${plural(n, "slot")} gain +${Math.round(v)} ability ${plural(Math.round(v), "level")}`;
      case "temporal_time": return "Temporal cards last three times as long";
      case "create_slots": return `adds ${n} card ${plural(n, "slot")}`;
      case "create_group_slots": return `converts ${n} ${plural(n, "slot")} into ${cfg.groupName} ${plural(n, "slot")}`;
      default: return cfg.type.replace(/_/g, " ");
    }
  }

  // ---- owned cores (Collection → Cores); a socketed copy keeps `owned` = the owned core's uid
  const ownedOf = (c) => (c && c.owned ? (S.ownedCores || []).find((o) => o.uid === c.owned) : null);
  function syncOwned(c) {
    const o = ownedOf(c);
    if (o) { o.variant = c.variant; o.value = c.value; }
  }
  /** Add a deck core to the owned cores unless an identical one is already there; returns its uid. */
  function addOwnedCore(c) {
    S.ownedCores = S.ownedCores || [];
    const same = S.ownedCores.find((o) => o.id === c.id && (o.variant || "base") === (c.variant || "base") && Math.abs(+o.value - +c.value) < 1e-6 &&
      !S.cores.some((x) => x !== c && x.owned === o.uid));
    if (same) return same.uid;
    const o = { uid: uid(), id: c.id, variant: c.variant || "base", value: +c.value };
    S.ownedCores.push(o);
    return o.uid;
  }
  function renderOwnedCores() {
    const list = $("#owned-core-list");
    list.innerHTML = "";
    const owned = S.ownedCores || [];
    $("#owned-core-count").textContent = owned.length ? String(owned.length) : "";
    if (!owned.length) list.append(el("div", { class: "note" }, "No cores yet. Add the cores you own, or import a deck."));
    owned.forEach((o, idx) => {
      const cfg = D.cores[o.id];
      if (!cfg) return;
      const vc = E.coreVariant(cfg, o.variant);
      const name = (vc && vc.name) || cfg.name;
      const icon = (vc && vc.icon) || cfg.icon;
      const variants = E.coreVariants(cfg);
      const [mn, mx] = E.coreValueRange(cfg, o.variant);
      const deckCore = S.cores.find((c) => c.owned === o.uid);
      const full = S.cores.length >= socketCount();
      const sync = () => { if (deckCore) { deckCore.variant = o.variant; deckCore.value = o.value; } };
      list.append(el("div", { class: "owned-core" + (deckCore ? " socketed" : "") },
        el("div", { class: "head" },
          icon ? el("img", { class: "px", src: icon, alt: "" }) : null,
          el("div", { class: "name", style: "color:" + (hex(vc ? vc.colour : cfg.colour) || "inherit") }, name, deckCore ? el("span", { class: "tag plan" }, "Socketed") : null),
          deckCore
            ? el("button", { class: "btn sm", type: "button", onclick: () => { S.cores = S.cores.filter((c) => c !== deckCore); refreshAll(); } }, "Unsocket")
            : el("button", { class: "btn sm", type: "button", disabled: full, title: full ? "All deck sockets are used" : "Put this core in the deck",
              onclick: () => { S.cores.push({ id: o.id, variant: o.variant, value: o.value, slots: [], owned: o.uid }); refreshAll(); } }, "Socket"),
          el("button", { class: "btn sm danger", type: "button", title: "Delete from collection", onclick: () => {
            S.ownedCores.splice(idx, 1);
            if (deckCore) delete deckCore.owned; // the deck keeps the core as a planned one
            refreshAll();
          } }, "×")),
        el("div", { class: "note" }, describeCore(cfg, +o.value, o.variant)),
        el("div", { class: "row" },
          variants.size ? el("label", { class: "f" }, "Variant", el("select", {
            onchange: (e) => { o.variant = e.target.value; o.value = E.coreDefault(cfg, o.variant); sync(); refreshAll(); },
          }, VARIANTS.filter((v) => v === "base" || variants.has(v)).map((v) => el("option", { value: v, selected: o.variant === v }, cap(v))))) : null,
          el("label", { class: "f" }, `Value (${E.fmtNum(mn)}–${E.fmtNum(mx)})`, el("input", {
            type: "number", step: "any", value: o.value,
            onchange: (e) => { o.value = +e.target.value; sync(); refreshAll(); },
          })))));
    });
    const items = Object.entries(D.cores).filter(([id, c]) => c.type !== "dummy" && !/_deck$/.test(id))
      .map(([id, c]) => ({ id, label: c.name || id, icon: c.icon, sub: titleCase(c.type.replace(/_/g, " ")), desc: describeCore(c, E.coreDefault(c)) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    picker($("#owned-core-picker"), {
      items, value: null, placeholder: "Add a core you own…",
      onChange: (id) => { S.ownedCores = S.ownedCores || []; S.ownedCores.push({ uid: uid(), id, variant: "base", value: E.coreDefault(D.cores[id], "base") }); refreshAll(); },
    });
  }
  function setCollectionTab(tab) {
    S.collectionTab = tab;
    $("#coll-cards").hidden = tab !== "cards";
    $("#coll-cores").hidden = tab !== "cores";
    $("#tab-cards").classList.toggle("active", tab === "cards");
    $("#tab-cores").classList.toggle("active", tab === "cores");
  }
  function renderCores() {
    const list = $("#core-list");
    list.innerHTML = "";
    $("#socket-count").textContent = `${S.cores.length}/${socketCount()}`;
    if (!S.cores.length) list.append(el("div", { class: "note" }, "No cores socketed."));
    S.cores.forEach((c, idx) => {
      const cfg = D.cores[c.id];
      if (!cfg) return;
      const variantCfg = E.coreVariant(cfg, c.variant);
      const icon = (variantCfg && variantCfg.icon) || cfg.icon;
      const name = (variantCfg && variantCfg.name) || cfg.name;
      const [mn, mx] = E.coreValueRange(cfg, c.variant);
      const variants = E.coreVariants(cfg);
      const pick = SLOT_PICK[cfg.type];
      const createsSlots = cfg.type === "create_slots" || cfg.type === "create_group_slots";
      const [smin, smax] = E.coreSlotRange(cfg, c.variant);
      const count = (c.slots || []).length;
      const row = el("div", { class: "panel", style: "padding:8px" },
        el("div", { class: "row", style: "align-items:center" },
          icon ? el("img", { class: "px", src: icon, alt: "", style: "width:28px;height:28px;flex:none" }) : null,
          el("div", { style: "flex:1;font-weight:600;color:" + (hex(variantCfg ? variantCfg.colour : cfg.colour) || "inherit") }, name,
            ownedOf(c) ? el("span", { class: "tag own", title: "From your collection" }, "Owned") : null),
          el("button", { class: "btn sm danger", style: "flex:none", onclick: () => { S.cores.splice(idx, 1); if (pickingCore === c) pickingCore = null; refreshAll(); } }, "Remove")),
        el("div", { class: "note", style: "margin:4px 0" }, describeCore(cfg, +c.value, c.variant)),
        el("div", { class: "row" },
          variants.size ? el("label", { class: "f" }, "Variant", el("select", {
            onchange: (e) => { c.variant = e.target.value; c.value = E.coreDefault(cfg, c.variant); syncOwned(c); refreshAll(); },
          }, VARIANTS.filter((v) => v === "base" || variants.has(v)).map((v) => el("option", { value: v, selected: c.variant === v }, cap(v))))) : null,
          createsSlots || cfg.type === "bounty" ? null : el("label", { class: "f" }, `Value (${E.fmtNum(mn)}–${E.fmtNum(mx)})`, el("input", {
            type: "number", step: "any", value: c.value,
            oninput: (e) => { if (e.target.value !== "" && isFinite(+e.target.value)) { c.value = +e.target.value; syncOwned(c); refreshResults(); } },
            onchange: (e) => { c.value = +e.target.value; syncOwned(c); refreshAll(); },
          }))),
        pick ? el("div", { class: "row", style: "margin-top:6px;align-items:center" },
          el("button", {
            class: "btn sm" + (pickingCore === c ? " primary" : ""), style: "flex:none",
            onclick: () => { pickingCore = pickingCore === c ? null : c; selectedSlot = null; renderCores(); renderGrid(); },
          }, pickingCore === c ? "Done" : "Select Slots"),
          el("span", { class: "note", style: count < smin || count > smax ? "color:var(--accent)" : null },
            `${count} of ${smin === smax ? smin : smin + "–" + smax} ${pick.noun} selected`)) : null,
        pickingCore === c ? el("div", { class: "note", style: "margin-top:4px" }, pick.hint) : null);
      list.append(row);
    });
    const items = Object.entries(D.cores).filter(([id, c]) => c.type !== "dummy" && !/_deck$/.test(id))
      .map(([id, c]) => ({ id, label: c.name || id, icon: c.icon, sub: titleCase(c.type.replace(/_/g, " ")), desc: describeCore(c, E.coreDefault(c)) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    picker($("#core-picker"), {
      items, value: null, placeholder: "Add core (planning)…",
      onChange: (id) => { S.cores.push({ id, variant: "base", value: E.coreDefault(D.cores[id], "base"), slots: [] }); refreshAll(); },
    });
  }

  // ------------------------------------------------------------------ grid
  function renderGrid() {
    const grid = $("#grid");
    grid.innerHTML = "";
    const d = deckOf();
    const editing = $("#layout-edit").checked;
    const L = ctx.layout;
    const rows = d.layout[0].value;
    let w = Math.max(...rows.map((r) => r.length), L.maxX + 1), h = Math.max(rows.length, L.maxY + 1);
    const pickingCells = pickingCore && D.cores[pickingCore.id].type === "create_slots";
    if (editing || pickingCells) { w = Math.max(w, 9); h = Math.max(h, 6); }
    grid.style.gridTemplateColumns = `repeat(${w}, var(--slot))`;
    $("#deck-title").textContent = d.name;
    const place = placeArray();
    const per = lastEval ? lastEval.perSlot : [];
    const locked = new Set(S.locked);
    const coreSlots = pickingCore ? new Set(pickingCore.slots || []) : null;
    const empowered = new Set(); // slots chosen by Empyreal / Adept cores (VH modified slot texture)
    for (const set of ctx.slotSets.values()) set.forEach((i) => empowered.add(i));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = E.key(x, y);
      const i = L.index.get(k);
      if (i === undefined) {
        grid.append(el("div", {
          class: "slot none", style: editing || pickingCells ? "border:1px dashed #3a3f49;cursor:pointer" : null,
          onclick: editing ? () => cycleCell(k, x, y) : pickingCells ? () => slotClick(k, x, y) : null,
        }));
        continue;
      }
      const s = L.slots[i], rc = place[i], info = per[i];
      const cls = ["slot"];
      if (s.arcane) cls.push("arcane");
      else if (empowered.has(i)) cls.push("modified");
      if (selectedSlot === k) cls.push("selected");
      if (coreSlots && coreSlots.has(k)) cls.push("hl");
      if (rc && info && info.entries.every((e) => !e.cond || e.disabled || e.N === 0) && rc.entries.some((e) => e.cfg.type === "gear")) cls.push("inactive");
      const node = el("div", {
        class: cls.join(" "), "data-k": k, title: s.arcane ? "Arcane slot" : null,
        onclick: () => slotClick(k, x, y),
        draggable: rc ? "true" : null,
        ondragstart: (e) => { e.dataTransfer.setData("text/plain", "slot:" + k); },
        ondragover: (e) => { e.preventDefault(); node.classList.add("drop"); },
        ondragleave: () => node.classList.remove("drop"),
        ondrop: (e) => { e.preventDefault(); node.classList.remove("drop"); onDrop(e.dataTransfer.getData("text/plain"), k); },
        onmouseenter: (e) => rc && showTip(e, slotTip(rc, info, i)),
        onmousemove: moveTip, onmouseleave: hideTip,
      });
      if (rc) {
        node.append(cardImg(rc));
        const val = mainValue(info);
        if (val) node.append(el("span", { class: "val" }, val));
        const mult = cardMultiplier(info);
        if (mult != null && Math.abs(mult - 1) > 1e-9) node.append(el("span", { class: "eff", title: "Card multiplier: scaler × efficiency × greed" }, "×" + E.fmtNum(Math.round(mult * 100) / 100)));
      }
      if (locked.has(k)) node.append(el("span", { style: "position:absolute;top:1px;left:2px;font-size:10px;color:var(--muted)", title: "Locked" }, "L"));
      grid.append(node);
    }
    renderSlotActions();
  }
  /** Multiplier of a placed card: N x M x G for stat cards, N for level / vault-modifier cards. */
  function cardMultiplier(info) {
    if (!info) return null;
    let m = 0, any = false;
    for (const e of info.entries) {
      if (e.mult != null) { m += e.mult; any = true; }
      else if (e.out.length) { m += e.N; any = true; }
    }
    return any ? m : null;
  }
  function mainValue(info) {
    if (!info) return "";
    for (const e of info.entries) for (const o of e.out) {
      if (o.k.startsWith("ability:") || o.k.startsWith("talent:")) return "+" + o.v;
      if (o.k.startsWith("vmod:")) return E.fmtNum(o.v / 20) + "s";
      if (o.k.startsWith("loot:")) return "x" + o.v;
      return E.formatValue(o.k, o.v, D);
    }
    return info.entries.some((e) => !e.cond) ? "off" : "";
  }
  function cycleCell(k, x, y) {
    const d = deckOf();
    const baseCh = (d.layout[0].value[y] || "")[x];
    const base = baseCh === "O" || baseCh === "A" ? baseCh : "X";
    const cur = S.layoutEdits[k] || base;
    const next = cur === "X" ? "O" : cur === "O" ? "A" : "X";
    if (next === base) delete S.layoutEdits[k]; else S.layoutEdits[k] = next;
    refreshAll();
  }
  function slotClick(k, x, y) {
    if ($("#layout-edit").checked) return cycleCell(k, x, y);
    if (pickingCore) {
      const cfg = D.cores[pickingCore.id];
      const i = ctx.layout.index.get(k);
      const s = i === undefined ? null : ctx.layout.slots[i];
      const set = new Set(pickingCore.slots || []);
      if (!set.has(k)) {
        if (cfg.type === "arcane_slot_boost" && !(s && s.arcane)) return flash("Select an Arcane slot.");
        if (cfg.type === "slot" && !(s && !s.arcane)) return flash("Select a normal slot.");
        if (cfg.type === "create_group_slots" && !(s && !s.arcane)) return flash("Select a normal slot to convert.");
        if (cfg.type === "create_slots") {
          if (s) return flash("Select an empty cell.");
          const L = ctx.layout;
          if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => L.at(x + dx, y + dy) >= 0)) return flash("New slots must be next to an existing slot.");
        }
      }
      set.has(k) ? set.delete(k) : set.add(k);
      pickingCore.slots = [...set];
      return refreshAll();
    }
    selectedSlot = selectedSlot === k ? null : k;
    renderGrid();
    renderCards();
  }
  function renderSlotActions() {
    const box = $("#slot-actions");
    box.innerHTML = "";
    if (!selectedSlot || !ctx.layout.index.has(selectedSlot)) { selectedSlot = null; return; }
    const has = !!S.placement[selectedSlot];
    const locked = S.locked.includes(selectedSlot);
    add(box, 
      el("span", { class: "note", style: "flex:0 0 auto;align-self:center" }, `Slot ${selectedSlot}${ctx.layout.slots[ctx.layout.index.get(selectedSlot)].arcane ? " (Arcane)" : ""}`),
      el("button", { class: "btn sm", style: "flex:0 0 auto", disabled: !has, onclick: () => { delete S.placement[selectedSlot]; refreshAll(); } }, "Remove card"),
      el("button", { class: "btn sm", style: "flex:0 0 auto", onclick: () => {
        S.locked = locked ? S.locked.filter((k) => k !== selectedSlot) : [...S.locked, selectedSlot]; refreshAll();
      } }, locked ? "Unlock slot" : "Lock slot"),
      has ? el("button", { class: "btn sm", style: "flex:0 0 auto", onclick: () => openCardDialog(S.cards.find((c) => c.uid === S.placement[selectedSlot])) }, "Edit card") : null);
  }
  function onDrop(payload, k) {
    const i = ctx.layout.index.get(k);
    const slot = ctx.layout.slots[i];
    if (payload.startsWith("card:")) {
      const u = payload.slice(5);
      placeCard(u, k);
    } else if (payload.startsWith("slot:")) {
      const from = payload.slice(5);
      if (from === k) return;
      const a = S.placement[from], b = S.placement[k];
      const fromSlot = ctx.layout.slots[ctx.layout.index.get(from)];
      if (a && !E.canPlace(resolved.get(a), slot, ctx)) return flash(`Card cannot be placed in ${slot.arcane ? "an Arcane" : "a normal"} slot.`);
      if (b && !E.canPlace(resolved.get(b), fromSlot, ctx)) return flash("Swap not allowed by slot type.");
      if (b) S.placement[from] = b; else delete S.placement[from];
      if (a) S.placement[k] = a;
      refreshAll();
    }
  }
  function placeCard(u, k) {
    const i = ctx.layout.index.get(k);
    const rc = resolved.get(u);
    if (!E.canPlace(rc, ctx.layout.slots[i], ctx)) {
      return flash(ctx.nitwit ? "Arcane cards cannot be placed in this deck." :
        ctx.layout.slots[i].arcane ? "Arcane slots only accept Arcane cards." : "Arcane cards can only be placed in Arcane slots.");
    }
    for (const [kk, uu] of Object.entries(S.placement)) if (uu === u) delete S.placement[kk];
    S.placement[k] = u;
    refreshAll();
  }
  let flashT = null;
  function flash(msg, ok) {
    const n = $("#slot-actions");
    n.innerHTML = "";
    n.append(el("span", { class: "note", style: `color:var(${ok ? "--good" : "--bad"});flex:0 1 auto` }, msg));
    clearTimeout(flashT);
    flashT = setTimeout(renderSlotActions, ok ? 7000 : 2500);
  }

  // ------------------------------------------------------------------ tooltips
  /** The tooltip element, kept inside the open modal dialog (top layer) so it is not drawn under its backdrop. */
  const tip = () => {
    const t = document.getElementById("tip");
    const host = document.querySelector("dialog[open]") || document.body;
    if (t.parentNode !== host) host.append(t);
    return t;
  };
  function showTip(e, content) { const t = tip(); t.innerHTML = ""; t.append(content); t.hidden = false; moveTip(e); }
  function moveTip(e) {
    const t = tip(); if (t.hidden) return;
    const pad = 14, w = t.offsetWidth, h = t.offsetHeight;
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + w > innerWidth - 8) x = e.clientX - w - pad;
    if (y + h > innerHeight - 8) y = Math.max(8, innerHeight - h - 8);
    t.style.left = Math.max(8, x) + "px"; t.style.top = y + "px";
  }
  function hideTip() { tip().hidden = true; }
  /** Tooltip for a dropdown entry: beside the open list, level with the entry (right side, else left). */
  function showTipBeside(item, content) {
    const t = tip(); t.innerHTML = ""; t.append(content); t.hidden = false;
    const pop = item.closest(".picker-pop") || item;
    const r = pop.getBoundingClientRect(), ir = item.getBoundingClientRect();
    const w = t.offsetWidth, h = t.offsetHeight, gap = 8;
    let x, y;
    if (r.right + gap + w <= innerWidth - 8) x = r.right + gap;
    else if (r.left - gap - w >= 8) x = r.left - gap - w;
    if (x != null) y = Math.min(Math.max(8, ir.top), innerHeight - h - 8);
    else { // no room beside the list (narrow screens): below it, else above it
      x = Math.min(Math.max(8, r.left), innerWidth - w - 8);
      y = r.bottom + gap + h <= innerHeight - 8 ? r.bottom + gap : Math.max(8, r.top - gap - h);
    }
    t.style.left = x + "px"; t.style.top = y + "px";
  }

  function cardTipBase(rc) {
    const box = el("div");
    rc.entries.forEach((e, n) => {
      const cfg = e.cfg;
      if (n === 0) box.append(el("div", { class: "h" }, cardName(e.src.mod) + "  ", el("span", { class: "m" }, "Tier " + rc.tier)));
      box.append(el("div", { class: "m" }, colorDots([...e.colors]), " ", [...e.groups].join(", ")));
      box.append(el("div", { class: "l" }, entryBaseText(e, rc.tier)));
      for (const f of (e.src.scaler && e.src.scaler.filters) || []) box.append(el("div", { class: "l" }, "> " + filterLine(f, false)));
      for (const f of (e.src.condition && e.src.condition.filters) || []) box.append(el("div", { class: "l" }, "> " + filterLine(f, true)));
    });
    return box;
  }
  // ---- Resource (task loot) cards: the card rolls one task from its difficulty pool
  const taskPoolOf = (cfg) => String(cfg.task || "").replace(/^@/, "");
  const DIFFICULTY = { easy: "Easy", medium: "Medium", hard: "Hard", extreme: "Extreme", impossible: "Impossible", default: "Starter" };
  function taskOptions(cfg) {
    const T = D.tasks || { pools: {}, values: {} };
    return (T.pools[taskPoolOf(cfg)] || []).filter((id) => T.values[id]).map((id) => ({ id, ...T.values[id] }));
  }
  /** "per 24 Horde Mobs killed" for a chosen task, else "per Medium task". */
  function taskText(cfg, task) {
    const T = D.tasks || { values: {} };
    const t = task && T.values[task.id];
    if (t) return t.text.replace("${target}", task.target ?? (t.target[0] === t.target[1] ? t.target[0] : t.target.join("–")));
    return `per ${DIFFICULTY[taskPoolOf(cfg)] || "random"} task`;
  }
  /** Resource core effects on a deck: requirement factor (Harvest) and double-loot chance. */
  function resourceCoreEffects() {
    let factor = 1, dbl = 0;
    for (const c of (ctx && ctx.cores) || []) {
      if (c.type === "resource_requirement") factor *= 1 - Math.min(1, Math.max(0, c.v));
      if (c.type === "resource_double") dbl += c.v;
    }
    return { factor, dbl: Math.min(1, dbl) };
  }
  function entryBaseText(e, tier) {
    const cfg = e.cfg, src = e.src;
    if (cfg.type === "greed") {
      const m = src.value != null ? src.value : (E.forTier(cfg.multiplierPool, tier) || {}).roll;
      return `×${m} to ${(cfg.targetColorFilter || []).map(cap).join("/") || "Any"} Card ${(cfg.targetNeighborTypes || []).map(cap).join("/")}`;
    }
    if (cfg.type === "dummy") return "No Attributes (Matches Scaler Filters Only)";
    if (cfg.type === "task_loot") {
      const c = src.value != null ? src.value : E.rollMid((E.forTier(cfg.count, tier) || {}).roll);
      const tpl = (cfg.tooltip || []).map((x) => x.text || "").join("");
      if (tpl.includes("${task}")) return tpl.replace("${count}", c).replace("${task}", taskText(cfg, src.task)).replace(/\s+/g, " ").trim();
      return `+${c} ${E.itemName((((cfg.loot || [])[0] || {}).item || {}).id || "", D)} ${taskText(cfg, src.task)}`;
    }
    const t = E.forTier(cfg.pool, tier) || {};
    if (cfg.attribute === "the_vault:added_ability_level") return `+${src.value ?? t.levelChange} ${t.abilityKey.replace(/_/g, " ")} Ability Level`;
    if (cfg.attribute === "the_vault:added_talent_level") return `+${src.value ?? t.levelChange} ${t.talentKey.replace(/_/g, " ")} Talent Level`;
    if (cfg.attribute === E.VMOD_ATTR) return `${t.count || 1}x ${E.prettyId(t.modifier)} for ${E.fmtNum((src.value ?? E.rollMid(t.time)) / 20)}s`;
    const v = src.value != null ? +src.value : E.rollMid(t);
    const a = D.attributes[cfg.attribute] || {};
    return `${E.formatValue(cfg.attribute, v, D)} ${a.reader === "increasedReader" ? "Increased " : ""}${a.name || E.prettyId(cfg.attribute)}`;
  }
  function slotTip(rc, info) {
    const box = cardTipBase(rc);
    if (!info) return box;
    box.append(el("hr"));
    // Efficiency and greed only scale numeric attribute cards; ability / talent levels, vault-modifier
    // durations and task loot are never multiplied by them in game (scalers still apply).
    const scaled = rc.entries.some((e) => e.cfg.type === "gear" && !E.LEVEL_ATTRS[e.cfg.attribute] && e.cfg.attribute !== E.VMOD_ATTR);
    if (scaled) {
      box.append(el("div", { class: "l" }, `Efficiency x${E.fmtNum(Math.round(info.M * 10000) / 10000)}`, info.G > 1 ? `  ·  Greed x${E.fmtNum(info.G)}` : ""));
      for (const p of info.parts) {
        box.append(el("div", { class: "m" }, `${p.c.implicit ? "Implicit " : ""}${p.c.cfg.name || p.c.id}: ${p.add != null ? (p.add >= 0 ? "+" : "") + fmtPct(p.add) : "x" + E.fmtNum(p.mul)}`));
      }
    } else if (rc.entries.some((e) => e.cfg.type === "gear" || e.cfg.type === "task_loot")) {
      box.append(el("div", { class: "m" }, "Not affected by card efficiency or greed"));
    }
    if (rc.entries.some((e) => e.cfg.type === "task_loot")) {
      const fx = resourceCoreEffects();
      for (const e of rc.entries) {
        if (e.cfg.type !== "task_loot") continue;
        const t = e.src.task && D.tasks && D.tasks.values[e.src.task.id];
        if (fx.factor < 1) {
          const tgt = t ? e.src.task.target : null;
          box.append(el("div", { class: "l" }, `Task requirement ×${E.fmtNum(Math.round(fx.factor * 1000) / 1000)}` +
            (tgt != null ? ` (about ${Math.max(1, Math.round(tgt * fx.factor))} instead of ${tgt})` : "")));
        }
        if (fx.dbl > 0) box.append(el("div", { class: "l" }, `${E.fmtNum(Math.round(fx.dbl * 1000) / 10)}% chance to double the loot`));
      }
    }
    info.entries.forEach((e) => {
      if (e.disabled) box.append(el("div", { class: "l", style: "color:var(--bad)" }, "Arcane entries are disabled in this deck"));
      else if (!e.cond) box.append(el("div", { class: "l", style: "color:var(--bad)" }, "Condition not met"));
      else if (e.N !== 1) box.append(el("div", { class: "l" }, `Scaler count: ${e.N}`));
      for (const o of e.out) box.append(el("div", { class: "l", style: "color:var(--good)" }, `= ${fmtOut(o)} ${E.attrLabel(o.k, D)}`));
    });
    return box;
  }
  function fmtOut(o) {
    if (o.k.startsWith("vmod:")) return `${o.count}x ${E.fmtNum(o.v / 20)}s`;
    if (o.k.startsWith("ability:") || o.k.startsWith("talent:") || o.k.startsWith("loot:")) return "+" + o.v;
    return E.formatValue(o.k, o.v, D);
  }

  // ------------------------------------------------------------------ collection
  function renderCards() {
    const list = $("#card-list");
    list.innerHTML = "";
    const q = $("#card-search").value.trim().toLowerCase();
    const only = $("#only-unplaced").checked;
    const placed = placedUids();
    $("#card-count").textContent = `${placed.size}/${S.cards.length}`;
    const rows = S.cards.map((c) => resolved.get(c.uid)).filter((rc) => {
      if (only && placed.has(rc.uid)) return false;
      if (!q) return true;
      return (cardName(rc.entries[0].src.mod) + " " + [...rc.groups].join(" ") + " " + (rc.firstColor || "")).toLowerCase().includes(q);
    });
    if (!S.cards.length) list.append(el("div", { class: "empty" }, "No cards yet. Use Add card to enter the cards you own."));
    for (const rc of rows) {
      const e0 = rc.entries[0];
      const sel = selectedSlot && ctx.layout.index.has(selectedSlot) ? ctx.layout.slots[ctx.layout.index.get(selectedSlot)] : null;
      const fits = !sel || E.canPlace(rc, sel, ctx);
      const row = el("div", {
        class: "card-row" + (placed.has(rc.uid) ? " placed" : ""), draggable: "true",
        style: fits ? null : "opacity:.45",
        ondragstart: (ev) => ev.dataTransfer.setData("text/plain", "card:" + rc.uid),
        onclick: (ev) => {
          if (ev.target.closest("button")) return;
          if (selectedSlot) placeCard(rc.uid, selectedSlot);
        },
        onmouseenter: (ev) => showTip(ev, cardTipBase(rc)), onmousemove: moveTip, onmouseleave: hideTip,
      },
      cardImg(rc, "card-img card-thumb"),
      el("div", { class: "info" },
        el("div", { class: "t" }, cardName(e0.src.mod),
          D.obtainable && !D.obtainable[e0.src.mod] ? el("span", { class: "tag warn", title: "No booster pack can roll this card" }, "Not in packs") : null,
          rc.card.planned ? el("span", { class: "tag plan", title: "Added by Auto build (best roll); you may not own this card yet" }, "Planned") : null),
        el("div", { class: "d" }, colorDots([...e0.colors]), ` T${rc.tier} · `, entryBaseText(e0, rc.tier),
          ...((e0.src.scaler && e0.src.scaler.filters) || []).map((f) => el("div", {}, "> " + filterLine(f, false))),
          ...((e0.src.condition && e0.src.condition.filters) || []).map((f) => el("div", {}, "> " + filterLine(f, true))))),
      el("div", { class: "acts" },
        el("button", { class: "btn sm", title: "Edit", onclick: () => openCardDialog(rc.card) }, "Edit"),
        el("button", { class: "btn sm", title: "Duplicate", onclick: () => { const c = JSON.parse(JSON.stringify(rc.card)); c.uid = uid(); S.cards.splice(S.cards.indexOf(rc.card) + 1, 0, c); refreshAll(); } }, "+1"),
        el("button", { class: "btn sm danger", title: "Delete", onclick: () => {
          S.cards = S.cards.filter((c) => c.uid !== rc.uid);
          for (const [k, u] of Object.entries(S.placement)) if (u === rc.uid) delete S.placement[k];
          refreshAll();
        } }, "×")));
      list.append(row);
    }
  }

  // ------------------------------------------------------------------ card dialog
  let editing = null; // {card | null}
  let draft = null;
  function newDraft(modId) {
    const cfg = D.cards[modId];
    return { mod: modId, tier: 1, colors: cfg && cfg.colors ? cfg.colors.slice() : ["GREEN"], extraGroups: [], value: null, scaler: [], condition: [], task: null };
  }
  function openCardDialog(card) {
    editing = card || null;
    if (card) {
      const e = card.entries[0];
      draft = { mod: e.mod, tier: card.tier, colors: (e.colors || []).slice(), extraGroups: (e.extraGroups || []).slice(), value: e.value, task: e.task ? { ...e.task } : null,
        scaler: JSON.parse(JSON.stringify((e.scaler && e.scaler.filters) || [])), condition: JSON.parse(JSON.stringify((e.condition && e.condition.filters) || [])) };
    } else { draft = newDraft(draft ? draft.mod : "attack_damage"); fitDraftToRolls(); }
    $("#cd-title").textContent = card ? "Edit card" : "Add card";
    $("#cd-copies").value = 1;
    $("#cd-copies").closest("label").hidden = !!card;
    renderDialog();
    $("#card-dialog").showModal();
  }
  function valueMeta(cfg, tier) {
    if (!cfg) return { label: "Value", def: null };
    if (cfg.type === "greed") return { label: "Multiplier", def: (E.forTier(cfg.multiplierPool, tier) || {}).roll, scale: 1 };
    if (cfg.type === "dummy") return { label: "Value", def: null, none: true };
    if (cfg.type === "task_loot") return { label: "Item count", def: E.rollMid((E.forTier(cfg.count, tier) || {}).roll), scale: 1 };
    const t = E.forTier(cfg.pool, tier) || {};
    if (E.LEVEL_ATTRS[cfg.attribute]) return { label: "Levels", def: t.levelChange, scale: 1 };
    if (cfg.attribute === E.VMOD_ATTR) {
      const [a, b] = E.rollRange(t.time);
      return { label: "Duration (s)", def: E.rollMid(t.time), scale: 1 / 20, range: [a, b] };
    }
    const pct = E.isPercent(cfg.attribute, D);
    const a = D.attributes[cfg.attribute] || {};
    const label = (a.reader === "increasedReader" ? "Increased " : "") + (a.name || E.prettyId(cfg.attribute)) + (pct ? " (%)" : "");
    return { label, def: E.rollMid(t), scale: pct ? 100 : 1, range: [t.min, t.max] };
  }
  const WHERE = ["SURROUNDING", "ADJACENT", "ROW", "COLUMN", "DIAGONAL", "ABOVE", "BELOW", "LEFT", "RIGHT"];
  const isWild = (cfg) => !!(cfg && (cfg.groups || []).includes("Wild"));
  /** What booster packs can roll on this card (data.cardRolls); null = unrestricted (card not from packs). */
  const rollsOf = (mod) => (D.cardRolls && D.cardRolls[mod]) || null;
  /** Fit the draft's extra groups, scaler and condition to what the card can roll. */
  function fitDraftToRolls() {
    const r = rollsOf(draft.mod);
    if (!r) return;
    draft.extraGroups = draft.extraGroups.filter((g) => g === "Foil" && r.foil);
    for (const [k, req] of [["scaler", "scalerRequired"], ["condition", "conditionRequired"]]) {
      const opt = r[k];
      if (!opt) { draft[k] = []; continue; }
      const pick = (vals) => (vals.includes("") ? [] : [vals[0]]);
      const fit = (f) => {
        const out = {};
        for (const fk of ["neighbor", "color", "group", "tier"]) {
          const allowed = opt[fk] || [""];
          const cur = (f[fk] || []).filter((v) => allowed.includes(String(v)));
          out[fk] = cur.length ? cur : pick(allowed).map((v) => (fk === "tier" ? +v : v));
        }
        if (k === "condition") {
          out.min = opt.min && f.min != null ? Math.min(Math.max(f.min, opt.min[0]), opt.min[1]) : null;
          out.max = opt.max && f.max != null ? Math.min(Math.max(f.max, opt.max[0]), opt.max[1]) : null;
          if (opt.min && (!opt.minOptional || (out.min == null && out.max == null))) out.min = out.min ?? opt.min[0];
          if (opt.max && !opt.maxOptional) out.max = out.max ?? opt.max[0];
          if (out.min == null && out.max == null && opt.max) out.max = opt.max[0];
        }
        return out;
      };
      draft[k] = draft[k].slice(0, 1).map(fit);
      if (r[req] && !draft[k].length) draft[k] = [fit({})];
    }
  }

  /** In-game style tooltip line for one filter, e.g. "For Each Yellow, Surrounding Card". */
  function filterLine(f, isCond) {
    const what = [(f.tier || []).map((t) => "Tier " + t).join("/"), (f.color || []).map(cap).join("/"), (f.group || []).join("/")].filter(Boolean).join(" ");
    const where = (f.neighbor || []).map(cap).join("/");
    const noun = (what ? what + (where ? ", " : " ") : "") + (where ? where + " " : "") + "Card";
    if (!isCond) return "For Each " + noun + (where ? "" : " in Deck");
    const lim = f.min != null && f.max != null ? (f.min === f.max ? `exactly ${f.min}` : `${f.min}-${f.max}`)
      : f.min != null ? `at least ${f.min}` : f.max != null ? `at most ${f.max}` : "any";
    return `Requires ${lim} ${noun}${where ? "" : " in Deck"}`;
  }

  function updatePreview() {
    const cfg = D.cards[draft.mod];
    const box = $("#cd-preview");
    box.innerHTML = "";
    if (!cfg) return;
    const groups = [...new Set([...(cfg.groups || []), ...draft.extraGroups])];
    const e = { cfg, src: { value: draft.value, task: draft.task } };
    box.append(
      el("div", { class: "h" }, cfg.name ? cfg.name.text : draft.mod),
      el("div", { class: "l" }, "Tier: " + draft.tier),
      el("div", { class: "l" }, "Color: " + (draft.colors.map(cap).join(", ") || "—")),
      el("div", { class: "l" }, "Groups: " + groups.join(", ")),
      el("div", { style: "color:" + (hex((D.attributes[cfg.attribute] || {}).color) || "#fff") }, entryBaseText(e, draft.tier)),
      ...draft.scaler.map((f) => el("div", { class: "l" }, "> " + filterLine(f, false))),
      ...draft.condition.map((f) => el("div", { class: "l" }, "> " + filterLine(f, true))));
  }

  function renderDialog() {
    // only cards that booster packs can roll (data.obtainable); the edited card stays listed if it is not one
    const obt = D.obtainable || {};
    const items = Object.entries(D.cards).filter(([id]) => obt[id] || id === draft.mod).map(([id, c]) => ({
      id, label: c.name ? c.name.text : id, icon: c.icon || frameIcon(id, c), group: cfgType(c),
      sub: c.type === "dummy" && c.colors ? "Colors: " + c.colors.map(cap).join("/") : entryBaseText({ cfg: c, src: {} }, 1),
      desc: obt[id] ? "From: " + obt[id].join(", ") : "Not obtainable from booster packs",
    })).sort((a, b) => a.label.localeCompare(b.label));
    picker($("#cd-picker"), { items, value: draft.mod, groups: CARD_TYPE_GROUPS(), onChange: (id) => {
      const keep = { tier: 1, scaler: draft.scaler, condition: draft.condition, extraGroups: draft.extraGroups };
      if (!isWild(D.cards[id]) && draft.colors.length) keep.colors = draft.colors.slice(0, 1);
      draft = Object.assign(newDraft(id), keep);
      fitDraftToRolls();
      renderDialog();
    } });
    const cfg = D.cards[draft.mod];
    const maxT = (cfg && cfg.maxTier) || 1;
    if (draft.tier > maxT) draft.tier = maxT;
    $("#cd-tier").innerHTML = "";
    for (let t = 1; t <= maxT; t++) $("#cd-tier").append(el("option", { value: t, selected: t === draft.tier }, "Tier " + t));
    $("#cd-tier").onchange = (e) => { draft.tier = +e.target.value; draft.value = null; renderDialog(); };

    const vm = valueMeta(cfg, draft.tier);
    $("#cd-value-label").textContent = vm.label;
    const vi = $("#cd-value");
    vi.disabled = !!vm.none;
    vi.value = vm.none ? "" : E.fmtNum((draft.value != null ? draft.value : vm.def) * (vm.scale || 1));
    vi.oninput = () => { draft.value = vi.value === "" ? null : +vi.value / (vm.scale || 1); updatePreview(); };
    $("#cd-value-note").textContent = vm.range && vm.range[0] !== vm.range[1]
      ? `Rolled range for tier ${draft.tier}: ${E.fmtNum(vm.range[0] * vm.scale)} – ${E.fmtNum(vm.range[1] * vm.scale)}. Enter the value shown on your card.` : "";

    // Resource cards: the task the card rolled (from its difficulty pool) and its target
    const taskBox = $("#cd-task");
    taskBox.innerHTML = "";
    taskBox.hidden = !(cfg && cfg.type === "task_loot");
    if (!taskBox.hidden) {
      const opts = taskOptions(cfg);
      if (draft.task && !opts.some((o) => o.id === draft.task.id)) draft.task = null;
      const cur = draft.task && opts.find((o) => o.id === draft.task.id);
      const rng = (o) => (o.target[0] === o.target[1] ? String(o.target[0]) : o.target.join("–"));
      add(taskBox, 
        el("label", { class: "f" }, `Task (${DIFFICULTY[taskPoolOf(cfg)] || taskPoolOf(cfg)} pool)`, el("select", {
          onchange: (e) => {
            const o = opts.find((x) => x.id === e.target.value);
            draft.task = o ? { id: o.id, target: o.target[0] } : null;
            renderDialog();
          },
        }, el("option", { value: "" }, "Any task (as shown on the card)"),
        opts.map((o) => el("option", { value: o.id, selected: !!cur && cur.id === o.id }, o.text.replace("${target}", rng(o)))))),
        cur ? el("label", { class: "f", style: "flex:0 0 110px" }, `Target (${rng(cur)})`, el("input", {
          type: "number", min: cur.target[0], max: cur.target[1], value: draft.task.target,
          oninput: (e) => { draft.task.target = e.target.value === "" ? cur.target[0] : +e.target.value; updatePreview(); },
        })) : null);
    }

    // Card color: single choice; Wild cards may carry several colors
    const wild = isWild(cfg);
    const colorBox = $("#cd-colors");
    colorBox.innerHTML = "";
    for (const c of E.COLORS) colorBox.append(el("label", {}, el("input", {
      type: wild ? "checkbox" : "radio", name: "cd-color", checked: draft.colors.includes(c),
      onchange: (e) => {
        if (!wild) draft.colors = [c];
        else draft.colors = (e.target.checked ? [...draft.colors, c] : draft.colors.filter((x) => x !== c)).sort((a, b) => E.COLORS.indexOf(a) - E.COLORS.indexOf(b));
        updatePreview();
      },
    }), el("span", { class: "dot c-" + c }), cap(c)));

    const gBox = $("#cd-groups");
    gBox.innerHTML = "";
    const base = (cfg && cfg.groups) || [];
    const rolls = rollsOf(draft.mod);
    // packs only add Foil; Shiny and Deluxe are part of those cards' own configs
    const extraOpts = rolls ? (rolls.foil ? ["Foil"] : []) : GROUPS_EXTRA;
    gBox.closest("fieldset").hidden = !extraOpts.some((g) => !base.includes(g));
    for (const g of extraOpts) {
      if (base.includes(g)) continue;
      gBox.append(el("label", {}, el("input", {
        type: "checkbox", checked: draft.extraGroups.includes(g),
        onchange: (e) => { draft.extraGroups = e.target.checked ? [...draft.extraGroups, g] : draft.extraGroups.filter((x) => x !== g); updatePreview(); },
      }), g));
    }
    renderFilters($("#cd-scaler"), draft.scaler, false);
    renderFilters($("#cd-condition"), draft.condition, true);
    updatePreview();
  }
  const ALL_GROUPS = () => {
    const s = new Set();
    Object.values(D.cards).forEach((c) => (c.groups || []).forEach((g) => s.add(g)));
    GROUPS_EXTRA.forEach((g) => s.add(g));
    return [...s].sort();
  };
  /** Single-value dropdown bound to a filter array; keeps multi-value arrays from imports intact. */
  function oneOf(values, arr, label, fmt, onSet, anyOk = true) {
    const cur = arr || [];
    const multi = cur.length > 1;
    // keep a value that is already set (e.g. from an import) selectable even if outside the options
    if (cur.length === 1 && !values.some((v) => String(v) === String(cur[0]))) values = [...values, cur[0]];
    return el("select", { onchange: (e) => onSet(e.target.value === "" ? [] : [values.find((v) => String(v) === e.target.value)]) },
      anyOk ? el("option", { value: "" }, label) : null,
      multi ? el("option", { value: "__multi", selected: true, disabled: true }, cur.map(fmt).join("/")) : null,
      values.map((v) => el("option", { value: v, selected: !multi && cur[0] === v }, fmt(v))));
  }
  function renderFilters(host, arr, isCond) {
    host.innerHTML = "";
    const rer = () => { renderFilters(host, arr, isCond); updatePreview(); };
    const rolls = rollsOf(draft.mod);
    const opt = rolls ? rolls[isCond ? "condition" : "scaler"] : null;
    const required = !!(rolls && rolls[isCond ? "conditionRequired" : "scalerRequired"]);
    const addBtn = $(isCond ? "#cd-add-condition" : "#cd-add-scaler");
    // packs roll at most one filter per line, and some cards can never have the line
    host.closest("fieldset").hidden = !!rolls && !opt && !arr.length;
    addBtn.hidden = !!rolls && (!opt || arr.length >= 1);
    const choices = (fk, all) => {
      if (!opt) return { values: all, any: true };
      const allowed = opt[fk] || [""];
      return { values: all.filter((v) => allowed.includes(String(v))), any: allowed.includes("") };
    };
    arr.forEach((f, n) => {
      const set = (k) => (v) => { f[k] = v; rer(); };
      const num = (k) => el("input", { type: "number", min: 0, value: f[k] ?? "", style: "flex:0 0 60px",
        oninput: (e) => { f[k] = e.target.value === "" ? null : +e.target.value; updatePreview(); } });
      let lead = null;
      if (isCond) {
        const mode = f.min != null && f.max != null ? "between" : f.max != null ? "max" : "min";
        const modes = [["min", "At least"], ["max", "At most"], ["between", "Between"]].filter(([v]) => !opt ||
          (v === "min" ? opt.min && opt.maxOptional : v === "max" ? opt.max && opt.minOptional : opt.min && opt.max));
        const numB = (k) => {
          const inp = num(k);
          if (opt && opt[k]) { inp.min = opt[k][0]; inp.max = opt[k][1]; }
          return inp;
        };
        const lo = (k) => (opt && opt[k] ? opt[k][0] : 1);
        lead = [el("select", { style: "flex:0 0 100px", onchange: (e) => {
          const m = e.target.value;
          if (m === "min") { f.min = f.min ?? lo("min"); f.max = null; }
          else if (m === "max") { f.max = f.max ?? lo("max"); f.min = null; }
          else { f.min = f.min ?? lo("min"); f.max = f.max ?? lo("max"); }
          rer();
        } }, (modes.length ? modes : [["min", "At least"]]).map(([v, t]) => el("option", { value: v, selected: v === mode }, t))),
        mode !== "max" ? numB("min") : null, mode !== "min" ? numB("max") : null];
      }
      const cc = choices("color", E.COLORS), cg = choices("group", ALL_GROUPS()), cn = choices("neighbor", WHERE), ct = choices("tier", [1, 2, 3, 4, 5]);
      const sel = (c, cur, label, fmt, key) => (c.values.length || (cur || []).length ? oneOf(c.values, cur, label, fmt, set(key), c.any) : null);
      host.append(el("div", { class: "row", style: "align-items:center" },
        el("span", { style: "flex:0 0 auto;font-size:13px" }, isCond ? "Requires" : "For each"),
        lead,
        sel(cc, f.color, "Any color", cap, "color"),
        sel(cg, f.group, "Any group", (g) => g, "group"),
        sel(cn, f.neighbor, "Whole deck", cap, "neighbor"),
        sel(ct, f.tier, "Any tier", (t) => "Tier " + t, "tier"),
        required ? null : el("button", { type: "button", class: "btn sm danger", style: "flex:0 0 auto", title: "Remove filter", onclick: () => { arr.splice(n, 1); rer(); } }, "×")));
    });
    $(isCond ? "#cd-add-condition" : "#cd-add-scaler").textContent = arr.length ? "Add another filter" : isCond ? "Add condition" : "Add scaler";
  }
  function saveDialog() {
    const entry = {
      mod: draft.mod, colors: draft.colors.slice(), extraGroups: draft.extraGroups.slice(), value: draft.value,
      task: draft.task && D.cards[draft.mod] && D.cards[draft.mod].type === "task_loot" ? { ...draft.task } : null,
      scaler: draft.scaler.length ? { filters: draft.scaler } : null,
      condition: draft.condition.length ? { filters: draft.condition } : null,
    };
    if (editing) {
      editing.tier = draft.tier;
      editing.entries = [entry];
    } else {
      const n = Math.max(1, Math.min(50, +$("#cd-copies").value || 1));
      for (let i = 0; i < n; i++) S.cards.push({ uid: uid(), tier: draft.tier, entries: [JSON.parse(JSON.stringify(entry))] });
    }
    refreshAll();
  }

  // ------------------------------------------------------------------ stats
  function candidateKeys() {
    const ks = new Set();
    for (const c of S.cards) for (const e of c.entries) { const k = entryKey(e); if (k) ks.add(k); }
    if (lastEval) Object.keys(lastEval.totals).forEach((k) => ks.add(k));
    return [...ks];
  }
  /** Icon of the card that produces attribute k (placed cards first, then the collection). */
  function attrIcon(k) {
    const pick = (rc) => { const e = rc && rc.entries.find((x) => entryKey(x.src) === k); return e ? e.cfg.icon || frameIcon(e.src.mod, e.cfg) : null; };
    for (const rc of placeArray()) { const i = pick(rc); if (i) return i; }
    for (const rc of resolved.values()) { const i = pick(rc); if (i) return i; }
    return null;
  }
  /** Card type for the statistics sections (same precedence as the card frame). */
  const CARD_TYPES = ["Evolution", "Stat", "Temporal", "Arcane", "Resource", "Knack", "Other"];
  /** Card type of a card config (same precedence as the card frame); Greed cards are their own type. */
  function cfgType(c) {
    if (c.type === "greed") return "Greed";
    const g = new Set(c.groups || []);
    for (const t of ["Arcane", "Temporal", "Resource", "Evolution", "Knack", "Stat"]) if (g.has(t)) return t;
    return "Other";
  }
  const CARD_TYPE_GROUPS = () => ["Evolution", "Stat", "Knack", "Temporal", "Arcane", "Resource", "Greed", "Other"].map((t) => ({
    id: t, label: t === "Other" ? "Other Cards" : t + " Cards", icon: D.gui["group" + t] || null,
  }));
  function cardType(rc) {
    for (const g of ["Arcane", "Temporal", "Resource", "Evolution", "Knack", "Stat"]) if (rc.groups.has(g)) return g;
    return "Other";
  }
  function renderStats() {
    const t = $("#stats");
    t.innerHTML = "";
    const keys = candidateKeys();
    t.append(el("tr", {}, el("th", {}, "Attribute"), el("th", { style: "text-align:right" }, "Deck total"), el("th", { style: "text-align:right;width:90px" }, "Weight")));
    if (!keys.length) {
      t.append(el("tr", {}, el("td", { colspan: 3, class: "note" }, "Add cards to see deck totals.")));
      return renderScore();
    }
    // per attribute: contribution by card type (placed cards), a representative card for the icon
    const parts = new Map(), repr = new Map();
    const place = placeArray(), per = lastEval ? lastEval.perSlot : [];
    place.forEach((rc, i) => {
      if (!rc || !per[i]) return;
      const type = cardType(rc);
      rc.entries.forEach((e, j) => {
        const k = entryKey(e.src);
        if (k && !repr.has(k)) repr.set(k, rc);
        for (const o of (per[i].entries[j] || { out: [] }).out) {
          const m = parts.get(o.k) || new Map();
          m.set(type, (m.get(type) || 0) + o.v);
          parts.set(o.k, m);
        }
      });
    });
    for (const rc of resolved.values()) for (const e of rc.entries) { const k = entryKey(e.src); if (k && !repr.has(k)) repr.set(k, rc); }
    const sectionOf = (k) => {
      const m = parts.get(k);
      if (m && m.size) return [...m].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0][0];
      const rc = repr.get(k);
      return rc ? cardType(rc) : "Other";
    };
    const bySec = new Map(CARD_TYPES.map((c) => [c, []]));
    // "Only stats with values": hide attributes whose deck total is empty or zero
    const hasValue = (k) => { const v = lastEval.totals[k]; return v != null && (typeof v === "object" ? v.time > 0 || v.count > 0 : Math.abs(v) > 1e-9); };
    const shownKeys = S.statsNonZero ? keys.filter(hasValue) : keys;
    for (const k of shownKeys) bySec.get(sectionOf(k)).push(k);
    if (!shownKeys.length) t.append(el("tr", {}, el("td", { colspan: 3, class: "note" }, "No stat has a value yet. Place cards in the deck, or untick Only stats with values.")));
    for (const [sec, list] of bySec) {
      if (!list.length) continue;
      list.sort((a, b) => E.attrLabel(a, D).localeCompare(E.attrLabel(b, D)));
      const gi = D.gui["group" + sec];
      const firstRc = repr.get(list[0]);
      t.append(el("tr", { class: "sec" }, el("th", { colspan: 3 },
        gi ? el("img", { class: "px sec-ico", src: gi, alt: "" }) : firstRc ? cardImg(firstRc, "card-img sec-card") : null,
        sec === "Other" ? "Other" : sec + " Cards")));
      for (const k of list) {
        const v = lastEval.totals[k];
        const a = D.attributes[k];
        const w = S.weights[k] ?? 1;
        const icon = attrIcon(k);
        const m = parts.get(k);
        const split = m && m.size > 1 ? [...m].map(([ty, pv]) => `${ty}: ${fmtOut({ k, v: pv, count: "" }).replace(/^x /, "")}`).join(" · ") : null;
        t.append(el("tr", { title: split ? "Contributions by card type: " + split : null },
          el("td", {}, el("div", { class: "attr" },
            icon ? el("img", { class: "px attr-ico", src: icon, alt: "" }) : el("span", { class: "attr-ico" }),
            el("span", { style: a && a.color != null ? "color:" + hex(a.color) : null }, E.attrLabel(k, D)),
            split ? el("span", { class: "note" }, "(" + [...m.keys()].join(" + ") + ")") : null)),
          el("td", { class: "num" }, v == null ? "—" : fmtOut({ k, v: typeof v === "object" ? v.time : v, count: v && v.count })),
          el("td", { class: "num" }, el("input", {
            type: "number", step: "any", value: w, style: "width:80px;text-align:right",
            onchange: (e) => { S.weights[k] = +e.target.value; save(); renderScore(); },
          }))));
      }
    }
    renderScore();
  }
  const MAX_PRIORITY = 3;
  function weightsFull() {
    const w = {};
    for (const k of candidateKeys()) w[k] = S.weights[k] ?? 1;
    return w;
  }
  /** Optimizer objective: scoring mode, weights and strict priorities (see js/optimizer.js). */
  function spec() {
    return { mode: S.scoreMode === "totals" ? "totals" : "mult", weights: weightsFull(), priority: (S.priority || []).slice() };
  }
  function renderPriority() {
    const box = $("#priority-box");
    box.innerHTML = "";
    const keys = candidateKeys();
    S.priority = (S.priority || []).filter((k) => keys.includes(k)).slice(0, MAX_PRIORITY);
    S.priority.forEach((k, r) => {
      const a = D.attributes[k];
      box.append(el("span", { class: "chip" },
        el("b", {}, r + 1 + "."),
        attrIcon(k) ? el("img", { class: "px chip-ico", src: attrIcon(k), alt: "" }) : null,
        el("span", { style: a && a.color != null ? "color:" + hex(a.color) : null }, E.attrLabel(k, D)),
        r > 0 ? el("button", { type: "button", class: "chip-x", title: "Move up", onclick: () => { const p = S.priority; [p[r - 1], p[r]] = [p[r], p[r - 1]]; save(); renderPriority(); } }, "↑") : null,
        el("button", { type: "button", class: "chip-x", title: "Remove", onclick: () => { S.priority.splice(r, 1); save(); renderPriority(); } }, "×")));
    });
    if (S.priority.length < MAX_PRIORITY && keys.length) {
      const host = el("div", { style: "min-width:220px;flex:1" });
      box.append(host);
      picker(host, {
        items: keys.filter((k) => !S.priority.includes(k)).map((k) => ({ id: k, label: E.attrLabel(k, D), icon: attrIcon(k) })).sort((a, b) => a.label.localeCompare(b.label)),
        value: null, placeholder: S.priority.length ? "Add next priority…" : "Prioritize attribute…",
        onChange: (k) => { S.priority.push(k); save(); renderPriority(); },
      });
    }
    const unit = S.scoreMode === "totals" ? "weighted deck totals" : "card multipliers (scaler × efficiency × greed), weighted per attribute";
    $("#priority-note").textContent = S.priority.length
      ? `Priorities are maximized strictly in order, then ${unit}.`
      : `The optimizer maximizes ${unit}.`;
    $("#score-mode").value = S.scoreMode === "totals" ? "totals" : "mult";
  }
  function renderScore() {
    const sp = spec();
    const s = lastEval ? O.score(lastEval, sp, D) : 0;
    $("#score").textContent = (sp.mode === "mult" ? "Multiplier score " : "Score ") + E.fmtNum(Math.round(s * 100) / 100);
  }

  // ------------------------------------------------------------------ optimizer
  /** Independent searches in Web Workers (one per core, max 12); the best result wins. */
  let optRun = null;
  function runOptimizer(auto, opts) {
    if (optRun) return optRun.stop();
    // Optimize + Compare: remember the current layout and its totals to compare and optionally revert
    const before = opts && opts.compare ? {
      state: JSON.parse(JSON.stringify({ placement: S.placement, cards: S.cards, cores: S.cores, implicits: S.implicits })),
      totals: JSON.parse(JSON.stringify(lastEval ? lastEval.totals : {})),
      score: lastEval ? O.score(lastEval, spec(), D) : 0,
    } : null;
    if (!auto && !S.cards.length) return flash("Add cards to the collection first.");
    const btn = auto ? auto.button : $(before ? "#btn-opt-compare" : "#btn-opt"), bar = $("#opt-progress"), out = $("#opt-result");
    const btnText = btn.textContent;
    const budgetMs = Math.max(1, +$("#opt-time").value || 10) * 1000;
    const sp = auto ? auto.spec : spec();
    const slots = ctx.layout.slots;
    const initial = auto ? auto.initial : slots.map((s) => S.placement[s.k] || null);
    const locked = auto ? auto.locked : S.locked.map((k) => ctx.layout.index.get(k)).filter((i) => i !== undefined);
    const templates = auto ? auto.templates : [];
    const deckSig = () => JSON.stringify([S.deckId, S.layoutEdits, S.cores, S.implicits, S.locked, S.cards.map((c) => c.uid)]);
    const sigAtStart = deckSig();
    const deckState = { deckId: S.deckId, layoutEdits: S.layoutEdits, implicits: S.implicits, cores: S.cores };
    const n = Math.max(1, Math.min(12, (navigator.hardwareConcurrency || 4) - 1));
    const results = new Array(n).fill(null), finals = [];
    let workers = [];
    const t0 = Date.now();
    const finish = () => {
      clearInterval(timer);
      workers.forEach((w) => w.terminate());
      optRun = null;
      btn.textContent = btnText;
      document.querySelectorAll("#btn-opt, #btn-opt-compare, #btn-auto-create, #btn-auto-finish, #btn-auto-collection").forEach((b) => (b.disabled = false));
      bar.style.width = "0";
      const got = results.filter(Boolean);
      if (!got.length) { out.textContent = "Search stopped before a result."; return; }
      if (deckSig() !== sigAtStart) {
        out.textContent = "The deck, cores, implicits or collection changed while the search was running, so its result was not applied. Run it again.";
        return;
      }
      got.sort((a, b) => O.compare(b.tuple, a.tuple));
      const best = got[0];
      const agree = got.filter((r) => O.compare(r.tuple, best.tuple) === 0).length;
      const evals = finals.reduce((a, r) => a + (r.evals || 0), 0);
      if (best.state) {
        S.cores = (best.state.cores || []).map((c) => ({ id: c.id, variant: c.variant || "base", value: c.value, slots: [], ...(c.owned ? { owned: c.owned } : {}) }));
        if (best.state.implicits) S.implicits = best.state.implicits.slice(0, 2);
        rebuild();
      }
      // cards the search created from candidates join the collection, marked as planned
      const have = new Set(S.cards.map((c) => c.uid));
      (best.cards || []).forEach((c) => { if (c && !have.has(c.uid)) { S.cards.push(Object.assign({}, c, { planned: true })); have.add(c.uid); } });
      S.placement = {};
      best.uids.forEach((u, i) => { if (u) S.placement[slots[i].k] = u; });
      if (auto && !auto.keepPlanned) { // drop planned cards the new build does not use
        const used = new Set(Object.values(S.placement));
        S.cards = S.cards.filter((c) => !c.planned || used.has(c.uid));
      }
      refreshAll();
      const goalLine = auto && sp.goals ? sp.goals.map((g) => { const v = lastEval.totals[g.key]; return `${E.attrLabel(g.key, D)} ${v == null ? "0" : E.formatValue(g.key, v, D)}${sp.caps && sp.caps[g.key] != null ? ` (cap ${sp.caps[g.key]}%)` : ""}`; }).join(" · ") : "";
      const coreLine = best.state ? " · Cores: " + S.cores.map((c) => (E.coreVariant(D.cores[c.id], c.variant) || {}).name || D.cores[c.id].name).join(", ") +
        (best.state.implicits && S.deckId === "mystery" ? " · Implicits: " + S.implicits.filter(Boolean).map((c) => D.cores[c.id].name).join(", ") : "") : "";
      out.textContent = (goalLine ? goalLine + coreLine + " — " : "") + `${agree} of ${got.length} independent searches found this result` +
        (finals.length < n ? " (stopped early)" : "") + (evals ? ` · ${(evals / 1e6).toFixed(2)}M layouts evaluated` : "") +
        (finals.length < n ? "" : agree === got.length && got.length > 1 ? " · very likely the best layout" : agree <= got.length / 2 ? " · results differ: search longer for a better one" : "");
      if (before) showCompare(before);
    };
    const timer = setInterval(() => {
      const f = Math.min(1, (Date.now() - t0) / budgetMs);
      bar.style.width = (f * 100).toFixed(1) + "%";
      $("#score").textContent = "Optimizing " + Math.round(f * 100) + "%";
    }, 200);
    btn.textContent = "Stop";
    document.querySelectorAll("#btn-opt, #btn-opt-compare, #btn-auto-create, #btn-auto-finish, #btn-auto-collection").forEach((b) => (b.disabled = b !== btn));
    out.textContent = auto ? `${auto.label}: ${templates.length ? templates.length + " candidate cards" : (auto.cards || S.cards).length + " of your cards"}, ${n} independent searches…` : `Running ${n} independent searches…`;
    optRun = { stop: finish };
    try {
      workers = results.map((_, wi) => {
        const w = new Worker("js/optworker.js");
        w.onmessage = (ev) => {
          const m = ev.data;
          results[wi] = { uids: m.uids, cards: m.cards, tuple: m.tuple, state: m.state };
          if (m.type === "done") { finals.push(m); if (finals.length === n) finish(); }
        };
        w.onerror = () => { finals.push({}); if (finals.length === n) finish(); };
        w.postMessage({ type: "data", data: D });
        const coreOpts = auto && auto.cores ? { chooseCores: true, sockets: auto.cores.sockets, chooseImplicits: auto.cores.chooseImplicits, randomStart: wi > 0, coreList: auto.cores.list } : {};
        w.postMessage({ type: "run", deckState, cards: auto && auto.cards ? auto.cards : S.cards, initial, locked, spec: sp, budgetMs, templates, ...coreOpts });
        return w;
      });
    } catch (err) {
      // no worker support (e.g. file://): one search on the main thread
      workers = [];
      const byUid = resolved;
      const res = O.search({ ctx, cards: [...resolved.values()], initial: initial.map((u) => (u ? byUid.get(u) : null)), locked: new Set(locked), spec: sp, budgetMs: Math.min(budgetMs, 4000), templates: templates.map((c) => E.resolveCard(c, D)) });
      results.length = 1; results[0] = { uids: res.place.map((c) => (c ? c.uid : null)), cards: res.place.map((c) => (c ? c.card : null)), tuple: res.tuple };
      finals.push(res);
      finish();
    }
  }

  // ------------------------------------------------------------------ compare (Optimize + Compare)
  let cmpBefore = null;
  function showCompare(before) {
    cmpBefore = before;
    const after = lastEval.totals;
    const sp = spec();
    const scoreAfter = O.score(lastEval, sp, D);
    const moved = ctx.layout.slots.filter((sl) => (before.state.placement[sl.k] || null) !== (S.placement[sl.k] || null)).length;
    const fmt = (k, v) => (v == null ? "—" : fmtOut({ k, v: typeof v === "object" ? v.time : v, count: v && v.count }));
    const num = (k, v) => (v == null ? 0 : typeof v === "object" ? v.time / 20 : E.displayValue(k, v, D));
    const keys = [...new Set([...Object.keys(before.totals), ...Object.keys(after)])]
      .sort((a, b) => E.attrLabel(a, D).localeCompare(E.attrLabel(b, D)));
    const t = $("#cmp-table");
    t.innerHTML = "";
    t.append(el("tr", {}, el("th", {}, "Attribute"), el("th", { style: "text-align:right" }, "Before"), el("th", { style: "text-align:right" }, "After"), el("th", { style: "text-align:right" }, "Change")));
    for (const k of keys) {
      const b = before.totals[k], a = after[k];
      const d = num(k, a) - num(k, b);
      const pct = E.isPercent(k, D) ? "%" : k.startsWith("vmod:") ? "s" : "";
      const icon = attrIcon(k);
      t.append(el("tr", {},
        el("td", {}, el("div", { class: "attr" }, icon ? el("img", { class: "px attr-ico", src: icon, alt: "" }) : el("span", { class: "attr-ico" }), E.attrLabel(k, D))),
        el("td", { class: "num" }, fmt(k, b)),
        el("td", { class: "num" }, fmt(k, a)),
        el("td", { class: "num " + (Math.abs(d) < 1e-9 ? "" : d > 0 ? "delta-pos" : "delta-neg") }, Math.abs(d) < 1e-9 ? "±0" : (d > 0 ? "+" : "") + E.fmtNum(Math.round(d * 1000) / 1000) + pct)));
    }
    const ds = scoreAfter - before.score;
    $("#cmp-summary").innerHTML = "";
    $("#cmp-summary").append(
      `${sp.mode === "mult" ? "Multiplier score" : "Score"}: ${E.fmtNum(Math.round(before.score * 100) / 100)} → ${E.fmtNum(Math.round(scoreAfter * 100) / 100)} `,
      el("span", { class: ds > 1e-9 ? "delta-pos" : ds < -1e-9 ? "delta-neg" : "" }, `(${ds >= 0 ? "+" : ""}${E.fmtNum(Math.round(ds * 100) / 100)})`),
      ` · ${moved} of ${ctx.layout.slots.length} slots changed.`);
    $("#compare-dialog").showModal();
  }
  function revertCompare() {
    if (!cmpBefore) return;
    Object.assign(S, JSON.parse(JSON.stringify(cmpBefore.state)));
    cmpBefore = null;
    $("#compare-dialog").close();
    $("#opt-result").textContent = "Reverted to the previous layout.";
    refreshAll();
  }

  // ------------------------------------------------------------------ compare decks page
  /** Evaluate a deck state (current or saved): context, resolved placement, totals and score. */
  function evalDeckState(st) {
    const s2 = sanitize(JSON.parse(JSON.stringify(st)));
    if (s2.implicits == null) s2.implicits = implicitDefaults(s2.deckId);
    const c2 = E.createContext(s2, D);
    const by = new Map(s2.cards.map((c) => [c.uid, E.resolveCard(c, D)]));
    const place = c2.layout.slots.map((sl) => {
      const rc = by.get(s2.placement[sl.k]);
      return rc && E.canPlace(rc, sl, c2) ? rc : null;
    });
    const res = E.evaluate(c2, place);
    return { st: s2, ctx: c2, place, res, score: O.score(res, spec(), D) };
  }
  function deckChoices() {
    const list = [{ id: "current", label: "Current deck" + (S.savedName ? ` (${S.savedName})` : ""), state: S }];
    for (const d of readSaves().sort((a, b) => b.savedAt - a.savedAt)) list.push({ id: d.id, label: d.name, state: d.state, saved: d });
    return list;
  }
  /** Icon for an attribute key: from the decks shown, else any obtainable card that gives it. */
  function keyIcon(k, decks) {
    for (const dk of decks) for (const rc of dk.place) {
      const e = rc && rc.entries.find((x) => entryKey(x.src) === k);
      if (e) return e.cfg.icon || frameIcon(e.src.mod, e.cfg);
    }
    for (const id of Object.keys(D.obtainable || {})) {
      const cfg = D.cards[id];
      if (cfg && window.AutoBuild.outputKey(cfg, E) === k && cfg.icon) return cfg.icon;
    }
    return null;
  }
  function miniGrid(dk) {
    const rows = (dk.ctx.deck && dk.ctx.deck.layout[0].value) || [];
    const L = dk.ctx.layout;
    const w = Math.max(...rows.map((r) => r.length), L.maxX + 1, 1), h = Math.max(rows.length, L.maxY + 1, 1);
    const grid = el("div", { class: "deck-grid" });
    grid.style.gridTemplateColumns = `repeat(${w}, var(--slot))`;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = L.index.get(E.key(x, y));
      if (i === undefined) { grid.append(el("div", { class: "slot none" })); continue; }
      const rc = dk.place[i];
      grid.append(el("div", {
        class: "slot" + (L.slots[i].arcane ? " arcane" : ""),
        onmouseenter: rc ? (ev) => showTip(ev, cardTipBase(rc)) : null, onmousemove: rc ? moveTip : null, onmouseleave: rc ? hideTip : null,
      }, rc ? cardImg(rc) : null));
    }
    return el("div", { class: "mini" }, grid);
  }
  function renderSide(host, choice, dk) {
    host.innerHTML = "";
    const deck = D.decks[dk.st.deckId];
    const coreName = (c) => { const cfg = D.cores[c.id]; const vc = cfg && E.coreVariant(cfg, c.variant); return (vc && vc.name) || (cfg && cfg.name) || c.id; };
    const placed = dk.place.filter(Boolean).length;
    add(host, 
      el("div", { class: "title" }, deck && deck.icon ? el("img", { class: "px", src: deck.icon, alt: "" }) : null,
        el("span", {}, choice.label), el("span", { class: "score" }, `${spec().mode === "mult" ? "Multiplier score" : "Score"} ${E.fmtNum(Math.round(dk.score * 100) / 100)}`)),
      el("div", { class: "note" }, `${deck ? deck.name : dk.st.deckId} · ${placed}/${dk.ctx.layout.slots.length} slots filled`),
      el("div", { class: "note" }, "Cores: " + ((dk.st.cores || []).map(coreName).join(", ") || "none")),
      (dk.st.implicits || []).filter(Boolean).length ? el("div", { class: "note" }, "Implicits: " + dk.st.implicits.filter(Boolean).map((c) => (D.cores[c.id] || {}).name || c.id).join(", ")) : null,
      miniGrid(dk),
      choice.saved ? el("button", { class: "btn sm", type: "button", style: "align-self:flex-start", onclick: () => { $("#decks-dialog").close(); loadSavedDeck(choice.saved.id); } }, "Load this deck") : null);
  }
  function renderDeckCompare() {
    const choices = deckChoices();
    const pick = (sel) => choices.find((c) => c.id === sel.value) || choices[0];
    const A = pick($("#cmp-a")), B = pick($("#cmp-b"));
    const da = evalDeckState(A.state), db = evalDeckState(B.state);
    renderSide($("#cmp-side-a"), A, da);
    renderSide($("#cmp-side-b"), B, db);
    const t = $("#cmp-decks-table");
    t.innerHTML = "";
    t.append(el("tr", {}, el("th", {}, "Attribute"), el("th", { style: "text-align:right" }, "Deck A"), el("th", { style: "text-align:right" }, "Deck B"), el("th", { style: "text-align:right" }, "B − A")));
    const num = (k, v) => (v == null ? 0 : typeof v === "object" ? v.time / 20 : E.displayValue(k, v, D));
    const fmt = (k, v) => (v == null ? "—" : fmtOut({ k, v: typeof v === "object" ? v.time : v, count: v && v.count }));
    const keys = [...new Set([...Object.keys(da.res.totals), ...Object.keys(db.res.totals)])]
      .sort((a, b) => E.attrLabel(a, D).localeCompare(E.attrLabel(b, D)));
    if (!keys.length) t.append(el("tr", {}, el("td", { colspan: 4, class: "note" }, "Neither deck has any stats yet.")));
    for (const k of keys) {
      const a = da.res.totals[k], b = db.res.totals[k], d = num(k, b) - num(k, a);
      const unit = E.isPercent(k, D) ? "%" : k.startsWith("vmod:") ? "s" : "";
      const icon = keyIcon(k, [da, db]);
      t.append(el("tr", {},
        el("td", {}, el("div", { class: "attr" }, icon ? el("img", { class: "px attr-ico", src: icon, alt: "" }) : el("span", { class: "attr-ico" }), E.attrLabel(k, D))),
        el("td", { class: "a" }, fmt(k, a)), el("td", { class: "b" }, fmt(k, b)),
        el("td", { class: "num " + (Math.abs(d) < 1e-9 ? "" : d > 0 ? "delta-pos" : "delta-neg") }, Math.abs(d) < 1e-9 ? "±0" : (d > 0 ? "+" : "") + E.fmtNum(Math.round(d * 1000) / 1000) + unit)));
    }
    const ds = db.score - da.score;
    t.append(el("tr", { class: "sum" }, el("td", {}, spec().mode === "mult" ? "Multiplier score" : "Score"),
      el("td", { class: "a" }, E.fmtNum(Math.round(da.score * 100) / 100)), el("td", { class: "b" }, E.fmtNum(Math.round(db.score * 100) / 100)),
      el("td", { class: "num " + (Math.abs(ds) < 1e-9 ? "" : ds > 0 ? "delta-pos" : "delta-neg") }, (ds >= 0 ? "+" : "") + E.fmtNum(Math.round(ds * 100) / 100))));
  }
  function openDeckCompare() {
    const choices = deckChoices();
    for (const [sel, def] of [[$("#cmp-a"), 0], [$("#cmp-b"), Math.min(1, choices.length - 1)]]) {
      const prev = sel.value;
      sel.innerHTML = "";
      choices.forEach((c, i) => sel.append(el("option", { value: c.id, selected: prev ? c.id === prev : i === def }, c.label)));
      if (!choices.some((c) => c.id === sel.value)) sel.selectedIndex = def;
    }
    renderDeckCompare();
    $("#decks-dialog").showModal();
  }

  // ------------------------------------------------------------------ custom auto build dialog
  let cuDraft = null;
  /** Every effect obtainable cards can give: key -> { key, label, icon, types:Set }. */
  function customEffects() {
    const AB = window.AutoBuild, out = new Map();
    for (const id of Object.keys(D.obtainable || {})) {
      const cfg = D.cards[id];
      const k = cfg && AB.outputKey(cfg, E);
      if (!k) continue;
      const ty = AB.cardType(cfg);
      if (!out.has(k)) out.set(k, { key: k, label: E.attrLabel(k, D), icon: cfg.icon || frameIcon(id, cfg), types: new Set() });
      out.get(k).types.add(ty);
    }
    return out;
  }
  function openCustomDialog() {
    const cu = S.customAuto || { types: window.AutoBuild.CARD_TYPES.slice(), keys: [] };
    cuDraft = { types: cu.types.slice(), keys: cu.keys.slice() };
    $("#cu-search").value = "";
    $("#cu-msg").textContent = "";
    renderCustomTypes();
    renderCustomEffects();
    $("#custom-dialog").showModal();
  }
  function renderCustomTypes() {
    const box = $("#cu-types");
    box.innerHTML = "";
    for (const ty of window.AutoBuild.CARD_TYPES) {
      box.append(el("label", {}, el("input", {
        type: "checkbox", checked: cuDraft.types.includes(ty),
        onchange: (e) => {
          cuDraft.types = window.AutoBuild.CARD_TYPES.filter((x) => (x === ty ? e.target.checked : cuDraft.types.includes(x)));
          renderCustomEffects();
        },
      }), D.gui["group" + ty] ? el("img", { class: "px", src: D.gui["group" + ty], alt: "", style: "width:14px;height:14px" }) : null, ty));
    }
  }
  function renderCustomEffects() {
    const box = $("#cu-effects");
    box.innerHTML = "";
    const all = customEffects();
    const q = $("#cu-search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const ty of window.AutoBuild.CARD_TYPES) {
      if (!cuDraft.types.includes(ty) || ty === "Greed") continue; // Greed cards boost others, they have no effect of their own
      const list = [...all.values()].filter((e) => e.types.has(ty) && q.every((w) => e.label.toLowerCase().includes(w)))
        .sort((a, b) => a.label.localeCompare(b.label));
      if (!list.length) continue;
      box.append(el("div", { class: "cu-type" }, D.gui["group" + ty] ? el("img", { class: "px", src: D.gui["group" + ty], alt: "" }) : null, ty + " Cards"));
      for (const e of list) {
        shown++;
        box.append(el("label", { class: "cu-effect" },
          el("input", { type: "checkbox", checked: cuDraft.keys.includes(e.key), onchange: (ev) => {
            cuDraft.keys = ev.target.checked ? [...new Set([...cuDraft.keys, e.key])] : cuDraft.keys.filter((k) => k !== e.key);
            renderCustomEffects();
          } }),
          e.icon ? el("img", { class: "px", src: e.icon, alt: "" }) : el("span", { style: "width:22px" }),
          e.label,
          el("span", { class: "sub" }, [...e.types].join(" · "))));
      }
    }
    if (!shown) box.append(el("div", { class: "note", style: "padding:8px" }, cuDraft.types.length ? "No card effects match." : "Tick at least one card type."));
    $("#cu-count").textContent = cuDraft.keys.length ? `(${cuDraft.keys.length} selected)` : "";
  }
  function saveCustomDialog() {
    if (!cuDraft.types.length) { $("#cu-msg").textContent = "Tick at least one card type."; return; }
    if (!cuDraft.keys.length) { $("#cu-msg").textContent = "Select at least one card effect."; return; }
    const all = customEffects();
    const lost = cuDraft.keys.filter((k) => ![...(all.get(k) || { types: new Set() }).types].some((t) => cuDraft.types.includes(t)));
    if (lost.length) { $("#cu-msg").textContent = "No ticked card type gives: " + lost.map((k) => E.attrLabel(k, D)).join(", ") + "."; return; }
    S.customAuto = { types: cuDraft.types.slice(), keys: cuDraft.keys.slice() };
    save();
    $("#custom-dialog").close();
    window.__renderAutoCustom();
  }

  // ------------------------------------------------------------------ banned cards (auto build)
  const banned = () => new Set(S.autoBanned || []);
  /** Cards that can be banned: every obtainable card plus any card in your collection. */
  function banChoices() {
    const ids = new Set(Object.keys(D.obtainable || {}));
    for (const c of S.cards) for (const e of c.entries) ids.add(e.mod);
    return [...ids].filter((id) => D.cards[id]).map((id) => {
      const cfg = D.cards[id];
      return { id, cfg, label: (cfg.name && cfg.name.text) || id, type: window.AutoBuild.cardType(cfg), icon: cfg.icon || frameIcon(id, cfg) };
    });
  }
  function renderBanList() {
    const box = $("#ban-list");
    box.innerHTML = "";
    const ban = banned();
    const q = $("#ban-search").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = banChoices().filter((c) => q.every((w) => c.label.toLowerCase().includes(w)));
    for (const ty of window.AutoBuild.CARD_TYPES) {
      const list = all.filter((c) => c.type === ty).sort((a, b) => a.label.localeCompare(b.label));
      if (!list.length) continue;
      add(box, el("div", { class: "cu-type" }, D.gui["group" + ty] ? el("img", { class: "px", src: D.gui["group" + ty], alt: "" }) : null, ty + " Cards"));
      for (const c of list) {
        add(box, el("label", { class: "cu-effect" },
          el("input", { type: "checkbox", checked: ban.has(c.id), onchange: (ev) => {
            const b = banned();
            if (ev.target.checked) b.add(c.id); else b.delete(c.id);
            S.autoBanned = [...b]; save(); renderBanSummary(); $("#ban-count").textContent = b.size ? `(${b.size} banned)` : "";
          } }),
          c.icon ? el("img", { class: "px", src: c.icon, alt: "" }) : el("span", { style: "width:22px" }),
          c.label));
      }
    }
    if (!box.childElementCount) box.append(el("div", { class: "note", style: "padding:8px" }, "No cards match."));
    $("#ban-count").textContent = ban.size ? `(${ban.size} banned)` : "";
  }
  /** Chips under the auto build options: the banned cards, each with × to unban. */
  function renderBanSummary() {
    const box = $("#auto-banned");
    box.innerHTML = "";
    const ban = [...banned()].filter((id) => D.cards[id]);
    add(box, el("button", { class: "btn sm", type: "button", onclick: openBanDialog, title: "Cards auto build never adds to the deck" }, "Banned cards…"),
      ban.length ? null : el("span", { class: "note" }, "none"),
      ban.map((id) => {
        const cfg = D.cards[id], ic = cfg.icon || frameIcon(id, cfg);
        return el("span", { class: "chip" }, ic ? el("img", { class: "px chip-ico", src: ic, alt: "" }) : null, (cfg.name && cfg.name.text) || id,
          el("button", { class: "chip-x", type: "button", title: "Unban", onclick: () => { S.autoBanned = ban.filter((x) => x !== id); save(); renderBanSummary(); } }, "×"));
      }));
  }
  function openBanDialog() {
    $("#ban-search").value = "";
    renderBanList();
    $("#ban-dialog").showModal();
  }

  // ------------------------------------------------------------------ auto build
  /** Auto-create (whole deck) or auto-finish (empty slots only) for the chosen build focus. */
  function autoBuild(mode) {
    if (optRun) return optRun.stop();
    const fid = $("#auto-focus").value;
    const f = window.AutoBuild.FOCUS[fid];
    const cu = S.customAuto;
    const keys = f.keys || (cu ? cu.keys : []);
    if (!keys.length) { if (fid === "custom") openCustomDialog(); return flash("Custom focus: choose the card effects to build for."); }
    const slots = ctx.layout.slots;
    const userLocked = new Set(S.locked.map((k) => ctx.layout.index.get(k)).filter((i) => i !== undefined));
    let initial, locked;
    if (mode === "create" || mode === "collection") {
      initial = slots.map((s, i) => (userLocked.has(i) ? S.placement[s.k] || null : null));
      locked = [...userLocked];
    } else {
      initial = slots.map((s) => S.placement[s.k] || null);
      locked = slots.map((s, i) => i).filter((i) => userLocked.has(i) || initial[i]);
      if (locked.length >= slots.length) return flash("Every slot is already filled. Use Auto-create to rebuild the deck.");
    }
    const AB = window.AutoBuild;
    // focus = all the preset's attributes (main one weighted most) or the Custom effects, balanced with survivability
    const focusKeys = keys;
    const bal = AB.BALANCE[$("#auto-balance").value] || AB.BALANCE.balanced;
    const sp = AB.balanceSpec(focusKeys, bal.focus, !!f.keys);
    // Custom: only the card types ticked (survivability candidates included only if their types are ticked)
    const types = fid === "custom" ? cu.types : null;
    const sameColor = $("#auto-samecolor").checked;
    // single-color deck: a chosen color, or the majority color of the placed cards (else of the collection)
    let oneColor = $("#auto-onecolor").value || null;
    if (oneColor === "majority") {
      const tally = (list) => { const m = {}; for (const c of list) { const col = (c.entries[0].colors || [])[0]; if (col) m[col] = (m[col] || 0) + 1; } return m; };
      const placedUids = new Set(Object.values(S.placement));
      let m = tally(S.cards.filter((c) => placedUids.has(c.uid)));
      if (!Object.keys(m).length) m = tally(S.cards.filter((c) => !c.planned));
      oneColor = Object.keys(m).sort((a, b) => m[b] - m[a])[0] || null;
      if (!oneColor) return flash("Majority color: place or import some cards first, or pick a color.");
    }
    const oneColorOk = (c) => !oneColor || c.entries.every((e) => (e.colors || []).length === 1 && e.colors[0] === oneColor);
    // same-color scaling: scaler / condition colors must be the card's own color (filters without a color are fine)
    const colorOk = (c) => !sameColor || c.entries.every((e) => AB.sameColorOk(e.colors || [],
      [...((e.scaler && e.scaler.filters) || []), ...((e.condition && e.condition.filters) || [])]));
    const anyGreed = $("#auto-anygreed").checked;
    const isGreed = (c) => (D.cards[c.entries[0].mod] || {}).type === "greed";
    // Allow any Greed card: Greed cards skip the color options (types still apply)
    const ban = banned();
    const notBanned = (c) => !c.entries.some((e) => ban.has(e.mod));
    const typeOk = (c) => notBanned(c) && (!types || types.includes(AB.cardType(D.cards[c.entries[0].mod] || {}))) && ((anyGreed && isGreed(c)) || (colorOk(c) && oneColorOk(c)));
    const fromCollection = mode === "collection";
    // Build from collection: only cards you own (not Planned ones), no candidate cards
    const own = S.cards.filter((c) => !c.planned && typeOk(c));
    if (fromCollection && !own.length) return flash(types || sameColor || oneColor || ban.size ? "None of your cards match the card type / color / banned settings." : "Your collection has no cards yet (Planned cards are not counted).");
    // banned cards are never candidates (cards in locked slots stay, they are yours to keep)
    const templates = fromCollection ? [] : AB.makeTemplates([...new Set([...focusKeys, ...AB.SURVIVAL])], D, E, ctx, types, sameColor, oneColor, anyGreed).filter(notBanned);
    const gives = (c) => keys.includes(AB.outputKey(D.cards[c.entries[0].mod], E));
    if (!fromCollection && !templates.some(gives)) {
      return flash("No allowed card gives the chosen effects. Edit the Custom selection or the banned cards.");
    }
    if (fromCollection && !own.some(gives)) {
      return flash("None of your cards give " + keys.map((k) => E.attrLabel(k, D)).join(", ") + ". Add cards or use Auto-create.");
    }
    const chooseCores = $("#auto-cores").checked;
    const names = { create: "Auto-create", finish: "Auto-finish", collection: "Build from collection" };
    runOptimizer({
      button: $({ create: "#btn-auto-create", finish: "#btn-auto-finish", collection: "#btn-auto-collection" }[mode]),
      label: names[mode] + " · " + f.label + " · " + bal.label + (oneColor ? " · only " + cap(oneColor) + " cards" : ""),
      spec: sp, initial, locked, templates,
      keepPlanned: fromCollection, // planned cards stay in the collection for later
      // Custom card types also limit which of your own cards may be used (locked / kept cards stay regardless)
      cards: fromCollection ? own.concat(S.cards.filter((c) => initial.includes(c.uid) && !own.includes(c)))
        : types || sameColor || oneColor || ban.size ? S.cards.filter((c) => typeOk(c) || initial.includes(c.uid)) : null,
      cores: chooseCores && !(fromCollection && !(S.ownedCores || []).length)
        ? { sockets: socketCount(), chooseImplicits: S.deckId === "mystery", list: fromCollection ? S.ownedCores.map((o) => ({ id: o.id, variant: o.variant, value: o.value, owned: o.uid })) : null }
        : null,
    });
  }

  // ------------------------------------------------------------------ collection import
  /** Merge a Copy Collection export: add the cards / cores you own that the site does not have yet. */
  function importCollection() {
    const msg = $("#import-msg");
    let res;
    try { res = window.DeckImport.parseCollection($("#import-text").value, D, E, uid); }
    catch (err) { msg.className = "note err"; msg.textContent = err.message; return; }
    let addedCards = 0, addedCores = 0, totalCards = 0, totalCores = 0;
    for (const { card, count } of res.cards) {
      totalCards += count;
      const have = S.cards.filter((c) => !c.planned && c.fp && c.fp === card.fp).length;
      for (let i = have; i < count; i++) { S.cards.push(Object.assign(JSON.parse(JSON.stringify(card)), { uid: uid() })); addedCards++; }
    }
    S.ownedCores = S.ownedCores || [];
    for (const { core, count, fp } of res.cores) {
      totalCores += count;
      // match by fingerprint, else an identical core added by hand or from a deck import
      const same = S.ownedCores.filter((o) => (o.fp ? o.fp === fp : o.id === core.id && o.variant === core.variant && Math.abs(+o.value - core.value) < 1e-6));
      same.forEach((o) => (o.fp = fp));
      for (let i = same.length; i < count; i++) { S.ownedCores.push({ uid: uid(), ...core, fp }); addedCores++; }
    }
    refreshAll();
    $("#import-text").value = "";
    $("#import-dialog").close();
    setCollectionTab(addedCores && !addedCards ? "cores" : "cards");
    $("#opt-result").textContent = `Collection import: ${totalCards} cards and ${totalCores} cores read; ${addedCards} new cards and ${addedCores} new cores added (cards already in your collection are kept).` +
      (res.warnings.length ? " " + res.warnings.slice(0, 3).join(" ") : "");
  }
  function openImport(kind) {
    $("#import-title").textContent = kind === "collection" ? "Import collection from game" : "Import deck from game";
    $("#import-msg").textContent = ""; $("#import-msg").className = "note";
    $("#import-dialog").showModal(); $("#import-text").focus();
  }

  // ------------------------------------------------------------------ saved decks
  function saveMsg(text, ok) {
    const m = $("#save-msg");
    m.textContent = text;
    m.style.color = ok ? "var(--good)" : text ? "var(--bad)" : "";
  }
  function saveCurrentDeck() {
    const name = $("#save-name").value.trim();
    if (!name) { saveMsg("Enter a name for the deck."); $("#save-name").focus(); return; }
    const list = readSaves();
    const same = list.find((d) => d.name.toLowerCase() === name.toLowerCase());
    if (same && same.id !== S.savedId && !confirm(`Replace the saved deck "${same.name}"?`)) return;
    const id = same ? same.id : uid();
    S.savedId = id;
    S.savedName = name;
    // the collection is shared: a saved deck keeps only the cards placed in it (and no owned cores)
    const placedUids = new Set(Object.values(S.placement));
    const snap = JSON.parse(JSON.stringify(S));
    snap.cards = snap.cards.filter((c) => placedUids.has(c.uid));
    delete snap.ownedCores;
    const entry = { id, name, savedAt: Date.now(), state: snap };
    const next = same ? list.map((d) => (d.id === id ? entry : d)) : [entry, ...list];
    if (!writeSaves(next)) { saveMsg("Could not save: browser storage is unavailable or full."); return; }
    save();
    saveMsg(`Saved "${name}".`, true);
    renderSaved();
  }
  function loadSavedDeck(id) {
    const d = readSaves().find((x) => x.id === id);
    if (!d) return;
    // keep the shared collection; add the saved deck's cards that are not in it (older saves held whole collections)
    const keepCards = S.cards, keepCores = S.ownedCores || [];
    S = sanitize(JSON.parse(JSON.stringify(d.state)));
    const have = new Set(keepCards.map((c) => c.uid));
    S.cards = keepCards.concat(S.cards.filter((c) => !have.has(c.uid)));
    const haveCores = new Set(keepCores.map((o) => o.uid));
    S.ownedCores = keepCores.concat((S.ownedCores || []).filter((o) => !haveCores.has(o.uid)));
    S.savedId = d.id; S.savedName = d.name;
    selectedSlot = null; pickingCore = null;
    $("#save-name").value = d.name;
    saveMsg(`Loaded "${d.name}".`, true);
    refreshAll();
  }
  function deleteSavedDeck(id) {
    const list = readSaves();
    const d = list.find((x) => x.id === id);
    if (!d || !confirm(`Delete the saved deck "${d.name}"?`)) return;
    writeSaves(list.filter((x) => x.id !== id));
    if (S.savedId === id) { delete S.savedId; save(); }
    saveMsg(`Deleted "${d.name}".`, true);
    renderSaved();
  }
  function newDeck() {
    if ((S.cards.length || S.cores.length) && !confirm("Start a new deck? Unsaved changes to the current deck are lost.")) return;
    const weights = S.weights, priority = S.priority, scoreMode = S.scoreMode; // scoring preferences carry over
    S = defaultState();
    Object.assign(S, { weights, priority, scoreMode });
    selectedSlot = null; pickingCore = null;
    $("#save-name").value = "";
    saveMsg("");
    refreshAll();
  }
  function renderSaved() {
    const list = readSaves().sort((a, b) => b.savedAt - a.savedAt);
    const box = $("#saved-list");
    box.innerHTML = "";
    $("#saved-count").textContent = list.length ? String(list.length) : "";
    if (!list.length) { box.append(el("div", { class: "note" }, "No saved decks yet.")); return; }
    for (const d of list) {
      const st = d.state || {};
      const deck = D.decks[st.deckId];
      const n = (st.cards || []).length, placed = Object.keys(st.placement || {}).length;
      const when = new Date(d.savedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      box.append(el("div", { class: "saved-item" + (S.savedId === d.id ? " current" : "") },
        deck && deck.icon ? el("img", { class: "px", src: deck.icon, alt: "" }) : el("span", { class: "saved-ico" }),
        el("div", { class: "saved-info" },
          el("div", { class: "saved-name" }, d.name),
          el("div", { class: "note" }, `${deck ? deck.name : st.deckId} · ${placed}/${n} cards · ${when}`)),
        el("button", { class: "btn sm", type: "button", onclick: () => loadSavedDeck(d.id) }, "Load"),
        el("button", { class: "btn sm danger", type: "button", title: "Delete", onclick: () => deleteSavedDeck(d.id) }, "×")));
    }
  }

  // ------------------------------------------------------------------ main
  /** Grid, statistics and score only (no panel re-render), e.g. while typing a core value. */
  function refreshResults() {
    rebuild();
    lastEval = E.evaluate(ctx, placeArray());
    renderGrid();
    renderStats();
    renderPriority();
    save();
  }
  function refreshAll() {
    if (S.implicits == null) S.implicits = implicitDefaults(S.deckId);
    rebuild();
    lastEval = E.evaluate(ctx, placeArray());
    renderDeckPanel();
    renderCores();
    renderGrid();
    renderCards();
    renderStats();
    renderPriority();
    renderSaved();
    renderOwnedCores();
    setCollectionTab(S.collectionTab || "cards");
    save();
  }

  function sanitize(s) {
    const d = defaultState();
    if (!s || typeof s !== "object") return d;
    const out = Object.assign(d, s);
    if (!D.decks[out.deckId]) out.deckId = "starter";
    out.cards = (out.cards || []).filter((c) => c && c.uid && Array.isArray(c.entries));
    out.cores = (out.cores || []).filter((c) => c && D.cores[c.id]);
    return out;
  }

  function bind() {
    $("#layout-edit").addEventListener("change", () => { pickingCore = null; refreshAll(); });
    $("#btn-add-card").addEventListener("click", () => openCardDialog(null));
    $("#card-search").addEventListener("input", renderCards);
    $("#only-unplaced").addEventListener("change", renderCards);
    $("#cd-add-scaler").addEventListener("click", () => {
      draft.scaler.push({ neighbor: [], color: [], group: [], tier: [] }); fitDraftToRolls();
      renderFilters($("#cd-scaler"), draft.scaler, false); updatePreview();
    });
    $("#cd-add-condition").addEventListener("click", () => {
      draft.condition.push({ neighbor: [], color: [], group: [], tier: [], min: 1, max: null }); fitDraftToRolls();
      renderFilters($("#cd-condition"), draft.condition, true); updatePreview();
    });
    $("#card-dialog").addEventListener("close", () => { if ($("#card-dialog").returnValue === "save") saveDialog(); });
    $("#tab-cards").addEventListener("click", () => setCollectionTab("cards"));
    $("#tab-cores").addEventListener("click", () => setCollectionTab("cores"));
    $("#btn-opt").addEventListener("click", () => runOptimizer());
    $("#btn-opt-compare").addEventListener("click", () => runOptimizer(null, { compare: true }));
    $("#cmp-revert").addEventListener("click", revertCompare);
    $("#btn-compare-decks").addEventListener("click", openDeckCompare);
    $("#cmp-a").addEventListener("change", renderDeckCompare);
    $("#cmp-b").addEventListener("change", renderDeckCompare);
    const af = $("#auto-focus");
    const renderAutoCustom = () => {
      const box = $("#auto-custom");
      box.hidden = af.value !== "custom";
      box.innerHTML = "";
      if (box.hidden) return;
      const cu = S.customAuto || { types: window.AutoBuild.CARD_TYPES.slice(), keys: [] };
      const effects = customEffects();
      if (!cu.keys.length) box.append(el("span", { class: "note" }, "No card effects chosen yet."));
      for (const k of cu.keys) {
        const e = effects.get(k);
        box.append(el("span", { class: "chip", title: e ? "From: " + [...e.types].join(", ") : null },
          e && e.icon ? el("img", { class: "px", src: e.icon, alt: "" }) : null, E.attrLabel(k, D)));
      }
      box.append(el("span", { class: "types", title: "Card types: " + cu.types.join(", ") },
        el("span", { class: "note" }, "Types"),
        ...cu.types.map((ty) => (D.gui["group" + ty] ? el("img", { class: "px", src: D.gui["group" + ty], alt: ty, title: ty }) : el("span", { class: "note" }, ty)))));
      box.append(el("button", { class: "btn sm", type: "button", onclick: openCustomDialog }, "Edit…"));
    };
    af.addEventListener("change", () => { renderAutoCustom(); if (af.value === "custom") openCustomDialog(); });
    $("#cu-save").addEventListener("click", saveCustomDialog);
    $("#cu-search").addEventListener("input", renderCustomEffects);
    $("#cu-clear").addEventListener("click", () => { cuDraft.keys = []; renderCustomEffects(); });
    window.__renderAutoCustom = renderAutoCustom;
    for (const [id, f] of Object.entries(window.AutoBuild.FOCUS)) af.append(el("option", { value: id }, f.label));
    for (const [id, b] of Object.entries(window.AutoBuild.BALANCE)) $("#auto-balance").append(el("option", { value: id, selected: id === "balanced" }, b.label));
    renderAutoCustom();
    $("#btn-auto-create").addEventListener("click", () => autoBuild("create"));
    $("#btn-auto-finish").addEventListener("click", () => autoBuild("finish"));
    $("#btn-auto-collection").addEventListener("click", () => autoBuild("collection"));
    $("#auto-samecolor").checked = !!S.autoSameColor;
    $("#auto-onecolor").value = S.autoOneColor || "";
    renderBanSummary();
    $("#ban-search").addEventListener("input", renderBanList);
    $("#ban-clear").addEventListener("click", () => { S.autoBanned = []; save(); renderBanList(); renderBanSummary(); });
    $("#auto-anygreed").checked = !!S.autoAnyGreed;
    $("#auto-anygreed").addEventListener("change", (e) => { S.autoAnyGreed = e.target.checked; save(); });
    $("#auto-onecolor").addEventListener("change", (e) => { S.autoOneColor = e.target.value; save(); });
    $("#auto-samecolor").addEventListener("change", (e) => { S.autoSameColor = e.target.checked; save(); });
    $("#stats-nonzero").checked = !!S.statsNonZero;
    $("#stats-nonzero").addEventListener("change", (e) => { S.statsNonZero = e.target.checked; save(); renderStats(); });
    $("#score-mode").addEventListener("change", (e) => { S.scoreMode = e.target.value; save(); renderPriority(); renderScore(); });
    $("#btn-clear").addEventListener("click", () => {
      const keep = new Set(S.locked);
      for (const k of Object.keys(S.placement)) if (!keep.has(k)) delete S.placement[k];
      refreshAll();
    });
    $("#save-form").addEventListener("submit", (e) => { e.preventDefault(); saveCurrentDeck(); });
    $("#btn-new-deck").addEventListener("click", newDeck);
    $("#btn-reset").addEventListener("click", () => {
      if (!confirm("Clear the deck, cores, collection and weights?")) return;
      S = defaultState(); selectedSlot = null; pickingCore = null; refreshAll();
    });
    $("#btn-export").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(S, null, 1)], { type: "application/json" });
      const a = el("a", { href: URL.createObjectURL(blob), download: `deck-${S.deckId}.json` });
      document.body.append(a); a.click(); a.remove();
    });
    $("#file-import").addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { S = sanitize(JSON.parse(await f.text())); refreshAll(); } catch (err) { alert("Invalid file: " + err.message); }
      e.target.value = "";
    });
    $("#btn-import-deck").addEventListener("click", () => openImport("deck"));
    $("#btn-import-coll").addEventListener("click", () => openImport("collection"));
    $("#import-go").addEventListener("click", () => {
      const msg = $("#import-msg");
      if (/^\s*WDO-COLL/.test($("#import-text").value)) return importCollection();
      try {
        const st = window.DeckImport.toState(window.DeckImport.extractDeckTag($("#import-text").value), D, E, uid);
        const keep = $("#import-keep").checked;
        S.deckId = st.deckId;
        S.layoutEdits = st.layoutEdits;
        S.implicits = st.implicits.length ? st.implicits : null;
        S.cores = st.cores;
        for (const c of S.cores) c.owned = addOwnedCore(c); // imported cores are owned
        S.cards = keep ? S.cards.concat(st.cards) : st.cards;
        S.placement = st.placement;
        S.locked = [];
        S.sockets = st.sockets;
        selectedSlot = null; pickingCore = null;
        refreshAll();
        $("#import-text").value = "";
        $("#import-dialog").close();
        if (st.warnings.length) alert(`Imported ${st.cards.length} cards with warnings:\n\n` + st.warnings.join("\n"));
      } catch (err) {
        msg.className = "note err";
        msg.textContent = err.message;
      }
    });
    $("#btn-plan").addEventListener("click", async () => {
      if (!S.cards.some((c) => c.fp)) return flash("Import the deck from the game first (Import deck).");
      const plan = window.DeckImport.buildPlan(S.cards, S.placement, (c) => cardName(c.entries[0].mod));
      try { await navigator.clipboard.writeText(plan.text); }
      catch (err) { prompt("Copy this layout:", plan.text); }
      const extra = plan.manual ? ` ${plan.manual} placed ${plan.manual === 1 ? "card was" : "cards were"} added on the site, not imported; place ${plan.manual === 1 ? "it" : "them"} by hand.` : "";
      flash(`Layout copied. In game, open the deck and click Apply Layout.${extra}`, true);
    });
    $("#btn-share").addEventListener("click", async () => {
      const url = location.href.split("#")[0] + "#s=" + await encodeShare(S);
      try { await navigator.clipboard.writeText(url); $("#btn-share").textContent = "Link copied"; }
      catch (err) { prompt("Copy this link:", url); }
      history.replaceState(null, "", url);
      setTimeout(() => ($("#btn-share").textContent = "Copy share link"), 1500);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Delete" && selectedSlot && S.placement[selectedSlot] && !e.target.closest("input,select,dialog")) { delete S.placement[selectedSlot]; refreshAll(); }
    });
  }

  async function init() {
    try {
      D = await (await fetch("data/game-data.json")).json();
    } catch (e) {
      document.body.prepend(el("div", { style: "padding:12px;background:#4a1d1d" }, "Failed to load data/game-data.json. Serve this folder over HTTP (GitHub Pages or a local server)."));
      return;
    }
    const root = document.documentElement.style;
    for (const [v, k] of [["--tex-deck", "deckBackground"], ["--tex-slot", "slot"], ["--tex-arcane", "arcaneSlot"], ["--tex-modified", "slotModified"]]) {
      if (D.gui[k]) root.setProperty(v, `url("${new URL(D.gui[k], location.href).href}")`); // absolute: url() in a var resolves against the stylesheet
    }
    $("#ver").textContent = `Vault Hunters ${D.meta.vaultHunters} · Wold's Vaults ${D.meta.woldsVaults}`;
    let s = null;
    const m = location.hash.match(/#s=([\w-]+)/);
    if (m) { try { s = await decodeShare(m[1]); } catch (e) { s = null; } }
    S = sanitize(s || loadLocal());
    bind();
    $("#save-name").value = S.savedName || "";
    refreshAll();
  }
  init();
})();
