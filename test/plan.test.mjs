// Checks on the sample data and on the planning helpers in js/plan.js.
// Run with:  node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const P = require('../js/plan.js');

// data/sample-data.js is a classic script that sets window.DC_DATA
function loadSample() {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../data/sample-data.js', import.meta.url), 'utf8'), ctx);
  return JSON.parse(JSON.stringify(ctx.window.DC_DATA));   // out of the vm realm, so deepEqual compares plain objects
}
const clone = (x) => JSON.parse(JSON.stringify(x));
const sample = loadSample();

test('the sample data has no errors and no warnings', () => {
  const { errors, warnings } = P.validate(sample);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('every rack fits in 42U and every free run is inside it', () => {
  for (const r of sample.racks) {
    const L = P.layout(r);
    assert.equal(L.overflow, 0, r.id);
    assert.equal(L.slots.reduce((s, x) => s + x.u, 0), P.RACK_U, `${r.id} accounts for every U`);
    for (const run of P.freeRuns(r)) assert.ok(run.top <= P.RACK_U && run.bottom >= 1 && run.top - run.bottom + 1 === run.u, `${r.id} ${JSON.stringify(run)}`);
  }
});

test('validation catches the mistakes it is there for', () => {
  const cases = [
    ['a rack over 42U', (d) => d.racks[0].items.push({ kind: 'gap', u: 40 }), /more than its 42U/],
    ['a device label used twice', (d) => {
      const dev = d.racks.flatMap((r) => r.items).find((it) => it.kind === 'device');
      d.racks[1].items.unshift({ ...dev });
    }, /appears twice/],
    ['a hop on a panel that does not exist', (d) => { d.cables[0].hops[0] = 'R9-99#P1:1'; }, /does not exist/],
    ['a hop past the last port', (d) => { d.cables[0].hops[0] = d.cables[0].hops[0].replace(/:\d+$/, ':99'); }, /not a port/],
    ['two cables on one port', (d) => { d.cables[1].hops = [d.cables[0].hops[0]]; }, /used by both/],
    ['a cable to an unknown device', (d) => { d.cables[0].a.item = 'SRV-NOWHERE'; }, /not a device/],
    ['a trunk to an unknown panel', (d) => { d.trunks[0].b = 'R1-01#P42'; }, /does not exist/],
    ['a row with an unknown rack', (d) => { d.rows['1'].push('R7-77'); }, /does not exist/],
  ];
  for (const [name, breakIt, expect] of cases) {
    const d = clone(sample);
    breakIt(d);
    const { errors } = P.validate(d);
    assert.ok(errors.some((e) => expect.test(e)), `${name}: ${errors.join(' | ') || 'no error'}`);
  }
});

test('power: watts follow the type and size, and can be overridden', () => {
  assert.equal(P.watts({ kind: 'device', type: 'server', u: 2 }), 2 * P.TYPE_WATTS.server);
  assert.equal(P.watts({ kind: 'device', type: 'switch', u: 1 }), P.TYPE_WATTS.switch);
  assert.equal(P.watts({ kind: 'device', type: 'switch', watts: 75 }), 75);
  assert.equal(P.watts({ kind: 'utp' }), 0);
  const rack = { id: 'X', powerKw: 2, items: [{ kind: 'device', label: 'A', type: 'server', u: 2 }, { kind: 'device', label: 'B', type: 'storage', u: 2 }] };
  const p = P.rackPower(rack, {});
  assert.equal(p.w, 2 * 280 + 2 * 380);
  assert.equal(p.feedA + p.feedB, p.w);
  assert.equal(p.status, 'ok');
  assert.ok(p.exhaustC > p.inletC);
  rack.powerKw = 1;
  assert.equal(P.rackPower(rack, {}).status, 'over');
});

test('power: the sample has racks in every state but none over budget, and heat rises with load', () => {
  const all = sample.racks.map((r) => P.rackPower(r, sample));
  assert.ok(all.every((p) => p.status !== 'over'));
  assert.ok(all.some((p) => p.status === 'high'), 'some rack near its budget, so the heat map has something to show');
  const byLoad = all.slice().sort((a, b) => a.w - b.w);
  for (let i = 1; i < byLoad.length; i++) if (byLoad[i].budget === byLoad[i - 1].budget) assert.ok(byLoad[i].exhaustC >= byLoad[i - 1].exhaustC);
});

test('where does it fit: a small device fits somewhere, a 43U one nowhere', () => {
  const small = P.findFit(sample, { u: 1, copper: 1, fiber: 0, watts: 100 });
  assert.equal(small.length, sample.racks.length);
  assert.ok(small.some((x) => x.status === 'fits'));
  assert.equal(small[0].status, 'fits', 'racks that fit come first');
  assert.ok(P.findFit(sample, { u: 43 }).every((x) => x.status === 'no'));
});

test('where does it fit: missing ports become panels or cassettes to add, and power can rule a rack out', () => {
  const rack = { id: 'T1', items: [{ kind: 'utp', id: 'P1', role: 'trunk' }, { kind: 'lc', id: 'F1', cassettes: [{ medium: 'mm' }, null, null, null] }] };
  const data = { racks: [rack], rows: { 1: ['T1'] }, cables: [], trunks: [], power: { rackKw: 1 } };
  const [ok] = P.findFit(data, { u: 2, copper: 10, fiber: 4, medium: 'mm', watts: 300 });
  assert.equal(ok.status, 'fits');
  const [cu] = P.findFit(data, { u: 2, copper: 30, watts: 300 });
  assert.equal(cu.status, 'add');
  assert.match(cu.add.join(), /UTP panel/);
  const [sm] = P.findFit(data, { u: 1, fiber: 2, medium: 'sm', watts: 100 });
  assert.equal(sm.status, 'add');
  assert.match(sm.add.join(), /SM cassette in an empty slot/);
  const [hot] = P.findFit(data, { u: 1, watts: 1500 });
  assert.equal(hot.status, 'no');
  assert.match(hot.why.join(), /exceed/);
});

test('CSV: the sample goes out and comes back with every item in the same U', () => {
  const { data, errors } = P.fromCsv(P.toCsv(sample), 'round trip');
  assert.deepEqual(errors, []);
  assert.deepEqual(P.validate(data).errors, []);
  assert.equal(data.racks.length, sample.racks.length);
  const pos = (d) => d.racks.flatMap((r) => P.layout(r).slots.filter((s) => s.it.kind !== 'gap').map((s) => `${r.id} ${s.top} ${s.it.kind} ${s.it.label || s.it.id || ''}`));
  assert.deepEqual(pos(data), pos(sample));
});

test('CSV: a hand-written inventory is read, and mistakes are reported by line', () => {
  const csv = [
    'rack,row,rack_name,u_top,kind,label,type,u,ports,uplinks,uplink_medium',
    'A1,1,Lab,42,utp,P1,,,,,',
    'A1,1,Lab,40,device,SW-LAB-01,switch,1,24,2,mm',
    'A1,1,Lab,30,device,SRV-LAB-01,server,2,2,,',
    'A2,1,Empty,,,,,,,,',
  ].join('\n');
  const { data, errors } = P.fromCsv(csv);
  assert.deepEqual(errors, []);
  assert.deepEqual(data.rows, { 1: ['A1', 'A2'] });
  const a1 = P.layout(data.racks[0]).slots.filter((s) => s.it.kind !== 'gap').map((s) => [s.top, s.it.label || s.it.id]);
  assert.deepEqual(a1, [[42, 'P1'], [40, 'SW-LAB-01'], [30, 'SRV-LAB-01']]);
  assert.equal(P.freeRuns(data.racks[1])[0].u, 42);

  const bad = P.fromCsv('rack,u_top,kind,label,type,u\nB1,10,device,X,server,2\nB1,10,device,Y,server,1\nB1,50,device,Z,server,1\nB1,5,shelf,,,');
  assert.equal(bad.errors.length, 3, bad.errors.join(' | '));
  assert.deepEqual(bad.errors.map((e) => +/Line (\d+)/.exec(e)[1]), [3, 4, 5], 'in line order');
  assert.ok(bad.errors.some((e) => /Line 3.*overlaps/.test(e)));
  assert.ok(bad.errors.some((e) => /Line 4.*u_top/.test(e)));
  assert.ok(bad.errors.some((e) => /Line 5.*unknown kind/.test(e)));
  assert.match(P.fromCsv('name,size\nx,1').errors.join(), /Missing column "rack"/);
});

test('where does it fit: star centers come after the other racks that fit', () => {
  const res = P.findFit(sample, { u: 1, copper: 1, watts: 100 });
  const fits = res.filter((x) => x.status === 'fits');
  const star = (r) => (Array.isArray(r.starCenter) ? r.starCenter.length : !!r.starCenter);
  const firstStar = fits.findIndex((x) => star(x.rack));
  assert.ok(firstStar > 0 && fits.slice(firstStar).every((x) => star(x.rack)), fits.map((x) => x.rack.id).join(' '));
});
