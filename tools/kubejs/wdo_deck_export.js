// Wold's Vault Deck Optimizer - card deck screen buttons and Copy Collection (KubeJS 1802, Minecraft 1.18.2, Forge 40)
//
// Copy for Optimizer: copies the deck's item data (SNBT) to the clipboard for the site's Import Deck box.
//                     Also written to logs/kubejs/startup.txt.
// Apply Layout:       reads a "WDO-PLAN" layout from the clipboard (site: Copy layout for game) and
//                     rearranges the cards with normal inventory clicks. Cards the plan leaves out of the
//                     deck are moved to your inventory.
//
// Client-side only: works on any server, no op rights needed, nothing required server-side.
// Install: copy this file to <instance>/minecraft/kubejs/startup_scripts/ and restart the game.
//
// Note: no try/catch on purpose. Rhino 1802.2.1 crashes the game (IllegalArgumentException:
// fileName) when a JS catch block receives a Java exception, so every call is guarded instead.

const WDO_Minecraft = java('net.minecraft.client.Minecraft')
const WDO_Button = java('net.minecraft.client.gui.components.Button')
const WDO_Text = java('net.minecraft.network.chat.TextComponent')
const WDO_ClickType = java('net.minecraft.world.inventory.ClickType')
const WDO_ItemStack = java('net.minecraft.world.item.ItemStack')
const WDO_W = 110, WDO_H = 20

function wdoIsDeckScreen(screen) {
  if (screen == null || typeof screen.getMenu !== 'function') return false
  const menu = screen.getMenu()
  return menu != null && typeof menu.getDeckStack === 'function'
}

function wdoSay(msg) {
  const p = WDO_Minecraft.getInstance().player
  if (p != null) p.displayClientMessage(new WDO_Text(msg), true)
}

/** FNV-1a over UTF-16 code units; same code as js/deckimport.js on the site. */
function wdoHash(str) {
  var h = 0x811c9dc5
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0
  }
  return ('0000000' + h.toString(16)).slice(-8)
}

function wdoDeckText(screen) {
  const mc = WDO_Minecraft.getInstance()
  const stack = screen.getMenu().getDeckStack(mc.player)
  const tag = stack == null || stack.isEmpty() ? null : stack.getTag()
  return tag == null ? null : String(tag.toString())
}

function wdoExport(screen, button) {
  const text = wdoDeckText(screen)
  if (text == null) { wdoSay('Deck Export: no deck data found'); return }
  console.info('WDO-DECK ' + text)
  WDO_Minecraft.getInstance().keyboardHandler.setClipboard('WDO-DECK ' + text)
  wdoSay('Deck copied to clipboard')
  button.setMessage(new WDO_Text('Copied'))
}

function wdoApply(screen, button) {
  const mc = WDO_Minecraft.getInstance()
  const player = mc.player
  const menu = screen.getMenu()
  if (wdoQueue != null) return
  if (!menu.getCarried().isEmpty()) { wdoSay('Apply Layout: put down the item on your cursor first'); return }

  const clip = String(mc.keyboardHandler.getClipboard()).trim()
  const plan = clip.split(' ')
  if (plan[0] !== 'WDO-PLAN' || plan[1] !== '3') {
    wdoSay(clip.indexOf('WDO-DECK') === 0
      ? 'Apply Layout: the clipboard holds the deck export, not a layout. On the site, click Copy layout for game again.'
      : 'Apply Layout: no layout on the clipboard. On the site, click Copy layout for game.')
    return
  }

  // position "x,y" -> menu slot index
  const posOf = {}
  const mapping = menu.getContainer().getSlotMapping()
  const byContainer = {}
  const it = mapping.entrySet().iterator()
  while (it.hasNext()) {
    var ent = it.next()
    var cp = ent.getValue()
    byContainer[Number(ent.getKey())] = cp.x + ',' + cp.y
  }
  const slots = menu.getCardSlots()
  for (var i = 0; i < slots.size(); i++) {
    var sl = slots.get(i)
    var sk = byContainer[Number(sl.getContainerSlot())]
    if (sk != null) posOf[sk] = Number(sl.index)
  }
  // keys: deck "x,y" or inventory "inv:<menu slot index>"
  const slotOf = k => k.indexOf('inv:') === 0 ? Number(k.slice(4)) : posOf[k]

  // Card identity: hash of the card item's "data" tag, the same text as the card in the deck export.
  const fpOf = st => {
    if (st.isEmpty() || st.getTag() == null || st.getTag().get('data') == null) return null
    return wdoHash(String(st.getTag().get('data').toString()))
  }
  const deckFp = {}, deckHas = {}
  for (var pk in posOf) {
    var dst0 = menu.getSlot(posOf[pk]).getItem()
    deckHas[pk] = !dst0.isEmpty()
    deckFp[pk] = fpOf(dst0)
  }
  const inv = []
  const ps = menu.getPlayerSlots()
  for (var j = 0; j < ps.size(); j++) {
    var f = fpOf(ps.get(j).getItem())
    if (f != null) inv.push({ k: 'inv:' + Number(ps.get(j).index), fp: f })
  }

  const targets = (plan[2] || '').split(';').filter(t => t.indexOf('=') > 0).map(t => {
    var eq = t.indexOf('='), tl = t.indexOf('~')
    return { pos: t.slice(0, eq), fp: t.slice(eq + 1, tl > 0 ? tl : t.length), name: tl > 0 ? decodeURIComponent(t.slice(tl + 1)) : '?' }
  })
  for (var a = 0; a < targets.length; a++) {
    if (posOf[targets[a].pos] == null) { wdoSay('Apply Layout: the layout does not fit this deck (slot ' + targets[a].pos + ')'); return }
  }
  // match each target to a card: the one already there, else one elsewhere in the deck, else the inventory
  const used = {}, src = {}, missing = []
  for (var t1 = 0; t1 < targets.length; t1++) {
    var tg = targets[t1]
    if (deckFp[tg.pos] === tg.fp) { src[tg.pos] = tg.pos; used[tg.pos] = true }
  }
  for (var t2 = 0; t2 < targets.length; t2++) {
    var tt = targets[t2]
    if (src[tt.pos] != null) continue
    var pick = null
    for (var dk in posOf) if (!used[dk] && deckFp[dk] === tt.fp) { pick = dk; break }
    if (pick == null) for (var v = 0; v < inv.length; v++) if (!used[inv[v].k] && inv[v].fp === tt.fp) { pick = inv[v].k; break }
    if (pick == null) { missing.push(tt.name); continue }
    used[pick] = true
    src[tt.pos] = pick
  }
  const moves = []
  for (var rk in posOf) if (deckHas[rk] && !used[rk]) moves.push([rk, '-'])
  for (var tk in src) moves.push([src[tk], tk])

  // Build the click list. Removals use shift-click (QUICK_MOVE). Rearranging follows chains:
  // pick up a card, click its target (the card there comes onto the cursor), click that card's
  // target, ... until a click lands on an empty slot. About one click per moved card.
  const clicks = []
  let removed = 0, moved = 0
  for (var b = 0; b < moves.length; b++) {
    if (moves[b][1] !== '-') continue
    clicks.push({ slot: slotOf(moves[b][0]), type: WDO_ClickType.QUICK_MOVE, emptySlot: true, k: moves[b][0] })
    removed++
  }
  const cur = {}, at = {}, tgt = {}
  for (var c = 0; c < moves.length; c++) {
    if (moves[c][1] === '-') continue
    cur[moves[c][0]] = moves[c][0]
    at[moves[c][0]] = moves[c][0]
    tgt[moves[c][0]] = moves[c][1]
  }
  for (var d = 0; d < moves.length; d++) {
    var card = moves[d][0]
    if (moves[d][1] === '-' || cur[card] === tgt[card]) continue
    clicks.push({ slot: slotOf(cur[card]), type: WDO_ClickType.PICKUP, carry: true, k: cur[card] })
    at[cur[card]] = null
    var carried = card
    while (carried != null) {
      var dst = tgt[carried]
      var next = at[dst]
      at[dst] = carried
      cur[carried] = dst
      moved++
      carried = next == null ? null : next
      clicks.push({ slot: slotOf(dst), type: WDO_ClickType.PICKUP, carry: carried != null, k: dst })
    }
  }
  const missingMsg = missing.length ? '. Not found in deck or inventory: ' + missing.join(', ') : ''
  if (!clicks.length) { wdoSay('Apply Layout: the deck already matches the layout' + missingMsg); return }
  const deckSlots = []
  for (var pk in posOf) deckSlots.push(posOf[pk])
  wdoQueue = {
    screen: screen, menu: menu, clicks: clicks, i: 0, removed: removed, moved: moved, button: button,
    deckSlots: deckSlots, missingMsg: missingMsg, waiting: false, sid: 0, waited: 0, last: null, recover: null,
  }
  button.setMessage(new WDO_Text('Applying...'))
}

// One click at a time: after each click the script waits until the server has answered (the menu's
// state id changes), then checks the result against the server's state before the next click.
// Sending clicks faster than the server answers lets server resyncs overwrite the client's view.
const WDO_ACK_TIMEOUT = 20 // ticks; a click that changes nothing gets no answer
let wdoQueue = null

function wdoClick(q, slot, type) {
  const mc = WDO_Minecraft.getInstance()
  q.sid = q.menu.getStateId()
  q.preSlot = q.menu.getSlot(slot).getItem().copy()
  q.preCarried = q.menu.getCarried().copy()
  mc.gameMode.handleInventoryMouseClick(q.menu.containerId, slot, 0, type, mc.player)
  q.waiting = true
  q.waited = 0
}

function wdoFinish(q, msg) {
  wdoQueue = null
  wdoSay(msg)
  q.button.setMessage(new WDO_Text(q.recover == null ? 'Applied' : 'Apply Layout'))
}

/** Stop: first put any card on the cursor back into a free deck slot. */
function wdoAbort(q, msg) {
  q.recover = { msg: msg, tries: 0 }
}

function wdoStep() {
  const q = wdoQueue
  const mc = WDO_Minecraft.getInstance()
  if (mc.screen !== q.screen || mc.player == null) {
    wdoQueue = null
    wdoSay('Apply Layout: deck closed, stopped after ' + q.i + ' of ' + q.clicks.length + ' clicks')
    return
  }
  if (q.waiting) {
    q.waited++
    // answered: state id changed; wait one more tick so all slot packets of that answer are in
    if (q.menu.getStateId() === q.sid && q.waited < WDO_ACK_TIMEOUT) return
    if (q.waited < 2) return
    q.waiting = false
    if (q.recover == null && q.last != null) {
      var ck = q.last
      // a PICKUP swaps slot and cursor exactly; a QUICK_MOVE empties the slot
      var bad = ck.emptySlot ? q.menu.getSlot(ck.slot).hasItem()
        : !(WDO_ItemStack.matches(q.menu.getSlot(ck.slot).getItem(), q.preCarried) && WDO_ItemStack.matches(q.menu.getCarried(), q.preSlot))
      if (bad) wdoAbort(q, ck.emptySlot ? 'Apply Layout: inventory full, stopped' : 'Apply Layout: unexpected result at ' + ck.k + ', stopped')
    }
  }
  if (q.recover != null) {
    var held = q.menu.getCarried()
    if (held.isEmpty()) { wdoFinish(q, q.recover.msg); return }
    if (q.recover.tries >= q.deckSlots.length) { wdoFinish(q, q.recover.msg + '. No free slot for the card on your cursor.'); return }
    var target = -1
    for (var r = q.recover.tries; r < q.deckSlots.length; r++) {
      var sl = q.menu.getSlot(q.deckSlots[r])
      if (!sl.hasItem() && sl.mayPlace(held)) { target = r; break }
    }
    if (target < 0) { wdoFinish(q, q.recover.msg + '. No free slot for the card on your cursor.'); return }
    q.recover.tries = target + 1
    wdoClick(q, q.deckSlots[target], WDO_ClickType.PICKUP)
    return
  }
  if (q.i >= q.clicks.length) {
    wdoFinish(q, 'Layout applied: ' + q.moved + ' cards moved' + (q.removed ? ', ' + q.removed + ' moved to inventory' : '') + q.missingMsg)
    return
  }
  q.last = q.clicks[q.i]
  q.i++
  wdoClick(q, q.last.slot, q.last.type)
}

onForgeEvent('net.minecraftforge.event.TickEvent$ClientTickEvent', event => {
  if (wdoQueue == null || String(event.phase) !== 'END') return
  wdoStep()
})

// ---------------------------------------------------------------- collection export
// Copy Collection: every card and deck core the client can see, grouped by identical data:
//  - your inventory (incl. armor/offhand slots) and the slots of the open container (chest, Card Binder, ...)
//  - the whole item list of an open Tom's Simple Storage terminal (itemListClient)
//  - the cards and cores inside card decks among those items
// Output: "WDO-COLL 1", then one line per distinct item: "K<TAB>count<TAB>card SNBT" or "C<TAB>count<TAB>core SNBT".
function wdoItemId(st) {
  return st == null || st.isEmpty() ? '' : String(st.getItem().getRegistryName())
}
function wdoCollect(screen) {
  const mc = WDO_Minecraft.getInstance()
  const groups = {}
  const order = []
  const isBlank = (cardTag) => cardTag.getList('entries', 10).size() === 0 // blank cards have no effect
  const add = (kind, snbt, n) => {
    var key = kind + wdoHash(snbt)
    if (groups[key] == null) { groups[key] = { kind: kind, snbt: snbt, count: 0 }; order.push(key) }
    groups[key].count += n
  }
  const addStack = (st, n) => {
    var id = wdoItemId(st)
    if (id === '') return
    var tag = st.getTag()
    if (tag == null) return
    if (id === 'the_vault:card' && tag.get('data') != null) { if (!isBlank(tag.getCompound('data'))) add('K', String(tag.get('data').toString()), n) }
    else if (id === 'the_vault:deck_socket' && tag.get('DeckModifier') != null) add('C', String(tag.get('DeckModifier').toString()), n)
    else if (id === 'the_vault:card_deck' && tag.get('data') != null) {
      var data = tag.getCompound('data')
      var cards = data.getList('cards', 10)
      for (var i = 0; i < cards.size(); i++) {
        var slot = cards.getCompound(i)
        if (slot.contains('card') && !isBlank(slot.getCompound('card'))) add('K', String(slot.getCompound('card').toString()), n)
      }
      var mods = data.getList('modifiers', 10)
      for (var j = 0; j < mods.size(); j++) {
        var m = mods.getCompound(j)
        if (String(m.getString('type')) !== 'implicit') add('C', String(m.toString()), n)
      }
    }
  }
  const inv = mc.player.getInventory()
  for (var a = 0; a < inv.getContainerSize(); a++) addStack(inv.getItem(a), inv.getItem(a).getCount())
  if (screen != null && typeof screen.getMenu === 'function') {
    var menu = screen.getMenu()
    var slots = menu.slots
    for (var b = 0; b < slots.size(); b++) {
      var sl = slots.get(b)
      if (inv.equals(sl.container)) continue // already counted
      var it = sl.getItem()
      if (!it.isEmpty()) addStack(it, it.getCount())
    }
    // Tom's Simple Storage terminal: the network's items are a client-side list, not slots
    if (menu.itemListClient != null && typeof menu.itemListClient.size === 'function') {
      var list = menu.itemListClient
      for (var c = 0; c < list.size(); c++) {
        var sis = list.get(c)
        addStack(sis.getStack(), Number(sis.getQuantity()))
      }
    }
  }
  var lines = ['WDO-COLL 1']
  var cardN = 0, coreN = 0
  for (var d = 0; d < order.length; d++) {
    var g = groups[order[d]]
    lines.push(g.kind + '\t' + g.count + '\t' + g.snbt)
    if (g.kind === 'K') cardN += g.count; else coreN += g.count
  }
  return { text: lines.join('\n'), cards: cardN, cores: coreN }
}
function wdoCopyCollection(screen, button) {
  const mc = WDO_Minecraft.getInstance()
  const r = wdoCollect(screen)
  if (r.cards + r.cores === 0) { wdoSay('Copy Collection: no cards or deck cores here. Open your storage, Card Binder or inventory.'); return }
  console.info(r.text)
  mc.keyboardHandler.setClipboard(r.text)
  wdoSay('Collection copied: ' + r.cards + ' cards, ' + r.cores + ' cores')
  button.setMessage(new WDO_Text('Copied ' + r.cards + '+' + r.cores))
}

// ---------------------------------------------------------------- buttons
// Vault Hunters screens (AbstractElementContainerScreen) override children() with their own element list,
// so vanilla widgets are drawn but never receive clicks. Buttons are added for rendering and clicks are
// routed to them from MouseClickedEvent.Pre.
let wdoButtons = []
let wdoScreen = null
const WDO_CW = 100
const WDO_TIPS = {
  collection: "Copies every card and deck core you have open here (your inventory, this container, a Tom's Storage terminal, and the cards and cores inside card decks) to the clipboard. On the optimizer site: Collection, Import, paste.",
  copy: 'Copies this deck (cards, positions, cores and implicits) to the clipboard. On the optimizer site: Import deck, paste.',
  apply: 'Rearranges this deck into the layout copied with "Copy layout for game" on the optimizer site. Cards are taken from the deck and your inventory; cards the layout leaves out go to your inventory.',
}
/** Button with a wrapped hover tooltip describing what it does. */
function wdoButton(screen, x, y, w, label, tip, onPress) {
  return new WDO_Button(x, y, w, WDO_H, new WDO_Text(label), onPress, (b, pose, mx, my) => {
    // Rhino routes both OnTooltip methods here: onTooltip(button, pose, x, y) and narrateTooltip(consumer).
    // The narration call has no pose / position: ignore it.
    if (pose == null || mx == null || my == null) return
    const mc = WDO_Minecraft.getInstance()
    // Forge's 5-argument overload (lines, x, y, font): the 4-argument renderTooltip is ambiguous in Rhino
    // (a List also converts to a Component), which throws while rendering and crashes the game
    screen.renderTooltip(pose, mc.font.split(new WDO_Text(tip), 200), mx, my, mc.font)
  })
}

onForgeEvent('net.minecraftforge.client.event.ScreenEvent$InitScreenEvent$Post', event => {
  const screen = event.getScreen()
  wdoButtons = []
  wdoScreen = null
  if (screen == null || typeof screen.getMenu !== 'function' || typeof screen.getGuiLeft !== 'function') return
  const sw = Number(screen.width), sh = Number(screen.height)
  const guiRight = screen.getGuiLeft() + screen.getXSize()
  // JEI's search bar spans the ingredient list at the bottom right: up to 9 columns of 18 px plus padding
  const cols = Math.max(1, Math.min(9, Math.floor((sw - guiRight - 12) / 18)))
  const searchLeft = sw - cols * 18 - 8
  var cx = searchLeft - WDO_CW - 4, cy = sh - 23
  if (cx < guiRight + 2) { cx = Math.max(2, searchLeft); cy = sh - 46 } // no room beside it: just above it
  const coll = wdoButton(screen, cx, cy, WDO_CW, 'Copy Collection', WDO_TIPS.collection, b => wdoCopyCollection(screen, b))
  event.addListener(coll)
  wdoButtons.push([coll, wdoCopyCollection])
  wdoScreen = screen
  if (!wdoIsDeckScreen(screen)) return
  const top = screen.getGuiTop()
  const right = guiRight
  // deck screen: a column right of the deck window, aligned with its top; above the window if the screen is too narrow
  var ax, ay, dx, dy
  if (right + 4 + WDO_W <= sw - 2) {
    ax = right + 4; ay = top + 2
    dx = ax; dy = ay + WDO_H + 2
  } else {
    ay = dy = top >= WDO_H + 4 ? top - WDO_H - 2 : 2
    dx = right - WDO_W; ax = dx - WDO_W - 4
  }
  const apply = wdoButton(screen, ax, ay, WDO_W, 'Apply Layout', WDO_TIPS.apply, b => wdoApply(screen, b))
  const copy = wdoButton(screen, dx, dy, WDO_W, 'Copy for Optimizer', WDO_TIPS.copy, b => wdoExport(screen, b))
  event.addListener(copy)
  event.addListener(apply)
  wdoButtons.push([copy, wdoExport])
  wdoButtons.push([apply, wdoApply])
})

onForgeEvent('net.minecraftforge.client.event.ScreenEvent$MouseClickedEvent$Pre', event => {
  if (wdoScreen == null || event.getScreen() !== wdoScreen || event.getButton() !== 0) return
  for (var i = 0; i < wdoButtons.length; i++) {
    var pair = wdoButtons[i]
    var b = pair[0]
    if (!b.isMouseOver(event.getMouseX(), event.getMouseY())) continue
    b.playDownSound(WDO_Minecraft.getInstance().getSoundManager())
    pair[1](wdoScreen, b)
    event.setCanceled(true)
    return
  }
})
