# Wold's Vault Deck Optimizer

Static web app for planning and optimizing card decks in **Wold's Vaults** (Vault Hunters 3rd Edition).
All data, names, icons and formulas come from the mod JARs and the pack's card configs.

- Vault Hunters: `the_vault-1.18.2-3.21.6.6884.jar`
- Wold's Vaults: `wolds-vaults-official-mod-0.34.1.jar`

## Usage

1. Choose a deck. The deck's implicit modifier is applied automatically. For the Mystery Deck, choose its two implicits.
2. Socket the deck cores you have. Pick the variant (Lesser, base or Greater) and enter the rolled value shown in game.
   - For Empyreal, Adept, Arcane and Construction cores, click **Select Slots** and then click the slots on the deck: the slots each core empowers, boosts, converts to Arcane, or adds.
   - Hover over a deck or an implicit in a picker to see its modifier.
   The **Collection** panel has two tabs. **Cards** holds your cards. **Cores** holds the cores you own (variant and rolled value): **Socket** puts one in the deck, **Unsocket** takes it out; importing a deck adds its cores. The deck's **Add core (planning)** picker still lets you try cores you do not own.
3. Enter your cards with **Add card**. The card list only offers cards that a booster pack can roll; hover a card to see which packs. Cards already in your collection that no pack can roll are marked **Not in packs**.
   The dialog only allows what packs can roll on that card: whether it has a scaling line and/or a condition line (and whether it is required), the values each filter can take, the condition count ranges, and Foil as the only extra group (Shiny and Deluxe are separate cards).
   Resource cards give their loot per completed task. Each card rolls one task from its difficulty pool (Easy, Medium, Hard, Extreme, Impossible); pick the task and target shown on your card (e.g. per 45 Horde Mobs killed). With a Harvest core the slot tooltip shows the reduced requirement; with a Resource double core, the chance to double the loot.
   For each card enter: card type, tier, color, extra groups (Foil, Shiny, Deluxe), the rolled value, and any scaler or condition filters shown on the card tooltip.
4. Choose how layouts are scored (**Score by**, above the statistics table):
   - **Multipliers** (default): every card scores its own multiplier, scaler count N × efficiency M × greed G (level and vault-modifier cards score N, since M and G do not apply to them), times its attribute's weight. This gets every card the most multipliers regardless of units. Raw totals break ties.
   - **Deck totals**: weight × displayed total per attribute (per 1% for percentage stats, per point for flat stats, per level, per second).
   The statistics table is grouped by card type (Evolution, Stat, Temporal, Arcane, Resource, Knack), with each attribute's card icon. An attribute produced by several card types sits under the largest contributor; hover it for the split.
   Optionally pick up to three **Priority** attributes. They are maximized strictly in order: priority 1 first, then priority 2 without lowering priority 1, then priority 3, then the weighted score.
5. Click **Optimize placement**. Locked slots are kept as they are. Each slot shows its card multiplier (×); hover a slot to see the full calculation.

### Auto build

Pick a **build focus** (Ability Power, Attack Damage, Tank, Mana, Loot, or Custom) and a **balance**, then click:

- **Auto-create**: builds the whole deck (locked slots are kept).
- **Auto-finish**: keeps the placed cards and fills only the empty slots.
- **Build from collection**: builds the whole deck from the cards you own only (not Planned ones, no candidate cards) and, with cores chosen, only from the cores you own; locked slots are kept and Planned cards stay in the collection.

Each preset builds for all its attributes (the main one weighs most, e.g. Ability Power: Increased Ability Power, then Ability Power and Cooldown Reduction). Auto build always balances the focus against survivability (Increased Health, Increased Armor, Resistance). **Balance** sets the split: Offense first (70 / 30), Balanced (50 / 50) or Survival first (30 / 70). The score is the weighted product of the goals (sum of weight × ln(1 + total)), so no goal can be traded away for a large gain in another. Player stat caps are respected: Resistance counts up to 50% and Cooldown Reduction up to 80% (the base caps in `AttributeLimitHelper`; gear can raise them up to 95%).

Selecting the **Custom** focus opens the **Custom auto build** window: tick the card types auto build may use (Evolution, Stat, Knack, Temporal, Arcane, Resource, Greed) and select the card effects to build for (every effect obtainable cards of those types give, grouped by type and searchable, including talent and ability levels, vault modifiers and Resource loot). **Edit…** reopens it. The types apply to candidate cards and to your own collection; without Arcane ticked, Arcane slots stay empty.

**Single color** builds a one-color deck: only cards of the chosen color (Greed and Arcane cards included), or **Majority color** = the most common color of the placed cards (else of your collection). Locked and kept cards stay.

**Allow any Greed card** exempts Greed cards from Single color and Same-color scaling (a Greed card's own color only matters to scalers; its job is to multiply the card it targets).

**Banned cards…** lets you pick cards that auto build never adds (Auto-create, Auto-finish and Build from collection); search the list grouped by card type, or remove a ban with × on its chip. Cards in locked slots, and cards already placed when you use Auto-finish, are kept.

**Same-color scaling** limits auto build (all three buttons) to cards whose scaling and condition colors are the card's own color, e.g. a Blue card that scales For Each Blue; lines without a color filter are allowed.

With **Auto build also chooses cores and implicits** (on by default) the search alternates between placing cards and picking the best core for every socket (best variant, top roll) and, on the Mystery Deck, the best two implicits. Cores that need hand-picked slots (Empyreal, Adept, Arcane, Construction) and Resource / Bounty cores are not chosen.

Candidate cards: any card a booster pack can roll, at max tier with the best value roll, in every color, with every scaler roll the packs allow and the most lenient required condition, plus Greed cards and an Arcane card for Arcane slots. Cards it adds join the collection marked **Planned**; planned cards a later auto build no longer uses are removed. Auto build has many more choices than placing your own cards, so give it more search time (30 s or more) when the searches disagree.

`node tests/autobuild_check.js 4` builds every focus on the fixture deck's setup and checks slot rules and that every card is pack-rollable.

**Optimize + Compare** runs the same optimization, then shows the score and every attribute before and after (with the change) and how many slots changed. Keep the optimized layout or revert to the previous one.

**Compare decks** (header) opens a page with two decks side by side: the current deck or any saved deck on each side, with score, deck type, filled slots, cores, implicits and a mini grid (hover a card for details), plus a table of every attribute for Deck A, Deck B and the difference. Saved decks have a **Load this deck** button.

### Optimizer

One independent search per CPU core (up to 12, in Web Workers) for the chosen search time. Each search runs staged parallel tempering: 6 replicas at temperatures spread over four orders of magnitude, scaled to the typical score change of a move, with replica exchange between neighbouring temperatures. Moves are swaps of two slots, replacing a card with one from the collection, and removing a card. Each priority is a stage that may not lower the earlier stages. A final polish applies every improving swap, replacement and removal until none is left, so the result is a local optimum. The result line shows how many searches reached the best layout; when all agree, it is very likely the global optimum.

`node tests/optimizer_check.js 8` checks layout validity, local optimality, strict priorities and run-to-run agreement on the fixture deck.

**Save deck** stores the current setup (deck, implicits, cores, collection, placement, weights and priorities) under a name in the browser's local storage; saving under an existing name asks before replacing it. **Load deck** lists the saved decks (deck, cards placed, date) with Load and Delete; **New deck** starts an empty setup and keeps your weights, priorities and scoring mode.

Your state is saved in the browser. It can be exported or imported as JSON, or shared as a link.

## Importing your collection from the game

The same KubeJS script adds a **Copy Collection** button next to the JEI search bar on any inventory screen. It copies every card and deck core the game shows you: your inventory, the open container (chest, Card Binder, ...), the whole item list of an open Tom's Simple Storage terminal, and the cards and cores inside any card deck among those items. Identical items are grouped with a count. On the site click **Import** in the Collection panel and paste: cards and cores you do not have yet are added (by fingerprint), nothing is removed, so you can import storage after storage. Refined Storage and AE2 terminals are not read yet.

Saved decks store only the deck and the cards placed in it; the collection is shared by all saved decks.

## Exporting a deck from the game

`tools/kubejs/wdo_deck_export.js` adds a **Copy for Optimizer** button to the card deck screen. It runs on the client only, so it works on servers without op rights.

1. Copy the file to `<instance>/minecraft/kubejs/startup_scripts/` and restart the game.
2. Open a deck and click **Copy for Optimizer**. The deck data (SNBT, prefixed `WDO-DECK`) goes to the clipboard and to `logs/kubejs/startup.txt`.
3. On the site, click **Import deck** and paste. The deck, its implicits, its cores (variant and rolled value), its socket count and every card are imported: tier, colors, groups, rolled value, scaler and condition, and position. Output from `/data get entity @s SelectedItem` is also accepted.

4. Optimize, then click **Copy layout for game**. In game, open the same deck and click **Apply Layout**. The script rearranges the cards with normal inventory clicks, one at a time, waiting for the server to confirm each click and checking the result. A server only accepts inventory changes as clicks unless a mod is installed on the server too. Cards the layout leaves out go to your inventory. If a click does not have the expected result, the script stops and puts any card on the cursor back into a free deck slot. The layout names each card by a fingerprint (a hash of the card's item data, which is identical to its entry in the deck export). The script finds every card wherever it is, in the deck or in your inventory, so the layout works no matter how the deck was arranged and cards removed earlier are put back. Cards it cannot find are listed. Cards added on the site by hand (not imported) must be placed by hand.
   Copying the deck in game (**Copy for Optimizer**) replaces the layout on the clipboard; copy the layout again before applying.

`node tests/plan_check.js` runs the Apply Layout logic against a mock deck menu with real card data and a player inventory: 300 layouts in a row, a deck changed by hand, a missing card, and runs where the server rejects a click.
`node tests/import_check.js` imports `tests/fixtures/mystery_deck.snbt` and prints the deck totals; for the deck it was made with they match the in-game tooltip exactly. The fixture is your own deck export (Copy for Optimizer, saved to that path) and is not committed, since it contains personal game data. The tests below need it too.

The server sends the deck's `data` tag (deck type, slots, cores and cards) but strips `inventory` (`CardDeckItem.getShareTag`), so the export holds everything the optimizer needs.

## Hosting (GitHub Pages)

Push the repository and enable Pages for the branch root. No build step is needed.
The page loads `data/game-data.json` with `fetch`, so open it over HTTP, not `file://`. For a local test:

```bash
python -m http.server 8000
```

## Regenerating data

```bash
python tools/build_data.py --instance "<path to the instance's .minecraft folder>"
```

The script needs Pillow and a JDK (`javap` reads attribute names from `ModGearAttributes`). It reads these sources:

| Source | Used for |
|---|---|
| `config/the_vault/card/*.json` | live card, deck, core, scaler, condition and booster pack configs |
| Wold's JAR `data/woldsvaults/vault_configs/**` | Wold's decks, cores, implicits and packs (merged over the live configs) |
| VH and Wold's JAR `assets/**`, `kubejs/assets/**` | item models and textures, resolved through the model's `layer0`/`front` texture |
| pack entries + scaler / condition configs | `cardRolls`: per card, whether Foil, a scaler and a condition can roll (and are required), and the allowed filter values and count ranges |
| loot tables, shops, rewards, quests, Wold's data | `livePacks`: booster packs the game can still give (referenced by an item source, not only defined). Currently every pack except the Wild Booster Pack, so Wild cards are not offered |
| booster pack configs + card pools | `obtainable`: every card id a live pack can roll (entries with weight and probability > 0, pool entries with weight > 0, ids that exist) and the packs it comes from |
| `config/the_vault/card/tasks.json` | `tasks`: Resource card task pools by difficulty (weight > 0) and each task's target range and text |
| VH, Wold's and KubeJS `en_us.json` | `itemNames`: in-game names of items rolled by Resource cards, with the pack's overrides (e.g. Woldium instead of Iskallium) |
| `iskallia/vault/init/ModGearAttributes.class` | attribute display names, colors, value types and readers |

Animated textures are cut to their first frame.
A few card models are missing from the JAR and show as missing textures in game: Heart Fragments, Blood Rush, Ethereal, Quickening, Clean Escape, Battle Trance, Lingering Fumes and Necromancy. For these the script uses the matching skill or ability GUI icon instead.

## Formula reference

These formulas come from the JAR bytecode: `CardDeck`, `CardEntry`, `CardScaler`, `CardCondition`, `CardNeighborType` and `GreedCardModifier`, plus the Wold's `MixinCardDeck`, `MixinCardEntry`, `MixinCardScaler` and `CardPosMixin` mixins.

### Per card entry

```
if condition fails                         -> entry contributes nothing
N    = scaler ? frequency : 1              (N = 0 -> nothing)
f    = M(card, slot) * G(card, slot)
each of N copies: value * f                (int attributes truncated per copy)
deck total = sum over all entries
```

Values that are not numeric are not multiplied by `f`. This covers ability levels, talent levels and vault-modifier durations.

### Scaler frequency

Each filter counts the matching **card entries**; the counts of all filters are added together.

- **Positions:** the union of the filter's neighbor types. With no neighbor type, every slot except the card's own.
- **Matching:** different filter kinds (color, group, tier) must all match (AND). Values inside one kind match if any one does (OR).
- **Wold's scaler bonus** (Wall, Bishop and Pillager decks): if the filter's neighbor types are a subset of the core's `validNeighborTypes`, the count is multiplied by the sum of `round(v)` over those cores.

### Condition

A condition counts entries the same way, except that with no neighbor type the whole deck counts, including the card itself.
Each filter must satisfy `min ≤ count ≤ max`, and every filter must pass.

### Neighbor types

| Type | Cells |
|---|---|
| ROW / COLUMN | every slot in the same row or column, **including itself**. Gaps do not break the line |
| DIAGONAL | the full diagonal lines inside the slot bounding box |
| ADJACENT | the 4 orthogonal neighbors |
| SURROUNDING | the 8 surrounding cells |
| ABOVE / BELOW / LEFT / RIGHT | the single cell on that side |

Wold's `CardPosMixin` makes Arcane slots visible to neighbor lookups.

### Deck efficiency M (Wold's `MixinCardDeck`)

```
M = (1 + Σ (m_i − 1)) × Π symmetry multipliers
```

All cores and implicits add their bonus linearly. Only `symmetry_balance` (Runic Deck) multiplies the result.
If two cores of the same type are socketed, only the higher value counts (`addModifier`).

| Type | m_i |
|---|---|
| stat_efficiency | Stat cards: `1 + v·uniqueColorsInDeck` |
| non_foil_efficiency | Stat and Evolution cards: `1 + v·nonFoilCards` |
| global | cards that have **all** required groups and whose first color is in the required colors: `1 + v` |
| slot | the core's slots, if the card has any required group: `1 + v` |
| empty_slot_efficiency | `1 + v·emptySlots` |
| no_arcane_efficiency | cards in Arcane slots: `1 + v`. Arcane entries are disabled |
| group_adjacency_efficiency | n = matching group occurrences in the region: `1 + (forEach ? n·v : v)` |
| color_mismatch_adjacency | n = neighbors of a different color: `1 + (forEach ? n·v : v)` |
| chain_reaction | `1 + v·(L − 1)`, where L = the orthogonal chain of same-color cards |
| unique_group_bonus | Stat cards: `1 + v·uniqueGroups` |
| dominance_boost | cards in the most or least common group, excluding some groups: `1 + v` |
| group_synergy | S = count of synergy-group occurrences in the deck: `1 + (forEvery ? S·v : v)` |
| group_synergy_multiplier | `(1 + v)^N`, where N = cards in the group |
| row_height_bonus | `1 + v·rowRank` |
| symmetry_balance | `× v` if the mirrored slot holds a card of the same color |

### Greed G

`G = max(1, Σ greed multipliers)` over all greed cards that target the slot. Multipliers from several greed cards add together.

### Slot rules

- An Arcane slot accepts only cards with the Arcane group.
- A normal slot rejects any card with the Arcane group. Wild cards carry the Arcane group, so they need an Arcane slot.
- Decks with Nitwit or the Villager implicit accept only non-Arcane cards, in any slot.

### Known approximations

- The Void core's stale-cache edge case is not reproduced. The intended value `1 + v·E` is used.
- Resource, task-loot and Temporal cards are listed by count and duration. Their task rolls are random and not simulated.
