"""
Extracts card / deck / core data and textures from the Wold's Vaults instance
into ./data/game-data.json and ./assets/ for the static web optimizer.

Sources (read-only):
  mods/the_vault-*.jar                    - textures, models, attribute names (ModGearAttributes)
  mods/wolds-vaults-official-mod-*.jar    - extra decks, cores, implicits, textures, lang
  config/the_vault/card/*.json            - live card configs used by the pack
  kubejs/assets/**                        - pack-added card icons

Usage:  python tools/build_data.py [--instance "<path to .minecraft>"]
Requires: Python 3.9+, Pillow, a JDK (javap) for attribute names.
"""
import argparse, glob, io, json, os, re, shutil, subprocess, sys, tempfile, zipfile
from datetime import date

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required: pip install pillow")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_INSTANCE = os.path.expandvars(
    r"%APPDATA%\PrismLauncher\instances\Wold's Vaults - Vault Hunters Expansion\minecraft")


def load_json(b):
    if isinstance(b, bytes):
        b = b.decode("utf-8-sig")
    # tolerate trailing commas used in some pack configs
    b = re.sub(r",(\s*[}\]])", r"\1", b)
    return json.loads(b)


class Assets:
    """Layered resource lookup: kubejs dir > wolds jar > vault jar."""

    def __init__(self, jars, kubejs_assets):
        self.jars = jars
        self.kubejs = kubejs_assets

    def read(self, path):
        if self.kubejs:
            p = os.path.join(self.kubejs, path.replace("assets/", "", 1))
            if os.path.isfile(p):
                return open(p, "rb").read()
        for z in self.jars:
            try:
                return z.read(path)
            except KeyError:
                pass
        return None

    def model(self, ref):
        """'the_vault:card/icon/x#inventory' -> resolved texture ref of the item model."""
        ref = ref.split("#")[0]
        ns, p = ref.split(":", 1) if ":" in ref else ("minecraft", ref)
        seen = 0
        textures = {}
        path = f"assets/{ns}/models/item/{p}.json"
        while path and seen < 8:
            seen += 1
            raw = self.read(path)
            if raw is None:
                break
            m = load_json(raw)
            for k, v in m.get("textures", {}).items():
                textures.setdefault(k, v)
            par = m.get("parent")
            if not par or par.startswith("item/") or par.startswith("minecraft:item/") or par.startswith("builtin"):
                break
            pns, pp = par.split(":", 1) if ":" in par else ("minecraft", par)
            path = f"assets/{pns}/models/{pp}.json"
        for key in ("layer0", "front", "texture", "all"):
            if key in textures and not textures[key].startswith("#"):
                return textures[key]
        for v in textures.values():
            if not v.startswith("#"):
                return v
        return None

    def texture(self, tref):
        ns, p = tref.split(":", 1) if ":" in tref else ("minecraft", tref)
        return self.read(f"assets/{ns}/textures/{p}.png")


class Exporter:
    def __init__(self, assets, outdir):
        self.assets = assets
        self.out = outdir
        self.done = {}

    def export_texture(self, tref, sub):
        if not tref:
            return None
        if tref in self.done:
            return self.done[tref]
        raw = self.assets.texture(tref)
        if raw is None:
            self.done[tref] = None
            return None
        img = Image.open(io.BytesIO(raw)).convert("RGBA")
        w, h = img.size
        if h > w and h % w == 0:  # animated strip -> first frame
            img = img.crop((0, 0, w, w))
        name = tref.replace(":", "__").replace("/", "_") + ".png"
        rel = f"assets/img/{sub}/{name}"
        os.makedirs(os.path.join(self.out, os.path.dirname(rel)), exist_ok=True)
        img.save(os.path.join(self.out, rel))
        self.done[tref] = rel
        return rel

    def export_model(self, mref, sub):
        if not mref:
            return None
        return self.export_texture(self.assets.model(mref), sub)


def parse_attributes(vault_jar_path):
    """Pull attribute id -> (display name, color, reader) from ModGearAttributes static init."""
    javap = shutil.which("javap")
    if not javap:
        for c in glob.glob(r"C:\Program Files\Java\*\bin\javap.exe") + glob.glob("/usr/lib/jvm/*/bin/javap"):
            javap = c
            break
    if not javap:
        print("warning: javap not found, attribute names unavailable")
        return {}
    tmp = tempfile.mkdtemp()
    with zipfile.ZipFile(vault_jar_path) as z:
        z.extract("iskallia/vault/init/ModGearAttributes.class", tmp)
    out = subprocess.run([javap, "-c", "-p", "-constants",
                          os.path.join(tmp, "iskallia/vault/init/ModGearAttributes.class")],
                         capture_output=True, text=True).stdout
    shutil.rmtree(tmp, ignore_errors=True)
    attrs, cur = {}, None
    lines = out.splitlines()
    start = next(i for i, l in enumerate(lines) if l.strip().startswith("static {}"))
    for l in lines[start:]:
        ms = re.search(r"// String (.*)$", l)
        mi = re.search(r"// int (-?\d+)$", l) or re.search(r"(?:bipush|sipush)\s+(-?\d+)", l)
        if ms:
            s = ms.group(1)
            if cur is None and re.fullmatch(r"[a-z0-9_]+", s):
                cur = {"id": s, "strings": [], "ints": [], "reader": None}
            elif cur is not None:
                cur["strings"].append(s)
        elif mi and cur is not None:
            cur["ints"].append(int(mi.group(1)))
        elif cur is not None and "VaultGearAttributeType." in l and "vtype" not in cur:
            cur["vtype"] = re.search(r"VaultGearAttributeType\.(\w+)", l).group(1).replace("Type", "")
        elif cur is not None and "ModGearAttributeReaders." in l and cur["reader"] is None:
            cur["reader"] = re.search(r"ModGearAttributeReaders\.(\w+)", l).group(1)
        elif cur is not None and re.search(r"reader/(\w+)\.\"<init>\"", l) and cur["reader"] is None:
            cur["reader"] = re.search(r"reader/(\w+)\.\"<init>\"", l).group(1)
        elif cur is not None and "putstatic" in l:
            name = cur["strings"][0] if cur["strings"] else None
            color = next((i for i in cur["ints"] if i > 255), None)
            attrs["the_vault:" + cur["id"]] = {"name": name, "color": color, "reader": cur["reader"],
                                               "type": cur.get("vtype")}
            cur = None
    return attrs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance", default=DEFAULT_INSTANCE)
    a = ap.parse_args()
    inst = a.instance
    mods = os.path.join(inst, "mods")
    vault_jar = sorted(glob.glob(os.path.join(mods, "the_vault-*.jar")))[-1]
    wolds_jar = sorted(glob.glob(os.path.join(mods, "wolds-vaults-official-mod-*.jar")))[-1]
    cfg = os.path.join(inst, "config", "the_vault", "card")
    zv, zw = zipfile.ZipFile(vault_jar), zipfile.ZipFile(wolds_jar)
    kubejs_assets = os.path.join(inst, "kubejs", "assets")
    assets = Assets([zw, zv], kubejs_assets if os.path.isdir(kubejs_assets) else None)

    img_root = os.path.join(ROOT, "assets", "img")
    shutil.rmtree(img_root, ignore_errors=True)
    ex = Exporter(assets, ROOT)

    def cfgj(name):
        return load_json(open(os.path.join(cfg, name), "rb").read())

    def wvj(path):
        return load_json(zw.read("data/woldsvaults/vault_configs/" + path))

    modifiers = cfgj("modifiers.json")
    decks = cfgj("decks.json")
    deck_mods = cfgj("deck_modifiers.json")
    implicits = cfgj("implicit_deck_modifiers.json")
    scalers = cfgj("scalers.json")
    conditions = cfgj("conditions.json")
    packs = cfgj("booster_packs.json")
    tasks_cfg = cfgj("tasks.json")

    # Wold's datapack configs are merged on top of the live VH configs (VHAPI loaders).
    wv_decks = wvj("card/decks/wolds_decks.json")
    wv_cores = wvj("card/deck_mods/new_cores.json")
    wv_impl = wvj("implicit_deck_modifiers/wolds_implicits.json")
    wv_packs = wvj("card/booster_packs/wolds_packs.json")
    decks["values"].update(wv_decks.get("values", {}))
    deck_mods["values"].update(wv_cores.get("values", {}))
    for k, v in wv_cores.get("pools", {}).items():
        deck_mods.setdefault("pools", {}).setdefault(k, []).extend(v)
    implicits["DECKS_TO_MODIFIERS_MAP"].update(wv_impl.get("DECKS_TO_MODIFIERS_MAP", {}))
    packs["values"].update(wv_packs.get("values", {}))

    # ---- cards
    cards = {}
    for cid, c in modifiers["values"].items():
        c = dict(c)
        c["icon"] = ex.export_model(c.get("model"), "icons") if c.get("model") else None
        if c.get("model") and not c["icon"]:
            # Model missing from the jar (renders as missing texture in game):
            # fall back to the matching skill / ability GUI icon.
            base = c["model"].split("#")[0].split("/")[-1]
            for t in (f"the_vault:gui/skills/{base}", f"the_vault:gui/abilities/{base}",
                      f"the_vault:gui/skills/{base.replace('_', '')}",
                      f"the_vault:gui/skills/{base}_ability", f"the_vault:item/{base.rstrip('s')}"):
                c["icon"] = ex.export_texture(t, "icons")
                if c["icon"]:
                    c["iconFallback"] = True
                    break
        cards[cid] = c

    # ---- card frames (front textures)
    frames = {}
    for n in zv.namelist():
        m = re.fullmatch(r"assets/the_vault/textures/item/card/([a-z0-9_]+)\.png", n)
        if m:
            frames[m.group(1)] = ex.export_texture("the_vault:item/card/" + m.group(1), "frames")

    # ---- decks
    out_decks = {}
    for did, d in decks["values"].items():
        d = dict(d)
        d["icon"] = ex.export_model(d.get("model"), "decks")
        d["implicit"] = implicits["DECKS_TO_MODIFIERS_MAP"].get(did)
        out_decks[did] = d
    # Drop decks that only duplicate another deck's name with layouts that can never roll (all weights 0),
    # e.g. "odungeon": a 20-slot "The Anvil Deck" next to the real 24-slot Anvil Deck.
    def can_roll(d):
        return any(float(l.get("weight", 0) or 0) > 0 for l in d.get("layout", []))
    for did in [k for k, d in out_decks.items() if not can_roll(d) and any(
            o is not d and o.get("name") == d.get("name") and can_roll(o) for o in out_decks.values())]:
        del out_decks[did]

    # ---- cores
    out_cores = {}
    for mid, m in deck_mods["values"].items():
        m = dict(m)
        m["icon"] = ex.export_model(m.get("modelId"), "cores") if m.get("modelId") else None
        for vk in ("modifierValues", "slotRolls"):
            for tier, tv in (m.get(vk) or {}).items():
                if isinstance(tv, dict) and tv.get("modelId"):
                    tv["icon"] = ex.export_model(tv["modelId"], "cores")
        out_cores[mid] = m

    # ---- gui
    gui = {}
    for key, tref in {
        "slot": "the_vault:gui/screen/inset_card_slot_background",
        "slotModified": "the_vault:gui/screen/inset_modified_card_slot_background",
        "arcaneSlot": "the_vault:gui/screen/card_deck_arcane_slot",
        "cardBack": "the_vault:item/card/card_back",
        "deckItem": "the_vault:item/card_deck",
        "deckMaster": "the_vault:gui/skills/deck_master",
        # Card Binder filter icons (10x10) for card groups
        "groupArcane": "the_vault:gui/screen/card_binder/icon/arcane",
        "groupEvolution": "the_vault:gui/screen/card_binder/icon/evolution",
        "groupResource": "the_vault:gui/screen/card_binder/icon/resource",
        "groupStat": "the_vault:gui/screen/card_binder/icon/stat",
        "groupWild": "the_vault:gui/screen/card_binder/icon/wild",
        "groupFoil": "the_vault:gui/screen/card_binder/icon/foil",
    }.items():
        gui[key] = ex.export_texture(tref, "gui")
    # Deck window background: 60x60 nine-slice (ScreenTextures.CARD_DECK_BACKGROUND_9, slice 20/20/20/20,
    # tiled) with 1px transparent gutter lines at x/y = 20 and 39. Strip them -> 58x58, slices 20/18/20.
    raw = ex.assets.texture("the_vault:gui/screen/card_deck_background.9")
    if raw is not None:
        src = Image.open(io.BytesIO(raw)).convert("RGBA")
        keep = [i for i in range(src.width) if i not in (20, 39)]
        bg = Image.new("RGBA", (len(keep), len(keep)))
        for nx, x in enumerate(keep):
            for ny, y in enumerate(keep):
                bg.putpixel((nx, ny), src.getpixel((x, y)))
        rel = "assets/img/gui/card_deck_background.png"
        bg.save(os.path.join(ex.out, rel))
        gui["deckBackground"] = rel

    # ---- localisation (Wold's en_us + VH en_us card/deck keys)
    lang = {}
    for z, ns in ((zv, "the_vault"), (zw, "woldsvaults")):
        try:
            l = load_json(z.read(f"assets/{ns}/lang/en_us.json"))
        except KeyError:
            continue
        for k, v in l.items():
            if re.search(r"card|deck|core|booster", k, re.I):
                lang[k] = v

    # ---- display names of items rolled by task-loot (Resource) cards, as the game shows them:
    # KubeJS lang overrides (e.g. Iskallium -> Woldium) > Wold's mod lang > Vault Hunters lang
    item_lang = {}
    for z, ns in ((zv, "the_vault"), (zw, "woldsvaults")):
        try:
            item_lang.update(load_json(z.read(f"assets/{ns}/lang/en_us.json")))
        except KeyError:
            pass
    if os.path.isdir(kubejs_assets):
        for ns in os.listdir(kubejs_assets):
            lp = os.path.join(kubejs_assets, ns, "lang", "en_us.json")
            if os.path.isfile(lp):
                item_lang.update(load_json(open(lp, "rb").read()))
    item_names = {}
    for c in cards.values():
        for l in c.get("loot") or []:
            iid = ((l.get("item") or {}).get("id")) or ""
            if ":" not in iid or iid in item_names:
                continue
            ns, path = iid.split(":", 1)
            nm = item_lang.get(f"item.{ns}.{path}") or item_lang.get(f"block.{ns}.{path}")
            if nm:
                item_names[iid] = re.sub(r"\u00a7.|§.", "", nm)

    # ---- Resource card tasks: pools by difficulty (weight > 0) and each task's target range and text
    def flat_text(t):
        if isinstance(t, str):
            return t
        return "".join(x.get("text", "") for x in (t or []) if isinstance(x, dict))
    tasks = {"pools": {}, "values": {}}
    for pname, lst in tasks_cfg.get("pools", {}).items():
        tasks["pools"][pname] = [x["value"] for x in lst if x.get("weight", 1)]
    for tid, t in tasks_cfg.get("values", {}).items():
        tgt = ((t.get("counter") or {}).get("target")) or {}
        text = flat_text(((t.get("renderer") or {}).get("tooltip")))
        text = re.sub(r"\s*\(\$\{current\}/\$\{target\}\)", "", text)  # progress counter is shown only in game
        tasks["values"][tid] = {"type": t.get("type"), "target": [tgt.get("min", tgt.get("count")), tgt.get("max", tgt.get("min", tgt.get("count")))], "text": text}

    def ver(p):
        return re.search(r"-(\d[\w.\-]*)\.jar$", os.path.basename(p)).group(1)

    # ---- booster packs the game can still give: the pack id appears in some item source (loot tables, card
    # shop, bounty / challenge rewards, quests, Wold's data), not only in a booster pack definition file.
    def is_pack_def(name):
        return name.endswith("booster_packs.json") or "/card/booster_packs/" in name.replace("\\", "/")
    blobs = []
    for base in ("config", "kubejs", "defaultconfigs", "datapacks"):
        for dp, dn, fn in os.walk(os.path.join(inst, base)):
            for f in fn:
                path = os.path.join(dp, f)
                if is_pack_def(path) or os.path.getsize(path) > 20_000_000:
                    continue
                try:
                    b = open(path, "rb").read()
                except OSError:
                    continue
                if b"booster_pack" in b:
                    blobs.append(b)
    for z in (zw, zv):
        for n in z.namelist():
            if n.startswith("assets/") or n.endswith(".class") or is_pack_def(n):
                continue
            b = z.read(n)
            if b"booster_pack" in b:
                blobs.append(b)
    live_packs = {pid for pid in packs["values"] if any(pid.encode() in b for b in blobs)}
    dead = sorted(set(packs["values"]) - live_packs)
    if dead:
        print("booster packs with no source (ignored):", ", ".join(dead))

    # ---- cards obtainable from booster packs: pack card entries (weight > 0, probability > 0) -> "@pool"
    # (pool entries with weight > 0) or a direct card id. Ids that do not exist are dropped (as in game).
    pools = modifiers.get("pools", {})
    obtainable = {}
    for pid, pack in packs["values"].items():
        if pid not in live_packs:
            continue
        pname = ((pack.get("name") or {}).get("text")) or pid
        for roll in pack.get("card", []):
            if not roll.get("weight", 1):
                continue
            for e in roll.get("value", []):
                if not e.get("probability", 1):
                    continue
                m = e.get("modifier", "")
                ids = [x["value"] for x in pools.get(m[1:], []) if x.get("weight", 1)] if m.startswith("@") else [m]
                for cid in ids:
                    if cid in cards and pname not in obtainable.setdefault(cid, []):
                        obtainable[cid].append(pname)

    # ---- what each card can roll with (from the pack entries that can roll it): Foil, scaler and condition
    # lines, and the values each filter field can take (from the referenced scaler / condition configs).
    def cfg_names(kind_cfg, ref):
        if not ref:
            return []
        if ref.startswith("@"):
            return [x["value"] for x in kind_cfg.get("pools", {}).get(ref[1:], []) if x.get("weight", 1)]
        return [ref] if ref in kind_cfg.get("values", {}) else []

    def filter_options(kind_cfg, names, counts):
        if not names:
            return None
        out = {"neighbor": set(), "color": set(), "group": set(), "tier": set(), "min": [], "max": []}
        fmap = {"neighborFilter": "neighbor", "colorFilter": "color", "groupFilter": "group", "tierFilter": "tier"}
        for nm in names:
            for t in kind_cfg["values"].get(nm, {}).get("tiers", []):
                for pe in t.get("pool", []):
                    for f in pe.get("filters", []):
                        for fk, key in fmap.items():
                            opts = f.get(fk)
                            if opts is None:
                                out[key].add("")  # field absent -> any
                                continue
                            for o in opts:
                                v = o.get("value")
                                if not v:
                                    out[key].add("")
                                else:
                                    for x in v:
                                        out[key].add(str(x))
                        if counts:
                            for ck in ("min", "max"):
                                r = f.get(ck + "Count")
                                if r is None:
                                    out[ck].append(None)
                                else:
                                    out[ck].append([r.get("min", r.get("count")), r.get("max", r.get("min", r.get("count")))])
        res = {k: sorted(v) for k, v in out.items() if k not in ("min", "max")}
        if counts:
            for ck in ("min", "max"):
                rs = [r for r in out[ck] if r]
                res[ck] = [min(r[0] for r in rs), max(r[1] for r in rs)] if rs else None
                res[ck + "Optional"] = any(r is None for r in out[ck])
        return res

    rolls = {}
    for pid, pack in packs["values"].items():
        if pid not in live_packs:
            continue
        for roll in pack.get("card", []):
            if not roll.get("weight", 1):
                continue
            for e in roll.get("value", []):
                if not e.get("probability", 1):
                    continue
                m = e.get("modifier", "")
                ids = [x["value"] for x in pools.get(m[1:], []) if x.get("weight", 1)] if m.startswith("@") else [m]
                for cid in ids:
                    if cid not in cards:
                        continue
                    r = rolls.setdefault(cid, {"foil": False, "plainOk": False, "scaler": set(), "condition": set(),
                                               "scalerOptional": False, "conditionOptional": False})
                    if "Foil" in (e.get("groups") or []):
                        r["foil"] = True
                    else:
                        r["plainOk"] = True
                    sc, co = cfg_names(scalers, e.get("scaler")), cfg_names(conditions, e.get("condition"))
                    r["scaler"].update(sc); r["condition"].update(co)
                    if not sc: r["scalerOptional"] = True
                    if not co: r["conditionOptional"] = True
    card_rolls = {}
    for cid, r in rolls.items():
        card_rolls[cid] = {
            "foil": r["foil"],
            "scaler": filter_options(scalers, sorted(r["scaler"]), False),
            "scalerRequired": bool(r["scaler"]) and not r["scalerOptional"],
            "condition": filter_options(conditions, sorted(r["condition"]), True),
            "conditionRequired": bool(r["condition"]) and not r["conditionOptional"],
        }

    data = {
        "meta": {
            "generated": date.today().isoformat(),
            "vaultHunters": ver(vault_jar),
            "woldsVaults": ver(wolds_jar),
            "minimumDeckLevel": decks.get("minimumDeckLevel", 0),
        },
        "attributes": parse_attributes(vault_jar),
        "cards": cards,
        "cardPools": modifiers.get("pools", {}),
        "frames": frames,
        "decks": out_decks,
        "cores": out_cores,
        "corePools": deck_mods.get("pools", {}),
        "scalers": scalers,
        "conditions": conditions,
        "boosterPacks": packs["values"],
        "obtainable": obtainable,
        "livePacks": sorted(live_packs),
        "itemNames": item_names,
        "tasks": tasks,
        "cardRolls": card_rolls,
        "gui": gui,
        "lang": lang,
    }
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "game-data.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
    missing = [k for k, c in cards.items() if c.get("model") and not c["icon"]]
    print(f"cards={len(cards)} decks={len(out_decks)} cores={len(out_cores)} "
          f"attributes={len(data['attributes'])} textures={sum(1 for v in ex.done.values() if v)}")
    if missing:
        print("cards without icon:", ", ".join(missing[:40]))
    md = [k for k, d in out_decks.items() if not d["icon"]]
    if md:
        print("decks without icon:", ", ".join(md))


if __name__ == "__main__":
    main()
