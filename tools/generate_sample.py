#!/usr/bin/env python3
"""Generate the fictitious sample data set for racks3d.

Builds N rows x M racks of generic equipment, assigns every sample cable port
by port through the star centers, adds new patch panels / cassettes when a rack
needs more than its installed ports + 30 % reserve, and writes
data/sample-data.js (window.DC_DATA = {...}).

Everything produced here is fictitious: generic device types, made-up labels,
no vendors, no models, no addresses. No external dependencies.

Usage:
    python3 tools/generate_sample.py [--rows 2] [--per-row 8] [--seed 7] [--out data/sample-data.js]
"""
import argparse
import json
import math
import os
import random

RACK_U = 42
RESERVE = 1.30
UTP_PORTS = 24
CASSETTE_PORTS = 12
SLOTS = 4

SWITCHLIKE = {"switch", "router", "firewall", "tap", "wlc"}


# --------------------------------------------------------------------------- items

def org():
    return {"kind": "org"}


def utp(role="trunk", new=False):
    it = {"kind": "utp", "role": role}
    if new:
        it["isNew"] = True
    return it


def lc(cassettes, role="trunk", new=False):
    it = {"kind": "lc", "role": role, "cassettes": [({"medium": c} if c else None) for c in cassettes]}
    if new:
        it["isNew"] = True
    return it


def gap(u):
    return {"kind": "gap", "u": u}


def dev(label, type_, u=1, ports=0, uplinks=0, medium="mm", mgmt=True):
    it = {"kind": "device", "label": label, "type": type_, "u": u, "ports": ports}
    if uplinks:
        it["uplinks"] = uplinks
        it["uplinkMedium"] = medium
    if not mgmt:
        it["mgmt"] = False
    return it


def item_u(it):
    return it.get("u", 1) if it["kind"] in ("device", "gap") else 1


def copper_ports(d):
    n = d.get("ports", 0)
    if d["type"] in SWITCHLIKE:
        return ["1/0/%d" % (i + 1) for i in range(n)]
    return ["eth%d" % i for i in range(n)]


def fiber_ports(d):
    n = d.get("uplinks", 0)
    if d["type"] in SWITCHLIKE:
        return ["1/1/%d" % (i + 1) for i in range(n)]
    return ["fib%d" % i for i in range(n)]


# --------------------------------------------------------------------------- rack templates
# Each template: (name, width mm, depth mm, patching block, devices).
# A reserved gap always sits right below the patching block: new panels are
# inserted there so devices never move.

def templates():
    return [
        ("Core Network", 800, 1200,
         [org(), lc(["mm", "mm", None, None]), utp(), utp(), org()],
         [dev("SW-CORE-01", "switch", 1, 8, 32, "mm"), dev("SW-CORE-02", "switch", 1, 8, 32, "mm"), gap(1),
          dev("RTR-CORE-01", "router", 2, 8, 4, "sm"), gap(2), dev("SRV-NMS-01", "server", 1, 2)]),
        ("Compute A", 600, 1000,
         [org(), lc(["mm", None, None, None]), utp(), org()],
         [dev("SW-ACCESS-01", "switch", 1, 48, 4, "mm"), dev("SW-ACCESS-02", "switch", 1, 48, 4, "mm"), org(), gap(1),
          dev("SRV-APP-01", "server", 2, 2), dev("SRV-APP-02", "server", 2, 2), dev("SRV-APP-03", "server", 2, 2),
          dev("SRV-APP-04", "server", 2, 2), gap(2), dev("SRV-APP-05", "server", 1, 2), dev("SRV-APP-06", "server", 1, 2)]),
        ("Compute B", 600, 1000,
         [org(), utp(), org()],
         [dev("SRV-APP-07", "server", 2, 2), dev("SRV-APP-08", "server", 2, 2), dev("SRV-APP-09", "server", 2, 2),
          dev("SRV-APP-10", "server", 2, 2), gap(1), dev("SRV-WEB-01", "server", 1, 2), dev("SRV-WEB-02", "server", 1, 2),
          dev("SRV-WEB-03", "server", 1, 2), dev("SRV-WEB-04", "server", 1, 2)]),
        ("Storage", 800, 1200,
         [org(), lc(["mm", None, None, None]), utp(), org()],
         [dev("STG-ARRAY-01", "storage", 4, 2, 4, "mm"), gap(1), dev("STG-ARRAY-02", "storage", 2, 2, 2, "mm"),
          dev("STG-SHELF-01", "storage", 2, 0), gap(2), dev("SRV-DB-01", "server", 2, 2, 2, "mm"),
          dev("SRV-DB-02", "server", 2, 2, 2, "mm")]),
        ("Services", 800, 1000,
         [org(), lc(["mm", None, None, None]), utp(), utp(), org()],
         [dev("SRV-DNS-01", "server", 1, 2), dev("SRV-DNS-02", "server", 1, 2), dev("SRV-AUTH-01", "server", 1, 2),
          dev("SRV-MAIL-01", "server", 1, 2), gap(1), dev("SRV-FILE-01", "server", 2, 2),
          dev("APP-LB-01", "appliance", 1, 4, 2, "mm"), dev("APP-LB-02", "appliance", 1, 4, 2, "mm")]),
        ("Security", 600, 1200,
         [org(), lc(["mm", None, None, None]), utp(), org()],
         [dev("FW-EDGE-01", "firewall", 2, 8, 4, "mm"), dev("FW-EDGE-02", "firewall", 2, 8, 4, "mm"), gap(1),
          dev("TAP-01", "tap", 1, 8), dev("APP-IPS-01", "appliance", 2, 4, 2, "mm")]),
        ("Edge / WAN", 600, 1000,
         [org(), lc(["mm", None, None, None]), utp(), org()],
         [dev("RTR-EDGE-01", "router", 1, 8, 4, "sm"), dev("RTR-EDGE-02", "router", 1, 8, 4, "sm"), gap(1),
          dev("SW-EDGE-01", "switch", 1, 24, 8, "mm")]),
        ("Lab", 800, 1000,
         [org(), utp("existing"), utp(), org()],
         [dev("SW-LAB-01", "switch", 1, 24, 2, "mm"), gap(1), dev("SRV-LAB-01", "server", 2, 2),
          dev("SRV-LAB-02", "server", 2, 2), gap(1), dev("CHS-LAB-01", "chassis", 6, 4, 4, "mm")]),
        ("Backup", 600, 1200,
         [org(), lc(["mm", None, None, None]), utp(), org()],
         [dev("SRV-BKP-01", "server", 2, 2, 2, "mm"), dev("SRV-BKP-02", "server", 2, 2, 2, "mm"), gap(1),
          dev("STG-BKP-01", "storage", 4, 2, 4, "mm"), dev("STG-TAPE-01", "storage", 4, 2)]),
        ("Compute C", 600, 1000,
         [org(), utp(), org()],
         [dev("SRV-APP-11", "server", 2, 2), dev("SRV-APP-12", "server", 2, 2), dev("SRV-APP-13", "server", 2, 2),
          dev("SRV-APP-14", "server", 2, 2), dev("SRV-APP-15", "server", 2, 2), dev("SRV-APP-16", "server", 2, 2)]),
        ("Virtualization", 800, 1200,
         [org(), lc(["mm", "mm", None, None]), utp(), utp(), org()],
         [dev("SW-ACCESS-03", "switch", 1, 48, 4, "mm"), dev("SW-ACCESS-04", "switch", 1, 48, 4, "mm"), org(), gap(1),
          dev("CHS-VIRT-01", "chassis", 10, 8, 8, "mm"), gap(1), dev("SRV-HV-01", "server", 2, 2, 2, "mm"),
          dev("SRV-HV-02", "server", 2, 2, 2, "mm"), dev("SRV-HV-03", "server", 2, 2, 2, "mm")]),
        ("Monitoring", 600, 1000,
         [org(), lc(["mm", None, None, None]), utp(), org()],
         [dev("SRV-MON-01", "server", 1, 4), dev("SRV-MON-02", "server", 1, 2), dev("SRV-LOG-01", "server", 2, 2),
          gap(1), dev("TAP-02", "tap", 1, 8), dev("APP-PROBE-01", "appliance", 1, 4, 2, "mm")]),
        ("Management", 600, 1000,
         [org(), utp(), org()],
         [dev("SRV-JUMP-01", "server", 1, 2), dev("SRV-PXE-01", "server", 1, 2), dev("WLC-01", "wlc", 1, 4, 2, "mm"),
          gap(1), dev("SRV-MON-03", "server", 1, 2)]),
        ("Reserve", 800, 1200,
         [org(), utp(), org()],
         [dev("SRV-SPARE-01", "server", 2, 2)]),
    ]


# --------------------------------------------------------------------------- build

class Gen:
    def __init__(self, rows, per_row, seed):
        self.rnd = random.Random(seed)
        self.rows_n = rows
        self.per_row = per_row
        self.racks = []
        self.rack_by_id = {}
        self.rows = {}
        self.dev_index = {}     # label -> (rack id, item)
        self.dev_used = {}      # label -> set(port names)
        self.port_used = {}     # "R#P" -> {port: cable id}
        self.cables = []
        self.trunks = []
        self.notes = []

    # -- layout -------------------------------------------------------------
    def build_racks(self):
        tpl = templates()
        k = 0
        for r in range(1, self.rows_n + 1):
            ids = ["R%d-%02d" % (r, n) for n in range(self.per_row, 0, -1)]   # physical order, left -> right
            self.rows[str(r)] = ids
            faces_plus_z = (r % 2 == 1)
            star = ids[0] if faces_plus_z else ids[-1]                            # rack at the room's door end
            for rid in ids:
                if rid == star:
                    rack = {"id": rid, "name": "", "width": 800, "depth": 1200, "row": r,
                            "starCenter": ["copper"], "items": []}
                else:
                    name, w, d, patch, devs = tpl[k % len(tpl)]
                    suffix = "" if k < len(tpl) else " %d" % (k // len(tpl) + 1)
                    patch = json.loads(json.dumps(patch))
                    devs = json.loads(json.dumps(devs))
                    if suffix:
                        for it in devs:
                            if it["kind"] == "device":
                                it["label"] += "-%d" % (k // len(tpl) + 1)
                    rack = {"id": rid, "name": name + suffix, "width": w, "depth": d, "row": r,
                            "starCenter": None, "items": patch + [gap(4)] + devs}
                    k += 1
                self.racks.append(rack)
                self.rack_by_id[rid] = rack
        self.copper_star = {}
        for r, ids in self.rows.items():
            for rid in ids:
                if self.rack_by_id[rid]["starCenter"]:
                    self.copper_star[r] = rid
        self.mm_star = self.copper_star["1"]
        self.sm_star = self.copper_star["2"] if "2" in self.copper_star else self.copper_star["1"]
        self.rack_by_id[self.mm_star]["starCenter"].append("mm")
        if "sm" not in self.rack_by_id[self.sm_star]["starCenter"]:
            self.rack_by_id[self.sm_star]["starCenter"].append("sm")
        for r, sid in self.copper_star.items():
            rk = self.rack_by_id[sid]
            parts = ["Cu row %s" % r] + [m.upper() for m in rk["starCenter"] if m != "copper"]
            rk["name"] = "Star Center %s (%s)" % (chr(64 + int(r)), " + ".join(parts))
            mgmt = "SW-MGMT-%02d" % int(r)
            rk["mgmtSwitch"] = mgmt
        for rack in self.racks:
            for it in rack["items"]:
                if it["kind"] == "device":
                    self.dev_index[it["label"]] = (rack["id"], it)
                    self.dev_used[it["label"]] = set()

    def row_of(self, rid):
        return str(self.rack_by_id[rid]["row"])

    # -- logical connections ------------------------------------------------
    def plan(self):
        """Return logical connections: dict(a, b, medium, kind, status)."""
        conns = []
        rnd = self.rnd

        def add(a, b, medium, kind="structured", status=None):
            if a not in self.dev_index and not a.startswith(("PDU:", "DOOR", "CAM", "PROVIDER")):
                return
            if b not in self.dev_index and not b.startswith(("PDU:", "DOOR", "CAM", "PROVIDER", "SW-MGMT")):
                return
            if status is None:
                status = "existing" if rnd.random() < 0.55 else "proposed"
            conns.append({"a": a, "b": b, "medium": medium, "kind": kind, "status": status})

        labels = list(self.dev_index.keys())
        access = {"1": ["SW-ACCESS-01", "SW-ACCESS-02"], "2": ["SW-ACCESS-03", "SW-ACCESS-04"]}
        cores = ["SW-CORE-01", "SW-CORE-02"]
        hosts = [l for l in labels if self.dev_index[l][1]["type"] in ("server", "storage", "chassis", "appliance", "wlc")]
        for h in hosts:
            rid, it = self.dev_index[h]
            row = self.row_of(rid)
            sw = access.get(row, access["1"])
            if self.rack_by_id[rid]["name"].startswith("Lab"):
                sw = ["SW-LAB-01", "SW-LAB-01"]
            elif self.rack_by_id[rid]["name"].startswith("Backup"):
                sw = access["1"]                                    # deliberately cross-row
            for i in range(min(it.get("ports", 0), 2)):
                add(h, sw[i % 2], "copper")
        # fiber uplinks
        for sw in access["1"] + access["2"] + ["SW-EDGE-01", "SW-LAB-01"]:
            if sw not in self.dev_index:
                continue
            for i in range(min(self.dev_index[sw][1].get("uplinks", 0), 4)):
                add(sw, cores[i % 2], "mm")
        for h in hosts:
            it = self.dev_index[h][1]
            if it.get("uplinks") and it.get("uplinkMedium") == "mm" and not h.startswith(("CHS-", "SRV-HV-01")):
                for i in range(min(it["uplinks"], 2)):
                    add(h, cores[i % 2], "mm")
        for fw in ("FW-EDGE-01", "FW-EDGE-02"):
            add(fw, "SW-CORE-01", "mm"); add(fw, "SW-CORE-02", "mm"); add(fw, "SW-EDGE-01", "mm")
        # single-mode: core router <-> edge routers, edge routers -> provider room
        add("RTR-CORE-01", "RTR-EDGE-01", "sm"); add("RTR-CORE-01", "RTR-EDGE-02", "sm")
        for r in ("RTR-EDGE-01", "RTR-EDGE-02"):
            add(r, "PROVIDER-ROOM", "sm", "exit")
            add(r, "PROVIDER-ROOM", "sm", "exit")
        add("SW-EDGE-01", "PROVIDER-ROOM", "copper", "exit")
        # active (fixed-length, tray, no patch panels)
        add("CHS-VIRT-01", "SW-CORE-01", "mm", "active", "proposed")
        add("CHS-VIRT-01", "SW-CORE-02", "mm", "active", "proposed")
        add("CHS-LAB-01", "SW-CORE-02", "mm", "active", "existing")
        add("SRV-HV-01", "STG-BKP-01", "mm", "active", "proposed")
        # in-rack direct
        add("FW-EDGE-01", "FW-EDGE-02", "copper", "direct", "existing")
        add("SW-CORE-01", "SW-CORE-02", "copper", "direct", "existing")
        add("TAP-01", "APP-IPS-01", "copper", "direct", "existing")
        add("TAP-01", "FW-EDGE-01", "copper", "direct", "proposed")
        add("TAP-02", "SRV-MON-01", "copper", "direct", "existing")
        # management of every device
        for l in labels:
            it = self.dev_index[l][1]
            if it.get("mgmt", True) is False:
                continue
            row = self.row_of(self.dev_index[l][0])
            add(l, "SW-MGMT-%02d" % int(row), "copper", "mgmt")
        # PDU management (one port per rack) + door / cameras
        for rack in self.racks:
            add("PDU:" + rack["id"], "SW-MGMT-%02d" % rack["row"], "copper", "pdu",
                "existing" if rnd.random() < 0.6 else "proposed")
        add("DOOR-CTRL-01", "SW-MGMT-01", "copper", "door", "existing")
        add("CAM-01", "SW-MGMT-01", "copper", "door", "existing")
        if "2" in self.copper_star:
            add("CAM-02", "SW-MGMT-02", "copper", "door", "proposed")
        # a few with an unknown far end -> pending
        add("SRV-SPARE-01", "SW-ACCESS-03", "copper", "structured", "pending")
        add("SRV-LAB-02", "SW-CORE-02", "copper", "structured", "pending")
        conns.sort(key=lambda c: 0 if c["status"] == "existing" else 1)
        return conns

    def rack_of(self, label):
        if label.startswith("PDU:"):
            return label[4:]
        if label.startswith("SW-MGMT"):
            return self.copper_star[str(int(label[-2:]))]
        if label in self.dev_index:
            return self.dev_index[label][0]
        return None

    # -- capacity -----------------------------------------------------------
    def star_for(self, medium, rid):
        if medium == "copper":
            return self.copper_star[self.row_of(rid)]
        return self.mm_star if medium == "mm" else self.sm_star

    def demand(self, conns):
        need = {r["id"]: {"copper": 0, "mm": 0, "sm": 0} for r in self.racks}
        inter = {}          # (row a, row b) -> copper cables between those rows
        exits = {"copper": 0, "sm": 0, "mm": 0}
        for c in conns:
            if c["kind"] in ("active", "direct"):
                continue
            ra, rb = self.rack_of(c["a"]), self.rack_of(c["b"])
            m = c["medium"]
            if c["kind"] == "pdu" or c["kind"] == "door":
                continue
            if c["kind"] == "exit":
                if ra != self.star_for(m, ra):
                    need[ra][m] += 1
                exits[m] += 1
                continue
            if ra == rb:
                continue
            for r in (ra, rb):
                if r != self.star_for(m, r):
                    need[r][m] += 1
            if m == "copper" and self.row_of(ra) != self.row_of(rb):
                key = tuple(sorted((self.row_of(ra), self.row_of(rb))))
                inter[key] = inter.get(key, 0) + 1
        return need, inter, exits

    def expand(self, need):
        """Insert new panels / cassettes where demand * 1.3 exceeds installed ports."""
        for rack in self.racks:
            if rack["starCenter"]:
                continue
            items = rack["items"]
            n_cu = math.ceil(need[rack["id"]]["copper"] * RESERVE)
            have_cu = sum(UTP_PORTS for it in items if it["kind"] == "utp" and it["role"] == "trunk")
            added = []
            while have_cu < n_cu:
                added.append(utp(new=True)); have_cu += UTP_PORTS
            for m in ("mm", "sm"):
                n = math.ceil(need[rack["id"]][m] * RESERVE)
                trays = [it for it in items + added if it["kind"] == "lc"]
                have = sum(CASSETTE_PORTS for t in trays for c in t["cassettes"] if c and c["medium"] == m)
                while have < n:
                    slot = None
                    for t in trays:
                        for i, c in enumerate(t["cassettes"]):
                            if c is None:
                                slot = (t, i); break
                        if slot:
                            break
                    if not slot:
                        t = lc([None] * SLOTS, new=True)
                        added.append(t); trays.append(t)
                        slot = (t, 0)
                    slot[0]["cassettes"][slot[1]] = {"medium": m, "isNew": True}
                    have += CASSETTE_PORTS
            if added:
                self._insert(rack, added)

    def _insert(self, rack, added):
        items = rack["items"]
        last_patch = 0
        while last_patch + 1 < len(items) and items[last_patch + 1]["kind"] in ("utp", "lc", "org"):
            last_patch += 1
        g = next((i for i in range(last_patch + 1, len(items)) if items[i]["kind"] == "gap"), None)
        if g is None or items[g]["u"] < len(added):
            self.notes.append("%s: not enough free U below the patching area for %d new item(s)." % (rack["id"], len(added)))
            g = g if g is not None else last_patch + 1
            items[g:g] = added
            return
        items[g]["u"] -= len(added)
        if items[g]["u"] == 0:
            items.pop(g)
        items[g:g] = added

    def build_stars(self, need, inter, exits):
        for r, sid in self.copper_star.items():
            star = self.rack_by_id[sid]
            items = [org()]
            star["_cp"] = {}       # remote "R#P" -> star panel object
            for rid in self.rows[r]:
                if rid == sid:
                    continue
                for it in self.rack_by_id[rid]["items"]:
                    if it["kind"] == "utp" and it["role"] == "trunk":
                        cp = utp(new=bool(it.get("isNew")))
                        cp["_remote"] = (rid, it)
                        items.append(cp)
            for (ra, rb), count in sorted(inter.items()):
                if r not in (ra, rb):
                    continue
                other = rb if r == ra else ra
                for i in range(max(1, math.ceil(math.ceil(count * RESERVE) / UTP_PORTS))):
                    p = utp(new=i > 0); p["_interrow"] = other
                    items.append(p)
            items.append(org())
            items.append(utp("pdu"))
            items.append(utp("camera"))
            if exits["copper"] and r == "1":
                p = utp("exit"); items.append(p)
            items.append(org())
            # fiber counterparts
            for m in [x for x in star["starCenter"] if x != "copper"]:
                cass = []
                for rack in self.racks:
                    if rack["id"] == sid:
                        continue
                    for t in rack["items"]:
                        if t["kind"] != "lc" or t.get("role") == "exit":
                            continue
                        for ci, c in enumerate(t["cassettes"]):
                            if c and c["medium"] == m:
                                cass.append((rack["id"], t, ci, bool(c.get("isNew"))))
                for i in range(0, len(cass), SLOTS):
                    chunk = cass[i:i + SLOTS]
                    t = lc([None] * SLOTS)
                    t["_remote"] = []
                    for j, (rid, rt, ci, new) in enumerate(chunk):
                        t["cassettes"][j] = {"medium": m}
                        if new:
                            t["cassettes"][j]["isNew"] = True
                        t["_remote"].append((rid, rt, ci))
                    if all(c and c.get("isNew") for c in t["cassettes"] if c):
                        t["isNew"] = True
                    items.append(t)
                if m == "sm" and exits["sm"]:
                    t = lc(["sm", None, None, None], role="exit")
                    items.append(t)
            items.append(org())
            items.append(dev(star["mgmtSwitch"], "switch", 1, 48, 2, "mm", mgmt=False))
            star["items"] = items
            for it in items:
                if it["kind"] == "device":
                    self.dev_index[it["label"]] = (sid, it)
                    self.dev_used[it["label"]] = set()

    # -- naming / trunks ----------------------------------------------------
    def number(self):
        for rack in self.racks:
            p = f = 0
            used = 0
            for it in rack["items"]:
                if it["kind"] == "utp":
                    p += 1; it["id"] = "P%d" % p
                elif it["kind"] == "lc":
                    f += 1; it["id"] = "F%d" % f
                used += item_u(it)
            if used > RACK_U:
                raise SystemExit("%s uses %dU > %dU" % (rack["id"], used, RACK_U))
            if used < RACK_U:
                rack["items"].append(gap(RACK_U - used))
            # merge consecutive gaps
            merged = []
            for it in rack["items"]:
                if it["kind"] == "gap" and merged and merged[-1]["kind"] == "gap":
                    merged[-1]["u"] += it["u"]
                elif not (it["kind"] == "gap" and it["u"] <= 0):
                    merged.append(it)
            rack["items"] = merged

    def link_trunks(self):
        self.counter = {}   # "R#P" -> "S#Pn"  and "R#F.C" -> "S#F.C"
        for r, sid in self.copper_star.items():
            star = self.rack_by_id[sid]
            inter = {}
            for it in star["items"]:
                if "_remote" in it and it["kind"] == "utp":
                    rid, rit = it.pop("_remote")
                    a, b = "%s#%s" % (rid, rit["id"]), "%s#%s" % (sid, it["id"])
                    self.counter[a] = b; self.counter[b] = a
                    self.trunks.append({"medium": "copper", "a": a, "b": b})
                elif "_interrow" in it:
                    inter.setdefault(it.pop("_interrow"), []).append(it)
                elif "_remote" in it and it["kind"] == "lc":
                    for ci, (rid, rt, rci) in enumerate(it.pop("_remote")):
                        a = "%s#%s.C%d" % (rid, rt["id"], rci + 1)
                        b = "%s#%s.C%d" % (sid, it["id"], ci + 1)
                        self.counter[a] = b; self.counter[b] = a
                        self.trunks.append({"medium": it["cassettes"][ci]["medium"], "a": a, "b": b})
                elif it.get("role") == "exit":
                    if it["kind"] == "lc":
                        self.trunks.append({"medium": "sm", "a": "%s#%s.C1" % (sid, it["id"]), "b": "PROVIDER-ROOM"})
                    else:
                        self.trunks.append({"medium": "copper", "a": "%s#%s" % (sid, it["id"]), "b": "PROVIDER-ROOM"})
            star["_inter"] = inter
        self.inter_panels = {}   # (star a, star b) -> inter-row panels in star a toward star b
        rows_ = sorted(self.copper_star)
        for i, ra in enumerate(rows_):
            for rb in rows_[i + 1:]:
                a, b = self.rack_by_id[self.copper_star[ra]], self.rack_by_id[self.copper_star[rb]]
                pas, pbs = a["_inter"].get(rb, []), b["_inter"].get(ra, [])
                for pa, pb in zip(pas, pbs):
                    x, y = "%s#%s" % (a["id"], pa["id"]), "%s#%s" % (b["id"], pb["id"])
                    self.counter[x] = y; self.counter[y] = x
                    self.trunks.append({"medium": "copper", "a": x, "b": y, "interRow": True})
                self.inter_panels[(a["id"], b["id"])] = pas
                self.inter_panels[(b["id"], a["id"])] = pbs
        for rk in self.racks:
            rk.pop("_cp", None); rk.pop("_inter", None)

    # -- port assignment ----------------------------------------------------
    def dev_port(self, label, medium):
        if label not in self.dev_index:
            return None
        it = self.dev_index[label][1]
        pool = copper_ports(it) if medium == "copper" else fiber_ports(it)
        if medium != "copper" and it.get("uplinkMedium", "mm") != medium:
            pool = []
        for p in pool:
            if p not in self.dev_used[label]:
                self.dev_used[label].add(p)
                return p
        return None

    def mgmt_port(self, label):
        it = self.dev_index[label][1]
        if it.get("mgmt", True) and "mgmt" not in self.dev_used[label]:
            self.dev_used[label].add("mgmt")
            return "mgmt"
        return self.dev_port(label, "copper")

    def free_panel_port(self, rid, medium, roles=("trunk",), pair=None, cid=None, allow_new=True):
        rack = self.rack_by_id[rid]
        for it in rack["items"]:
            if it["kind"] not in ("utp", "lc") or it.get("role") not in roles:
                continue
            if it.get("isNew") and not allow_new:
                continue
            if medium == "copper" and it["kind"] != "utp":
                continue
            if medium != "copper" and it["kind"] != "lc":
                continue
            key = "%s#%s" % (rid, it["id"])
            used = self.port_used.setdefault(key, {})
            if it["kind"] == "utp":
                ports = range(1, UTP_PORTS + 1)
            else:
                ports = [ci * CASSETTE_PORTS + k + 1 for ci, c in enumerate(it["cassettes"])
                         if c and c["medium"] == medium and (allow_new or not c.get("isNew"))
                         for k in range(CASSETTE_PORTS)]
            for p in ports:
                if p in used:
                    continue
                if pair:
                    far = self.far(key, p)
                    if far is None:
                        continue
                    fk, fp = far
                    if fp in self.port_used.setdefault(fk, {}):
                        continue
                used[p] = cid
                return key, p
        return None

    def far(self, key, port):
        """Counterpart of panel port `key:port` across its trunk."""
        if "#F" in key:
            ci = (port - 1) // CASSETTE_PORTS + 1
            k = (port - 1) % CASSETTE_PORTS + 1
            other = self.counter.get("%s.C%d" % (key, ci))
            if not other:
                return None
            okey, oc = other.rsplit(".C", 1)
            return okey, (int(oc) - 1) * CASSETTE_PORTS + k
        other = self.counter.get(key)
        return (other, port) if other else None

    def take(self, key, port, cid):
        self.port_used.setdefault(key, {})[port] = cid

    def route(self, conns):
        n = 0
        for c in conns:
            n += 1
            cid = "c%d" % n
            a, b, m, kind = c["a"], c["b"], c["medium"], c["kind"]
            status = c["status"]
            ra, rb = self.rack_of(a), self.rack_of(b)
            hops = []
            ok = True
            allow_new = status != "existing"

            def leg(rid):
                """Reserve a trunk port in rid toward its star; return (rack hop, star hop)."""
                got = self.free_panel_port(rid, m, pair=True, cid=cid, allow_new=allow_new)
                if not got and not allow_new:
                    got = self.free_panel_port(rid, m, pair=True, cid=cid, allow_new=True)
                if not got:
                    return None
                key, p = got
                fk, fp = self.far(key, p)
                self.take(fk, fp, cid)
                new = self.is_new(key, p) or self.is_new(fk, fp)
                return ["%s:%d" % (key, p), "%s:%d" % (fk, fp)], new

            touches_new = False
            if kind in ("structured", "mgmt", "exit") and ra != rb:
                star_a = self.star_for(m, ra)
                star_b = self.star_for(m, rb) if rb else star_a
                left, right = [], []
                if ra != star_a:
                    r = leg(ra)
                    if r is None:
                        ok = False
                    else:
                        left, nw = r; touches_new |= nw
                if kind == "exit":
                    got = self.free_panel_port(star_a, m, roles=("exit",), cid=cid)
                    if got:
                        right = ["%s:%d" % got]
                    else:
                        ok = False
                else:
                    if rb != star_b:
                        r = leg(rb)
                        if r is None:
                            ok = False
                        else:
                            right, nw = r; touches_new |= nw
                            right = right[::-1]
                    if m == "copper" and star_a != star_b:
                        got = self.inter_port(star_a, star_b, cid)
                        if got:
                            left = left + got[0]
                            touches_new |= got[1]
                        else:
                            ok = False
                hops = left + right
            elif kind in ("pdu", "door"):
                star = self.copper_star[str(int(b[-2:]))]
                if ra != star:
                    got = self.free_panel_port(star, m, roles=("pdu",) if kind == "pdu" else ("camera",), cid=cid)
                    if got:
                        hops = ["%s:%d" % got]
                    else:
                        ok = False
            pa = "NET" if a.startswith("PDU:") else ("eth0" if a.startswith(("DOOR", "CAM")) else
                                                     (self.mgmt_port(a) if kind == "mgmt" else self.dev_port(a, m)))
            if b == "PROVIDER-ROOM":
                pb = "HANDOFF-%d" % (len([x for x in self.cables if x["b"]["item"] == "PROVIDER-ROOM"]) + 1)
            else:
                pb = self.dev_port(b, m)
            if pa is None or pb is None or not ok:
                status = "pending"
            elif touches_new and status == "existing":
                status = "proposed"
            cab = {"id": cid, "medium": m, "kind": kind, "a": {"item": a, "port": pa or "?"},
                   "hops": hops, "b": {"item": b, "port": pb or "?"}, "status": status}
            if kind == "active":
                cab["note"] = "Fixed-length active cable laid in the tray (cannot pass through patch panels)."
            self.cables.append(cab)

    def inter_port(self, star_a, star_b, cid):
        for pa in self.inter_panels.get((star_a, star_b), []):
            key = "%s#%s" % (star_a, pa["id"])
            used = self.port_used.setdefault(key, {})
            for p in range(1, UTP_PORTS + 1):
                if p in used:
                    continue
                fk, fp = self.far(key, p)
                if fp in self.port_used.setdefault(fk, {}):
                    continue
                used[p] = cid
                self.take(fk, fp, cid)
                return ["%s:%d" % (key, p), "%s:%d" % (fk, fp)], bool(pa.get("isNew"))
        return None

    def is_new(self, key, port):
        rid, pid = key.split("#")
        for it in self.rack_by_id[rid]["items"]:
            if it.get("id") == pid:
                if it.get("isNew"):
                    return True
                if it["kind"] == "lc":
                    c = it["cassettes"][(port - 1) // CASSETTE_PORTS]
                    return bool(c and c.get("isNew"))
        return False

    # -- summary ------------------------------------------------------------
    def summary(self):
        s = {"newUtpPanels": 0, "newLcTrays": 0, "newCassettes": {"mm": 0, "sm": 0}, "newTrunks": 0,
             "activeCables": 0, "transceivers": 0}
        for rack in self.racks:
            for it in rack["items"]:
                if it["kind"] == "utp" and it.get("isNew"):
                    s["newUtpPanels"] += 1
                if it["kind"] == "lc":
                    if it.get("isNew"):
                        s["newLcTrays"] += 1
                    for c in it["cassettes"]:
                        if c and c.get("isNew"):
                            s["newCassettes"][c["medium"]] += 1
        news = set()
        for rack in self.racks:
            for it in rack["items"]:
                if it.get("id"):
                    key = "%s#%s" % (rack["id"], it["id"])
                    if it.get("isNew"):
                        news.add(key)
                    if it["kind"] == "lc":
                        for ci, c in enumerate(it["cassettes"]):
                            if c and c.get("isNew"):
                                news.add("%s.C%d" % (key, ci + 1))
        s["newTrunks"] = sum(1 for t in self.trunks if t["a"] in news or t["b"] in news)
        for c in self.cables:
            if c["kind"] == "active" and c["status"] != "existing":
                s["activeCables"] += 1
            if c["medium"] != "copper" and c["status"] == "proposed":
                s["transceivers"] += 2
        return s


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rows", type=int, default=2, help="number of rows (1-4)")
    ap.add_argument("--per-row", type=int, default=8, help="racks per row (4-12)")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "sample-data.js"))
    args = ap.parse_args()
    if not 1 <= args.rows <= 4 or not 4 <= args.per_row <= 12:
        raise SystemExit("rows must be 1-4 and per-row 4-12")

    g = Gen(args.rows, args.per_row, args.seed)
    g.build_racks()
    conns = g.plan()
    need, inter, exits = g.demand(conns)
    g.expand(need)
    g.build_stars(need, inter, exits)
    g.number()
    g.link_trunks()
    g.route(conns)

    data = {
        "meta": {"title": "Sample data hall (fictitious)", "generator": "tools/generate_sample.py",
                 "seed": args.seed, "reserve": RESERVE},
        "room": {"coldAisle": 1.2, "hotAisle": 1.0, "rackHeight": 2.0,
                 "trayHeights": {"copper": 2.3, "fiber": 2.5}, "crossTrays": [1.2, 4.2]},
        # power budget per rack (kW, a rack can override it with "powerKw"), cold-aisle
        # temperature and the fan airflow per kW the exhaust estimate assumes
        "power": {"rackKw": 5, "inletC": 22, "cfmPerKw": 120},
        "starCenters": {"copper": list(g.copper_star.values()), "mm": g.mm_star, "sm": g.sm_star},
        "rows": g.rows,
        "racks": [{k: v for k, v in r.items() if not k.startswith("_")} for r in g.racks],
        "externals": [
            {"id": "DOOR-CTRL-01", "type": "door", "label": "Door access controller", "place": "door"},
            {"id": "CAM-01", "type": "camera", "label": "Ceiling camera (door end)", "place": "ceiling-door"},
            {"id": "CAM-02", "type": "camera", "label": "Ceiling camera (far end)", "place": "ceiling-far"},
            {"id": "PROVIDER-ROOM", "type": "provider", "label": "Provider room (outside this model)", "place": "portal"},
        ],
        "trunks": g.trunks,
        "cables": g.cables,
        "notes": g.notes,
        "summary": g.summary(),
    }
    js = ("// Generated by tools/generate_sample.py - FICTITIOUS SAMPLE DATA. Do not put real data in this file.\n"
          "window.DC_DATA = " + json.dumps(data, indent=1) + ";\n")
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(js)
    s = data["summary"]
    print("wrote %s" % out)
    print("  racks %d | cables %d | trunks %d" % (len(g.racks), len(g.cables), len(g.trunks)))
    print("  new: %d UTP panels, %d LC trays, %d MM + %d SM cassettes, %d trunks" % (
        s["newUtpPanels"], s["newLcTrays"], s["newCassettes"]["mm"], s["newCassettes"]["sm"], s["newTrunks"]))
    print("  pending cables: %d" % sum(1 for c in g.cables if c["status"] == "pending"))


if __name__ == "__main__":
    main()
