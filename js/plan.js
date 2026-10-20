/* racks3d — planning helpers with no 3D in them, so the tests can run them under node.
 * Validation of a data set, power and heat per rack, free ports, "where does it fit?",
 * and the inventory CSV. Loaded as a classic script (window.Racks3dPlan) or with require().
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Racks3dPlan = api;
})(this, function () {
  'use strict';

  const RACK_U = 42, UTP_PORTS = 24, CASS_PORTS = 12, SLOTS = 4;
  const TYPES = ['switch', 'router', 'firewall', 'server', 'storage', 'chassis', 'appliance', 'tap', 'wlc'];
  const SWITCHLIKE = new Set(['switch', 'router', 'firewall', 'tap', 'wlc']);
  const KINDS = ['device', 'utp', 'lc', 'org', 'gap'];

  // ------------------------------------------------------------------ layout
  // Items are listed top → bottom; the U positions follow from their order and sizes.
  const sizeOf = it => (it.kind === 'device' || it.kind === 'gap') ? Math.max(1, it.u || 1) : 1;
  function layout(rack) {
    let top = RACK_U;
    const out = [];
    (rack.items || []).filter(Boolean).forEach(it => {
      if (it._implicit) return;                       // the trailing gap the 3D view adds
      const u = sizeOf(it);
      out.push({ it, u, top, bottom: top - u + 1 });
      top -= u;
    });
    if (top > 0) out.push({ it: { kind: 'gap', u: top }, u: top, top, bottom: 1, implicit: true });
    return { slots: out, overflow: Math.max(0, -top) };
  }
  // Free runs of U, largest first: [{top, bottom, u}]
  function freeRuns(rack) {
    const runs = [];
    let cur = null;
    layout(rack).slots.forEach(s => {
      if (s.it.kind === 'gap') {
        if (cur && cur.bottom === s.top + 1) { cur.bottom = s.bottom; cur.u += s.u; }
        else { cur = { top: s.top, bottom: s.bottom, u: s.u }; runs.push(cur); }
      } else cur = null;
    });
    return runs.sort((a, b) => b.u - a.u || b.top - a.top);
  }

  // ------------------------------------------------------------------ ports
  const parseHop = h => { const i = h.lastIndexOf(':'); return { key: h.slice(0, i), port: parseInt(h.slice(i + 1), 10) }; };
  function panels(data) {
    const map = {};
    (data.racks || []).forEach(r => {
      let p = 0, f = 0;
      (r.items || []).forEach(it => {
        if (!it) return;
        if (it.kind === 'utp') { p++; map[r.id + '#' + (it.id || 'P' + p)] = { rack: r, it }; }
        if (it.kind === 'lc') { f++; map[r.id + '#' + (it.id || 'F' + f)] = { rack: r, it }; }
      });
    });
    return map;
  }
  // "R1-03#P1:5" → cable ids using that panel port
  function portUse(data) {
    const use = {};
    (data.cables || []).forEach(c => (c.hops || []).forEach(h => { (use[h] = use[h] || []).push(c.id); }));
    return use;
  }
  // Free patching ports in a rack: copper on its trunk UTP panels, fiber per medium on its
  // cassettes, and the empty cassette slots of its trays. In a star center the trunked panels
  // are the far ends of other racks' trunks, not ports a device in this rack can use.
  function freePorts(rack, data, use) {
    use = use || portUse(data);
    const out = { copper: 0, mm: 0, sm: 0, emptySlots: 0 };
    const star = isStar(rack), farEnd = new Set();
    if (star) (data.trunks || []).forEach(t => { farEnd.add(t.a); farEnd.add(t.b); });
    let p = 0, f = 0;
    (rack.items || []).forEach(it => {
      if (!it) return;
      if (it.kind === 'utp') {
        p++;
        if (it.role && it.role !== 'trunk') return;
        const key = rack.id + '#' + (it.id || 'P' + p);
        if (farEnd.has(key)) return;
        for (let n = 1; n <= UTP_PORTS; n++) if (!use[key + ':' + n]) out.copper++;
      }
      if (it.kind === 'lc') {
        f++;
        const key = rack.id + '#' + (it.id || 'F' + f);
        for (let ci = 0; ci < SLOTS; ci++) {
          const c = (it.cassettes || [])[ci];
          if (!c) { out.emptySlots++; continue; }
          if (farEnd.has(key + '.C' + (ci + 1))) continue;
          const m = c.medium === 'sm' ? 'sm' : 'mm';
          for (let k = 1; k <= CASS_PORTS; k++) if (!use[key + ':' + (ci * CASS_PORTS + k)]) out[m]++;
        }
      }
    });
    return out;
  }

  // ------------------------------------------------------------------ power and heat
  // Typical draw of the generic equipment types, in watts. Servers and storage scale with
  // their height; anything can override it with `watts` in the data.
  const TYPE_WATTS = { switch: 180, router: 350, firewall: 250, server: 280, storage: 380, chassis: 900, appliance: 150, tap: 60, wlc: 120 };
  const PER_U = new Set(['server', 'storage']);
  const POWER_DEFAULTS = { rackKw: 5, inletC: 22, cfmPerKw: 120 };
  const powerOf = data => Object.assign({}, POWER_DEFAULTS, (data && data.power) || {});
  function watts(it) {
    if (!it || it.kind !== 'device') return 0;
    if (typeof it.watts === 'number') return it.watts;
    const w = TYPE_WATTS[it.type] || 150;
    return PER_U.has(it.type) ? w * Math.max(1, it.u || 1) : w;
  }
  // Load against the rack's budget, split over its A and B feeds, and an estimate of the
  // exhaust temperature: the fans are sized for the budget (cfmPerKw), and the sensible-heat
  // rule ΔT(°F) = 3.16 × W / CFM is ΔT(°C) = 1.76 × W / CFM.
  function rackPower(rack, data) {
    const P = powerOf(data);
    const w = (rack.items || []).reduce((s, it) => s + watts(it), 0);
    const budget = (rack.powerKw || P.rackKw) * 1000;
    const util = budget ? w / budget : 0;
    const dT = budget ? 1.76 * w / (P.cfmPerKw * budget / 1000) : 0;
    return {
      w, budget, util, feedA: w / 2, feedB: w / 2,
      inletC: P.inletC, exhaustC: P.inletC + dT,
      // 2N feeds: each must be able to carry the whole rack alone if the other fails
      status: util > 1 ? 'over' : util > 0.8 ? 'high' : 'ok',
    };
  }

  // ------------------------------------------------------------------ where does it fit?
  // need: { u, copper, fiber, medium: 'mm' | 'sm', watts }
  // For each rack: does the device fit as things are, fit once a panel or cassette is
  // added, or not at all, and why.
  const RANK = { fits: 0, add: 1, no: 2 };
  const isStar = r => (Array.isArray(r.starCenter) ? r.starCenter.length : r.starCenter) ? 1 : 0;
  function findFit(data, need) {
    const use = portUse(data);
    const n = Object.assign({ u: 1, copper: 0, fiber: 0, medium: 'mm', watts: 0 }, need);
    return (data.racks || []).map(r => {
      const runs = freeRuns(r), free = freePorts(r, data, use), pw = rackPower(r, data);
      const add = [], why = [];
      let extraU = 0;
      if (n.copper > free.copper) {
        const panelsNeeded = Math.ceil((n.copper - free.copper) / UTP_PORTS);
        add.push(panelsNeeded + ' × 24-port UTP panel (' + panelsNeeded + 'U)');
        extraU += panelsNeeded;
      }
      const freeFiber = free[n.medium === 'sm' ? 'sm' : 'mm'];
      if (n.fiber > freeFiber) {
        let cass = Math.ceil((n.fiber - freeFiber) / CASS_PORTS);
        const inSlots = Math.min(cass, free.emptySlots);
        if (inSlots) add.push(inSlots + ' × ' + n.medium.toUpperCase() + ' cassette in an empty slot');
        cass -= inSlots;
        if (cass) {
          const trays = Math.ceil(cass / SLOTS);
          add.push(trays + ' × fiber tray with ' + cass + ' ' + n.medium.toUpperCase() + ' cassette(s) (' + trays + 'U)');
          extraU += trays;
        }
      }
      const largest = runs[0] ? runs[0].u : 0;
      const totalFree = runs.reduce((s, x) => s + x.u, 0);
      // the device needs one free run of its own height; new panels can go in any other free U
      const devRun = runs.find(x => x.u >= n.u);
      const roomForAdds = devRun ? totalFree - n.u >= extraU : false;
      const after = pw.w + n.watts;
      if (!devRun) why.push(largest ? 'largest free space is ' + largest + 'U' : 'no free U');
      else if (!roomForAdds) why.push('no U left for the ' + extraU + 'U of new patching');
      if (after > pw.budget) why.push('power ' + (after / 1000).toFixed(1) + ' kW would exceed the ' + (pw.budget / 1000).toFixed(1) + ' kW budget');
      const status = why.length ? 'no' : add.length ? 'add' : 'fits';
      return {
        rack: r, status, why, add, run: devRun || null, largest, free,
        powerAfter: after, budget: pw.budget, headroom: pw.budget - after,
      };
    // best first: fits, then fits with additions; star centers (patching racks) after the
    // others; then the rack with the most power to spare
    }).sort((a, b) => RANK[a.status] - RANK[b.status] || isStar(a.rack) - isStar(b.rack) || b.headroom - a.headroom);
  }

  // ------------------------------------------------------------------ route a new cable
  // Suggests the hops for a new cable between two devices: patch into a trunk panel in the
  // first device's rack, follow trunks with the same port free at both ends (crossing
  // connect in a star center), and patch out to the second device. Fewest trunks first.
  // Returns { ok, medium, a, b, hops, legs, why }.
  function deviceRack(data, label) {
    for (const r of data.racks || []) for (const it of r.items || []) if (it && it.kind === 'device' && it.label === label) return { rack: r, it };
    return null;
  }
  // the next free port of a device on that medium, named like the ports already cabled
  function freeDevicePort(data, label, it, fiber) {
    const used = new Set();
    (data.cables || []).forEach(c => [c.a, c.b].forEach(e => { if (e && e.item === label) used.add(String(e.port)); }));
    const sw = SWITCHLIKE.has(it.type);
    const name = k => sw ? (fiber ? '1/1/' : '1/0/') + k : (fiber ? 'fib' : 'eth') + (k - 1);
    const max = fiber ? (sw ? it.uplinks || 0 : Math.max(2, it.uplinks || 0)) : Math.max(sw ? it.ports || 0 : 2, it.ports || 0);
    for (let k = 1; k <= max; k++) if (!used.has(name(k))) return name(k);
    return null;
  }
  function suggestRoute(data, fromLabel, toLabel, medium) {
    medium = medium === 'mm' || medium === 'sm' ? medium : 'copper';
    const fiber = medium !== 'copper', out = { ok: false, medium, hops: [], legs: [], why: [] };
    const A = deviceRack(data, fromLabel), B = deviceRack(data, toLabel);
    if (!A || !B) { out.why.push((!A ? fromLabel : toLabel) + ' is not a device.'); return out; }
    if (A.it === B.it) { out.why.push('Pick two different devices.'); return out; }
    const pa = freeDevicePort(data, fromLabel, A.it, fiber), pb = freeDevicePort(data, toLabel, B.it, fiber);
    if (!pa) out.why.push(fromLabel + ' has no free ' + (fiber ? 'fiber' : 'copper') + ' port.');
    if (!pb) out.why.push(toLabel + ' has no free ' + (fiber ? 'fiber' : 'copper') + ' port.');
    out.a = { item: fromLabel, port: pa || '?' }; out.b = { item: toLabel, port: pb || '?' };
    if (A.rack === B.rack) {
      out.ok = !out.why.length;
      out.legs.push({ type: 'patch', text: 'patch cord inside ' + A.rack.id });
      return out;
    }
    // the trunks of this medium, each end with its panel and the port numbers it carries
    const P = panels(data), use = portUse(data);
    const end = ref => {
      const m = /^(.*#F\d+)\.C(\d+)$/.exec(ref);
      if (m) {
        const p = P[m[1]], ci = +m[2] - 1, cas = p && (p.it.cassettes || [])[ci];
        return cas ? { rack: p.rack, ports: k => m[1] + ':' + (ci * CASS_PORTS + k), n: CASS_PORTS, medium: cas.medium === 'sm' ? 'sm' : 'mm' } : null;
      }
      const p = P[ref];
      return p && p.it.kind === 'utp' && (!p.it.role || p.it.role === 'trunk') ? { rack: p.rack, ports: k => ref + ':' + k, n: UTP_PORTS, medium: 'copper' } : null;
    };
    const edges = [];
    (data.trunks || []).forEach(t => {
      const a = end(t.a), b = end(t.b);
      if (!a || !b || a.medium !== medium || b.medium !== medium) return;
      // first port number free at both ends
      let k = 0;
      for (let i = 1; i <= Math.min(a.n, b.n); i++) if (!use[a.ports(i)] && !use[b.ports(i)]) { k = i; break; }
      if (!k) return;
      edges.push({ from: a.rack, to: b.rack, hops: [a.ports(k), b.ports(k)], free: k });
      edges.push({ from: b.rack, to: a.rack, hops: [b.ports(k), a.ports(k)], free: k });
    });
    // breadth first over racks, fewest trunks first
    const prev = new Map([[A.rack, null]]), queue = [A.rack];
    while (queue.length && !prev.has(B.rack)) {
      const r = queue.shift();
      if (r !== A.rack && !isStar(r)) continue;        // cross-connects happen in star centers only
      edges.filter(e => e.from === r && !prev.has(e.to)).forEach(e => { prev.set(e.to, e); queue.push(e.to); });
    }
    if (!prev.has(B.rack)) {
      out.why.push('No ' + (fiber ? medium.toUpperCase() + ' fiber' : 'copper') + ' trunks with a free port join ' + A.rack.id + ' and ' + B.rack.id + '.');
      return out;
    }
    const path = [];
    for (let e = prev.get(B.rack); e; e = prev.get(e.from)) path.unshift(e);
    out.legs.push({ type: 'patch', text: 'patch cord in ' + A.rack.id });
    path.forEach((e, i) => {
      if (i) out.legs.push({ type: 'cross', text: 'cross-connect in ' + e.from.id });
      out.legs.push({ type: 'trunk', text: 'trunk ' + e.from.id + ' → ' + e.to.id });
      out.hops.push(...e.hops);
    });
    out.legs.push({ type: 'patch', text: 'patch cord in ' + B.rack.id });
    out.ok = !out.why.length;
    return out;
  }

  // ------------------------------------------------------------------ validation
  // Checks a data set before it is drawn: anything in `errors` would draw wrongly or break
  // a trace; `warnings` are worth a look but harmless.
  function validate(data) {
    const errors = [], warnings = [];
    if (!data || !Array.isArray(data.racks) || !data.racks.length) return { errors: ['No racks in the data.'], warnings };
    const rackIds = new Set(), labels = new Set(), ext = new Set((data.externals || []).map(e => e.id));
    data.racks.forEach(r => {
      if (!r.id) { errors.push('A rack has no id.'); return; }
      if (rackIds.has(r.id)) errors.push('Rack ' + r.id + ' appears twice.');
      rackIds.add(r.id);
      const L = layout(r);
      if (L.overflow) errors.push(r.id + ' uses ' + (RACK_U + L.overflow) + 'U, more than its ' + RACK_U + 'U.');
      const ids = new Set();
      (r.items || []).forEach(it => {
        if (!it) return;
        if (!KINDS.includes(it.kind)) { errors.push(r.id + ': unknown item kind "' + it.kind + '".'); return; }
        if (it.kind === 'device') {
          if (!it.label) errors.push(r.id + ': a device has no label.');
          else if (labels.has(it.label)) errors.push('Device ' + it.label + ' appears twice.');
          labels.add(it.label);
          if (!TYPES.includes(it.type)) warnings.push(it.label + ': unknown type "' + it.type + '", drawn as a generic device.');
          if (it.u != null && !(Number.isInteger(it.u) && it.u >= 1)) errors.push(it.label + ': height must be a whole number of U.');
        }
        if (it.id && (it.kind === 'utp' || it.kind === 'lc')) {
          if (ids.has(it.id)) errors.push(r.id + ': panel ' + it.id + ' appears twice.');
          ids.add(it.id);
        }
      });
    });
    const listed = new Set();
    Object.keys(data.rows || {}).forEach(k => (data.rows[k] || []).forEach(id => {
      if (!rackIds.has(id)) errors.push('Row ' + k + ' lists rack ' + id + ', which does not exist.');
      listed.add(id);
    }));
    data.racks.forEach(r => { if (r.id && !listed.has(r.id) && r.row == null) warnings.push(r.id + ' is in no row; it is placed in a row of its own.'); });

    const P = panels(data);
    const cassette = ref => {
      const m = /^(.*#F\d+)\.C(\d+)$/.exec(ref);
      if (!m) return null;
      const p = P[m[1]];
      return p && (p.it.cassettes || [])[+m[2] - 1] ? p : false;
    };
    const trunkOf = {};
    (data.trunks || []).forEach(t => {
      [t.a, t.b].forEach(ref => {
        const ok = ext.has(ref) || (cassette(ref) === null ? !!P[ref] : !!cassette(ref));
        if (!ok) errors.push('Trunk ' + t.a + ' ↔ ' + t.b + ': ' + ref + ' does not exist.');
      });
      trunkOf[t.a] = t.b; trunkOf[t.b] = t.a;
    });

    const used = {};
    const tkey = h => {
      const { key, port } = parseHop(h), p = P[key];
      return p && p.it.kind === 'lc' ? key + '.C' + (Math.floor((port - 1) / CASS_PORTS) + 1) : key;
    };
    (data.cables || []).forEach(c => {
      const name = 'Cable ' + c.id;
      [c.a, c.b].forEach(e => {
        if (!e || !e.item) { errors.push(name + ': an end is missing.'); return; }
        const item = e.item;
        const ok = labels.has(item) || ext.has(item) || (/^PDU:/.test(item) && rackIds.has(item.slice(4)));
        if (!ok) errors.push(name + ': ' + item + ' is not a device, PDU or external element.');
      });
      const hops = c.hops || [];
      hops.forEach(h => {
        const { key, port } = parseHop(h), p = P[key];
        if (!p) { errors.push(name + ': hop ' + h + ' is on a panel that does not exist.'); return; }
        const max = p.it.kind === 'utp' ? UTP_PORTS : SLOTS * CASS_PORTS;
        if (!(port >= 1 && port <= max)) { errors.push(name + ': hop ' + h + ' is not a port of that panel.'); return; }
        if (p.it.kind === 'lc' && !(p.it.cassettes || [])[Math.floor((port - 1) / CASS_PORTS)]) errors.push(name + ': hop ' + h + ' is in an empty cassette slot.');
        if (used[h]) errors.push('Port ' + h + ' is used by both ' + used[h] + ' and ' + c.id + '.');
        used[h] = c.id;
      });
      // two hops in different racks must be the two ends of one trunk
      for (let i = 1; i < hops.length; i++) {
        const a = P[parseHop(hops[i - 1]).key], b = P[parseHop(hops[i]).key];
        if (!a || !b || a.rack === b.rack) continue;
        if (trunkOf[tkey(hops[i - 1])] !== tkey(hops[i])) warnings.push(name + ': ' + hops[i - 1] + ' → ' + hops[i] + ' crosses between racks without a trunk.');
      }
    });
    return { errors, warnings };
  }

  // ------------------------------------------------------------------ inventory CSV
  // One line per item, in its rack, with the U it starts at (its top U). A line with no
  // kind just declares a rack. Cables and trunks are not part of the CSV.
  const CSV_COLS = ['rack', 'row', 'rack_name', 'width', 'depth', 'rack_kw', 'u_top', 'kind', 'label', 'type', 'u', 'ports', 'uplinks', 'uplink_medium', 'watts', 'role', 'cassettes', 'new'];
  const cell = s => { s = s == null ? '' : String(s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function toCsv(data) {
    const lines = [CSV_COLS.join(',')];
    const rowOf = {};
    Object.keys(data.rows || {}).forEach(k => (data.rows[k] || []).forEach(id => { rowOf[id] = k; }));
    (data.racks || []).forEach(r => {
      const head = [r.id, rowOf[r.id] || r.row || '', r.name || '', r.width || 600, r.depth || 1000, r.powerKw || ''];
      const slots = layout(r).slots.filter(s => s.it.kind !== 'gap');
      if (!slots.length) lines.push(head.concat(new Array(CSV_COLS.length - head.length).fill('')).map(cell).join(','));
      slots.forEach(({ it, top }) => {
        const isDev = it.kind === 'device';
        lines.push(head.concat([
          top, it.kind, isDev ? it.label : it.id || '', isDev ? it.type : '', isDev ? it.u || 1 : '',
          isDev ? it.ports || 0 : '', isDev ? it.uplinks || '' : '', isDev && it.uplinks ? it.uplinkMedium || 'mm' : '',
          isDev && typeof it.watts === 'number' ? it.watts : '', it.kind === 'utp' || it.kind === 'lc' ? it.role || 'trunk' : '',
          it.kind === 'lc' ? (it.cassettes || []).map(c => c ? c.medium : '').join('|') : '', it.isNew ? 'yes' : '',
        ]).map(cell).join(','));
      });
    });
    return lines.join('\n') + '\n';
  }
  function parseCsvText(text) {
    const rows = [];
    let row = [], f = '', q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { f += '"'; i++; }
        else if (ch === '"') q = false;
        else f += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',' || ch === ';') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(f); f = '';
        if (row.some(x => x.trim() !== '')) rows.push(row);
        row = [];
      } else f += ch;
    }
    row.push(f);
    if (row.some(x => x.trim() !== '')) rows.push(row);
    return rows;
  }
  // CSV text → a data set (racks, rows, meta). Returns { data, errors }.
  function fromCsv(text, title) {
    const rows = parseCsvText(text), errors = [];
    if (!rows.length) return { data: null, errors: ['The file is empty.'] };
    const head = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
    ['rack', 'u_top', 'kind'].forEach(c => { if (!head.includes(c)) errors.push('Missing column "' + c + '".'); });
    if (errors.length) return { data: null, errors };
    const get = (r, c) => { const i = head.indexOf(c); return i < 0 ? '' : (r[i] || '').trim(); };
    const num = (s, d) => { const n = parseFloat(s); return isNaN(n) ? d : n; };
    const racks = [], byId = {}, rowsMap = {};
    rows.slice(1).forEach((r, li) => {
      const line = li + 2, id = get(r, 'rack');
      if (!id) { errors.push('Line ' + line + ': no rack.'); return; }
      let rack = byId[id];
      if (!rack) {
        rack = byId[id] = { id, name: get(r, 'rack_name') || id, width: num(get(r, 'width'), 600), depth: num(get(r, 'depth'), 1000), row: get(r, 'row') || '1', _list: [] };
        if (get(r, 'rack_kw')) rack.powerKw = num(get(r, 'rack_kw'), undefined);
        racks.push(rack);
        (rowsMap[rack.row] = rowsMap[rack.row] || []).push(id);
      }
      const kind = get(r, 'kind').toLowerCase();
      if (!kind) return;
      if (!['device', 'utp', 'lc', 'org'].includes(kind)) { errors.push('Line ' + line + ': unknown kind "' + kind + '" (device, utp, lc or org).'); return; }
      const top = parseInt(get(r, 'u_top'), 10);
      if (!(top >= 1 && top <= RACK_U)) { errors.push('Line ' + line + ': u_top must be 1–' + RACK_U + '.'); return; }
      const it = { kind };
      if (kind === 'device') {
        it.label = get(r, 'label'); it.type = get(r, 'type').toLowerCase() || 'server'; it.u = Math.max(1, parseInt(get(r, 'u'), 10) || 1);
        it.ports = parseInt(get(r, 'ports'), 10) || 0;
        const up = parseInt(get(r, 'uplinks'), 10) || 0;
        if (up) { it.uplinks = up; it.uplinkMedium = get(r, 'uplink_medium').toLowerCase() === 'sm' ? 'sm' : 'mm'; }
        if (get(r, 'watts')) it.watts = num(get(r, 'watts'), undefined);
      } else if (kind === 'utp' || kind === 'lc') {
        if (get(r, 'label')) it.id = get(r, 'label');
        it.role = get(r, 'role') || 'trunk';
        if (kind === 'lc') it.cassettes = get(r, 'cassettes').split('|').slice(0, SLOTS).map(m => (m = m.trim().toLowerCase()) ? { medium: m === 'sm' ? 'sm' : 'mm' } : null);
      }
      if (/^(yes|y|true|1|new)$/i.test(get(r, 'new'))) it.isNew = true;
      rack._list.push({ top, it, line });
    });
    // place the items by their top U, filling the space between them with gaps
    racks.forEach(rack => {
      const list = rack._list.sort((a, b) => b.top - a.top);
      const items = [];
      let next = RACK_U;
      list.forEach(({ top, it, line }) => {
        const u = it.kind === 'device' ? it.u : 1;
        if (top > next) { errors.push('Line ' + line + ': ' + (it.label || it.kind) + ' at U' + top + ' overlaps the item above it in ' + rack.id + '.'); return; }
        if (top - u + 1 < 1) { errors.push('Line ' + line + ': ' + (it.label || it.kind) + ' at U' + top + ' runs below U1.'); return; }
        if (top < next) items.push({ kind: 'gap', u: next - top });
        items.push(it);
        next = top - u;
      });
      rack.items = items;
      delete rack._list;
    });
    const lineOf = e => { const m = /^Line (\d+)/.exec(e); return m ? +m[1] : Infinity; };
    errors.sort((a, b) => lineOf(a) - lineOf(b));
    const data = {
      meta: { title: title || 'Imported data hall', imported: true },
      rows: rowsMap, racks, externals: [], trunks: [], cables: [], notes: [],
    };
    return { data, errors };
  }

  return { RACK_U, UTP_PORTS, CASS_PORTS, SLOTS, TYPES, TYPE_WATTS, POWER_DEFAULTS, layout, freeRuns, portUse, freePorts, watts, rackPower, findFit, suggestRoute, validate, toCsv, fromCsv, parseCsvText, SWITCHLIKE };
});
