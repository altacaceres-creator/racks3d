/* racks3d — static 3D digital twin of a data hall.
 * Plain JavaScript + Three.js 0.147 (classic scripts, works from file://).
 * Data comes from window.DC_DATA (data/sample-data.js). 1 scene unit = 1 metre.
 */
(function () {
  'use strict';

  const DATA = window.DC_DATA;
  if (!DATA || !Array.isArray(DATA.racks) || !DATA.racks.length) {
    document.body.insertAdjacentHTML('beforeend', '<p class="fatal">No data loaded — check data/sample-data.js</p>');
    return;
  }

  // the data as loaded, before the view adds its own fields to it: what Import exports
  const RAW = JSON.parse(JSON.stringify(DATA));
  const V3 = THREE.Vector3;
  const v = (x, y, z) => new V3(x, y, z);
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

  // ------------------------------------------------------------------ constants
  const U = 0.04445;            // 1U = 44.45 mm
  const RAIL = 0.4826;          // 19" = 482.6 mm
  const BASE = 0.06;            // plinth height, U1 starts here
  const RACK_U = 42;
  const FRONT_RAIL = -0.08;     // front mounting plane, behind the door
  const UTP_PORTS = 24, CASS_PORTS = 12, SLOTS = 4;
  const RESERVE = (DATA.meta && DATA.meta.reserve) || 1.3;
  const ROOM = Object.assign({ coldAisle: 1.2, hotAisle: 1.0, rackHeight: 2.0, crossTrays: [1.2, 4.2] }, DATA.room || {});
  ROOM.trayHeights = Object.assign({ copper: 2.3, fiber: 2.5 }, ROOM.trayHeights || {});
  const RH = ROOM.rackHeight;
  const WALL_H = 3.0;
  const TEX_W = 384;            // base texture width for a 19" face
  const SWITCHLIKE = new Set(['switch', 'router', 'firewall', 'tap', 'wlc']);
  const FRONT_PORTS = new Set(['switch', 'router', 'firewall', 'tap', 'wlc', 'appliance']);
  const DEPTH = { org: 0.10, utp: 0.12, lc: 0.26, switch: 0.38, router: 0.45, firewall: 0.5, server: 0.72, storage: 0.7, chassis: 0.76, appliance: 0.5, tap: 0.3, wlc: 0.36 };
  const C = {
    bg: '#0a0b1a', copper: '#2f9bff', mm: '#9be22d', sm: '#ffd23f', smPort: '#3a7bff', pending: '#ff4d5e', pdu: '#ff8a1f',
    door: '#b07cff', exit: '#e6dcb9', active: '#ff5fd2', new: '#ffb600', free: '#3ddc84', accent: '#009bff', hover: '#ffb600',
    brand: '#1e1ec8', muted: '#a3a6bd', text: '#eceaf4', rack: '#22243a',
  };
  const TYPE_COLOR = {
    switch: '#1a2340', router: '#1f2238', firewall: '#2b1b26', server: '#1c1f30', storage: '#1b2229', chassis: '#191b2b',
    appliance: '#1a2a2c', tap: '#23233a', wlc: '#1a2638', utp: '#191b2c', lc: '#1a1c2e', org: '#141626',
  };
  const TYPE_NAME = {
    switch: 'Switch', router: 'Router', firewall: 'Firewall', server: 'Server', storage: 'Storage', chassis: 'Chassis',
    appliance: 'Appliance', tap: 'Network TAP', wlc: 'Wireless controller', utp: 'UTP patch panel', lc: 'Fiber tray', org: 'Cable organizer', gap: 'Free space',
  };
  const ROLE_NAME = { trunk: 'Trunk', pdu: 'PDU management', camera: 'Door / cameras', existing: 'Legacy (not trunked)', exit: 'To provider room' };
  const KIND_NAME = { structured: 'Structured', mgmt: 'Management', direct: 'Direct (no star center)', active: 'Active cable (fixed length)', pdu: 'PDU management', door: 'Door / camera', exit: 'Provider-room exit' };
  const MEDIUM_NAME = { copper: 'Copper', mm: 'MM fiber', sm: 'SM fiber' };
  const mkey = m => (m === 'mm' || m === 'sm') ? m : 'cu';

  // power, heat, validation and the fit search live in js/plan.js (no 3D, tested under node)
  const PLAN = window.Racks3dPlan;
  const power = r => PLAN.rackPower(r, DATA);
  const kw = w => (w / 1000).toFixed(w < 10000 ? 2 : 1) + ' kW';
  const HEAT = [[22, '#2f9bff'], [27, '#3ddc84'], [31, '#ffd23f'], [35, '#ff8a1f'], [40, '#ff4d5e']];
  function heatColor(t) {
    const c = new THREE.Color(HEAT[0][1]);
    for (let i = 1; i < HEAT.length; i++) {
      if (t <= HEAT[i][0]) return c.set(HEAT[i - 1][1]).lerp(new THREE.Color(HEAT[i][1]), Math.max(0, (t - HEAT[i - 1][0]) / (HEAT[i][0] - HEAT[i - 1][0])));
    }
    return c.set(HEAT[HEAT.length - 1][1]);
  }
  const POWER_CLS = { ok: 'free', high: 'new', over: 'pending' };
  const powerSpan = p => '<span style="color:var(--' + ({ ok: 'text', high: 'new', over: 'pending' })[p.status] + ')">' + kw(p.w) + '</span> of ' + kw(p.budget) + ' (' + Math.round(p.util * 100) + ' %)';

  // ------------------------------------------------------------------ data model
  const racks = DATA.racks;
  const rackById = {}, panelByKey = {}, devByLabel = {}, extById = {};
  (DATA.externals || []).forEach(e => { extById[e.id] = e; });

  racks.forEach(r => {
    rackById[r.id] = r;
    r.star = Array.isArray(r.starCenter) ? r.starCenter.slice() : (r.starCenter ? [r.starCenter] : []);
    r.w = (r.width || 600) / 1000;
    r.d = (r.depth || 1000) / 1000;
    r.items = (r.items || []).filter(Boolean);
    let top = RACK_U, p = 0, f = 0;
    const place = (it, i) => {
      const u = (it.kind === 'device' || it.kind === 'gap') ? Math.max(1, it.u || 1) : 1;
      it._u = u; it._top = top; it._bottom = top - u + 1; top -= u; it._rack = r; it._i = i;
      if (it.kind === 'utp') { p++; if (!it.id) it.id = 'P' + p; }
      if (it.kind === 'lc') {
        f++; if (!it.id) it.id = 'F' + f;
        it.cassettes = (it.cassettes || []).slice(0, SLOTS);
        while (it.cassettes.length < SLOTS) it.cassettes.push(null);
      }
      if (it.id) { it._key = r.id + '#' + it.id; panelByKey[it._key] = it; }
      if (it.kind === 'device') { it._key = 'dev:' + it.label; devByLabel[it.label] = it; }
      if (!it._key) it._key = r.id + '#' + it.kind + i;
    };
    r.items.forEach(place);
    if (top > 0) { const g = { kind: 'gap', u: top, _implicit: true }; r.items.push(g); place(g, r.items.length - 1); }
    if (top < 0) console.warn('racks3d: ' + r.id + ' uses more than ' + RACK_U + 'U');
  });

  function devPorts(it) {
    const sw = SWITCHLIKE.has(it.type), cu = [], fo = [];
    for (let i = 0; i < (it.ports || 0); i++) cu.push(sw ? '1/0/' + (i + 1) : 'eth' + i);
    for (let i = 0; i < (it.uplinks || 0); i++) fo.push(sw ? '1/1/' + (i + 1) : 'fib' + i);
    return { cu, fo, mgmt: it.mgmt !== false };
  }
  const portFace = it => FRONT_PORTS.has(it.type) ? 'front' : 'rear';
  const isItemNew = it => !!(it.isNew || (it.kind === 'lc' && it.cassettes.some(c => c && c.isNew)));

  const cables = (DATA.cables || []).filter(c => c && c.a && c.b);
  const trunks = (DATA.trunks || []).filter(t => t && t.a && t.b);
  const portCable = {};      // "R1-03#P1:5" | "dev:LABEL:port" | "pdu:R1-03:NET" -> cable
  const cablesBy = {};       // item key -> [cables]
  const parseHop = h => { const i = h.lastIndexOf(':'); return { key: h.slice(0, i), port: parseInt(h.slice(i + 1), 10) }; };
  const refKey = item => devByLabel[item] ? 'dev:' + item : /^PDU:/.test(item) ? 'pdu:' + item.slice(4) : 'ext:' + item;
  const addBy = (k, c) => { (cablesBy[k] = cablesBy[k] || []).includes(c) || cablesBy[k].push(c); };
  cables.forEach(c => {
    c.hops = (c.hops || []).filter(h => typeof h === 'string' && h.includes(':'));
    [c.a, c.b].forEach(e => { const k = refKey(e.item); portCable[k + ':' + e.port] = c; addBy(k, c); });
    c.hops.forEach(h => { const p = parseHop(h); portCable[p.key + ':' + p.port] = c; addBy(p.key, c); });
  });
  const trunkPeer = {};      // "R1-03#P1" | "R1-03#F1.C2" -> {peer, t}
  trunks.forEach(t => { trunkPeer[t.a] = { peer: t.b, t }; trunkPeer[t.b] = { peer: t.a, t }; });

  const refRack = item => devByLabel[item] ? devByLabel[item]._rack : /^PDU:/.test(item) ? rackById[item.slice(4)] || null : null;
  function cableAt(it, name) {
    if (it.kind === 'device') return portCable['dev:' + it.label + ':' + name];
    return portCable[it._key + ':' + name];
  }
  function cableColor(c) {
    if (!c) return null;
    if (c.status === 'pending') return C.pending;
    if (c.kind === 'pdu') return C.pdu;
    if (c.kind === 'door') return C.door;
    if (c.kind === 'active') return C.active;
    return C[c.medium] || C.copper;
  }
  const rackCables = {};
  function cablesOfRack(r) {
    if (rackCables[r.id]) return rackCables[r.id];
    const pre = r.id + '#';
    return (rackCables[r.id] = cables.filter(c => refRack(c.a.item) === r || refRack(c.b.item) === r || c.hops.some(h => h.startsWith(pre))));
  }
  function cablesOfItem(it) {
    if (it.kind === 'device') return cablesBy['dev:' + it.label] || [];
    return cablesBy[it._key] || [];
  }

  // ------------------------------------------------------------------ physical layout
  const rowKeys = Object.keys(DATA.rows || {}).sort((a, b) => (parseFloat(a) - parseFloat(b)) || String(a).localeCompare(b));
  const rows = rowKeys.map((k, i) => ({ key: k, i, ids: (DATA.rows[k] || []).filter(id => rackById[id]) }));
  racks.forEach(r => {
    if (rows.some(R => R.ids.includes(r.id))) return;
    let R = rows.find(x => x.key === String(r.row));
    if (!R) { R = { key: String(r.row || rows.length + 1), i: rows.length, ids: [] }; rows.push(R); }
    R.ids.push(r.id);
  });
  rows.forEach((R, i) => {
    R.i = i; R.sgn = i % 2 === 0 ? 1 : -1;               // +1: fronts face +z
    R.racks = R.ids.map(id => rackById[id]);
    R.maxD = Math.max(...R.racks.map(r => r.d));
    R.len = sum(R.racks, r => r.w);
    R.name = 'Row ' + R.key;
  });
  const maxLen = Math.max(...rows.map(R => R.len));
  const X0 = -maxLen / 2, X1 = maxLen / 2;
  rows.forEach((R, i) => {
    if (i === 0) R.front = -ROOM.coldAisle / 2;
    else if (i % 2 === 1) R.front = rows[i - 1].front + ROOM.coldAisle;
    else R.front = rows[i - 1].front + rows[i - 1].maxD + ROOM.hotAisle + R.maxD;
    let x = X0;
    // physical order is left -> right as seen from the front (the cold aisle)
    (R.sgn === 1 ? R.racks : R.racks.slice().reverse()).forEach(r => {
      r._x = x + r.w / 2; x += r.w; r._row = R; r._front = R.front; r._sgn = R.sgn;
    });
    R.trayZ = { copper: R.front - R.sgn * 0.62, fiber: R.front - R.sgn * 0.25 };
  });
  const firstRow = rows[0], lastRow = rows[rows.length - 1];
  const RZ0 = firstRow.front - firstRow.maxD - ROOM.hotAisle;
  const RZ1 = lastRow.sgn === -1 ? lastRow.front + lastRow.maxD + ROOM.hotAisle : lastRow.front + ROOM.coldAisle;
  const RX0 = X0 - 1.6, RX1 = X1 + 1.6;
  const aisles = [];
  (function () {
    let n = 1, h = 1;
    aisles.push({ type: 'hot', name: 'Hot aisle ' + h++, z: firstRow.front - firstRow.maxD - ROOM.hotAisle / 2, width: ROOM.hotAisle, a: null, b: 0 });
    rows.forEach((R, i) => {
      const N = rows[i + 1];
      if (i % 2 === 0) {
        if (N) aisles.push({ type: 'cold', name: 'Cold aisle ' + n++, z: (R.front + N.front) / 2, width: ROOM.coldAisle, a: i, b: i + 1 });
        else aisles.push({ type: 'cold', name: 'Cold aisle ' + n++, z: R.front + ROOM.coldAisle / 2, width: ROOM.coldAisle, a: i, b: null });
      } else if (N) {
        aisles.push({ type: 'hot', name: 'Hot aisle ' + h++, z: (R.front + R.maxD + N.front - N.maxD) / 2, width: ROOM.hotAisle, a: i, b: i + 1 });
      } else {
        aisles.push({ type: 'hot', name: 'Hot aisle ' + h++, z: R.front + R.maxD + ROOM.hotAisle / 2, width: ROOM.hotAisle, a: i, b: null });
      }
    });
    aisles.sort((p, q) => p.z - q.z);
  })();
  const COLD_Z = (aisles.find(a => a.type === 'cold') || aisles[0]).z;
  const X_END = [X0 - 0.45, X1 + 0.45];
  const CROSS = (ROOM.crossTrays || []).map(c => X0 + c).filter(x => x > X0 && x < X1).concat(X_END);

  const toW = (r, p) => v(r._x + r._sgn * p.x, p.y, r._front + r._sgn * p.z);
  const orgX = r => r.w >= 0.75 ? 0.31 : 0.262;

  function extPos(e) {
    switch (e.place) {
      case 'door': return v(RX0 + 0.08, 1.35, COLD_Z + 0.8);
      case 'ceiling-door': return v(X0 + 0.4, 2.85, COLD_Z);
      case 'ceiling-far': return v(X1 - 0.4, 2.85, COLD_Z);
      case 'portal': return v(RX1 - 0.06, ROOM.trayHeights.copper, COLD_Z);
      default: return Array.isArray(e.pos) ? v(e.pos[0], e.pos[1], e.pos[2]) : v(RX0 + 0.1, 1.5, COLD_Z - 0.8);
    }
  }

  // ------------------------------------------------------------------ item geometry & port layout
  function geomOf(it) {
    if (it._g) return it._g;
    const h = it._u * U - 0.0012, yb = BASE + (it._bottom - 1) * U + 0.0006;
    const depth = Math.min(DEPTH[it.kind === 'device' ? it.type : it.kind] || 0.4, it._rack.d - 0.25);
    return (it._g = { h, yb, yt: yb + h, depth, zf: FRONT_RAIL, zr: FRONT_RAIL - depth });
  }

  // Normalised port rectangles per face (x, y from the top-left as seen by the viewer of that face).
  function layoutOf(it) {
    if (it._layout) return it._layout;
    const L = { front: [], rear: [] }, u = it._u;
    if (it.kind === 'utp') {
      const slot = 0.8 / 25.5;
      for (let i = 0; i < UTP_PORTS; i++) {
        const g = Math.floor(i / 6), x = 0.15 + (i + g * 0.5) * slot + slot * 0.1, w = slot * 0.8;
        L.front.push({ name: String(i + 1), x, y: 0.38, w, h: 0.48, shape: 'rj45' });
        L.rear.push({ name: String(i + 1), x: 1 - x - w, y: 0.28, w, h: 0.42, shape: 'keystone' });
      }
    } else if (it.kind === 'lc') {
      const cw = 0.8 / SLOTS;
      it.cassettes.forEach((c, ci) => {
        if (!c) return;
        const x0 = 0.15 + ci * cw, pw = cw * 0.86 / 6;
        for (let k = 0; k < CASS_PORTS; k++) {
          const col = k % 6, row = Math.floor(k / 6);
          L.front.push({ name: String(ci * CASS_PORTS + k + 1), x: x0 + cw * 0.07 + col * pw + pw * 0.1, y: 0.2 + row * 0.38, w: pw * 0.8, h: 0.3, shape: 'lc', cass: ci });
        }
        const rx = 1 - (x0 + cw);  // the cassette as seen from the rear
        ['A', 'B'].forEach((s, j) => L.rear.push({ name: 'C' + (ci + 1) + s, x: rx + cw * (0.16 + j * 0.44), y: 0.3, w: cw * 0.26, h: 0.4, shape: 'mpo', cass: ci }));
      });
    } else if (it.kind === 'device') {
      const P = devPorts(it), face = portFace(it), list = L[face];
      const cuRows = P.cu.length > 12 ? 2 : 1, foRows = P.fo.length > 6 ? 2 : 1;
      const cuCols = Math.ceil(P.cu.length / cuRows), foCols = Math.ceil(P.fo.length / foRows);
      const gw = 0.0105, groups = Math.max(0, Math.floor((cuCols - 1) / 6));
      let pw = 0.0284, sw = 0.031;
      const need = cuCols * pw + groups * gw + (foCols ? 0.025 + foCols * sw : 0);
      const avail = face === 'front' ? 0.75 : 0.56;
      const k = Math.min(1, avail / Math.max(need, 0.001)); pw *= k; sw *= k;
      const yc = (face === 'front' || u === 1) ? 0.5 : 1 - 0.5 / u;
      const rowY = (n, r) => n === 1 ? yc : yc + (r === 0 ? -0.2 : 0.2) / u;
      const ph = n => (n === 1 ? 0.42 : 0.32) / u;
      let x = 0.215;
      if (P.mgmt) list.push({ name: 'mgmt', x: 0.176, y: yc - 0.16 / u, w: 0.026, h: 0.32 / u, shape: 'rj45', mgmt: true });
      P.cu.forEach((n, i) => {
        const col = Math.floor(i / cuRows), row = i % cuRows, h = ph(cuRows);
        list.push({ name: n, x: x + col * pw + Math.floor(col / 6) * gw + pw * 0.08, y: rowY(cuRows, row) - h / 2, w: pw * 0.84, h, shape: 'rj45' });
      });
      x += cuCols * pw + groups * gw + (cuCols ? 0.025 : 0);
      P.fo.forEach((n, i) => {
        const col = Math.floor(i / foRows), row = i % foRows, h = ph(foRows) * 0.9;
        list.push({ name: n, x: x + col * sw + sw * 0.08, y: rowY(foRows, row) - h / 2, w: sw * 0.84, h, shape: 'sfp' });
      });
    }
    return (it._layout = L);
  }

  function portLocal(it, name, face) {
    const g = geomOf(it), p = layoutOf(it)[face].find(q => q.name === name);
    const nx = p ? p.x + p.w / 2 : 0.5, ny = p ? p.y + p.h / 2 : 0.5;
    const x = face === 'front' ? -RAIL / 2 + nx * RAIL : RAIL / 2 - nx * RAIL;
    return v(x, g.yt - ny * g.h, face === 'front' ? g.zf + 0.004 : g.zr - 0.004);
  }
  const pduLocal = r => v(r.w / 2 - 0.045, BASE + 1.72, -r.d + 0.06);

  // ------------------------------------------------------------------ renderer, scene, camera
  const stage = $('#stage');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.localClippingEnabled = true;
  stage.appendChild(renderer.domElement);
  const labelRenderer = new THREE.CSS2DRenderer();
  labelRenderer.setSize(innerWidth, innerHeight);
  $('#labels').appendChild(labelRenderer.domElement);
  const MAX_ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(C.bg);
  scene.fog = new THREE.Fog(C.bg, 18, 48);
  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.03, 200);
  const controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 0.25;
  controls.maxDistance = 40;
  controls.screenSpacePanning = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  scene.add(new THREE.HemisphereLight(0xb8c4ff, 0x0a0b1a, 0.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(X0 - 4, 9, RZ1 + 4);
  sun.target.position.set(0, 0, (RZ0 + RZ1) / 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  (function () {
    const e = Math.max(RX1 - RX0, RZ1 - RZ0) * 0.75 + 1.5, sc = sun.shadow.camera;
    sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e; sc.near = 1; sc.far = 40;
  })();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  const fillLight = new THREE.DirectionalLight(0x5a5af0, 0.45);
  fillLight.position.set(X1 + 5, 4, RZ0 - 4);
  scene.add(fillLight);

  function canvasTex(cv) {
    const t = new THREE.CanvasTexture(cv);
    t.encoding = THREE.sRGBEncoding;
    t.anisotropy = MAX_ANISO;
    return t;
  }
  const mkCanvas = (w, h) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; return cv; };
  function css2d(html, cls) {
    const el = document.createElement('div');
    if (cls) el.className = cls;
    el.innerHTML = html;
    return new THREE.CSS2DObject(el);
  }
  const merge = geos => {
    const g = THREE.BufferGeometryUtils.mergeBufferGeometries(geos, false);
    geos.forEach(x => x.dispose());
    return g;
  };

  // ------------------------------------------------------------------ room
  const roomGroup = new THREE.Group();      // floor + aisle tints (always on)
  const wallsGroup = new THREE.Group();     // walls, door, boards, portal, externals
  const traysGroup = new THREE.Group();
  scene.add(roomGroup, wallsGroup, traysGroup);
  const extMeshes = [];
  let doorPivot = null;

  (function buildRoom() {
    const W = RX1 - RX0, D = RZ1 - RZ0;
    const cv = mkCanvas(256, 256), x = cv.getContext('2d');
    x.fillStyle = '#15172c'; x.fillRect(0, 0, 256, 256);
    x.fillStyle = '#1a1d36';
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) { x.beginPath(); x.arc(24 + i * 30, 24 + j * 30, 3, 0, 7); x.fill(); }
    x.strokeStyle = '#2a2e52'; x.lineWidth = 5; x.strokeRect(2.5, 2.5, 251, 251);
    const tex = canvasTex(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(W / 0.6, D / 0.6);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, metalness: 0.1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((RX0 + RX1) / 2, 0, (RZ0 + RZ1) / 2);
    floor.receiveShadow = true;
    roomGroup.add(floor);
    aisles.forEach(a => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(X1 - X0 + 1.4, a.width),
        new THREE.MeshBasicMaterial({ color: a.type === 'cold' ? 0x1e6bff : 0xff3b3b, transparent: true, opacity: a.type === 'cold' ? 0.14 : 0.1, depthWrite: false }));
      m.rotation.x = -Math.PI / 2;
      m.position.set((X0 + X1) / 2, 0.003, a.z);
      roomGroup.add(m);
    });

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x1a1d3a, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false, roughness: 0.9 });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x3a3e6a });
    const wall = (x0, z0, x1, z1, h, y0) => {
      h = h || WALL_H; y0 = y0 || 0;
      const geo = new THREE.BoxGeometry(Math.hypot(x1 - x0, z1 - z0), h, 0.08);
      const m = new THREE.Mesh(geo, wallMat);
      m.position.set((x0 + x1) / 2, y0 + h / 2, (z0 + z1) / 2);
      m.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
      e.position.copy(m.position); e.rotation.copy(m.rotation);
      wallsGroup.add(m, e);
    };
    wall(RX0, RZ0, RX1, RZ0);
    wall(RX0, RZ1, RX1, RZ1);
    wall(RX1, RZ0, RX1, RZ1);
    wall(RX0, RZ0, RX0, COLD_Z - 0.55);
    wall(RX0, COLD_Z + 0.55, RX0, RZ1);
    wall(RX0, COLD_Z - 0.55, RX0, COLD_Z + 0.55, WALL_H - 2.15, 2.15);

    // access door (pivot on its hinge so the walk-through can open it)
    doorPivot = new THREE.Group();
    doorPivot.position.set(RX0, 0, COLD_Z - 0.5);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.045, 2.1, 1.0), new THREE.MeshStandardMaterial({ color: 0x2b2f55, metalness: 0.3, roughness: 0.6 }));
    leaf.position.set(0, 1.05, 0.5);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.03, 0.14), new THREE.MeshStandardMaterial({ color: 0xc8cce0, metalness: 0.8, roughness: 0.3 }));
    handle.position.set(0, 1.05, 0.88);
    doorPivot.add(leaf, handle);
    wallsGroup.add(doorPivot);
    const doorSign = css2d('Access door', 'wall-label');
    doorSign.position.set(RX0 + 0.1, 2.3, COLD_Z);
    wallsGroup.add(doorSign);

    // generic wall boards
    ['Board A', 'Board B'].forEach((name, i) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.1, 0.18), new THREE.MeshStandardMaterial({ color: 0x34374f, metalness: 0.4, roughness: 0.6 }));
      b.position.set(RX0 + 0.75 + i * 0.95, 1.25, RZ0 + 0.13);
      b.castShadow = true;
      wallsGroup.add(b);
      const lab = css2d(name, 'wall-label');
      lab.position.set(b.position.x, 1.95, b.position.z);
      wallsGroup.add(lab);
    });

    // portal to the provider room
    const pm = new THREE.MeshStandardMaterial({ color: 0x009bff, emissive: 0x009bff, emissiveIntensity: 0.8 });
    const frame = [[0.06, 2.4, 1.3, 0, 1.2, 0], [0.06, 0.08, 1.42, 0, 2.44, 0], [0.06, 2.4, 0.06, 0, 1.2, -0.68], [0.06, 2.4, 0.06, 0, 1.2, 0.68]];
    frame.slice(1).forEach(f => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(f[0], f[1], f[2]), pm);
      m.position.set(RX1 - 0.05 + f[3], f[4], COLD_Z + f[5]);
      wallsGroup.add(m);
    });
    const inner = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 2.4), new THREE.MeshBasicMaterial({ color: 0x050612 }));
    inner.rotation.y = -Math.PI / 2;
    inner.position.set(RX1 - 0.03, 1.2, COLD_Z);
    wallsGroup.add(inner);
    const pl = css2d('→ Provider room', 'portal-label');
    pl.position.set(RX1 - 0.1, 2.7, COLD_Z);
    wallsGroup.add(pl);

    // elements outside the racks
    (DATA.externals || []).forEach(e => {
      if (e.place === 'portal') return;
      const p = extPos(e);
      let m;
      if (e.type === 'camera') {
        m = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xdfe3f5, roughness: 0.3 }));
        m.rotation.x = Math.PI;
      } else {
        m = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.18, 0.12), new THREE.MeshStandardMaterial({ color: 0x3b3f66, emissive: 0x6b3fe0, emissiveIntensity: 0.25 }));
      }
      m.position.copy(p);
      m.userData.ext = e;
      wallsGroup.add(m);
      extMeshes.push(m);
    });
  })();

  (function buildTrays() {
    const cu = [], fo = [], H = ROOM.trayHeights;
    const seg = (arr, a, b, width, side) => {
      const alongX = Math.abs(b.x - a.x) > Math.abs(b.z - a.z), len = Math.hypot(b.x - a.x, b.z - a.z);
      const cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
      const bottom = new THREE.BoxGeometry(alongX ? len : width, 0.008, alongX ? width : len);
      bottom.translate(cx, a.y, cz); arr.push(bottom);
      [-1, 1].forEach(s => {
        const g = new THREE.BoxGeometry(alongX ? len : 0.008, side, alongX ? 0.008 : len);
        g.translate(cx + (alongX ? 0 : s * width / 2), a.y + side / 2, cz + (alongX ? s * width / 2 : 0));
        arr.push(g);
      });
    };
    const cuY = H.copper - 0.06, foY = H.fiber - 0.05;
    rows.forEach(R => {
      seg(cu, v(X_END[0], cuY, R.trayZ.copper), v(X_END[1], cuY, R.trayZ.copper), 0.3, 0.07);
      seg(fo, v(X_END[0], foY, R.trayZ.fiber), v(X_END[1], foY, R.trayZ.fiber), 0.12, 0.05);
    });
    const zc = rows.map(R => R.trayZ.copper).concat(COLD_Z), zf = rows.map(R => R.trayZ.fiber).concat(COLD_Z);
    CROSS.forEach(x => {
      seg(cu, v(x, cuY, Math.min(...zc)), v(x, cuY, Math.max(...zc)), 0.3, 0.07);
      seg(fo, v(x, foY, Math.min(...zf)), v(x, foY, Math.max(...zf)), 0.12, 0.05);
    });
    const exitRun = [v(X_END[1], cuY, COLD_Z), v(RX1 - 0.05, cuY, COLD_Z)];
    seg(cu, exitRun[0], exitRun[1], 0.3, 0.07);
    const m1 = new THREE.Mesh(merge(cu), new THREE.MeshStandardMaterial({ color: 0x8a91b4, metalness: 0.7, roughness: 0.35 }));
    const m2 = new THREE.Mesh(merge(fo), new THREE.MeshStandardMaterial({ color: 0x9c7a1c, metalness: 0.1, roughness: 0.7 }));
    m1.castShadow = m2.castShadow = true;
    traysGroup.add(m1, m2);
  })();

  // ------------------------------------------------------------------ face painting (canvas)
  function rrect(x, px, py, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    x.beginPath();
    x.moveTo(px + r, py); x.lineTo(px + w - r, py); x.quadraticCurveTo(px + w, py, px + w, py + r);
    x.lineTo(px + w, py + h - r); x.quadraticCurveTo(px + w, py + h, px + w - r, py + h);
    x.lineTo(px + r, py + h); x.quadraticCurveTo(px, py + h, px, py + h - r);
    x.lineTo(px, py + r); x.quadraticCurveTo(px, py, px + r, py);
    x.closePath();
  }
  function text(x, s, px, py, size, color, weight, align, maxW) {
    const font = sz => (weight || 600) + ' ' + Math.max(4, sz) + 'px Aptos, "Segoe UI", Roboto, Arial, sans-serif';
    x.font = font(size);
    if (maxW) { const w = x.measureText(s).width; if (w > maxW) x.font = font(size * maxW / w); }
    x.fillStyle = color || C.text;
    x.textAlign = align || 'left';
    x.textBaseline = 'middle';
    x.fillText(s, px, py);
  }
  const shortRef = ref => String(ref).replace('#', ' ');

  function paintFace(cv, it, face, scale, hover) {
    const g = geomOf(it), W = Math.round(TEX_W * scale), H = Math.max(8, Math.round(W * g.h / RAIL));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const x = cv.getContext('2d'), s = scale, uPx = H / it._u;
    const kind = it.kind === 'device' ? it.type : it.kind;
    const fs = Math.min(uPx * 0.3, 11 * s);
    x.clearRect(0, 0, W, H);
    x.fillStyle = TYPE_COLOR[kind] || '#1c1f30';
    x.fillRect(0, 0, W, H);
    const gr = x.createLinearGradient(0, 0, 0, H);
    gr.addColorStop(0, 'rgba(255,255,255,.08)'); gr.addColorStop(0.5, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(0,0,0,.22)');
    x.fillStyle = gr; x.fillRect(0, 0, W, H);
    x.strokeStyle = 'rgba(0,0,0,.55)'; x.lineWidth = Math.max(1, s); x.strokeRect(0.5, 0.5, W - 1, H - 1);

    if (face === 'front') {
      x.fillStyle = 'rgba(255,255,255,.06)';
      x.fillRect(0, 0, W * 0.035, H); x.fillRect(W * 0.965, 0, W * 0.035, H);
      x.fillStyle = '#0b0c16';
      for (let i = 0; i < it._u; i++) {
        [W * 0.0175, W * 0.9825].forEach(cx => { x.beginPath(); x.arc(cx, (i + 0.5) * uPx, Math.max(1.2, 2.2 * s), 0, 7); x.fill(); });
      }
    }
    const led = (px, py, col) => { x.fillStyle = col; x.beginPath(); x.arc(px, py, Math.max(1.2, 1.8 * s), 0, 7); x.fill(); };

    if (it.kind === 'org') {
      if (face === 'front') {
        x.fillStyle = '#07080f'; rrect(x, W * 0.1, H * 0.38, W * 0.8, H * 0.24, 3 * s); x.fill();
        x.strokeStyle = 'rgba(160,165,200,.25)'; x.lineWidth = Math.max(1, s * 0.8);
        for (let i = 0; i < 90; i++) { const px = W * 0.1 + (i / 90) * W * 0.8; x.beginPath(); x.moveTo(px, H * 0.38); x.lineTo(px + 2 * s, H * 0.5); x.moveTo(px, H * 0.62); x.lineTo(px + 2 * s, H * 0.5); x.stroke(); }
        x.strokeStyle = '#4a4e78'; x.lineWidth = 2 * s;
        [0.14, 0.38, 0.62, 0.86].forEach(f => { x.beginPath(); x.arc(W * f, H * 0.5, uPx * 0.3, Math.PI * 0.2, Math.PI * 0.8, true); x.stroke(); });
      }
    } else if (it.kind === 'utp') {
      const peer = trunkPeer[it._key];
      const roleTxt = it.role === 'trunk' ? (peer ? '→ ' + shortRef(peer.peer) : 'TRUNK') : (ROLE_NAME[it.role] || it.role || '').toUpperCase();
      text(x, it.id, W * 0.045, H * 0.32, fs * 1.15, C.text, 700, 'left', W * 0.045);
      text(x, roleTxt, W * 0.045, H * 0.7, fs * 0.72, it.role === 'pdu' ? C.pdu : it.role === 'camera' ? C.door : it.role === 'exit' ? C.exit : C.muted, 600, 'left', W * 0.1);
      if (face === 'front') {
        layoutOf(it).front.forEach(p => text(x, p.name, (p.x + p.w / 2) * W, p.y * H - uPx * 0.12, uPx * 0.17, C.muted, 500, 'center'));
      } else {
        x.fillStyle = 'rgba(0,0,0,.35)'; x.fillRect(W * 0.03, H * 0.2, W * 0.94, H * 0.6);
      }
    } else if (it.kind === 'lc') {
      const cw = 0.8 / SLOTS;
      text(x, it.id, W * 0.045, H * 0.32, fs * 1.15, C.text, 700, 'left', W * 0.045);
      text(x, it.role === 'exit' ? 'EXIT' : 'LC', W * 0.045, H * 0.7, fs * 0.72, C.muted);
      it.cassettes.forEach((c, ci) => {
        const fx = face === 'front' ? 0.15 + ci * cw : 1 - (0.15 + (ci + 1) * cw);
        const px = fx * W + 2 * s, pw = cw * W - 4 * s;
        if (!c) {
          x.fillStyle = '#07080f'; x.fillRect(px, H * 0.1, pw, H * 0.8);
          text(x, 'EMPTY', px + pw / 2, H * 0.5, fs * 0.8, '#4b4f72', 700, 'center');
          return;
        }
        const col = c.medium === 'sm' ? C.sm : C.mm;
        x.fillStyle = c.medium === 'sm' ? '#2e2a12' : '#22300f';
        x.fillRect(px, H * 0.08, pw, H * 0.84);
        x.strokeStyle = c.isNew ? C.new : col; x.lineWidth = Math.max(1, 1.4 * s); x.strokeRect(px, H * 0.08, pw, H * 0.84);
        const peer = trunkPeer[it._key + '.C' + (ci + 1)];
        text(x, 'C' + (ci + 1) + ' ' + c.medium.toUpperCase() + (peer ? ' → ' + shortRef(peer.peer) : ''), px + 3 * s, H * 0.94 - uPx * 0.06, uPx * 0.13, col, 600, 'left', pw - 6 * s);
      });
    } else if (it.kind === 'device') {
      const label = it.label || '';
      const lblX = face === 'front' ? W * 0.045 : W * 0.03;
      text(x, label, lblX, Math.min(uPx * 0.3, H * 0.3), fs, C.text, 700, 'left', face === 'front' && FRONT_PORTS.has(it.type) ? W * 0.125 : W * 0.3);
      text(x, (TYPE_NAME[it.type] || it.type) + ' · ' + it._u + 'U', lblX, Math.min(uPx * 0.62, H * 0.62), fs * 0.75, C.muted, 500);
      led(lblX + W * 0.11, Math.min(uPx * 0.82, H * 0.85), C.free);
      if (face === 'front') paintDeviceFront(x, it, W, H, uPx, s, led);
      else paintDeviceRear(x, it, W, H, uPx, s);
    }

    // ports
    layoutOf(it)[face].forEach(p => {
      const px = p.x * W, py = p.y * H, pw = p.w * W, ph = p.h * H;
      if (p.shape === 'mpo') {
        const c = it.cassettes[p.cass];
        x.fillStyle = c && c.medium === 'sm' ? C.smPort : '#19c3c3';
        rrect(x, px, py, pw, ph, 2 * s); x.fill();
        x.fillStyle = '#05060c'; x.fillRect(px + pw * 0.15, py + ph * 0.35, pw * 0.7, ph * 0.3);
      } else {
        const cab = cableAt(it, p.name), col = cableColor(cab);
        x.fillStyle = '#05060c';
        x.fillRect(px, py, pw, ph);
        if (p.shape === 'lc') {
          const c = it.cassettes[p.cass];
          x.strokeStyle = c && c.medium === 'sm' ? C.smPort : 'rgba(155,226,45,.55)';
          x.lineWidth = Math.max(1, s * 0.8); x.strokeRect(px, py, pw, ph);
        } else if (p.shape === 'sfp') {
          x.strokeStyle = 'rgba(200,205,230,.45)'; x.lineWidth = Math.max(1, s * 0.8); x.strokeRect(px, py, pw, ph);
        } else {
          x.fillStyle = 'rgba(255,255,255,.07)'; x.fillRect(px + pw * 0.3, py + ph * (face === 'front' ? 0.72 : 0), pw * 0.4, ph * 0.28);
          if (p.mgmt) { x.strokeStyle = C.pdu; x.lineWidth = Math.max(1, s * 0.8); x.strokeRect(px, py, pw, ph); }
        }
        if (col) {
          x.fillStyle = col;
          x.fillRect(px + pw * 0.16, py + ph * 0.16, pw * 0.68, ph * 0.68);
          if (cab.status === 'proposed') { x.fillStyle = C.new; x.beginPath(); x.arc(px + pw * 0.86, py + ph * 0.14, Math.max(1, pw * 0.16), 0, 7); x.fill(); }
          if (face === 'rear' && it.kind === 'utp') {
            x.strokeStyle = col; x.lineWidth = Math.max(1, pw * 0.4);
            x.beginPath(); x.moveTo(px + pw / 2, py + ph); x.lineTo(px + pw / 2, H * 0.97); x.stroke();
          }
        }
      }
      if (hover && hover === p.name) {
        x.strokeStyle = C.hover; x.lineWidth = Math.max(2, 2 * s);
        x.shadowColor = C.hover; x.shadowBlur = 6 * s;
        x.strokeRect(px - 1.5 * s, py - 1.5 * s, pw + 3 * s, ph + 3 * s);
        x.shadowBlur = 0;
      }
    });
    if (face === 'rear' && it.kind === 'utp') {
      x.fillStyle = '#0c0d18'; x.fillRect(W * 0.03, H * 0.9, W * 0.94, H * 0.06);
    }

    if (isItemNew(it) && it.isNew) {
      x.strokeStyle = C.new; x.lineWidth = Math.max(2, 2.5 * s); x.strokeRect(1.5 * s, 1.5 * s, W - 3 * s, H - 3 * s);
      const th = Math.min(uPx * 0.26, H * 0.34), tx = it.kind === 'device' ? W * 0.86 : W * 0.093;
      x.fillStyle = C.new; rrect(x, tx, H * 0.32 - th / 2, W * 0.05, th, 3 * s); x.fill();
      text(x, 'NEW', tx + W * 0.025, H * 0.32, th * 0.7, '#1a1300', 800, 'center', W * 0.044);
    }
  }

  function paintDeviceFront(x, it, W, H, uPx, s, led) {
    const t = it.type;
    if (t === 'server') {
      const rowsN = it._u >= 2 ? 3 : 1, cols = it._u >= 2 ? 4 : 10;
      const x0 = W * 0.2, x1 = W * 0.86, y0 = H * 0.1, y1 = H * 0.9;
      const bw = (x1 - x0) / cols, bh = (y1 - y0) / rowsN;
      for (let r = 0; r < rowsN; r++) for (let c = 0; c < cols; c++) {
        const px = x0 + c * bw + 1.5 * s, py = y0 + r * bh + 1.5 * s;
        x.fillStyle = '#10121e'; x.fillRect(px, py, bw - 3 * s, bh - 3 * s);
        x.fillStyle = '#2a2d44'; x.fillRect(px + 2 * s, py + (bh - 3 * s) * 0.7, bw - 7 * s, Math.max(1, (bh - 3 * s) * 0.12));
        led(px + bw - 6 * s, py + 4 * s, (r + c) % 5 ? C.free : C.accent);
      }
      x.strokeStyle = '#3b3f66'; x.lineWidth = 1.5 * s; x.beginPath(); x.arc(W * 0.92, H * 0.5, Math.min(uPx * 0.18, 6 * s), 0, 7); x.stroke();
    } else if (t === 'storage') {
      const rowsN = it._u >= 4 ? 2 : 1, cols = 12;
      const x0 = W * 0.2, x1 = W * 0.94, y0 = H * 0.08, y1 = H * 0.92;
      const bw = (x1 - x0) / cols, bh = (y1 - y0) / rowsN;
      for (let r = 0; r < rowsN; r++) for (let c = 0; c < cols; c++) {
        const px = x0 + c * bw + 1 * s, py = y0 + r * bh + 1 * s;
        x.fillStyle = (it.ports || it.uplinks) ? '#12141f' : '#141822'; x.fillRect(px, py, bw - 2 * s, bh - 2 * s);
        led(px + (bw - 2 * s) / 2, py + bh * 0.85, c % 7 ? C.free : C.new);
      }
    } else if (t === 'chassis') {
      const n = 8, x0 = W * 0.2, x1 = W * 0.95, y0 = H * 0.06, y1 = H * 0.96, bw = (x1 - x0) / n;
      for (let i = 0; i < n; i++) {
        const px = x0 + i * bw + 2 * s;
        x.fillStyle = '#12142a'; x.fillRect(px, y0, bw - 4 * s, y1 - y0);
        x.fillStyle = '#2a2e50'; x.fillRect(px + (bw - 4 * s) * 0.3, y0 + (y1 - y0) * 0.45, (bw - 4 * s) * 0.4, (y1 - y0) * 0.1);
        led(px + 6 * s, y0 + 8 * s, i < 6 ? C.free : '#555');
      }
    } else {
      if (it._u >= 2) {
        x.strokeStyle = 'rgba(255,255,255,.06)'; x.lineWidth = 1.5 * s;
        for (let i = 0; i < 10; i++) { const py = H * 0.08 + i * 3 * s; x.beginPath(); x.moveTo(W * 0.2, py); x.lineTo(W * 0.95, py); x.stroke(); }
      }
      if (t === 'firewall') { x.fillStyle = '#b02a3c'; x.fillRect(W * 0.035, H - 3 * s, W * 0.93, 3 * s); }
      if (t === 'appliance') { x.fillStyle = '#0a2a3a'; x.fillRect(W * 0.86, H * 0.2, W * 0.08, H * 0.35); }
    }
  }

  function paintDeviceRear(x, it, W, H, uPx, s) {
    const t = it.type;
    const psu = (px, py, pw, ph) => {
      x.fillStyle = '#121320'; x.fillRect(px, py, pw, ph);
      x.strokeStyle = '#33365a'; x.lineWidth = s; x.strokeRect(px, py, pw, ph);
      x.fillStyle = '#05060c'; x.fillRect(px + pw * 0.08, py + ph * 0.25, pw * 0.22, ph * 0.5);
      x.fillStyle = C.free; x.beginPath(); x.arc(px + pw * 0.85, py + ph * 0.5, Math.max(1, 1.6 * s), 0, 7); x.fill();
    };
    const fan = (cx, cy, r) => {
      x.strokeStyle = '#3a3e62'; x.lineWidth = s; x.beginPath(); x.arc(cx, cy, r, 0, 7); x.stroke();
      for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.cos(a) * r * 0.85, cy + Math.sin(a) * r * 0.85); x.stroke(); }
    };
    const ph = Math.min(uPx * 0.7, H * 0.8), py0 = H - ph - Math.min(uPx * 0.15, H * 0.1);
    if (SWITCHLIKE.has(t) || t === 'appliance') {
      const r = Math.min(uPx * 0.32, W * 0.03);
      for (let i = 0; i < 3; i++) fan(W * (0.3 + i * 0.08), H / 2, r);
      psu(W * 0.62, H * 0.5 - ph / 2, W * 0.15, ph); psu(W * 0.79, H * 0.5 - ph / 2, W * 0.15, ph);
      return;
    }
    // server / storage / chassis: PSUs on the right, PCIe slots above the port band
    if (it._u >= 2) {
      psu(W * 0.8, H * 0.5 - ph - 2 * s, W * 0.17, ph); psu(W * 0.8, H * 0.5 + 2 * s, W * 0.17, ph);
      const n = t === 'chassis' ? 6 : 4;
      for (let i = 0; i < n; i++) {
        const px = W * (0.2 + i * 0.09);
        x.fillStyle = '#10111c'; x.fillRect(px, H * 0.08, W * 0.07, H * 0.5 - uPx * 0.3);
        x.fillStyle = '#2a2d44'; x.fillRect(px + W * 0.025, H * 0.1, W * 0.02, Math.max(2, (H * 0.5 - uPx * 0.3) * 0.8));
      }
      if (t === 'chassis') for (let i = 0; i < 6; i++) fan(W * (0.66 + (i % 2) * 0.06), H * (0.12 + Math.floor(i / 2) * 0.12), Math.min(uPx * 0.3, W * 0.025));
    } else {
      psu(W * 0.8, py0, W * 0.08, ph); psu(W * 0.89, py0, W * 0.08, ph);
    }
  }

  // ------------------------------------------------------------------ racks & items
  const rackObjs = {};
  const itemSideMat = new THREE.MeshStandardMaterial({ color: 0x23263c, metalness: 0.55, roughness: 0.5 });
  const perfTex = (function () {
    const cv = mkCanvas(64, 64), x = cv.getContext('2d');
    x.fillStyle = 'rgba(40,43,72,1)'; x.fillRect(0, 0, 64, 64);
    x.globalCompositeOperation = 'destination-out';
    [[16, 16], [48, 16], [0, 48], [32, 48], [64, 48]].forEach(([cx, cy]) => { x.beginPath(); x.arc(cx, cy, 11, 0, 7); x.fill(); });
    const t = canvasTex(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(14, 46);
    return t;
  })();
  const doorMat = new THREE.MeshStandardMaterial({ map: perfTex, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false, metalness: 0.4, roughness: 0.5 });
  const handleMat = new THREE.MeshStandardMaterial({ color: 0xb8bcd4, metalness: 0.8, roughness: 0.3 });
  const pduMat = new THREE.MeshStandardMaterial({ color: 0x1b1d2c, metalness: 0.4, roughness: 0.6 });
  const pduLedMat = new THREE.MeshBasicMaterial({ color: 0x3ddc84 });
  const starMat = { copper: new THREE.MeshBasicMaterial({ color: C.copper }), mm: new THREE.MeshBasicMaterial({ color: C.mm }), sm: new THREE.MeshBasicMaterial({ color: C.sm }) };
  const gapMat = new THREE.LineDashedMaterial({ color: C.free, dashSize: 0.02, gapSize: 0.012 });
  const gapFillMat = new THREE.MeshBasicMaterial({ color: C.free, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide });

  function faceMaterial(it, face, scale) {
    const cv = mkCanvas(8, 8);
    paintFace(cv, it, face, scale, null);
    const tex = canvasTex(cv);
    return { cv, tex, scale, mat: new THREE.MeshStandardMaterial({ map: tex, metalness: 0.25, roughness: 0.6 }) };
  }
  function makeItemMesh(it, scale, sideMat) {
    const g = geomOf(it);
    const f = faceMaterial(it, 'front', scale), r = faceMaterial(it, 'rear', scale), sm = sideMat || itemSideMat;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(RAIL, g.h, g.depth), [sm, sm, sm, sm, f.mat, r.mat]);
    mesh.position.set(0, g.yb + g.h / 2, g.zf - g.depth / 2);
    mesh.userData.item = it;
    mesh.userData.faces = { front: f, rear: r };
    return mesh;
  }
  function repaint(mesh, face, hover, scale) {
    const f = mesh.userData.faces[face];
    if (scale && scale !== f.scale) {
      f.scale = scale;
      f.cv = mkCanvas(8, 8);
      paintFace(f.cv, mesh.userData.item, face, scale, hover);
      f.tex.dispose();
      f.tex = canvasTex(f.cv);
      f.mat.map = f.tex;
      f.mat.needsUpdate = true;
    } else {
      paintFace(f.cv, mesh.userData.item, face, f.scale, hover);
      f.tex.needsUpdate = true;
    }
  }
  function disposeMesh(mesh) {
    mesh.geometry.dispose();
    ['front', 'rear'].forEach(k => { const f = mesh.userData.faces[k]; f.tex.dispose(); f.mat.dispose(); });
  }

  racks.forEach(r => {
    const grp = new THREE.Group();
    grp.position.set(r._x, 0, r._front);
    grp.rotation.y = r._sgn === 1 ? 0 : Math.PI;
    grp.userData.rack = r;
    const w = r.w, d = r.d, geos = [];
    const box = (sx, sy, sz, px, py, pz) => { const g = new THREE.BoxGeometry(sx, sy, sz); g.translate(px, py, pz); geos.push(g); };
    box(0.014, RH - 0.03, d, -w / 2 + 0.007, (RH - 0.03) / 2, -d / 2);
    box(0.014, RH - 0.03, d, w / 2 - 0.007, (RH - 0.03) / 2, -d / 2);
    box(w, 0.03, d, 0, RH - 0.015, -d / 2);
    box(w - 0.02, BASE, d - 0.04, 0, BASE / 2, -d / 2);
    box(w, 0.05, 0.03, 0, RH - 0.055, -0.03);
    box(w, 0.05, 0.03, 0, RH - 0.055, -d + 0.03);
    const rearRail = -Math.min(d - 0.12, 0.85);
    [FRONT_RAIL, rearRail].forEach(z => [-1, 1].forEach(s => box(0.018, RACK_U * U + 0.02, 0.045, s * (RAIL / 2 + 0.009), BASE + RACK_U * U / 2, z + (z === FRONT_RAIL ? -0.0225 : 0.0225))));
    const bodyMat = new THREE.MeshStandardMaterial({ color: C.rack, metalness: 0.45, roughness: 0.55, emissive: 0x000000 });
    const body = new THREE.Mesh(merge(geos), bodyMat);
    body.castShadow = true; body.receiveShadow = true;
    body.userData.rack = r;
    grp.add(body);

    const doorGeo = new THREE.BoxGeometry(w - 0.012, RH - 0.07, 0.01);
    const doorF = new THREE.Mesh(doorGeo, doorMat);
    doorF.position.set(0, (RH - 0.07) / 2 + 0.03, -0.006);
    doorF.userData.rack = r;
    const hdl = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.2, 0.025), handleMat);
    hdl.position.set(w / 2 - 0.05, 0, 0.015);
    doorF.add(hdl);
    const doorR = new THREE.Mesh(doorGeo, doorMat);
    doorR.position.set(0, (RH - 0.07) / 2 + 0.03, -d + 0.006);
    doorR.userData.rack = r;
    grp.add(doorF, doorR);

    r.star.forEach((m, i) => {
      const n = r.star.length, sw = (w - 0.04) / n;
      const strip = new THREE.Mesh(new THREE.BoxGeometry(sw - 0.01, 0.014, 0.12), starMat[m] || starMat.copper);
      strip.position.set(-w / 2 + 0.02 + sw * (i + 0.5), RH + 0.007, -0.08);
      grp.add(strip);
    });

    const pdus = [];
    [-1, 1].forEach(s => {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.055, 1.7, 0.06), pduMat);
      p.position.set(s * (w / 2 - 0.045), BASE + 0.9, -d + 0.06);
      const ledM = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 0.004), pduLedMat);
      ledM.position.set(0, 0.8, -0.031);
      p.add(ledM);
      p.userData.pdu = { rack: r, master: s === 1 };
      grp.add(p); pdus.push(p);
    });

    const items = [];
    r.items.forEach(it => {
      if (it.kind === 'gap') return;
      const m = makeItemMesh(it, 1);
      grp.add(m); items.push(m); it._mesh = m;
    });

    const label = css2d('<b>' + esc(r.id) + '</b><small>' + esc(r.name || '') + '</small>' +
      (r.items.some(isItemNew) ? '<br><span class="tag">+' + r.items.filter(isItemNew).length + ' new</span>' : ''), 'rack-label');
    label.position.set(0, RH + 0.22, -d / 2);
    grp.add(label);

    scene.add(grp);
    rackObjs[r.id] = { group: grp, body, bodyMat, doorF, doorR, items, pdus, label, overlay: null, gaps: null };
  });

  function buildGaps(r) {
    const g = new THREE.Group();
    r.items.forEach(it => {
      if (it.kind !== 'gap') return;
      const yb = BASE + (it._bottom - 1) * U + 0.002, yt = BASE + it._top * U - 0.002, z = FRONT_RAIL + 0.006;
      const x0 = -RAIL / 2 + 0.006, x1 = RAIL / 2 - 0.006;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([v(x0, yb, z), v(x1, yb, z), v(x1, yt, z), v(x0, yt, z), v(x0, yb, z)]), gapMat);
      line.computeLineDistances();
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, yt - yb), gapFillMat);
      fill.position.set(0, (yb + yt) / 2, z);
      const lab = css2d(esc(fmtRange(it)) + ' · ' + it._u + 'U free', 'gap-label');
      lab.position.set(0, (yb + yt) / 2, z);
      g.add(line, fill, lab);
    });
    g.visible = false;
    return g;
  }
  function buildOverlay(r) {
    const g = new THREE.Group();
    // U ruler on the left rail
    const cv = mkCanvas(64, RACK_U * 32), x = cv.getContext('2d');
    x.fillStyle = '#0d0e1c'; x.fillRect(0, 0, 64, cv.height);
    for (let i = 0; i < RACK_U; i++) {
      const y = i * 32;
      x.fillStyle = i % 2 ? '#15172a' : '#101224'; x.fillRect(0, y, 64, 32);
      x.fillStyle = '#5a5f8a'; x.fillRect(44, y, 20, 2);
      text(x, String(RACK_U - i), 34, y + 16, 17, C.muted, 600, 'right');
    }
    const ruler = new THREE.Mesh(new THREE.PlaneGeometry(0.03, RACK_U * U), new THREE.MeshBasicMaterial({ map: canvasTex(cv) }));
    ruler.position.set(-RAIL / 2 - 0.04, BASE + RACK_U * U / 2, FRONT_RAIL + 0.02);
    g.add(ruler);
    // item labels on the right side
    r.items.forEach(it => {
      if (it.kind === 'gap' || it.kind === 'org') return;
      const gm = geomOf(it);
      const lab = css2d(esc(fmtRange(it)) + ' · ' + esc(itemName(it)), 'item-label' + (isItemNew(it) ? ' new' : ''));
      lab.position.set(r.w / 2 + 0.01, (gm.yb + gm.yt) / 2, FRONT_RAIL);
      g.add(lab);
    });
    g.visible = false;
    return g;
  }

  // ------------------------------------------------------------------ cable geometry
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function lane(s) {
    const h = hash(s);
    return { o: (h % 9) - 4, k: (h >>> 4) % 12, dz: (((h >>> 8) % 11) - 5) * 0.022, dx: (((h >>> 12) % 9) - 4) * 0.02, dy: ((h >>> 16) % 3) * 0.012 };
  }
  function clean(pts) {
    const out = [];
    pts.forEach(p => { if (!out.length || out[out.length - 1].distanceToSquared(p) > 1e-8) out.push(p); });
    return out;
  }
  function rounded(pts, r) {
    pts = clean(pts); r = r || 0.04;
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1], p = pts[i], b = pts[i + 1], da = p.distanceTo(a), db = p.distanceTo(b);
      const rr = Math.min(r, da * 0.45, db * 0.45);
      const p0 = p.clone().lerp(a, rr / da), p2 = p.clone().lerp(b, rr / db);
      for (let k = 0; k <= 4; k++) {
        const t = k / 4, u = 1 - t;
        out.push(v(u * u * p0.x + 2 * u * t * p.x + t * t * p2.x, u * u * p0.y + 2 * u * t * p.y + t * t * p2.y, u * u * p0.z + 2 * u * t * p.z + t * t * p2.z));
      }
    }
    out.push(pts[pts.length - 1]);
    return clean(out);
  }
  // Tube swept along a polyline with parallel-transport frames.
  function tubeGeo(pts, radius, radial) {
    radial = radial || 6;
    const n = pts.length, pos = new Float32Array(n * radial * 3), nor = new Float32Array(n * radial * 3), idx = [];
    const T = v(0, 0, 0), N = v(0, 0, 0), B = v(0, 0, 0), tmp = v(0, 0, 0);
    for (let i = 0; i < n; i++) {
      T.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize();
      if (i === 0) N.crossVectors(T, Math.abs(T.y) < 0.9 ? v(0, 1, 0) : v(1, 0, 0)).normalize();
      else {
        N.sub(tmp.copy(T).multiplyScalar(N.dot(T)));
        if (N.lengthSq() < 1e-8) N.crossVectors(T, Math.abs(T.y) < 0.9 ? v(0, 1, 0) : v(1, 0, 0));
        N.normalize();
      }
      B.crossVectors(T, N).normalize();
      for (let j = 0; j < radial; j++) {
        const a = j / radial * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), k = (i * radial + j) * 3;
        const nx = c * N.x + s * B.x, ny = c * N.y + s * B.y, nz = c * N.z + s * B.z;
        pos[k] = pts[i].x + radius * nx; pos[k + 1] = pts[i].y + radius * ny; pos[k + 2] = pts[i].z + radius * nz;
        nor[k] = nx; nor[k + 1] = ny; nor[k + 2] = nz;
      }
    }
    for (let i = 0; i < n - 1; i++) for (let j = 0; j < radial; j++) {
      const a = i * radial + j, b = i * radial + (j + 1) % radial, c = (i + 1) * radial + j, d = (i + 1) * radial + (j + 1) % radial;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(idx);
    return g;
  }
  const polyLen = pts => { let s = 0; for (let i = 1; i < pts.length; i++) s += pts[i].distanceTo(pts[i - 1]); return s; };

  // An anchor is {rack, p (local), face} or {world}.
  function anchorOf(ref) {
    if (typeof ref === 'string') {
      const { key, port } = parseHop(ref), it = panelByKey[key];
      if (!it || !(port > 0)) return null;
      const name = String(port);
      const rearName = it.kind === 'lc' ? 'C' + (Math.floor((port - 1) / CASS_PORTS) + 1) + 'A' : name;
      return { type: 'panel', rack: it._rack, item: it, port, name, front: portLocal(it, name, 'front'), rear: portLocal(it, rearName, 'rear'),
        tkey: it.kind === 'lc' ? key + '.C' + (Math.floor((port - 1) / CASS_PORTS) + 1) : key };
    }
    if (devByLabel[ref.item]) {
      const it = devByLabel[ref.item], f = portFace(it);
      return { type: 'device', rack: it._rack, item: it, name: ref.port, face: f, p: portLocal(it, ref.port, f) };
    }
    if (/^PDU:/.test(ref.item)) {
      const r = rackById[ref.item.slice(4)];
      return r ? { type: 'pdu', rack: r, face: 'rear', p: pduLocal(r) } : null;
    }
    const e = extById[ref.item];
    return e ? { type: 'external', ext: e, world: extPos(e) } : null;
  }
  const side = medium => medium === 'copper' ? 1 : -1;
  const asRun = E => E.type === 'panel' ? { rack: E.rack, p: E.rear, face: 'rear' } : E;
  const asPatch = E => E.type === 'panel' ? { rack: E.rack, p: E.front, face: 'front' } : E;

  function patchPath(r, A, B, sd, ln) {
    const ox = sd * (orgX(r) - 0.008 + ln.o * 0.0022), zf = FRONT_RAIL + 0.028 + (ln.k % 5) * 0.004;
    const ap = E => {
      const p = E.p;
      if (E.face === 'front') return [p, v(p.x, p.y, zf), v(ox, p.y, zf)];
      const zr = p.z - 0.03;
      return [p, v(p.x, p.y, zr), v(ox, p.y, zr), v(ox, p.y, zf)];
    };
    return ap(A).concat(ap(B).reverse()).map(p => toW(r, p));
  }
  function rise(A, h, sd, ln, trayKey) {
    if (A.world) {
      const w = A.world;
      return { pts: [w, v(w.x, h, w.z)], x: w.x, z: w.z, ext: true };
    }
    const r = A.rack, p = A.p, ox = sd * (orgX(r) - 0.006 + ln.o * 0.002);
    let loc;
    if (A.face === 'front') {
      const z = FRONT_RAIL + 0.03 + (ln.k % 4) * 0.004;
      loc = [p, v(p.x, p.y, z), v(ox, p.y, z), v(ox, RH - 0.05, z), v(ox, RH + 0.02, z - 0.06)];
    } else {
      const z = p.z - 0.035 - (ln.k % 4) * 0.004;
      loc = [p, v(p.x, p.y, z), v(ox, p.y, z), v(ox, RH + 0.02, z)];
    }
    const pts = loc.map(q => toW(r, q)), top = pts[pts.length - 1];
    const zt = r._row.trayZ[trayKey] + ln.dz * (trayKey === 'fiber' ? 0.5 : 1);
    pts.push(v(top.x, h, top.z), v(top.x, h, zt));
    return { pts, x: top.x, z: zt, ext: false };
  }
  function runPath(A, B, medium, ln) {
    const trayKey = medium === 'mm' || medium === 'sm' ? 'fiber' : 'copper';
    const h = ROOM.trayHeights[trayKey] - 0.035 + ln.dy, sd = side(medium);
    const a = rise(A, h, sd, ln, trayKey), b = rise(B, h, sd, ln, trayKey);
    let mid = [];
    if (a.ext || b.ext || Math.abs(a.z - b.z) > 0.2) {
      const opts = (a.ext || b.ext) ? X_END : CROSS;
      let best = opts[0], bd = Infinity;
      opts.forEach(c => { const dd = Math.abs(a.x - c) + Math.abs(c - b.x); if (dd < bd) { bd = dd; best = c; } });
      const cx = best + ln.dx;
      mid = [v(cx, h, a.z), v(cx, h, b.z)];
    } else if (Math.abs(a.z - b.z) > 1e-6) {
      mid = [v((a.x + b.x) / 2, h, a.z), v((a.x + b.x) / 2, h, b.z)];
    }
    return a.pts.concat(mid, b.pts.slice().reverse());
  }

  function trunkAnchor(ref) {
    if (extById[ref]) return { world: extPos(extById[ref]) };
    const m = /^(.*#F\d+)\.C(\d+)$/.exec(ref);
    if (m) { const it = panelByKey[m[1]]; return it ? { rack: it._rack, face: 'rear', p: portLocal(it, 'C' + m[2] + 'A', 'rear') } : null; }
    const it = panelByKey[ref];
    if (!it) return null;
    return { rack: it._rack, face: 'rear', p: portLocal(it, '12', 'rear').add(portLocal(it, '13', 'rear')).multiplyScalar(0.5) };
  }
  const trunkLayer = t => extById[t.b] || extById[t.a] ? 'exit' : t.interRow ? 'interrow' : 'trunk-' + mkey(t.medium);
  const TRUNK_R = { 'trunk-cu': 0.011, 'trunk-mm': 0.006, 'trunk-sm': 0.006, interrow: 0.014, exit: 0.008 };

  function cablePieces(c) {
    const E = [anchorOf(c.a)].concat(c.hops.map(anchorOf), [anchorOf(c.b)]);
    if (E.some(e => !e)) return [];
    const out = [];
    for (let i = 0; i < E.length - 1; i++) {
      const P = E[i], Q = E[i + 1], ln = lane(c.id + ':' + i);
      if (P.rack && Q.rack && P.rack === Q.rack) {
        out.push({ type: 'patch', P, Q, cross: P.type === 'panel' && Q.type === 'panel', pts: patchPath(P.rack, asPatch(P), asPatch(Q), side(c.medium), ln) });
        continue;
      }
      let t = null;
      if (P.type === 'panel' && trunkPeer[P.tkey]) {
        const peer = trunkPeer[P.tkey];
        if ((Q.type === 'panel' && peer.peer === Q.tkey) || (Q.type === 'external' && peer.peer === Q.ext.id)) t = peer.t;
      } else if (Q.type === 'panel' && P.type === 'external' && trunkPeer[Q.tkey] && trunkPeer[Q.tkey].peer === P.ext.id) t = trunkPeer[Q.tkey].t;
      const pts = runPath(asRun(P), asRun(Q), c.medium, t ? lane(t.a + '|' + t.b) : ln);
      out.push({ type: 'run', P, Q, trunk: t, pts });
    }
    return out;
  }
  function pieceLayer(c, pc) {
    if (pc.trunk) return null;
    if (c.status === 'pending') return 'pending';
    if (c.kind === 'pdu') return 'pdu';
    if (c.kind === 'door') return 'door';
    if (pc.type === 'run') return c.kind === 'active' ? 'active' : c.kind === 'exit' ? 'exit' : 'patch-' + mkey(c.medium);
    return 'patch-' + mkey(c.medium);
  }

  const LAYER_DEFS = [
    { id: 'walls', label: 'Room & walls', group: 'Room', color: '#6b70a0' },
    { id: 'trays', label: 'Cable trays', group: 'Room', color: '#8a91b4' },
    { id: 'doors', label: 'Rack doors', group: 'Room', color: '#4b4f78' },
    { id: 'labels', label: 'Rack labels', group: 'Room', color: '#eceaf4' },
    { id: 'heat', label: 'Heat map (exhaust)', group: 'Room', color: '#ff8a1f' },
    { id: 'trunk-cu', label: 'Copper trunks', group: 'Trunks', color: '#3a6df0' },
    { id: 'trunk-mm', label: 'MM fiber trunks', group: 'Trunks', color: '#7ac81e' },
    { id: 'trunk-sm', label: 'SM fiber trunks', group: 'Trunks', color: '#e8b820' },
    { id: 'interrow', label: 'Inter-row trunk', group: 'Trunks', color: '#00d0ff' },
    { id: 'exit', label: 'Provider-room exits', group: 'Trunks', color: C.exit },
    { id: 'patch-cu', label: 'Copper patch cords', group: 'Cables', color: C.copper },
    { id: 'patch-mm', label: 'MM fiber cords', group: 'Cables', color: C.mm },
    { id: 'patch-sm', label: 'SM fiber cords', group: 'Cables', color: C.sm },
    { id: 'active', label: 'Active cables', group: 'Cables', color: C.active },
    { id: 'pdu', label: 'PDU management', group: 'Cables', color: C.pdu },
    { id: 'door', label: 'Door & cameras', group: 'Cables', color: C.door },
    { id: 'pending', label: 'Pending', group: 'Cables', color: C.pending },
  ];
  const CABLE_LAYERS = LAYER_DEFS.filter(d => d.group !== 'Room').map(d => d.id);
  const LEVELS = {
    room: ['walls', 'trays', 'doors', 'labels'],
    trunks: ['walls', 'trays', 'doors', 'labels', 'trunk-cu', 'trunk-mm', 'trunk-sm', 'interrow', 'exit'],
    all: LAYER_DEFS.map(d => d.id),
  };
  const layerCount = {};
  const cableMeshes = {};
  const cablesGroup = new THREE.Group();
  scene.add(cablesGroup);

  (function buildCables() {
    const geos = {};
    const push = (id, g) => { (geos[id] = geos[id] || []).push(g); };
    const counted = {};
    cables.forEach(c => {
      c._pieces = cablePieces(c);
      c._len = sum(c._pieces, p => polyLen(p.pts));
      c._pieces.forEach(pc => {
        const id = pieceLayer(c, pc);
        if (!id) return;
        pc.layer = id;
        push(id, tubeGeo(rounded(pc.pts, pc.type === 'patch' ? 0.025 : 0.06), pc.type === 'patch' ? 0.0032 : 0.0045, 5));
        (counted[id] = counted[id] || new Set()).add(c.id);
      });
    });
    trunks.forEach(t => {
      const A = trunkAnchor(t.a), B = trunkAnchor(t.b);
      if (!A || !B) return;
      const id = trunkLayer(t);
      t._pts = runPath(A, B, t.medium, lane(t.a + '|' + t.b));
      t._len = polyLen(t._pts);
      push(id, tubeGeo(rounded(t._pts, 0.07), TRUNK_R[id] || 0.008, 7));
      layerCount[id] = (layerCount[id] || 0) + 1;
    });
    Object.keys(counted).forEach(id => { layerCount[id] = counted[id].size; });
    LAYER_DEFS.forEach(d => {
      if (!geos[d.id]) return;
      const col = new THREE.Color(d.color);
      const mat = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.25, roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(merge(geos[d.id]), mat);
      mesh.visible = false;
      cablesGroup.add(mesh);
      cableMeshes[d.id] = mesh;
    });
    layerCount.walls = '';
    layerCount.trays = rows.length * 2 + CROSS.length * 2;
    layerCount.doors = racks.length * 2;
    layerCount.labels = racks.length;
    layerCount.heat = racks.length;
  })();

  // Heat map: a tile on the floor behind each rack, in the hot aisle, coloured by its
  // estimated exhaust temperature, with the temperature written on it.
  const heatGroup = new THREE.Group();
  scene.add(heatGroup);
  racks.forEach(r => {
    const p = power(r), deep = Math.min(0.8, ROOM.hotAisle - 0.1);
    const tile = new THREE.Mesh(new THREE.PlaneGeometry(r.w - 0.04, deep),
      new THREE.MeshBasicMaterial({ color: heatColor(p.exhaustC), transparent: true, opacity: 0.55, depthWrite: false }));
    tile.rotation.x = -Math.PI / 2;
    tile.position.copy(toW(r, v(0, 0.006, -r.d - deep / 2 - 0.02)));
    const lab = css2d(Math.round(p.exhaustC) + ' °C<small>' + kw(p.w) + '</small>', 'heat-label ' + p.status);
    lab.position.copy(toW(r, v(0, 0.35, -r.d - deep / 2)));
    heatGroup.add(tile, lab);
  });

  // ------------------------------------------------------------------ helpers for text
  function fmtRange(it) { return it._u === 1 ? 'U' + it._top : 'U' + it._top + '–U' + it._bottom; }
  function itemName(it) {
    switch (it.kind) {
      case 'device': return it.label;
      case 'utp': return it.id + ' · UTP 24p · ' + (ROLE_NAME[it.role] || it.role || 'Trunk');
      case 'lc': return it.id + ' · Fiber tray · ' + it.cassettes.map(c => c ? c.medium.toUpperCase() : '—').join('/');
      case 'org': return 'Cable organizer';
      case 'gap': return it._u + 'U free';
      default: return it.kind;
    }
  }
  function swatch(it) {
    if (it.kind === 'gap') return 'transparent';
    if (isItemNew(it)) return C.new;
    if (it.kind === 'utp') return C.copper;
    if (it.kind === 'lc') return it.cassettes.some(c => c && c.medium === 'sm') ? C.sm : C.mm;
    if (it.kind === 'org') return '#4b4f78';
    return ({ switch: '#4f7bff', router: '#7a6bff', firewall: '#ff5f7a', server: '#6c7396', storage: '#38b2a5', chassis: '#9a8cff', appliance: '#3fc0d8', tap: '#c0a0ff', wlc: '#5fb0ff' })[it.type] || '#888';
  }
  function rackStats(r) {
    const s = { uFree: 0, uUsed: 0, devices: 0, newItems: 0, panels: 0, trays: 0, copper: { inst: 0, newInst: 0, used: 0 }, mm: { inst: 0, newInst: 0, used: 0 }, sm: { inst: 0, newInst: 0, used: 0 } };
    r.items.forEach(it => {
      if (it.kind === 'gap') { s.uFree += it._u; return; }
      s.uUsed += it._u;
      if (it.kind === 'device') s.devices++;
      if (it.isNew) s.newItems++;
      if (it.kind === 'utp') {
        s.panels++;
        if (it.role === 'existing') return;
        s.copper.inst += UTP_PORTS;
        if (it.isNew) s.copper.newInst += UTP_PORTS;
        for (let p = 1; p <= UTP_PORTS; p++) if (portCable[it._key + ':' + p]) s.copper.used++;
      }
      if (it.kind === 'lc') {
        s.trays++;
        it.cassettes.forEach((c, ci) => {
          if (!c) return;
          const m = c.medium === 'sm' ? 'sm' : 'mm';
          s[m].inst += CASS_PORTS;
          if (c.isNew || it.isNew) s[m].newInst += CASS_PORTS;
          if (c.isNew && !it.isNew) s.newItems++;
          for (let k = 1; k <= CASS_PORTS; k++) if (portCable[it._key + ':' + (ci * CASS_PORTS + k)]) s[m].used++;
        });
      }
    });
    s.cables = cablesOfRack(r).length;
    return s;
  }
  function endpointText(ref) {
    if (typeof ref === 'string') {
      const { key, port } = parseHop(ref), it = panelByKey[key];
      if (!it) return { t: shortRef(ref), sub: 'unknown panel' };
      const cas = it.kind === 'lc' ? ' (C' + (Math.floor((port - 1) / CASS_PORTS) + 1) + '/' + (((port - 1) % CASS_PORTS) + 1) + ')' : '';
      return { t: it._rack.id + ' ' + it.id + ' · port ' + port + cas, sub: (it.kind === 'lc' ? 'Fiber tray ' : 'UTP panel ') + fmtRange(it) };
    }
    if (devByLabel[ref.item]) { const it = devByLabel[ref.item]; return { t: ref.item + ' · ' + ref.port, sub: it._rack.id + ' ' + fmtRange(it) }; }
    if (/^PDU:/.test(ref.item)) return { t: 'PDU ' + ref.item.slice(4) + ' · ' + ref.port, sub: 'Rack PDU (rear)' };
    const e = extById[ref.item];
    return { t: (e ? e.label : ref.item) + (ref.port ? ' · ' + ref.port : ''), sub: 'Not in any rack' };
  }
  function cableSummary(c) { return c.a.item.replace(/^PDU:/, 'PDU ') + ' ' + c.a.port + ' → ' + c.b.item.replace(/^PDU:/, 'PDU ') + ' ' + c.b.port; }

  // ------------------------------------------------------------------ state & visibility
  const state = { level: 'room', layers: new Set(LEVELS.room), mode: 'room', rack: null, row: null, face: 'front', aisle: null, sel: null, trace: null, hoverRack: null };
  const stack = [];
  const walk = { active: false, poses: [], idx: 0, t: 0, phase: 'dwell', paused: false, speed: 1, rack: null };
  const tour = { list: [], i: 0, t: 0, paused: false, dwell: 6 };
  const fit = { need: null, results: null, byRack: null };

  function boxPlanes(min, max) {
    return [
      new THREE.Plane(v(1, 0, 0), -min.x), new THREE.Plane(v(-1, 0, 0), max.x),
      new THREE.Plane(v(0, 1, 0), -min.y), new THREE.Plane(v(0, -1, 0), max.y),
      new THREE.Plane(v(0, 0, 1), -min.z), new THREE.Plane(v(0, 0, -1), max.z),
    ];
  }
  function rackBox(r) {
    const a = toW(r, v(-r.w / 2 - 0.02, 0, 0.05)), b = toW(r, v(r.w / 2 + 0.02, RH + 0.22, -r.d - 0.02));
    return boxPlanes(v(Math.min(a.x, b.x), 0, Math.min(a.z, b.z)), v(Math.max(a.x, b.x), RH + 0.22, Math.max(a.z, b.z)));
  }
  function rowBox(R) {
    const zs = [R.front + R.sgn * 0.05, R.front - R.sgn * (R.maxD + 0.02)];
    return boxPlanes(v(X0 - 0.02, 0, Math.min(...zs)), v(X0 + R.len + 0.02, RH + 0.22, Math.max(...zs)));
  }
  const inRackMode = () => state.mode === 'rack' || state.mode === 'tour';

  function applyVisibility() {
    const m = state.mode, L = state.layers, inRack = inRackMode(), isRow = m === 'row';
    const tr = m === 'trace' ? trace : null;
    racks.forEach(r => {
      const o = rackObjs[r.id];
      o.group.visible = inRack ? r === state.rack : isRow ? r._row === state.row : true;
      const touched = !tr || tr.racks.has(r);
      o.bodyMat.transparent = !touched; o.bodyMat.opacity = touched ? 1 : 0.1; o.bodyMat.depthWrite = touched;
      o.items.forEach(mesh => ghostItem(mesh, !!tr && !tr.items.has(mesh.userData.item)));
      o.pdus.forEach(pm => { pm.visible = touched; });
      const focus = (m === 'walk' && walk.rack === r);
      const doors = L.has('doors') && !inRack && !isRow && !focus && !tr;
      o.doorF.visible = doors;
      o.doorR.visible = doors;
      o.label.userData.show = L.has('labels') && !inRack && !isRow && ((m !== 'walk' && m !== 'aisle') || focus) && touched;
      if (o.overlay) o.overlay.visible = m === 'rack' && r === state.rack;
      if (o.gaps) o.gaps.visible = (inRack && r === state.rack) || focus;
      glow(r, focus);
      if (o.ghost) {
        o.ghost.visible = !!fit.results && (inRack ? r === state.rack : true);
        o.ghost.userData.label.userData.show = inRack;    // in the room the boxes say enough; labels would pile up
      }
    });
    doorMat.opacity = (m === 'aisle' || m === 'walk') ? 0.38 : 0.9;
    wallsGroup.visible = L.has('walls') && !inRack && !isRow;
    heatGroup.visible = L.has('heat') && !inRack && !isRow && !tr;
    traysGroup.visible = L.has('trays') && !inRack && !isRow;
    const clip = inRack && state.rack ? rackBox(state.rack) : isRow && state.row ? rowBox(state.row) : null;
    CABLE_LAYERS.forEach(id => {
      const mesh = cableMeshes[id];
      if (!mesh) return;
      mesh.visible = tr ? false : inRack ? true : L.has(id);
      mesh.material.clippingPlanes = clip;
    });
    syncLabels();
    renderer.shadowMap.needsUpdate = true;
    invalidate();
  }
  function syncLabels() {
    scene.traverse(o => {
      if (!o.isCSS2DObject) return;
      let vis = o.userData.show !== false, p = o.parent;
      while (vis && p) { if (!p.visible) vis = false; p = p.parent; }
      o.visible = vis;
    });
  }
  function effVisible(o) { while (o) { if (!o.visible) return false; o = o.parent; } return true; }

  // ------------------------------------------------------------------ render loop
  let needsRender = true;
  function invalidate() { needsRender = true; }
  const clock = new THREE.Clock();
  let camTween = null;
  const tweens = [];
  const ease = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  function tween(ms, fn, done) { const t = { t0: performance.now(), ms, fn, done }; tweens.push(t); invalidate(); return t; }
  function flyTo(pos, target, fov, ms, cam, ctl) {
    cam = cam || camera; ctl = ctl || controls;
    if (camTween) { const i = tweens.indexOf(camTween); if (i >= 0) tweens.splice(i, 1); }
    const p0 = cam.position.clone(), t0 = ctl.target.clone(), f0 = cam.fov, f1 = fov || f0;
    camTween = tween(ms == null ? 800 : ms, k => {
      cam.position.lerpVectors(p0, pos, k);
      ctl.target.lerpVectors(t0, target, k);
      cam.fov = f0 + (f1 - f0) * k;
      cam.updateProjectionMatrix();
      cam.lookAt(ctl.target);
    }, () => { camTween = null; });
  }
  function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(0.1, clock.getDelta());
    if (document.hidden) return;
    let anim = false;
    if (tweens.length) {
      anim = true;
      for (let i = tweens.length - 1; i >= 0; i--) {
        const t = tweens[i];
        const k = t.ms > 0 ? Math.min(1, (performance.now() - t.t0) / t.ms) : 1;
        t.fn(ease(k));
        if (k >= 1) { tweens.splice(i, 1); if (t.done) t.done(); }
      }
    }
    if (tickWalk(dt)) anim = true;
    tickTour(dt);
    tickTrace(dt);
    const ctl = studio.open ? studio.controls : controls;
    if (ctl && ctl.enabled && ctl.update()) anim = true;
    if (!needsRender && !anim) return;
    needsRender = false;
    if (studio.open) {
      renderer.render(studio.scene, studio.cam);
      studio.labels.render(studio.scene, studio.cam);
    } else {
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    }
  }
  controls.addEventListener('change', invalidate);

  // ------------------------------------------------------------------ camera presets
  function roomCam() {
    const cz = (RZ0 + RZ1) / 2, k = Math.max(1, 1.5 / Math.max(0.3, camera.aspect));
    return { pos: v(X0 - 2.2 * k, 5.6 * k, cz + 7.8 * k), target: v(0, 0.8, cz), fov: 45 };
  }
  function rackCam(r, face, focus) {
    if (face === 'rear') return { pos: toW(r, v(0, 1.05, -r.d - 2.6)), target: toW(r, v(0, 1.0, -r.d + 0.1)), fov: 45 };
    if (face === 'side') return { pos: toW(r, v(2.7, 1.25, -r.d / 2 + 0.4)), target: toW(r, v(0, 1.0, -r.d / 2)), fov: 45 };
    if (focus) {
      const g = geomOf(focus), y = (g.yb + g.yt) / 2;
      return { pos: toW(r, v(0.12, y + 0.1, 0.95)), target: toW(r, v(0, y, FRONT_RAIL)), fov: 45 };
    }
    return { pos: toW(r, v(0, 1.05, 2.6)), target: toW(r, v(0, 1.0, -0.1)), fov: 45 };
  }
  function rowCam(R, face) {
    const fov = 24, t = Math.tan(THREE.MathUtils.degToRad(fov / 2));
    const W = R.len + 0.9, Hh = RH + 0.7;
    const D = Math.max((Hh / 2) / t, (W / 2) / (t * camera.aspect));
    const cx = X0 + R.len / 2;
    const zRef = face === 'front' ? R.front : R.front - R.sgn * R.maxD;
    const dir = face === 'front' ? R.sgn : -R.sgn;
    return { pos: v(cx, 1.0, zRef + dir * D), target: v(cx, 1.0, zRef), fov };
  }
  function aisleCam(a, look, x) {
    // stand at the far edge of the aisle so the facing row fits in view
    const back = look === 'along' ? 0 : (look === 'a' ? 1 : -1) * Math.max(0, a.width / 2 - 0.15);
    const pos = v(x, 1.6, a.z + back);
    const target = look === 'along' ? v(x + 4, 1.45, a.z) : v(x, 1.05, a.z + (look === 'a' ? -2 : 2));
    return { pos, target, fov: 74 };
  }

  // ------------------------------------------------------------------ modes
  function snapshot() {
    return { mode: state.mode, rack: state.rack, row: state.row, face: state.face, aisle: state.aisle && Object.assign({}, state.aisle),
      cam: camera.position.clone(), target: controls.target.clone(), fov: camera.fov, walkIdx: walk.idx, tourI: tour.i,
      cable: trace.c, traceStep: trace.step, traceWhole: trace.whole };
  }
  function pushMode() { stack.push(snapshot()); }

  function teardown(prev) {
    if (prev === 'rack' || prev === 'tour') {
      const r = state.rack;
      if (r) rackObjs[r.id].items.forEach(m => { repaint(m, 'front', null, 1); repaint(m, 'rear', null, 1); });
      $('#elev').hidden = true;
    }
    if (prev === 'walk') { walk.active = false; walk.rack = null; if (doorPivot) doorPivot.rotation.y = 0; }
    if (prev === 'trace') {
      clearTraceGroup();
      trace.c = null; trace.playing = false; trace.racks.clear(); trace.items.clear();
      hideCard();
    }
    $('#placard').hidden = true;
    $('#modebar').hidden = true;
    clearSel();
    setHover(null);
  }

  function setMode(mode, opt) {
    opt = opt || {};
    teardown(state.mode);
    state.mode = mode;
    state.rack = opt.rack || null;
    state.row = opt.row || null;
    state.face = opt.face || 'front';
    state.aisle = opt.aisle || null;
    controls.enabled = true; controls.enableRotate = true; controls.enablePan = true; controls.enableZoom = true;
    let cam = null;
    if (mode === 'room') {
      cam = roomCam();
    } else if (mode === 'rack') {
      showRackVisuals(state.rack);
      renderElev(state.rack);
      cam = rackCam(state.rack, state.face, opt.focus);
      rackBar();
      if (opt.focus) selectItem(opt.focus); else showRackCard(state.rack);
    } else if (mode === 'tour') {
      tour.i = opt.tourI || 0;
      state.rack = tour.list[tour.i];
      showRackVisuals(state.rack);
      cam = rackCam(state.rack, 'front');
      tourBar();
      showPlacard(state.rack, 'Rack tour · ' + (tour.i + 1) + ' / ' + tour.list.length);
    } else if (mode === 'row') {
      controls.enableRotate = false;
      cam = rowCam(state.row, state.face);
      rowBar();
    } else if (mode === 'aisle') {
      controls.enabled = false;
      cam = aisleCam(aisles[state.aisle.idx], state.aisle.look, state.aisle.x);
      aisleBar();
    } else if (mode === 'walk') {
      controls.enabled = false;
      startWalk(opt.walkIdx || 0, !!opt.paused);
    } else if (mode === 'trace') {
      trace.c = opt.cable; trace.steps = traceSteps(trace.c); trace.playing = false; trace.t = 0;
      trace.step = Math.max(0, Math.min(trace.steps.length - 1, opt.step || 0)); trace.whole = !!opt.whole;
      trace.steps.forEach(st => { if (st.E && st.E.rack) trace.racks.add(st.E.rack); if (st.E && st.E.item) trace.items.add(st.E.item); });
      drawTrace();
      traceBar();
      showCableCard(trace.c);
      cam = trace.whole ? wholeCam() : stepCam(trace.steps[trace.step]);
    }
    document.body.dataset.mode = mode;
    applyVisibility();
    updateHint();
    $$('#views [data-act]').forEach(b => b.classList.toggle('on', (b.dataset.act === mode) || (b.dataset.act === 'aisle' && mode === 'aisle') || (b.dataset.act === 'tour' && mode === 'tour')));
    $$('#rowButtons button').forEach(b => b.classList.toggle('on', mode === 'row' && state.row && b.dataset.row === state.row.key));
    const r = opt.restore;
    if (r) flyTo(r.cam, r.target, r.fov, mode === 'walk' || mode === 'aisle' ? 0 : 700);
    else if (cam) flyTo(cam.pos, cam.target, cam.fov, mode === 'aisle' ? 500 : 800);
  }

  function back() {
    if (!$('#studio').hidden) return closeStudio();
    if (!$('#modal').hidden) return closeModal();
    if (!$('#results').hidden) return hideResults();
    const s = stack.pop();
    if (!s) {
      if (state.mode !== 'room') setMode('room');
      hideCard();
      return;
    }
    hideCard();
    setMode(s.mode, { rack: s.rack, row: s.row, face: s.face, aisle: s.aisle, walkIdx: s.walkIdx, tourI: s.tourI, paused: true, restore: s, cable: s.cable, step: s.traceStep, whole: s.traceWhole });
  }
  function goRoom() { stack.length = 0; setMode('room'); }

  function openRack(r, opt) {
    if (!r) return;
    if (state.mode !== 'rack') pushMode();
    setMode('rack', { rack: r, face: (opt && opt.face) || 'front', focus: opt && opt.focus });
  }
  function openRow(R, face) {
    if (state.mode !== 'row') pushMode();
    setMode('row', { row: R, face: face || 'front' });
  }
  function openAisle(idx) {
    const cold = aisles.findIndex(a => a.type === 'cold');
    const a = { idx: idx != null ? idx : Math.max(0, cold), look: 'a', x: X0 + 0.3 };
    if (aisles[a.idx].a == null) a.look = 'b';
    if (state.mode !== 'aisle') pushMode();
    setMode('aisle', { aisle: a });
  }

  function showRackVisuals(r) {
    const o = rackObjs[r.id];
    if (!o.overlay) { o.overlay = buildOverlay(r); o.group.add(o.overlay); }
    if (!o.gaps) { o.gaps = buildGaps(r); o.group.add(o.gaps); }
    o.items.forEach(m => { repaint(m, 'front', null, 2); repaint(m, 'rear', null, 2); });
  }

  // ------------------------------------------------------------------ mode bars
  function bar(html) { const b = $('#modebar'); b.innerHTML = html; b.hidden = false; return b; }
  const rackOrder = () => rows.reduce((a, R) => a.concat(R.racks), []);
  function rackBar() {
    const r = state.rack;
    const b = bar('<button class="btn" data-k="prev" title="Previous rack (←)">‹</button>' +
      '<span class="title">' + esc(r.id) + ' · ' + esc(r.name) + '</span>' +
      '<button class="btn" data-k="next" title="Next rack (→)">›</button>' +
      '<div class="seg">' + ['front', 'rear', 'side'].map(f => '<button data-face="' + f + '" class="' + (state.face === f ? 'on' : '') + '">' + f[0].toUpperCase() + f.slice(1) + '</button>').join('') + '</div>' +
      '<button class="btn" data-k="row">Row ' + esc(r._row.key) + ' elevation</button>' +
      '<button class="btn" data-k="back">Back <kbd>Esc</kbd></button>');
    b.onclick = e => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.face) { state.face = t.dataset.face; $$('[data-face]', b).forEach(x => x.classList.toggle('on', x === t)); const c = rackCam(r, state.face); flyTo(c.pos, c.target, c.fov); }
      else if (t.dataset.k === 'prev' || t.dataset.k === 'next') stepRack(t.dataset.k === 'next' ? 1 : -1);
      else if (t.dataset.k === 'row') openRow(r._row, 'front');
      else if (t.dataset.k === 'back') back();
    };
  }
  function stepRack(d) {
    const list = rackOrder(), i = list.indexOf(state.rack);
    const r = list[(i + d + list.length) % list.length];
    setMode('rack', { rack: r, face: state.face });
  }
  function rowBar() {
    const R = state.row;
    const cells = (R.sgn === 1 ? R.racks : R.racks.slice().reverse());
    const ordered = state.face === 'front' ? R.racks : R.racks.slice().reverse();
    void cells;
    const foot = ordered.map(r => {
      const s = rackStats(r);
      return '<div data-r="' + esc(r.id) + '"><b>' + esc(r.id) + '</b>' + s.uUsed + 'U used · ' + s.uFree + 'U free<div class="mini-bar"><span style="width:' + (s.uUsed / RACK_U * 100).toFixed(0) + '%"></span></div></div>';
    }).join('');
    const tot = ordered.reduce((a, r) => { const s = rackStats(r); a.u += s.uUsed; a.f += s.uFree; return a; }, { u: 0, f: 0 });
    const b = bar('<span class="title">' + esc(R.name) + ' elevation</span>' +
      '<div class="seg">' + ['front', 'rear'].map(f => '<button data-face="' + f + '" class="' + (state.face === f ? 'on' : '') + '">' + (f === 'front' ? 'Front' : 'Rear') + '</button>').join('') + '</div>' +
      (rows.length > 1 ? '<button class="btn" data-k="prev">‹ Row</button><button class="btn" data-k="next">Row ›</button>' : '') +
      '<span class="muted">' + tot.u + 'U used · ' + tot.f + 'U free · click a rack to open it</span>' +
      '<button class="btn" data-k="back">Back <kbd>Esc</kbd></button>' +
      '<div class="footer-racks">' + foot + '</div>');
    b.onclick = e => {
      const rk = e.target.closest('[data-r]');
      if (rk) return openRack(rackById[rk.dataset.r]);
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.face) setMode('row', { row: R, face: t.dataset.face });
      else if (t.dataset.k === 'prev' || t.dataset.k === 'next') setMode('row', { row: rows[(R.i + (t.dataset.k === 'next' ? 1 : -1) + rows.length) % rows.length], face: state.face });
      else if (t.dataset.k === 'back') back();
    };
  }
  function aisleBar() {
    const a = aisles[state.aisle.idx];
    const sideName = k => { const ri = k === 'a' ? (a.b === a.a + 1 || a.type === 'hot' ? Math.min(a.a == null ? Infinity : a.a, a.b == null ? Infinity : a.b) : a.a) : null; void ri; return ''; };
    void sideName;
    const rowA = rows.find(R => (R.front - R.sgn * R.maxD / 2) < a.z && Math.abs(R.front - a.z) < 3 && rowSideOf(R, a) === 'a');
    const rowB = rows.find(R => rowSideOf(R, a) === 'b');
    const looks = [];
    if (rowA) looks.push(['a', 'Look at ' + rowA.name]);
    if (rowB) looks.push(['b', 'Look at ' + rowB.name]);
    looks.push(['along', 'Look along']);
    const b = bar('<div class="seg">' + aisles.map((x, i) => '<button data-a="' + i + '" class="' + (i === state.aisle.idx ? 'on' : '') + '">' + esc(x.name) + '</button>').join('') + '</div>' +
      '<div class="seg">' + looks.map(l => '<button data-look="' + l[0] + '" class="' + (state.aisle.look === l[0] ? 'on' : '') + '">' + esc(l[1]) + '</button>').join('') + '</div>' +
      '<input type="range" id="aisleX" min="' + (X0 - 1).toFixed(2) + '" max="' + (X1 + 1).toFixed(2) + '" step="0.05" value="' + state.aisle.x + '" aria-label="Position along the aisle">' +
      '<span class="muted"><kbd>←</kbd><kbd>→</kbd> walk · click a rack to open it</span>' +
      '<button class="btn" data-k="back">Back <kbd>Esc</kbd></button>');
    b.onclick = e => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.a != null) { const i = +t.dataset.a; const look = aisles[i].a == null ? 'b' : aisles[i].b == null && state.aisle.look === 'b' ? 'a' : state.aisle.look; setMode('aisle', { aisle: { idx: i, look, x: state.aisle.x } }); }
      else if (t.dataset.look) { state.aisle.look = t.dataset.look; $$('[data-look]', b).forEach(x => x.classList.toggle('on', x === t)); moveAisle(0, 400); }
      else if (t.dataset.k === 'back') back();
    };
    $('#aisleX').oninput = e => { state.aisle.x = parseFloat(e.target.value); moveAisle(0, 0); };
  }
  function rowSideOf(R, a) {
    // rows whose front or rear faces this aisle; 'a' is the -z side, 'b' the +z side
    const near = [R.front, R.front - R.sgn * R.maxD];
    if (!near.some(z => Math.abs(z - a.z) <= a.width / 2 + 0.01)) return null;
    const center = R.front - R.sgn * R.maxD / 2;
    return center < a.z ? 'a' : 'b';
  }
  function moveAisle(dx, ms) {
    const a = aisles[state.aisle.idx];
    state.aisle.x = Math.max(X0 - 1, Math.min(X1 + 1, state.aisle.x + dx));
    const s = $('#aisleX'); if (s) s.value = state.aisle.x;
    const c = aisleCam(a, state.aisle.look, state.aisle.x);
    if (!ms) { camera.position.copy(c.pos); controls.target.copy(c.target); camera.lookAt(c.target); invalidate(); }
    else flyTo(c.pos, c.target, c.fov, ms);
  }

  // ------------------------------------------------------------------ walk-through
  function buildWalk() {
    const a = aisles.find(x => x.type === 'cold') || aisles[0], z = a.z;
    const left = rows.filter(R => rowSideOf(R, a) === 'a').reduce((s, R) => s.concat(R.racks), []).sort((p, q) => p._x - q._x);
    const right = rows.filter(R => rowSideOf(R, a) === 'b').reduce((s, R) => s.concat(R.racks), []).sort((p, q) => p._x - q._x);
    const F = Math.PI / 2, P = [];
    const pose = (x, yaw, extra) => P.push(Object.assign({ pos: v(x, 1.65, z), yaw, pitch: 0, dwell: 0 }, extra || {}));
    pose(RX0 - 1.8, F, { dwell: 0.8 });
    pose(RX0 - 0.5, F, { door: 1 });
    pose(X0 - 0.45, F, { dwell: 0.3 });
    const n = Math.max(left.length, right.length);
    for (let i = 0; i < n; i++) {
      const l = left[i], r = right[i], x = ((l || r)._x + (r || l)._x) / 2;
      pose(x, F);
      if (l) pose(x, Math.PI, { rack: l, pitch: -0.1, dwell: 4 });
      if (r) pose(x, 0, { rack: r, pitch: -0.1, dwell: 4 });
    }
    pose(X1 + 0.7, F, { dwell: 1.5 });
    return P;
  }
  function applyPose(p) {
    camera.position.copy(p.pos);
    const dir = v(Math.sin(p.yaw) * Math.cos(p.pitch), Math.sin(p.pitch), Math.cos(p.yaw) * Math.cos(p.pitch));
    controls.target.copy(p.pos).add(dir);
    camera.lookAt(controls.target);
    invalidate();
  }
  function lerpPose(a, b, k) { return { pos: a.pos.clone().lerp(b.pos, k), yaw: a.yaw + (b.yaw - a.yaw) * k, pitch: a.pitch + (b.pitch - a.pitch) * k }; }
  function startWalk(idx, paused) {
    walk.poses = buildWalk();
    walk.active = true; walk.idx = Math.min(idx, walk.poses.length - 1); walk.t = 0; walk.phase = 'dwell'; walk.paused = paused;
    camera.fov = 62; camera.updateProjectionMatrix();
    if (doorPivot) doorPivot.rotation.y = walk.idx >= 1 ? 1.45 : 0;
    applyPose(walk.poses[walk.idx]);
    arrive(walk.poses[walk.idx]);
    walkBar();
  }
  function walkBar() {
    const b = bar('<span class="title">Walk-through</span>' +
      '<button class="btn" data-k="prev" title="Previous rack">‹</button>' +
      '<button class="btn" data-k="pause">' + (walk.paused ? '▶ Play' : '❚❚ Pause') + '</button>' +
      '<button class="btn" data-k="next" title="Next rack">›</button>' +
      '<div class="seg">' + [1, 2].map(s => '<button data-speed="' + s + '" class="' + (walk.speed === s ? 'on' : '') + '">' + s + '×</button>').join('') + '</div>' +
      '<button class="btn" data-k="detail"' + (walk.rack ? '' : ' disabled') + '>View this rack in detail</button>' +
      '<button class="btn" data-k="back">Exit <kbd>Esc</kbd></button>');
    b.onclick = e => {
      const t = e.target.closest('button');
      if (!t || t.disabled) return;
      if (t.dataset.speed) { walk.speed = +t.dataset.speed; walkBar(); }
      else if (t.dataset.k === 'pause') { walk.paused = !walk.paused; walkBar(); }
      else if (t.dataset.k === 'prev' || t.dataset.k === 'next') walkJump(t.dataset.k === 'next' ? 1 : -1);
      else if (t.dataset.k === 'detail' && walk.rack) { walk.paused = true; const r = walk.rack; pushMode(); setMode('rack', { rack: r }); }
      else if (t.dataset.k === 'back') back();
    };
  }
  function walkJump(d) {
    const P = walk.poses;
    let j = walk.idx + d;
    while (j >= 0 && j < P.length && !P[j].rack) j += d;
    if (j < 0 || j >= P.length) return;
    walk.idx = j; walk.phase = 'dwell'; walk.t = 0;
    if (doorPivot) doorPivot.rotation.y = 1.45;
    applyPose(P[j]);
    arrive(P[j]);
  }
  function arrive(p) {
    const prev = walk.rack;
    walk.rack = p.rack || null;
    if (walk.rack) {
      const o = rackObjs[walk.rack.id];
      if (!o.gaps) { o.gaps = buildGaps(walk.rack); o.group.add(o.gaps); }
      showPlacard(walk.rack, 'Walk-through');
    } else $('#placard').hidden = true;
    if (prev !== walk.rack) { applyVisibility(); walkBar(); }
  }
  function tickWalk(dt) {
    if (!walk.active || walk.paused || state.mode !== 'walk') return false;
    walk.t += dt * walk.speed;
    const P = walk.poses, cur = P[walk.idx], nxt = P[walk.idx + 1];
    if (walk.phase === 'dwell') {
      if (walk.t < (cur.dwell || 0)) return false;
      if (!nxt) { walk.paused = true; walkBar(); return false; }
      walk.phase = 'move'; walk.t = 0;
      if (walk.rack) { walk.rack = null; $('#placard').hidden = true; applyVisibility(); walkBar(); }
    }
    const dur = Math.max(0.45, cur.pos.distanceTo(nxt.pos) / 1.25, Math.abs(nxt.yaw - cur.yaw) / 1.7);
    const k = Math.min(1, walk.t / dur), e = ease(k);
    applyPose(lerpPose(cur, nxt, e));
    if (nxt.door && doorPivot) doorPivot.rotation.y = 1.45 * e;
    if (k >= 1) { walk.idx++; walk.phase = 'dwell'; walk.t = 0; arrive(P[walk.idx]); }
    return true;
  }

  // ------------------------------------------------------------------ rack tour
  function startTour() {
    tour.list = rackOrder(); tour.t = 0; tour.paused = false;
    if (state.mode !== 'tour') pushMode();
    setMode('tour', { tourI: 0 });
  }
  function tourBar() {
    const b = bar('<span class="title">Rack tour</span>' +
      '<button class="btn" data-k="prev">‹</button>' +
      '<button class="btn" data-k="pause">' + (tour.paused ? '▶ Play' : '❚❚ Pause') + '</button>' +
      '<button class="btn" data-k="next">›</button>' +
      '<button class="btn" data-k="open">Open this rack</button>' +
      '<button class="btn" data-k="back">Exit <kbd>Esc</kbd></button>');
    b.onclick = e => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.k === 'pause') { tour.paused = !tour.paused; tourBar(); }
      else if (t.dataset.k === 'prev' || t.dataset.k === 'next') tourGo(tour.i + (t.dataset.k === 'next' ? 1 : -1));
      else if (t.dataset.k === 'open') { tour.paused = true; const r = state.rack; pushMode(); setMode('rack', { rack: r }); }
      else if (t.dataset.k === 'back') back();
    };
  }
  function tourGo(i) { tour.t = 0; setMode('tour', { tourI: (i + tour.list.length) % tour.list.length }); }
  function tickTour(dt) {
    if (state.mode !== 'tour' || tour.paused) return;
    tour.t += dt;
    if (tour.t >= tour.dwell) tourGo(tour.i + 1);
  }

  function showPlacard(r, kicker) {
    const s = rackStats(r), news = r.items.filter(isItemNew);
    const devs = r.items.filter(it => it.kind === 'device');
    const p = $('#placard');
    p.innerHTML = '<span class="badge mute">' + esc(kicker) + '</span> ' + (r.star.length ? '<span class="badge">Star center ' + r.star.map(x => x === 'copper' ? 'Cu' : x.toUpperCase()).join(' + ') + '</span>' : '') +
      '<h3>' + esc(r.id) + ' · ' + esc(r.name) + '</h3>' +
      '<div class="kv"><div><b>' + s.uUsed + '</b><small>U used</small></div><div><b style="color:var(--free)">' + s.uFree + '</b><small>U free</small></div>' +
      '<div><b>' + s.devices + '</b><small>Devices</small></div><div><b>' + s.cables + '</b><small>Cables</small></div>' +
      '<div><b style="color:var(--' + ({ ok: 'text', high: 'new', over: 'pending' })[power(r).status] + ')">' + kw(power(r).w) + '</b><small>Power</small></div></div>' +
      (devs.length ? '<div style="color:var(--muted);font-size:12px">' + devs.slice(0, 8).map(d => esc(d.label)).join(' · ') + (devs.length > 8 ? ' …' : '') + '</div>' : '') +
      (news.length ? '<ul>' + news.map(it => '<li style="color:var(--new)">To order: ' + esc(itemName(it)) + ' (' + fmtRange(it) + ')</li>').join('') + '</ul>' : '');
    p.hidden = false;
  }

  // ------------------------------------------------------------------ elevation panel
  function renderElev(r) {
    const s = rackStats(r), el = $('#elev');
    el.innerHTML = '<h3>' + esc(r.id) + ' · ' + esc(r.name) + '</h3>' +
      '<div class="sub">' + r.width + ' × ' + r.depth + ' mm · ' + s.uUsed + 'U used · ' + s.uFree + 'U free</div>' +
      '<ul class="elev-list">' + r.items.map(it => '<li data-i="' + it._i + '" class="' + (it.kind === 'gap' ? 'gap' : '') + (isItemNew(it) ? ' new' : '') + '">' +
        '<span class="u">' + fmtRange(it) + '</span><span class="sw" style="background:' + swatch(it) + '"></span><span>' + esc(itemName(it)) + '</span></li>').join('') + '</ul>';
    el.hidden = false;
    el.onclick = e => {
      const li = e.target.closest('li[data-i]');
      if (!li) return;
      const it = r.items[+li.dataset.i];
      if (it && it.kind !== 'gap') { selectItem(it); const c = rackCam(r, 'front', it); flyTo(c.pos, c.target, c.fov, 600); }
    };
  }

  // ------------------------------------------------------------------ selection, hover, trace
  const selBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: C.hover, depthTest: false, transparent: true }));
  selBox.renderOrder = 10;
  function clearSel() {
    if (selBox.parent) selBox.parent.remove(selBox);
    state.sel = null;
    $$('#elev li.sel').forEach(li => li.classList.remove('sel'));
  }
  function selectItem(it) {
    clearSel();
    state.sel = it;
    const m = it._mesh;
    if (m) {
      const g = geomOf(it);
      selBox.scale.set(RAIL + 0.012, g.h + 0.006, g.depth + 0.012);
      m.add(selBox);
      selBox.scale.divide(m.scale);
    }
    const li = $('#elev li[data-i="' + it._i + '"]');
    if (li) { li.classList.add('sel'); li.scrollIntoView({ block: 'nearest' }); }
    showItemCard(it);
    invalidate();
  }
  // a rack lights blue when focused or hovered, else green or amber while a fit search is shown
  const FIT_GLOW = { fits: 0x0d8a4a, add: 0x8a5a00 };
  function glow(r, focus) {
    const o = rackObjs[r.id], f = fit.byRack && fit.byRack[r.id];
    const c = focus || state.hoverRack === r ? 0x1e1ec8 : f && FIT_GLOW[f.status] && !inRackMode() ? FIT_GLOW[f.status] : 0x000000;
    o.bodyMat.emissive.set(c);
    o.bodyMat.emissiveIntensity = focus ? 0.9 : 0.6;
  }
  function setHover(r) {
    if (state.hoverRack === r) return;
    state.hoverRack = r;
    racks.forEach(x => glow(x, state.mode === 'walk' && walk.rack === x));
    invalidate();
  }

  // ------------------------------------------------------------------ trace: a walk along a cable, stop by stop
  // The trace has a view of its own. Every rack stays in place; racks and items the cable
  // does not touch fade to glass, and the camera goes from one end of the cable to the other
  // one stop at a time (device, panel port, panel port, … device), or stands back to show
  // the whole path in the room.
  const trace = { c: null, steps: [], step: 0, whole: false, playing: false, t: 0, group: null, racks: new Set(), items: new Set() };
  const TRACE_DWELL = 2.8;
  const traceMats = {
    done: new THREE.MeshBasicMaterial({ color: C.hover }),
    now: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    next: new THREE.MeshBasicMaterial({ color: 0x8a8fc0, transparent: true, opacity: 0.3, depthWrite: false }),
    // the walked part also shows through racks, faintly, so it never disappears behind them
    xray: new THREE.MeshBasicMaterial({ color: C.hover, transparent: true, opacity: 0.3, depthTest: false, depthWrite: false }),
  };
  const ghostMat = new THREE.MeshBasicMaterial({ color: 0x9aa0d0, transparent: true, opacity: 0.06, depthWrite: false });
  const GHOST = [ghostMat, ghostMat, ghostMat, ghostMat, ghostMat, ghostMat];
  function ghostItem(mesh, on) {
    if (on && !mesh.userData.real) { mesh.userData.real = mesh.material; mesh.material = GHOST; }
    else if (!on && mesh.userData.real) { mesh.material = mesh.userData.real; mesh.userData.real = null; }
  }
  function linkText(c, pc) {
    let what;
    if (pc.type === 'patch') what = pc.cross ? 'cross-connect (patch cord)' : 'patch cord';
    else if (pc.trunk) what = pc.trunk.interRow ? 'inter-row trunk' : (extById[pc.trunk.b] ? 'exit trunk' : 'trunk (' + (pc.trunk.medium === 'copper' ? 'copper' : 'MPO') + ')');
    else what = c.kind === 'active' ? 'active cable through the tray' : 'cable run through the tray';
    return what + ' · ≈ ' + polyLen(pc.pts).toFixed(1) + ' m';
  }
  // One stop per end and per panel port: where it is in the room and the link that leaves it.
  function traceSteps(c) {
    const refs = [c.a].concat(c.hops, [c.b]), P = c._pieces || [];
    if (!P.length || P.length !== refs.length - 1) return [];
    return refs.map((ref, i) => {
      const last = i === P.length, pc = last ? P[i - 1] : P[i];
      return { ref, E: last ? pc.Q : pc.P, at: last ? pc.pts[pc.pts.length - 1] : pc.pts[0], text: endpointText(ref), link: last ? null : linkText(c, pc) };
    });
  }
  // Stand in front of (or behind) the rack the stop is in, a little to the side, looking at the port.
  function stepCam(st) {
    const p = st.at, E = st.E;
    if (E && E.rack) {
      const r = E.rack, lx = (p.x - r._x) * r._sgn, lz = (p.z - r._front) * r._sgn, front = lz > -r.d / 2;
      return { pos: toW(r, v(lx * 0.4 + (front ? 0.45 : -0.45), Math.min(RH + 0.3, p.y + 0.4), front ? 1.4 : -r.d - 1.4)), target: p.clone(), fov: 50 };
    }
    const to = v((X0 + X1) / 2 - p.x, 0, (RZ0 + RZ1) / 2 - p.z).normalize();
    return { pos: p.clone().addScaledVector(to, 1.8).add(v(0, 0.3, 0)), target: p.clone(), fov: 50 };
  }
  function wholeCam() {
    const box = new THREE.Box3();
    trace.c._pieces.forEach(pc => pc.pts.forEach(q => box.expandByPoint(q)));
    const ctr = box.getCenter(v(0, 0, 0)), size = box.getSize(v(0, 0, 0)), R = Math.max(size.x, size.z, 2.5);
    const k = Math.max(1, 1.4 / Math.max(0.5, camera.aspect));
    return { pos: v(ctr.x - R * 0.3 * k, ctr.y + (R * 0.75 + 1.6) * k, ctr.z + (R * 0.85 + 1.4) * k), target: ctr.setY(1), fov: 45 };
  }
  // labels are DOM elements the label renderer does not remove on its own
  function clearTraceGroup() {
    if (!trace.group) return;
    trace.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.isCSS2DObject && o.element) o.element.remove(); });
    scene.remove(trace.group);
    trace.group = null;
  }
  function drawTrace() {
    clearTraceGroup();
    const g = trace.group = new THREE.Group(), c = trace.c;
    c._pieces.forEach((pc, i) => {
      const kind = trace.whole || i < trace.step ? 'done' : i === trace.step ? 'now' : 'next';
      const base = pc.trunk ? (TRUNK_R[trunkLayer(pc.trunk)] || 0.008) : 0.0045;
      const pts = rounded(pc.pts, pc.type === 'patch' ? 0.025 : 0.06);
      g.add(new THREE.Mesh(tubeGeo(pts, base + (kind === 'now' ? 0.008 : 0.004), 8), traceMats[kind]));
      if (kind !== 'next') { const x = new THREE.Mesh(tubeGeo(pts, base + 0.003, 6), traceMats.xray); x.renderOrder = 15; g.add(x); }
    });
    trace.steps.forEach((st, i) => {
      const cur = !trace.whole && i === trace.step, seen = trace.whole || i <= trace.step;
      const m = new THREE.Mesh(new THREE.SphereGeometry(cur ? 0.028 : 0.016, 14, 10), cur ? traceMats.now : seen ? traceMats.done : traceMats.next);
      m.position.copy(st.at);
      g.add(m);
      if (trace.whole || cur) {
        const lab = css2d('<b>' + (i + 1) + '</b>' + (cur ? ' ' + esc(st.text.t) : ''), 'trace-label' + (cur ? ' now' : ''));
        lab.position.copy(st.at).add(v(0, 0.06, 0));
        g.add(lab);
      }
    });
    scene.add(g);
    invalidate();
  }
  function openTrace(c, opt) {
    if (!(c._pieces || []).length) return showCableCard(c, true);
    if (studio.open) closeStudio();
    if (state.mode !== 'trace') pushMode();
    setMode('trace', Object.assign({ cable: c, step: 0 }, opt || {}));
  }
  const traceCable = c => openTrace(c);
  function traceGo(i, whole) {
    trace.step = Math.max(0, Math.min(trace.steps.length - 1, i));
    trace.whole = !!whole;
    trace.t = 0;
    drawTrace();
    traceBar();
    showCableCard(trace.c);
    const cam = trace.whole ? wholeCam() : stepCam(trace.steps[trace.step]);
    flyTo(cam.pos, cam.target, cam.fov, 900);
  }
  function tickTrace(dt) {
    if (state.mode !== 'trace' || !trace.playing) return;
    trace.t += dt;
    if (trace.t < TRACE_DWELL) return;
    if (trace.step >= trace.steps.length - 1) { trace.playing = false; traceGo(trace.step, true); return; }
    traceGo(trace.step + 1);
  }
  function traceBar() {
    const n = trace.steps.length, st = trace.steps[trace.step];
    const b = bar('<button class="btn" data-k="prev" title="Previous stop (←)">‹</button>' +
      '<button class="btn" data-k="play">' + (trace.playing ? '❚❚ Pause' : '▶ Walk it') + '</button>' +
      '<button class="btn" data-k="next" title="Next stop (→)">›</button>' +
      '<span class="title">' + (trace.whole ? esc('Cable ' + trace.c.id + ' · whole path, ' + n + ' stops') : 'Stop ' + (trace.step + 1) + ' / ' + n + ' · ' + esc(st.text.t)) + '</span>' +
      '<button class="btn' + (trace.whole ? ' on' : '') + '" data-k="whole">Whole path in the room</button>' +
      '<button class="btn" data-k="back">Exit <kbd>Esc</kbd></button>');
    b.onclick = e => {
      const t = e.target.closest('button');
      if (!t) return;
      if (t.dataset.k === 'prev') { trace.playing = false; traceGo(trace.whole ? 0 : trace.step - 1); }
      else if (t.dataset.k === 'next') { trace.playing = false; traceGo(trace.whole ? 0 : trace.step + 1); }
      else if (t.dataset.k === 'play') { trace.playing = !trace.playing; if (trace.playing && (trace.whole || trace.step >= n - 1)) traceGo(0); else traceBar(); }
      else if (t.dataset.k === 'whole') { trace.playing = false; traceGo(trace.step, !trace.whole); }
      else if (t.dataset.k === 'back') back();
    };
  }

  // ------------------------------------------------------------------ cards
  let cardActions = [];
  function showCard(o) {
    cardActions = o.actions || [];
    const el = $('#card');
    el.innerHTML = '<button class="close" data-close-card aria-label="Close">×</button>' +
      '<button class="close fold" data-fold-card aria-label="Fold the card">▾</button>' +
      '<span class="badge ' + (o.badgeCls || '') + '">' + esc(o.badge) + '</span>' + (o.extraBadges || '') +
      '<h3>' + esc(o.title) + '</h3>' +
      (o.rows ? '<table>' + o.rows.filter(Boolean).map(r => '<tr><td>' + esc(r[0]) + '</td><td>' + r[1] + '</td></tr>').join('') + '</table>' : '') +
      (o.html || '') +
      (o.cables && o.cables.length ? '<h4>Cables (' + o.cables.length + ')</h4><ul class="cables">' + o.cables.slice(0, 40).map(c =>
        '<li data-c="' + esc(c.id) + '"><span class="dot" style="background:' + cableColor(c) + '"></span><span>' + esc(cableSummary(c)) + '</span><small>' + esc(c.status) + '</small></li>').join('') +
        (o.cables.length > 40 ? '<li><small>… and ' + (o.cables.length - 40) + ' more</small></li>' : '') + '</ul>' : '') +
      (o.note ? '<p class="src">' + esc(o.note) + '</p>' : '') +
      (cardActions.length ? '<div class="actions">' + cardActions.map((a, i) => '<button class="btn' + (i === 0 ? ' primary' : '') + '" data-ca="' + i + '">' + esc(a[0]) + '</button>').join('') + '</div>' : '');
    el.hidden = false;
  }
  function hideCard() { $('#card').hidden = true; }
  $('#card').addEventListener('click', e => {
    if (e.target.closest('[data-close-card]')) { if (state.mode === 'trace') back(); else hideCard(); return; }
    if (e.target.closest('[data-fold-card]') || (e.target.closest('h3') && $('#card').classList.contains('folded'))) { $('#card').classList.toggle('folded'); return; }
    const st = e.target.closest('[data-step]');
    if (st && state.mode === 'trace') { trace.playing = false; traceGo(+st.dataset.step); return; }
    const ca = e.target.closest('[data-ca]');
    if (ca) { const a = cardActions[+ca.dataset.ca]; if (a) a[1](); return; }
    const fr = e.target.closest('[data-fit]');
    if (fr) { openRack(rackById[fr.dataset.fit]); return; }
    const li = e.target.closest('[data-c]');
    if (li) { const c = cables.find(x => x.id === li.dataset.c); if (c) traceCable(c); }
  });
  const SOURCE = (DATA.meta && DATA.meta.private) ? 'Source: private data file (not published).'
    : (DATA.meta && DATA.meta.imported) ? 'Source: a file imported in this browser (not published).'
    : 'Source: data/sample-data.js — fictitious sample data.';

  function showRackCard(r) {
    const s = rackStats(r), news = r.items.filter(isItemNew).length, pw = power(r);
    const acts = [];
    if (state.mode !== 'rack') acts.push(['Open rack', () => openRack(r)]);
    if (fit.results) acts.push(['Back to the fit results', showFitCard]);
    acts.push(['Row ' + r._row.key + ' elevation', () => openRow(r._row, 'front')]);
    showCard({
      badge: r.star.length ? 'Star center' : 'Rack', title: r.id + ' · ' + r.name,
      rows: [
        ['Row', esc(r._row.name)],
        ['Size', r.width + ' × ' + r.depth + ' mm · 42U'],
        r.star.length ? ['Star center for', esc(r.star.map(x => MEDIUM_NAME[x] || x).join(', '))] : null,
        ['U used / free', s.uUsed + ' / <span style="color:var(--free)">' + s.uFree + '</span>'],
        ['Devices', s.devices],
        ['Patching', s.panels + ' UTP panels · ' + s.trays + ' fiber trays'],
        ['Ports Cu / MM / SM', s.copper.used + '/' + s.copper.inst + ' · ' + s.mm.used + '/' + s.mm.inst + ' · ' + s.sm.used + '/' + s.sm.inst],
        news ? ['New items', '<span style="color:var(--new)">' + news + ' to order</span>'] : null,
        ['Power', powerSpan(pw)],
        ['Feeds A / B', kw(pw.feedA) + ' / ' + kw(pw.feedB) + (pw.status === 'over' ? ' · <span style="color:var(--pending)">one feed alone cannot carry it</span>' : '')],
        ['Exhaust (est.)', Math.round(pw.exhaustC) + ' °C · inlet ' + pw.inletC + ' °C'],
        fit.byRack ? ['Fit: ' + esc(fitName(fit.shown)), fitText(fit.byRack[r.id])] : null,
      ],
      cables: cablesOfRack(r), note: SOURCE, actions: acts,
    });
  }
  function showItemCard(it) {
    const r = it._rack, g = geomOf(it), cs = cablesOfItem(it);
    let ports = '';
    if (it.kind === 'utp') ports = cs.length + ' / ' + UTP_PORTS + ' used';
    else if (it.kind === 'lc') ports = cs.length + ' / ' + it.cassettes.filter(Boolean).length * CASS_PORTS + ' used · ' + it.cassettes.map((c, i) => 'C' + (i + 1) + ' ' + (c ? c.medium.toUpperCase() + (c.isNew ? ' (new)' : '') : 'empty')).join(', ');
    else if (it.kind === 'device') { const P = devPorts(it); ports = P.cu.length + ' copper · ' + P.fo.length + ' fiber (' + (it.uplinkMedium || 'mm').toUpperCase() + ')' + (P.mgmt ? ' · mgmt' : '') + ' — ' + cs.length + ' cabled'; }
    const peer = it.kind === 'utp' && trunkPeer[it._key];
    const peers = it.kind === 'lc' ? it.cassettes.map((c, i) => trunkPeer[it._key + '.C' + (i + 1)]).filter(Boolean) : [];
    const acts = studio.open ? [] : [['Inspect in 3D studio', () => openStudio(it)]];
    if (!inRackMode()) acts.push(['Show in rack', () => openRack(r, { focus: it })]);
    showCard({
      badge: TYPE_NAME[it.kind === 'device' ? it.type : it.kind] || it.kind, badgeCls: isItemNew(it) ? 'new' : '',
      extraBadges: isItemNew(it) ? ' <span class="badge new">To order</span>' : '',
      title: it.kind === 'device' ? it.label : r.id + ' ' + (it.id || '') + ' · ' + (TYPE_NAME[it.kind] || it.kind),
      rows: [
        ['Rack', esc(r.id + ' · ' + r.name)],
        ['Position', fmtRange(it) + ' (' + it._u + 'U)'],
        ['Size', '482.6 mm (19") × ' + (it._u * 44.45).toFixed(2) + ' mm × ' + Math.round(g.depth * 1000) + ' mm deep'],
        it.kind === 'utp' ? ['Role', esc(ROLE_NAME[it.role] || it.role)] : null,
        ports ? ['Ports', esc(ports)] : null,
        it.kind === 'device' ? ['Power', PLAN.watts(it) + ' W' + (typeof it.watts === 'number' ? '' : ' (typical for a ' + esc((TYPE_NAME[it.type] || it.type).toLowerCase()) + ')')] : null,
        peer ? ['Trunk to', esc(shortRef(peer.peer))] : null,
        peers.length ? ['Trunks to', esc(peers.map(p => shortRef(p.peer)).join(', '))] : null,
        ['Status', isItemNew(it) ? '<span style="color:var(--new)">New — to order</span>' : 'Installed'],
      ],
      cables: cs, note: SOURCE, actions: acts,
    });
  }
  function showPortCard(it, p) {
    const c = cableAt(it, p.name);
    if (c) return traceCable(c);
    if (p.shape === 'mpo') {
      const k = it._key + '.C' + (p.cass + 1), peer = trunkPeer[k];
      return showCard({ badge: 'MPO trunk', title: shortRef(k), rows: [['Medium', esc((it.cassettes[p.cass] || {}).medium || '').toUpperCase()], ['Trunk to', peer ? esc(shortRef(peer.peer)) : 'none'], ['Length', peer && peer.t._len ? '≈ ' + peer.t._len.toFixed(1) + ' m' : '—']], note: SOURCE });
    }
    showCard({ badge: 'Port', badgeCls: 'free', title: (it.kind === 'device' ? it.label : it._rack.id + ' ' + it.id) + ' · ' + p.name, rows: [['Status', '<span style="color:var(--free)">Free</span>'], ['Rack', esc(it._rack.id)]], note: SOURCE, actions: [['Item details', () => showItemCard(it)]] });
  }
  function showCableCard(c, broken) {
    const live = state.mode === 'trace' && trace.c === c;
    const steps = (live ? trace.steps : traceSteps(c)).map((st, i) =>
      '<li data-step="' + i + '" class="' + (live && (trace.whole || i === trace.step) ? 'on' : '') + '"><b>' + esc(st.text.t) + '</b><br><small style="color:var(--muted)">' + esc(st.text.sub) + '</small></li>' +
      (st.link ? '<li class="link">' + esc(st.link) + '</li>' : '')).join('');
    showCard({
      badge: MEDIUM_NAME[c.medium] || c.medium, badgeCls: '',
      extraBadges: ' <span class="badge ' + (c.status === 'pending' ? 'pending' : c.status === 'proposed' ? 'new' : 'mute') + '">' + esc(c.status) + '</span>',
      title: 'Cable ' + c.id,
      rows: [['Kind', esc(KIND_NAME[c.kind] || c.kind)], ['From', esc(c.a.item + ' · ' + c.a.port)], ['To', esc(c.b.item + ' · ' + c.b.port)], ['Length', '≈ ' + (c._len || 0).toFixed(1) + ' m'], ['Panel hops', c.hops.length]],
      html: broken ? '<p class="note-line bad">This cable has an end or a hop that is not in the model, so it cannot be drawn.</p>'
        : '<h4>Path · ' + (live ? 'click a stop to go there' : '') + '</h4><ol class="steps">' + steps + '</ol>',
      note: c.note || SOURCE,
      actions: live ? [] : [['Trace it', () => openTrace(c)]],
    });
  }
  function showExtCard(e) {
    showCard({ badge: e.type, title: e.label || e.id, rows: [['Id', esc(e.id)], ['Location', 'Not in any rack (' + esc(e.place || 'room') + ')']], cables: cablesBy['ext:' + e.id] || [], note: SOURCE });
  }
  function showPduCard(info) {
    const r = info.rack, c = portCable['pdu:' + r.id + ':NET'];
    showCard({ badge: 'PDU', title: 'PDU ' + r.id + (info.master ? ' · master' : ' · slave'), rows: [['Rack', esc(r.id)], ['Position', 'Rear, vertical (0U)'], ['Network', info.master ? (c ? esc(c.b.item + ' ' + c.b.port) + ' (' + esc(c.status) + ')' : 'not connected') : 'chained to the master PDU']], cables: info.master && c ? [c] : [], note: SOURCE });
  }

  // ------------------------------------------------------------------ pointer
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pickAt(e, objs, cam) {
    const b = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
    ray.setFromCamera(ndc, cam || camera);
    return ray.intersectObjects(objs, false).find(h => effVisible(h.object)) || null;
  }
  function portFromHit(h) {
    const it = h && h.object.userData.item;
    if (!it || !h.uv || !h.face) return null;
    const mi = h.face.materialIndex, face = mi === 4 ? 'front' : mi === 5 ? 'rear' : null;
    if (!face) return { it, face: null, port: null };
    const nx = h.uv.x, ny = 1 - h.uv.y, px = 0.004, py = 0.04;
    const port = layoutOf(it)[face].find(q => nx >= q.x - px && nx <= q.x + q.w + px && ny >= q.y - py && ny <= q.y + q.h + py) || null;
    return { it, face, port };
  }
  function roomPickables() {
    const list = [];
    racks.forEach(r => { const o = rackObjs[r.id]; list.push(o.body, o.doorF, o.doorR); });
    return list.concat(extMeshes);
  }
  function rackPickables() {
    const o = rackObjs[state.rack.id];
    return o.items.concat(o.pdus);
  }

  let down = null, hoverPort = null, moveQueued = null;
  const tip = $('#tooltip');
  function showTip(e, html) { tip.innerHTML = html; tip.hidden = false; tip.style.left = Math.min(innerWidth - 330, e.clientX + 14) + 'px'; tip.style.top = (e.clientY + 14) + 'px'; }
  function hideTip() { tip.hidden = true; }
  function setPortHover(mesh, face, name) {
    if (hoverPort && (hoverPort.mesh !== mesh || hoverPort.face !== face || hoverPort.name !== name)) { repaint(hoverPort.mesh, hoverPort.face, null); hoverPort = null; }
    if (mesh && name && !hoverPort) { hoverPort = { mesh, face, name }; repaint(mesh, face, name); }
    invalidate();
  }
  function portTip(it, p) {
    const c = cableAt(it, p.name);
    const head = (it.kind === 'device' ? esc(it.label) : esc(it._rack.id + ' ' + it.id)) + ' · ' + esc(p.name);
    if (p.shape === 'mpo') { const peer = trunkPeer[it._key + '.C' + (p.cass + 1)]; return head + '<br><small>MPO trunk ' + (peer ? '→ ' + esc(shortRef(peer.peer)) : '') + '</small>'; }
    return head + '<br><small>' + (c ? '<span style="color:' + cableColor(c) + '">●</span> ' + esc(cableSummary(c)) + ' (' + esc(c.status) + ')' : 'free') + '</small>';
  }

  renderer.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down = null; return; }
    down = null;
    onClick(e);
  });
  renderer.domElement.addEventListener('dblclick', e => {
    if (studio.open) return;
    if (inRackMode() || state.mode === 'row') {
      const h = pickAt(e, inRackMode() ? rackPickables() : racks.filter(r => r._row === state.row).reduce((a, r) => a.concat(rackObjs[r.id].items), []));
      if (h && h.object.userData.item) openStudio(h.object.userData.item);
    }
  });
  renderer.domElement.addEventListener('pointermove', e => {
    if (moveQueued) { moveQueued = e; return; }
    moveQueued = e;
    requestAnimationFrame(() => { const ev = moveQueued; moveQueued = null; onHover(ev); });
  });
  renderer.domElement.addEventListener('pointerleave', () => { hideTip(); setHover(null); });

  function onClick(e) {
    if (studio.open) return studioClick(e);
    hideResults();
    if (inRackMode()) {
      const h = pickAt(e, rackPickables());
      if (!h) return;
      if (h.object.userData.pdu) return showPduCard(h.object.userData.pdu);
      const pf = portFromHit(h);
      if (pf && pf.port) { if (state.sel !== pf.it) selectItem(pf.it); return showPortCard(pf.it, pf.port); }
      if (pf) selectItem(pf.it);
      return;
    }
    if (state.mode === 'walk') return;
    const h = pickAt(e, roomPickables());
    if (!h) return;
    if (h.object.userData.ext) return showExtCard(h.object.userData.ext);
    const r = h.object.userData.rack;
    if (r) openRack(r);
  }
  function onHover(e) {
    if (!e) return;
    if (studio.open) return studioHover(e);
    if (inRackMode()) {
      const pf = portFromHit(pickAt(e, rackPickables()));
      if (pf && pf.port) { setPortHover(pf.it._mesh, pf.face, pf.port.name); showTip(e, portTip(pf.it, pf.port)); renderer.domElement.style.cursor = 'pointer'; }
      else { setPortHover(null); hideTip(); renderer.domElement.style.cursor = pf ? 'pointer' : ''; }
      return;
    }
    if (state.mode === 'walk') return;
    const h = pickAt(e, roomPickables());
    const r = h && h.object.userData.rack;
    setHover(r || null);
    if (r) { showTip(e, '<b>' + esc(r.id) + '</b> · ' + esc(r.name) + '<br><small>Click to open</small>'); renderer.domElement.style.cursor = 'pointer'; }
    else if (h && h.object.userData.ext) { showTip(e, esc(h.object.userData.ext.label) + '<br><small>Not in any rack</small>'); renderer.domElement.style.cursor = 'pointer'; }
    else { hideTip(); renderer.domElement.style.cursor = ''; }
  }

  // ------------------------------------------------------------------ inspection studio
  const studio = { open: false, scene: null, cam: null, controls: null, mesh: null, item: null, labels: null, dims: null, hover: null };
  const studioSideMat = new THREE.MeshStandardMaterial({ color: 0x2a2d44, metalness: 0.65, roughness: 0.38 });
  function buildStudio() {
    const s = new THREE.Scene();
    const cv = mkCanvas(16, 512), x = cv.getContext('2d'), g = x.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, '#2a2c6a'); g.addColorStop(0.55, '#121433'); g.addColorStop(1, '#06070f');
    x.fillStyle = g; x.fillRect(0, 0, 16, 512);
    s.background = canvasTex(cv);
    const pm = new THREE.PMREMGenerator(renderer);
    s.environment = pm.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
    pm.dispose();
    s.add(new THREE.AmbientLight(0xffffff, 0.2));
    const key = new THREE.DirectionalLight(0xffffff, 0.7); key.position.set(1, 2, 1.5); s.add(key);
    const sc = mkCanvas(256, 256), y = sc.getContext('2d'), rg = y.createRadialGradient(128, 128, 8, 128, 128, 128);
    rg.addColorStop(0, 'rgba(0,0,0,.7)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
    y.fillStyle = rg; y.fillRect(0, 0, 256, 256);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: canvasTex(sc), transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.0005;
    s.add(shadow);
    const cam = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.01, 50);
    const ctl = new THREE.OrbitControls(cam, renderer.domElement);
    ctl.enabled = false; ctl.enableDamping = true; ctl.dampingFactor = 0.12; ctl.minDistance = 0.15; ctl.maxDistance = 6;
    ctl.addEventListener('change', invalidate);
    const lr = new THREE.CSS2DRenderer(); lr.setSize(innerWidth, innerHeight);
    $('#studioLabels').appendChild(lr.domElement);
    Object.assign(studio, { scene: s, cam, controls: ctl, labels: lr, shadow });
  }
  function openStudio(it) {
    if (!studio.scene) buildStudio();
    clearStudioItem();
    const g = geomOf(it);
    const mesh = makeItemMesh(it, 3, studioSideMat);
    mesh.position.set(0, g.h / 2, 0);
    studio.scene.add(mesh);
    studio.mesh = mesh; studio.item = it;
    studio.shadow.scale.set(RAIL * 1.8, g.depth * 1.8, 1);
    const d = new THREE.Group(), lm = new THREE.LineBasicMaterial({ color: 0xe6dcb9 });
    const line = (a, b) => d.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), lm));
    const lab = (p, t) => { const o = css2d(esc(t), 'dim-label'); o.position.copy(p); d.add(o); };
    const zf = g.depth / 2, xr = RAIL / 2 + 0.035, y0 = 0.002;
    line(v(-RAIL / 2, y0, zf + 0.05), v(RAIL / 2, y0, zf + 0.05));
    line(v(-RAIL / 2, y0, zf + 0.03), v(-RAIL / 2, y0, zf + 0.07)); line(v(RAIL / 2, y0, zf + 0.03), v(RAIL / 2, y0, zf + 0.07));
    lab(v(0, y0, zf + 0.09), '482.6 mm (19")');
    line(v(xr, 0, zf), v(xr, g.h, zf));
    line(v(xr - 0.015, 0, zf), v(xr + 0.015, 0, zf)); line(v(xr - 0.015, g.h, zf), v(xr + 0.015, g.h, zf));
    lab(v(xr + 0.03, g.h / 2, zf), it._u + ' RU · ' + (it._u * 44.45).toFixed(2) + ' mm');
    line(v(xr, y0, zf), v(xr, y0, -zf));
    lab(v(xr + 0.03, y0, 0), Math.round(g.depth * 1000) + ' mm deep');
    studio.scene.add(d);
    studio.dims = d;
    $('#studioBadge').textContent = TYPE_NAME[it.kind === 'device' ? it.type : it.kind] || it.kind;
    $('#studioTitle').textContent = it.kind === 'device' ? it.label + ' · ' + it._rack.id + ' ' + fmtRange(it) : it._rack.id + ' ' + (it.id || '') + ' · ' + fmtRange(it);
    studio.open = true;
    $('#studio').hidden = false;
    document.body.classList.add('studio-open');
    $('#labels').style.display = 'none';
    ['#topbar', '#layers', '#elev', '#modebar', '#placard', '#hint'].forEach(s => { const el = $(s); el.dataset.wasHidden = el.hidden ? '1' : ''; el.hidden = true; });
    controls.enabled = false;
    studio.controls.enabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    hideTip(); setPortHover(null);
    studio.cam.aspect = innerWidth / innerHeight; studio.cam.updateProjectionMatrix();
    studioView('front', 0);
    showItemCard(it);
    invalidate();
  }
  function clearStudioItem() {
    if (studio.mesh) { studio.scene.remove(studio.mesh); disposeMesh(studio.mesh); studio.mesh = null; }
    if (studio.dims) {
      studio.dims.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.isCSS2DObject && o.element.parentNode) o.element.parentNode.removeChild(o.element); });
      studio.scene.remove(studio.dims); studio.dims = null;
    }
    studio.hover = null;
  }
  function closeStudio() {
    if (!studio.open) return;
    clearStudioItem();
    studio.open = false;
    $('#studio').hidden = true;
    document.body.classList.remove('studio-open');
    $('#labels').style.display = '';
    ['#topbar', '#layers', '#elev', '#modebar', '#placard', '#hint'].forEach(s => { const el = $(s); el.hidden = el.dataset.wasHidden === '1'; });
    studio.controls.enabled = false;
    controls.enabled = !(state.mode === 'aisle' || state.mode === 'walk');
    renderer.toneMapping = THREE.NoToneMapping;
    hideTip();
    if (state.sel) showItemCard(state.sel); else hideCard();
    invalidate();
  }
  function studioView(view, ms) {
    const g = geomOf(studio.item), D = Math.max(1.35, g.h * 2.8);
    let p;
    if (view === 'rear') p = v(0, g.h / 2 + 0.02, -D);
    else if (view === 'top') p = v(0, D + g.h, 0.001);
    else if (view === 'iso') p = v(D * 0.62, g.h / 2 + D * 0.45, D * 0.72);
    else p = v(0, g.h / 2 + 0.02, D);
    flyTo(p, v(0, g.h / 2, 0), 32, ms == null ? 600 : ms, studio.cam, studio.controls);
    $$('#studioViews button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  }
  function studioHover(e) {
    const pf = portFromHit(pickAt(e, [studio.mesh], studio.cam));
    const name = pf && pf.port ? pf.port.name : null, face = pf && pf.face;
    const h = studio.hover;
    if (h && (h.face !== face || h.name !== name)) { repaint(studio.mesh, h.face, null); studio.hover = null; }
    if (name && !studio.hover) { studio.hover = { face, name }; repaint(studio.mesh, face, name); }
    if (name) { showTip(e, portTip(studio.item, pf.port)); renderer.domElement.style.cursor = 'pointer'; }
    else { hideTip(); renderer.domElement.style.cursor = ''; }
    invalidate();
  }
  function studioClick(e) {
    const pf = portFromHit(pickAt(e, [studio.mesh], studio.cam));
    if (pf && pf.port) showPortCard(studio.item, pf.port);
  }
  $('#studioClose').onclick = closeStudio;
  $('#studioViews').onclick = e => { const b = e.target.closest('[data-view]'); if (b) studioView(b.dataset.view); };

  // ------------------------------------------------------------------ occupancy, shopping list, observations
  function trunkIsNew(t) {
    return [t.a, t.b].some(ref => {
      const m = /^(.*#F\d+)\.C(\d+)$/.exec(ref);
      if (m) { const it = panelByKey[m[1]]; const c = it && it.cassettes[+m[2] - 1]; return !!(it && (it.isNew || (c && c.isNew))); }
      const it = panelByKey[ref];
      return !!(it && it.isNew);
    });
  }
  const STD_LEN = [1, 2, 3, 5, 7, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100];
  const stdLen = l => STD_LEN.find(x => x >= (l || 0) * 1.1) || Math.ceil((l || 0) * 1.1);
  function shopping() {
    const out = [], add = (qty, item, loc, reason) => out.push({ qty, item, loc, reason });
    const reason = (r, it, cass) => {
      if (r.star.length) {
        const k = cass != null ? it._key + '.C' + (cass + 1) : it._key, peer = trunkPeer[k];
        if (peer && peer.t.interRow) return 'Inter-row trunk expansion';
        return peer ? 'Star-center counterpart of ' + shortRef(peer.peer) : 'Star-center expansion';
      }
      if (cass != null && it.cassettes[cass].medium === 'sm' && !r.items.some(x => x.kind === 'lc' && x.cassettes.some(c => c && c.medium === 'sm' && !c.isNew && !x.isNew))) return 'Rack had no single-mode fiber';
      return 'Demand +30 % exceeds installed ports';
    };
    racks.forEach(r => r.items.forEach(it => {
      if (it.kind === 'utp' && it.isNew) add(1, '24-port UTP patch panel, 1U', r.id + ' ' + it.id + ' (' + fmtRange(it) + ')', reason(r, it));
      if (it.kind === 'lc') {
        if (it.isNew) add(1, 'Fiber tray 1U, 4 cassette slots', r.id + ' ' + it.id + ' (' + fmtRange(it) + ')', reason(r, it));
        it.cassettes.forEach((c, ci) => { if (c && c.isNew) add(1, 'MPO–LC cassette, 12 duplex ports, ' + c.medium.toUpperCase(), r.id + ' ' + it.id + '.C' + (ci + 1), reason(r, it, ci)); });
      }
    }));
    trunks.forEach(t => {
      if (!trunkIsNew(t)) return;
      const L = stdLen(t._len);
      add(1, t.medium === 'copper' ? 'Pre-terminated copper trunk, 24 links, ' + L + ' m' : 'MPO trunk ' + t.medium.toUpperCase() + ', 24 fibers, ' + L + ' m',
        shortRef(t.a) + ' ↔ ' + shortRef(t.b), t.interRow ? 'Inter-row trunk between copper star centers' : 'Trunk for a new panel / cassette');
    });
    cables.forEach(c => {
      if (c.kind === 'active' && c.status !== 'existing') add(1, 'Active optical cable, fixed length ' + stdLen(c._len) + ' m', c.a.item + ' ' + c.a.port + ' ↔ ' + c.b.item + ' ' + c.b.port, 'Cannot pass through patch panels — laid in the tray');
    });
    const tx = { mm: 0, sm: 0 }, cords = { copper: 0, mm: 0, sm: 0 };
    let runM = 0, runs = 0;
    cables.forEach(c => {
      if (c.status !== 'proposed') return;
      if ((c.medium === 'mm' || c.medium === 'sm') && c.kind !== 'active') tx[c.medium] += extById[c.b.item] ? 1 : 2;
      c._pieces.forEach(p => {
        if (p.type === 'patch') cords[c.medium] = (cords[c.medium] || 0) + 1;
        else if (!p.trunk && c.kind !== 'active') { runs++; runM += polyLen(p.pts); }
      });
    });
    if (tx.mm) add(tx.mm, 'Optical transceiver, MM short reach', 'Proposed MM links', 'One per fiber link end');
    if (tx.sm) add(tx.sm, 'Optical transceiver, SM', 'Proposed SM links', 'One per fiber link end');
    if (cords.copper) add(cords.copper, 'Copper patch cord, 0.5–3 m', 'Various racks', 'Patch cords for proposed copper links');
    if (cords.mm) add(cords.mm, 'LC–LC duplex patch cord, MM', 'Various racks', 'Patch cords for proposed MM links');
    if (cords.sm) add(cords.sm, 'LC–LC duplex patch cord, SM', 'Various racks', 'Patch cords for proposed SM links');
    if (runs) add(runs, 'Copper cable, tray run (≈ ' + Math.ceil(runM * 1.1) + ' m total)', 'PDU / door / camera runs', 'Direct runs to the star center');
    return out;
  }
  function observations() {
    const out = [];
    racks.forEach(r => r.items.forEach(it => {
      if (it.kind !== 'device' || !SWITCHLIKE.has(it.type)) return;
      const P = devPorts(it);
      if (!P.cu.length) return;
      const used = P.cu.filter(n => portCable['dev:' + it.label + ':' + n]).length;
      const waiting = (cablesBy['dev:' + it.label] || []).filter(c => c.status === 'pending' && ((c.a.item === it.label && c.a.port === '?') || (c.b.item === it.label && c.b.port === '?'))).length;
      if (used + waiting > P.cu.length / RESERVE) {
        out.push({ sev: used + waiting >= P.cu.length ? 'bad' : 'warn', text: it.label + ': ' + used + '/' + P.cu.length + ' copper ports used' + (waiting ? ', ' + waiting + ' cable(s) waiting for a port' : '') + ' — less than 30 % reserve.', sub: r.id + ' ' + fmtRange(it), go: () => openRack(r, { focus: it }) });
      }
    }));
    racks.forEach(r => {
      if (r.star.includes('sm')) return;
      const had = r.items.some(it => it.kind === 'lc' && !it.isNew && it.cassettes.some(c => c && c.medium === 'sm' && !c.isNew));
      const needs = r.items.filter(it => it.kind === 'device' && it.uplinkMedium === 'sm');
      if (needs.length && !had) {
        const planned = r.items.reduce((n, it) => n + (it.kind === 'lc' ? it.cassettes.filter(c => c && c.medium === 'sm' && c.isNew).length : 0), 0);
        out.push({ sev: 'warn', text: r.id + ' has no single-mode fiber installed, but ' + needs.map(d => d.label).join(', ') + (needs.length > 1 ? ' need it.' : ' needs it.'), sub: planned ? planned + ' new SM cassette(s) planned' : 'No SM cassette planned yet', go: () => openRack(r) });
      }
    });
    const act = cables.filter(c => c.kind === 'active');
    if (act.length) out.push({ sev: 'info', text: act.length + ' active cable(s) cannot pass through patch panels; they are laid in the tray with a fixed length.', sub: act.map(c => c.a.item + ' ↔ ' + c.b.item).join(' · ') });
    if (!cables.length) out.push({ sev: 'info', text: 'This data has no cables or trunks, so there is nothing to trace and the port occupancy reads empty.', sub: DATA.meta && DATA.meta.imported ? 'An inventory CSV holds racks and equipment only; import a JSON file to bring cables in.' : '' });
    const pend = cables.filter(c => c.status === 'pending');
    if (pend.length) out.push({ sev: 'bad', text: pend.length + ' pending cable(s) without a confirmed port.', sub: pend.map(c => c.id + ' ' + cableSummary(c)).join(' · ') });
    racks.forEach(r => {
      const p = power(r);
      if (p.status !== 'ok') out.push({ sev: p.status === 'over' ? 'bad' : 'warn', text: r.id + ' draws ' + kw(p.w) + ', ' + Math.round(p.util * 100) + ' % of its ' + kw(p.budget) + ' budget' + (p.status === 'over' ? ': one feed alone could not carry it.' : '.'), sub: 'Estimated exhaust ' + Math.round(p.exhaustC) + ' °C', go: () => openRack(r) });
    });
    racks.forEach(r => { const s = rackStats(r); if (s.uFree < 4) out.push({ sev: 'warn', text: r.id + ' has only ' + s.uFree + 'U free.', sub: r.name, go: () => openRack(r) }); });
    const ext = DATA.externals || [];
    if (ext.length) out.push({ sev: 'info', text: ext.length + ' element(s) are outside the racks.', sub: ext.map(e => e.label || e.id).join(' · ') });
    (DATA.notes || []).forEach(n => out.push({ sev: 'info', text: n, sub: 'From the data generator' }));
    return out;
  }

  // ------------------------------------------------------------------ modals
  function openModal(html, onClick) {
    $('#modalContent').innerHTML = html;
    $('#modal').hidden = false;
    $('#modalContent').onclick = onClick || null;
    hideTip();
  }
  function closeModal() { $('#modal').hidden = true; $('#modalContent').onmouseover = null; setHover(null); }
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });

  function barCell(s) {
    const demand = Math.ceil(s.used * RESERVE), scale = Math.max(s.inst, demand, 1);
    const pct = x => (x / scale * 100).toFixed(1) + '%';
    if (!s.inst && !s.used) return '<span style="color:var(--muted)">—</span>';
    return '<div class="bar-cell"><div class="bar"><span class="fill" style="width:' + pct(s.used) + ';background:' + (demand > s.inst ? 'var(--pending)' : 'var(--accent)') + '"></span>' +
      (s.newInst ? '<span class="newcap" style="left:' + pct(s.inst - s.newInst) + ';width:' + pct(s.newInst) + '"></span>' : '') +
      '<i class="mark" style="left:' + pct(demand) + '" title="Demand +30 %: ' + demand + '"></i></div><small>' + s.used + ' / ' + s.inst + '</small></div>';
  }
  function showOccupancy() {
    const all = racks.map(r => ({ r, s: rackStats(r) }));
    const between = cables.filter(c => { const a = refRack(c.a.item), b = refRack(c.b.item); return a && b && a !== b; }).length;
    const interPanels = new Set();
    trunks.forEach(t => { if (t.interRow) { interPanels.add(t.a); interPanels.add(t.b); } });
    const inter = cables.filter(c => c.hops.some(h => interPanels.has(parseHop(h).key))).length;
    const newEl = sum(all, x => x.s.newItems), pend = cables.filter(c => c.status === 'pending').length;
    openModal('<h2>Occupancy</h2><p class="sub">Ports used per rack and medium. The white mark is the demand plus the 30 % reserve; the dashed amber part is capacity still to be installed.</p>' +
      '<div class="kpis"><div class="kpi"><b>' + between + '</b><small>Cables between racks</small></div><div class="kpi"><b>' + inter + '</b><small>Over the inter-row trunk</small></div>' +
      '<div class="kpi warn"><b>' + newEl + '</b><small>New elements to order</small></div><div class="kpi bad"><b>' + pend + '</b><small>Pending cables</small></div>' +
      '<div class="kpi"><b>' + cables.length + '</b><small>Cables in the model</small></div></div>' +
      '<div class="table-wrap"><table class="grid"><thead><tr><th>Rack</th><th>U used</th><th>UTP</th><th>FO MM</th><th>FO SM</th><th>New</th></tr></thead><tbody>' +
      all.map(({ r, s }) => '<tr data-r="' + esc(r.id) + '" style="cursor:pointer"><td><b>' + esc(r.id) + '</b><br><small style="color:var(--muted)">' + esc(r.name) + '</small></td>' +
        '<td>' + s.uUsed + '/' + RACK_U + '</td><td>' + barCell(s.copper) + '</td><td>' + barCell(s.mm) + '</td><td>' + barCell(s.sm) + '</td>' +
        '<td>' + (s.newItems ? '<span class="badge new">' + s.newItems + '</span>' : '') + '</td></tr>').join('') +
      '</tbody></table></div>' +
      '<div class="legend"><span><i class="dot" style="background:var(--accent)"></i>Used</span><span><i class="dot" style="background:var(--pending)"></i>Used, demand +30 % above capacity</span><span><i class="dot" style="border:1px dashed var(--new)"></i>New capacity</span><span><i class="dot" style="background:#fff"></i>Demand +30 %</span></div>',
      e => { const tr = e.target.closest('[data-r]'); if (tr) { closeModal(); openRack(rackById[tr.dataset.r]); } });
  }
  function csvCell(s) { s = String(s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function showShopping() {
    const list = shopping();
    openModal('<h2>Shopping list</h2><p class="sub">Derived from the data: items flagged as new, trunks that touch them, proposed fiber links and active cables.</p>' +
      '<div class="actions" style="margin-bottom:10px"><button class="btn primary" data-csv>Download CSV</button></div>' +
      '<div class="table-wrap"><table class="grid"><thead><tr><th>Qty</th><th>Item</th><th>Location</th><th>Reason</th></tr></thead><tbody>' +
      (list.length ? list.map(x => '<tr><td><b>' + x.qty + '</b></td><td>' + esc(x.item) + '</td><td>' + esc(x.loc) + '</td><td style="color:var(--muted)">' + esc(x.reason) + '</td></tr>').join('') : '<tr><td colspan="4">Nothing to order.</td></tr>') +
      '</tbody></table></div>',
      e => {
        if (!e.target.closest('[data-csv]')) return;
        const csv = ['Qty,Item,Location,Reason'].concat(list.map(x => [x.qty, x.item, x.loc, x.reason].map(csvCell).join(','))).join('\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
        a.download = 'racks3d-shopping-list.csv';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      });
  }
  function showPower() {
    const all = racks.map(r => ({ r, p: power(r) }));
    const total = sum(all, x => x.p.w), budget = sum(all, x => x.p.budget);
    const hot = all.reduce((a, x) => (x.p.exhaustC > a.p.exhaustC ? x : a), all[0]);
    const high = all.filter(x => x.p.status !== 'ok').length;
    const dot = t => '<i class="dot" style="background:#' + heatColor(t).getHexString() + '"></i>';
    openModal('<h2>Power &amp; heat</h2><p class="sub">Load per rack against its budget, split over the A and B feeds, and the estimated exhaust temperature in the hot aisle. ' +
      'Devices draw the typical watts of their type unless the data gives <code>watts</code>. Turn on the <b>Heat map</b> layer to see it on the floor.</p>' +
      '<div class="kpis"><div class="kpi"><b>' + kw(total) + '</b><small>Total load · ' + Math.round(total / budget * 100) + ' % of ' + kw(budget) + '</small></div>' +
      '<div class="kpi' + (high ? ' warn' : '') + '"><b>' + high + '</b><small>Racks above 80 % of budget</small></div>' +
      '<div class="kpi"><b>' + Math.round(hot.p.exhaustC) + ' °C</b><small>Hottest exhaust · ' + esc(hot.r.id) + '</small></div>' +
      '<div class="kpi"><b>' + powerOfData.inletC + ' °C</b><small>Cold-aisle inlet</small></div></div>' +
      '<div class="table-wrap"><table class="grid"><thead><tr><th>Rack</th><th>Load / budget</th><th>Feed A</th><th>Feed B</th><th>Exhaust</th></tr></thead><tbody>' +
      all.map(({ r, p }) => '<tr data-r="' + esc(r.id) + '" style="cursor:pointer"><td><b>' + esc(r.id) + '</b><br><small style="color:var(--muted)">' + esc(r.name) + '</small></td>' +
        '<td><div class="bar-cell"><div class="bar"><span class="fill" style="width:' + Math.min(100, p.util * 100).toFixed(1) + '%;background:var(--' + ({ ok: 'accent', high: 'new', over: 'pending' })[p.status] + ')"></span><i class="mark" style="left:80%" title="80 %"></i></div><small>' + kw(p.w) + ' / ' + kw(p.budget) + '</small></div></td>' +
        '<td>' + kw(p.feedA) + '</td><td>' + kw(p.feedB) + '</td><td>' + dot(p.exhaustC) + ' ' + Math.round(p.exhaustC) + ' °C</td></tr>').join('') +
      '</tbody></table></div>' +
      '<div class="legend"><span><i class="dot" style="background:var(--accent)"></i>Under 80 %</span><span><i class="dot" style="background:var(--new)"></i>80–100 %</span><span><i class="dot" style="background:var(--pending)"></i>Over budget: with 2N feeds, one feed alone could not carry the rack</span><span><i class="dot" style="background:#fff"></i>80 % mark</span></div>' +
      '<p class="sub" style="margin-top:10px">The exhaust is an estimate, not a measurement: fans sized for the rack budget (' + powerOfData.cfmPerKw + ' CFM per kW), so ΔT (°C) = 1.76 × W ÷ CFM, the usual 3.16 × W ÷ CFM in °F.</p>',
      e => { const tr = e.target.closest('[data-r]'); if (tr) { closeModal(); openRack(rackById[tr.dataset.r]); } });
  }
  const powerOfData = Object.assign({}, PLAN.POWER_DEFAULTS, DATA.power || {});

  // ------------------------------------------------------------------ where does it fit?
  const FIT_PRESETS = [
    ['server1', '1U server', { type: 'server', u: 1, copper: 3, fiber: 0, medium: 'mm' }],
    ['server2', '2U server', { type: 'server', u: 2, copper: 3, fiber: 2, medium: 'mm' }],
    ['storage', '2U storage array', { type: 'storage', u: 2, copper: 3, fiber: 4, medium: 'mm' }],
    ['switch', 'Access switch', { type: 'switch', u: 1, copper: 1, fiber: 2, medium: 'mm' }],
    ['router', 'Edge router', { type: 'router', u: 2, copper: 2, fiber: 4, medium: 'sm' }],
    ['chassis', '6U blade chassis', { type: 'chassis', u: 6, copper: 4, fiber: 8, medium: 'mm' }],
    ['custom', 'Something else', { type: 'appliance', u: 1, copper: 1, fiber: 0, medium: 'mm' }],
  ];
  const fitName = n => n.u + 'U ' + (TYPE_NAME[n.type] || n.type).toLowerCase() + ' · ' + n.watts + ' W';
  const runText = (x, n) => x.run ? 'U' + x.run.top + (n.u > 1 ? '–U' + (x.run.top - n.u + 1) : '') : '—';
  function fitText(x) {
    if (!x) return '';
    if (x.status === 'fits') return '<span style="color:var(--free)">Fits</span> at ' + runText(x, fit.shown);
    if (x.status === 'add') return '<span style="color:var(--new)">Fits once you add</span> ' + esc(x.add.join(' + '));
    return '<span style="color:var(--muted)">Does not fit:</span> ' + esc(x.why.join('; '));
  }
  function showFit() {
    const n = fit.need || Object.assign({ preset: 'server2', watts: PLAN.watts({ kind: 'device', type: 'server', u: 2 }) }, FIT_PRESETS[1][2]);
    const field = (k, label, html) => '<label class="field"><span>' + label + '</span>' + html + '</label>';
    const numIn = (k, min, max) => '<input type="number" data-f="' + k + '" min="' + min + '" max="' + max + '" value="' + n[k] + '">';
    openModal('<h2>Where does it fit?</h2><p class="sub">Describe the equipment and see which racks have a free run of U for it, patching ports for its cables and power to spare. ' +
      'Ports count the free ports on each rack’s trunk panels and cassettes; when they run short, the panels or cassettes to add are listed.</p>' +
      '<div class="fit-form">' +
      field('preset', 'Equipment', '<select data-f="preset">' + FIT_PRESETS.map(p => '<option value="' + p[0] + '"' + (p[0] === n.preset ? ' selected' : '') + '>' + esc(p[1]) + '</option>').join('') + '</select>') +
      field('type', 'Type', '<select data-f="type">' + PLAN.TYPES.map(t => '<option value="' + t + '"' + (t === n.type ? ' selected' : '') + '>' + esc(TYPE_NAME[t] || t) + '</option>').join('') + '</select>') +
      field('u', 'Height (U)', numIn('u', 1, RACK_U)) +
      field('copper', 'Copper ports to patch', numIn('copper', 0, 96)) +
      field('fiber', 'Fiber ports to patch', numIn('fiber', 0, 48)) +
      field('medium', 'Fiber', '<select data-f="medium"><option value="mm"' + (n.medium === 'mm' ? ' selected' : '') + '>Multimode</option><option value="sm"' + (n.medium === 'sm' ? ' selected' : '') + '>Single-mode</option></select>') +
      field('watts', 'Power (W)', numIn('watts', 0, 20000)) +
      '</div><div id="fitResults"></div>',
      e => {
        const tr = e.target.closest('[data-r]');
        if (tr) { closeModal(); applyFit(); openRack(rackById[tr.dataset.r]); return; }
        if (e.target.closest('[data-show]')) { closeModal(); applyFit(); if (state.mode !== 'room') goRoom(); showFitCard(); }
      });
    const form = $('.fit-form');
    const read = () => {
      const g = k => $('[data-f="' + k + '"]', form);
      return { preset: g('preset').value, type: g('type').value, u: Math.max(1, Math.min(RACK_U, parseInt(g('u').value, 10) || 1)),
        copper: Math.max(0, parseInt(g('copper').value, 10) || 0), fiber: Math.max(0, parseInt(g('fiber').value, 10) || 0),
        medium: g('medium').value, watts: Math.max(0, parseInt(g('watts').value, 10) || 0) };
    };
    const render = () => {
      fit.need = read();
      const res = PLAN.findFit(DATA, fit.need), count = st => res.filter(x => x.status === st).length;
      $('#fitResults').innerHTML = '<div class="kpis"><div class="kpi"><b style="color:var(--free)">' + count('fits') + '</b><small>Racks where it fits now</small></div>' +
        '<div class="kpi warn"><b>' + count('add') + '</b><small>Fit once a panel or cassette is added</small></div>' +
        '<div class="kpi"><b>' + count('no') + '</b><small>No room, ports or power</small></div></div>' +
        '<div class="actions" style="margin-bottom:10px"><button class="btn primary" data-show>Show in 3D</button></div>' +
        '<div class="table-wrap"><table class="grid"><thead><tr><th>Rack</th><th>Result</th><th>Free run</th><th>Power after</th></tr></thead><tbody>' +
        res.map(x => '<tr data-r="' + esc(x.rack.id) + '" style="cursor:pointer"><td><b>' + esc(x.rack.id) + '</b><br><small style="color:var(--muted)">' + esc(x.rack.name) + '</small></td>' +
          '<td>' + (x.status === 'fits' ? '<span class="badge free">Fits</span>' : x.status === 'add' ? '<span class="badge new">Add</span> ' + esc(x.add.join(' + ')) : '<span class="badge mute">No</span> <small style="color:var(--muted)">' + esc(x.why.join('; ')) + '</small>') + '</td>' +
          '<td>' + runText(x, fit.need) + ' <small style="color:var(--muted)">(largest ' + x.largest + 'U)</small></td>' +
          '<td>' + kw(x.powerAfter) + ' <small style="color:var(--muted)">of ' + kw(x.budget) + '</small></td></tr>').join('') + '</tbody></table></div>';
      fit.preview = res;
    };
    form.addEventListener('input', e => {
      const k = e.target.dataset.f;
      if (k === 'preset') {
        const p = FIT_PRESETS.find(q => q[0] === e.target.value)[2];
        Object.keys(p).forEach(f => { $('[data-f="' + f + '"]', form).value = p[f]; });
      }
      if (k === 'preset' || k === 'type' || k === 'u') $('[data-f="watts"]', form).value = PLAN.watts({ kind: 'device', type: $('[data-f="type"]', form).value, u: parseInt($('[data-f="u"]', form).value, 10) || 1 });
      render();
    });
    render();
  }
  // keep the last search on screen: racks glow, and each rack that can take it shows a ghost of it
  function applyFit() {
    clearFit();
    fit.results = fit.preview;
    fit.shown = Object.assign({}, fit.need);
    fit.byRack = {};
    fit.results.forEach(x => {
      fit.byRack[x.rack.id] = x;
      if (!x.run) return;
      const r = x.rack, o = rackObjs[r.id], n = fit.shown;
      const top = x.run.top, bottom = top - n.u + 1, yb = BASE + (bottom - 1) * U, h = n.u * U, depth = Math.min(DEPTH[n.type] || 0.5, r.d - 0.25);
      const g = new THREE.Group();
      const col = x.status === 'fits' ? C.free : x.status === 'add' ? C.new : C.muted;
      const box = new THREE.Mesh(new THREE.BoxGeometry(RAIL, h - 0.002, depth), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.28, depthWrite: false }));
      box.position.set(0, yb + h / 2, FRONT_RAIL - depth / 2);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color: col }));
      edges.position.copy(box.position);
      const lab = css2d('Proposed ' + esc(fitName(n)) + '<br>' + runText(x, n), 'ghost-label ' + x.status);
      lab.position.set(0, yb + h / 2, FRONT_RAIL + 0.02);
      g.add(box, edges, lab);
      g.userData.label = lab;
      o.group.add(g);
      o.ghost = g;
    });
    applyVisibility();
  }
  function clearFit() {
    racks.forEach(r => {
      const o = rackObjs[r.id];
      if (!o.ghost) return;
      o.ghost.traverse(m => { if (m.geometry) m.geometry.dispose(); if (m.material) m.material.dispose(); });
      o.group.remove(o.ghost);
      o.ghost = null;
    });
    fit.results = fit.byRack = null;
    applyVisibility();
  }
  function showFitCard() {
    if (!fit.results) return;
    const ok = fit.results.filter(x => x.status !== 'no');
    showCard({
      badge: 'Where does it fit?', title: fitName(fit.shown),
      html: '<p style="color:var(--muted);margin:4px 0 8px">Green racks take it as they are, amber ones once a panel or cassette is added; star centers come last, as they are for patching. Open one to see the proposed position.</p>' +
        '<ul class="cables">' + (ok.length ? ok.map(x => '<li data-fit="' + esc(x.rack.id) + '"><span class="dot" style="background:' + (x.status === 'fits' ? C.free : C.new) + '"></span><span>' + esc(x.rack.id) + ' · ' + esc(x.rack.name) + '</span><small>' + (x.status === 'fits' ? runText(x, fit.shown) : '+ ' + x.add.length + ' to add') + '</small></li>').join('') : '<li><span>No rack can take it.</span></li>') + '</ul>',
      actions: [['Change the search', showFit], ['Clear', () => { clearFit(); hideCard(); }]],
    });
  }
  // ------------------------------------------------------------------ import
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  // A file's text → { data, errors }. CSV is the inventory; JSON or a .js data file is the full model.
  function readData(name, text) {
    if (/\.csv$/i.test(name)) return PLAN.fromCsv(text, name);
    try {
      const json = text.replace(/^[\s\S]*?window\.DC_DATA\s*=\s*/, '').replace(/;\s*$/, '');
      return { data: JSON.parse(json), errors: [] };
    } catch (e) { return { data: null, errors: ['Not a CSV, or JSON in the racks3d format: ' + e.message] }; }
  }
  function showImport() {
    const cur = window.Racks3dImport && window.Racks3dImport.load();
    let pending = null;
    openModal('<h2>Import your data hall</h2><p class="sub">Open an <b>inventory CSV</b> (racks and the equipment in them, one line per item) or a <b>JSON</b> file in the same format as <code>data/sample-data.js</code> (with cables and trunks). ' +
      'The file is read here and kept in this browser only: nothing is uploaded.</p>' +
      (cur ? '<p class="note-line">Showing <b>' + esc(cur.name) + '</b>, imported ' + esc(new Date(cur.at).toLocaleString()) + '. <button class="btn" data-k="sample">Back to the sample</button></p>' : '') +
      '<label class="drop" id="drop"><input type="file" id="file" accept=".csv,.json,.js,text/csv,application/json" hidden><b>Drop a file here</b><small>or click to choose · .csv, .json</small></label>' +
      '<div id="importResult"></div>' +
      '<div class="actions"><button class="btn" data-k="template">Download the CSV of this hall</button><button class="btn" data-k="json">Download the JSON of this hall</button></div>' +
      '<p class="sub" style="margin-top:10px">The CSV columns are <code>' + esc('rack, row, rack_name, width, depth, rack_kw, u_top, kind, label, type, u, ports, uplinks, uplink_medium, watts, role, cassettes, new') + '</code>. ' +
      '<code>kind</code> is device, utp, lc or org; <code>u_top</code> is the U the item starts at; a line with no kind just declares an empty rack. The CSV of this hall is a ready-made example.</p>',
      e => {
        const k = e.target.closest('[data-k]');
        if (!k) return;
        if (k.dataset.k === 'template') download('racks3d-inventory.csv', '\uFEFF' + PLAN.toCsv(RAW), 'text/csv');
        else if (k.dataset.k === 'json') download('racks3d-data.json', JSON.stringify(RAW, null, 1), 'application/json');
        else if (k.dataset.k === 'sample') { window.Racks3dImport.clear(); location.reload(); }
        else if (k.dataset.k === 'open' && pending) {
          if (window.Racks3dImport.save(pending)) location.reload();
          else $('#importResult').insertAdjacentHTML('beforeend', '<p class="note-line bad">This browser does not allow saving it (private window or blocked storage).</p>');
        }
      });
    const drop = $('#drop'), file = $('#file');
    const take = f => {
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        const { data, errors } = readData(f.name, String(rd.result));
        const v = data ? PLAN.validate(data) : { errors: [], warnings: [] };
        const all = errors.concat(v.errors);
        const devices = data ? data.racks.reduce((n, r) => n + (r.items || []).filter(it => it && it.kind === 'device').length, 0) : 0;
        pending = all.length ? null : { name: f.name, at: Date.now(), data };
        const list = (xs, cls) => '<ul class="notes">' + xs.slice(0, 30).map(x => '<li class="' + cls + '"><span class="ico">!</span><div>' + esc(x) + '</div></li>').join('') + (xs.length > 30 ? '<li class="' + cls + '"><span class="ico">…</span><div>and ' + (xs.length - 30) + ' more</div></li>' : '') + '</ul>';
        $('#importResult').innerHTML = '<h3>' + esc(f.name) + '</h3>' +
          (data ? '<p class="sub">' + data.racks.length + ' racks · ' + devices + ' devices · ' + ((data.cables || []).length) + ' cables</p>' : '') +
          (data && !(data.cables || []).length ? '<p class="note-line">No cables or trunks in this file' + (/\.csv$/i.test(f.name) ? ' (an inventory CSV only holds racks and equipment)' : '') +
            ': racks, power, heat and Fit will work, but there will be nothing to trace and the port occupancy will read empty.</p>' : '') +
          (all.length ? '<p class="note-line bad">' + all.length + ' problem(s) to fix in the file before it can be opened:</p>' + list(all, 'bad')
            : '<div class="actions" style="margin:0 0 10px"><button class="btn primary" data-k="open">Open it</button></div>') +
          (v.warnings.length ? '<p class="note-line">' + v.warnings.length + ' warning(s), it opens anyway:</p>' + list(v.warnings, 'warn') : '');
      };
      rd.readAsText(f);
    };
    file.onchange = () => take(file.files[0]);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); take(e.dataTransfer.files[0]); };
  }
  let notesCache = null;
  function showNotes() {
    const list = notesCache || (notesCache = observations());
    openModal('<h2>Observations</h2><p class="sub">Generated by rules from the data.</p><ul class="notes">' +
      list.map((n, i) => '<li class="' + n.sev + '" data-n="' + i + '"' + (n.go ? ' style="cursor:pointer"' : '') + '><span class="ico">' + (n.sev === 'info' ? 'i' : '!') + '</span><div>' + esc(n.text) + (n.sub ? '<small>' + esc(n.sub) + '</small>' : '') + '</div></li>').join('') + '</ul>',
      e => { const li = e.target.closest('[data-n]'); const n = li && list[+li.dataset.n]; if (n && n.go) { closeModal(); n.go(); } });
  }
  function showRacksMenu() {
    const order = rows.slice().sort((a, b) => (a.front - a.sgn * a.maxD / 2) - (b.front - b.sgn * b.maxD / 2));
    let html = '<h2>Racks</h2><p class="sub">Mini plan seen from above, rows in their physical order. Hover a rack to light it in 3D; click to open it.</p><div class="plan">';
    order.forEach((R, k) => {
      const cells = R.racks.slice().sort((a, b) => a._x - b._x);
      html += '<div class="plan-row"><div class="rowname"><b>' + esc(R.name) + '</b><button class="btn" data-row="' + esc(R.key) + '">View full row</button></div><div class="plan-cells">' +
        cells.map(r => {
          const s = rackStats(r);
          return '<div class="plan-cell' + (r.w >= 0.75 ? ' w800' : '') + (r.star.length ? ' star' : '') + '" data-r="' + esc(r.id) + '"><b>' + esc(r.id) + '</b><small>' + esc(r.name) + '</small>' +
            '<div class="mini-bar"><span style="width:' + (s.uUsed / RACK_U * 100).toFixed(0) + '%"></span></div>' +
            (s.newItems ? '<span class="newn">+' + s.newItems + ' new</span>' : '<small>' + s.uFree + 'U free</small>') + '</div>';
        }).join('') + '</div></div>';
      const N = order[k + 1];
      if (N) {
        const a = aisles.find(x => rowSideOf(R, x) && rowSideOf(N, x));
        if (a) html += '<div class="aisle-strip ' + a.type + '">' + esc(a.name) + '</div>';
      }
    });
    html += '</div>';
    openModal(html, e => {
      const c = e.target.closest('[data-r]');
      if (c) { closeModal(); openRack(rackById[c.dataset.r]); return; }
      const b = e.target.closest('[data-row]');
      if (b) { closeModal(); openRow(rows.find(R => R.key === b.dataset.row), 'front'); }
    });
    $('#modalContent').onmouseover = e => { const c = e.target.closest('[data-r]'); setHover(c ? rackById[c.dataset.r] : null); };
  }

  // ------------------------------------------------------------------ search
  const index = [];
  racks.forEach(r => index.push({ kind: 'rack', label: r.id, sub: r.name, hay: (r.id + ' ' + r.name + ' rack').toLowerCase(), go: () => openRack(r) }));
  racks.forEach(r => r.items.forEach(it => {
    if (it.kind === 'device') index.push({ kind: it.type, label: it.label, sub: r.id + ' ' + fmtRange(it), hay: (it.label + ' ' + it.type + ' ' + r.id).toLowerCase(), go: () => openRack(r, { focus: it }) });
    else if (it.kind === 'utp' || it.kind === 'lc') index.push({ kind: it.kind === 'utp' ? 'panel' : 'fiber', label: r.id + ' ' + it.id, sub: itemName(it), hay: (r.id + ' ' + it.id + ' ' + r.id + '#' + it.id + ' ' + r.id + it.id + ' ' + (it.kind === 'utp' ? 'utp patch panel ' + (it.role || '') : 'lc fiber tray cassette')).toLowerCase(), go: () => openRack(r, { focus: it }) });
  }));
  (DATA.externals || []).forEach(e => index.push({ kind: e.type, label: e.id, sub: 'not in any rack', hay: (e.id + ' ' + (e.label || '') + ' ' + e.type).toLowerCase(), go: () => { if (state.mode !== 'room') goRoom(); showExtCard(e); } }));
  cables.forEach(c => index.push({ kind: 'cable', label: c.id, sub: cableSummary(c), hay: (c.id + ' cable').toLowerCase(), go: () => traceCable(c) }));

  let results = [], resIdx = 0;
  const qEl = $('#q'), resEl = $('#results');
  function hideResults() { resEl.hidden = true; }
  function runSearch() {
    const q = qEl.value.trim().toLowerCase();
    if (!q) { hideResults(); return; }
    const toks = q.replace(/#/g, ' ').split(/\s+/).filter(Boolean);
    results = index.filter(e => toks.every(t => e.hay.includes(t)));
    const rank = e => e.label.toLowerCase() === q ? 0 : e.label.toLowerCase().startsWith(toks[0]) ? 1 : e.kind === 'cable' ? 3 : 2;
    results.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
    results = results.slice(0, 14);
    resIdx = 0;
    resEl.innerHTML = results.length
      ? results.map((e, i) => '<li data-i="' + i + '" class="' + (i === 0 ? 'on' : '') + '"><span class="badge mute">' + esc(e.kind) + '</span><b>' + esc(e.label) + '</b><small>' + esc(e.sub) + '</small></li>').join('')
      : '<li class="empty">No match: “' + esc(qEl.value.trim()) + '” is not in any rack or cable of this model.</li>';
    resEl.hidden = false;
  }
  function choose(i) {
    const e = results[i];
    if (!e) return;
    hideResults();
    qEl.blur();
    e.go();
  }
  qEl.addEventListener('input', runSearch);
  qEl.addEventListener('focus', () => { if (qEl.value.trim()) runSearch(); });
  qEl.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      resIdx = (resIdx + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      $$('li', resEl).forEach((li, i) => li.classList.toggle('on', i === resIdx));
      const on = $('li.on', resEl); if (on) on.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { e.preventDefault(); choose(resIdx); }
    else if (e.key === 'Escape') { e.stopPropagation(); hideResults(); qEl.blur(); }
  });
  resEl.addEventListener('mousedown', e => { const li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); choose(+li.dataset.i); } });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('#search')) hideResults(); });

  // ------------------------------------------------------------------ layers panel & top bar
  function renderLayers() {
    let html = '', grp = null;
    LAYER_DEFS.forEach(d => {
      if (d.group !== grp) { grp = d.group; html += '<div class="layer-group">' + esc(grp) + '</div>'; }
      html += '<label class="layer"><input type="checkbox" data-layer="' + d.id + '"' + (state.layers.has(d.id) ? ' checked' : '') + '><span class="dot" style="background:' + d.color + '"></span>' + esc(d.label) + '<span class="count">' + (layerCount[d.id] != null ? layerCount[d.id] : 0) + '</span></label>';
    });
    $('#layerList').innerHTML = html;
  }
  $('#layerList').addEventListener('change', e => {
    const id = e.target.dataset.layer;
    if (!id) return;
    if (e.target.checked) state.layers.add(id); else state.layers.delete(id);
    $$('#levels button').forEach(b => b.classList.toggle('on', LEVELS[b.dataset.level].length === state.layers.size && LEVELS[b.dataset.level].every(x => state.layers.has(x))));
    applyVisibility();
  });
  $('#layersToggle').onclick = () => { const p = $('#layers'); p.classList.toggle('collapsed'); $('#layersToggle').setAttribute('aria-expanded', String(!p.classList.contains('collapsed'))); };
  if (innerWidth < 760) $('#layers').classList.add('collapsed');
  function setLevel(l) {
    state.level = l;
    state.layers = new Set(LEVELS[l]);
    $$('#levels button').forEach(b => b.classList.toggle('on', b.dataset.level === l));
    renderLayers();
    applyVisibility();
  }
  $('#levels').onclick = e => { const b = e.target.closest('[data-level]'); if (b) setLevel(b.dataset.level); };
  $('#rowButtons').innerHTML = rows.map(R => '<button data-row="' + esc(R.key) + '">' + esc(R.name) + '</button>').join('');
  $('#rowButtons').onclick = e => { const b = e.target.closest('[data-row]'); if (b) openRow(rows.find(R => R.key === b.dataset.row), 'front'); };
  $('#views').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'racks') showRacksMenu();
    else if (a === 'aisle') openAisle();
    else if (a === 'walk') { if (state.mode !== 'walk') { pushMode(); setMode('walk', { walkIdx: 0 }); } }
    else if (a === 'tour') startTour();
    else if (a === 'occupancy') showOccupancy();
    else if (a === 'power') showPower();
    else if (a === 'fit') showFit();
    else if (a === 'import') showImport();
    else if (a === 'shopping') showShopping();
    else if (a === 'notes') showNotes();
  });
  if (DATA.meta && DATA.meta.title) $('#dataset').textContent = DATA.meta.title;

  function updateHint() {
    const h = {
      room: 'Click a rack to open it · drag to orbit, right-drag to pan · <kbd>/</kbd> search',
      rack: 'Click a port to trace its cable · double-click an item to inspect · <kbd>←</kbd><kbd>→</kbd> racks · <kbd>Esc</kbd> back',
      row: 'Front or rear elevation · click a rack to open it · <kbd>Esc</kbd> back',
      aisle: '<kbd>←</kbd><kbd>→</kbd> walk along the aisle · <kbd>Esc</kbd> back',
      walk: '<kbd>Space</kbd> pause · <kbd>←</kbd><kbd>→</kbd> previous / next rack · <kbd>Esc</kbd> exit',
      tour: '<kbd>Space</kbd> pause · <kbd>←</kbd><kbd>→</kbd> previous / next rack · <kbd>Esc</kbd> exit',
      trace: '<kbd>←</kbd><kbd>→</kbd> stop by stop · <kbd>Space</kbd> walk it · <kbd>Esc</kbd> exit',
    };
    $('#hint').innerHTML = h[state.mode] || '';
  }

  // ------------------------------------------------------------------ keyboard & resize
  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
    if (e.key === 'Escape') { if (!typing) { e.preventDefault(); back(); } return; }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); qEl.focus(); return; }
    if (studio.open || !$('#modal').hidden) return;
    const m = state.mode;
    if (m === 'rack' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); stepRack(e.key === 'ArrowRight' ? 1 : -1); }
    else if (m === 'aisle' && /^Arrow/.test(e.key)) {
      e.preventDefault();
      const d = (e.key === 'ArrowRight' || e.key === 'ArrowUp') ? 0.3 : -0.3;
      moveAisle(d, 0);
    } else if (m === 'walk') {
      if (e.key === ' ') { e.preventDefault(); walk.paused = !walk.paused; walkBar(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); walkJump(e.key === 'ArrowRight' ? 1 : -1); }
    } else if (m === 'trace') {
      if (e.key === ' ') { e.preventDefault(); $('#modebar [data-k="play"]').click(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); $('#modebar [data-k="' + (e.key === 'ArrowRight' ? 'next' : 'prev') + '"]').click(); }
    } else if (m === 'tour') {
      if (e.key === ' ') { e.preventDefault(); tour.paused = !tour.paused; tourBar(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); tourGo(tour.i + (e.key === 'ArrowRight' ? 1 : -1)); }
    }
  });
  function fitPanels() {
    const tb = $('#topbar').getBoundingClientRect();
    document.documentElement.style.setProperty('--top', Math.round(tb.bottom + 12) + 'px');
  }
  // the card sits above the mode bar on narrow screens, whatever its height (0 while it is hidden)
  new ResizeObserver(() => document.documentElement.style.setProperty('--mb', Math.round($('#modebar').getBoundingClientRect().height) + 'px')).observe($('#modebar'));
  fitPanels();
  window.addEventListener('resize', () => {
    fitPanels();
    renderer.setSize(innerWidth, innerHeight);
    labelRenderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    if (studio.cam) { studio.cam.aspect = camera.aspect; studio.cam.updateProjectionMatrix(); studio.labels.setSize(innerWidth, innerHeight); }
    if (state.mode === 'row') { const c = rowCam(state.row, state.face); flyTo(c.pos, c.target, c.fov, 0); }
    invalidate();
  });
  document.addEventListener('visibilitychange', invalidate);
  document.body.dataset.mode = state.mode;

  // ------------------------------------------------------------------ start
  renderLayers();
  const nc = observations().filter(n => n.sev !== 'info').length;
  $('#notesCount').textContent = nc ? String(nc) : '';
  const rc = roomCam();
  camera.position.copy(rc.pos);
  controls.target.copy(rc.target);
  controls.update();
  applyVisibility();
  updateHint();
  loop();

  // Small read-only handle for debugging from the console.
  window.racks3d = { state, rows, aisles, renderer, scene, camera, stats: () => racks.map(r => [r.id, rackStats(r)]), shopping, observations };
})();
