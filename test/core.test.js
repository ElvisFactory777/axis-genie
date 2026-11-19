'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../src/core.js');

function clock(start = 1.7e12) { let t = start; const f = () => t; f.advance = (ms) => { t += ms; }; return f; }
async function seeded() {
  const clk = clock(); const store = new C.MemoryStore(); const L = new C.Ledger({ store, clock: clk });
  const obs = await L.append({ source: 'devicemotion', class: 'OBSERVED', kind: 'motion.sample', data: { g: 1 } });
  const der = await L.append({ source: 'calc', class: 'DERIVED', kind: 'feat', data: { peak: 1 }, provenance: [obs.id], confidence: 1 });
  return { L, store, clk, obs, der };
}
const rejects = (p, rule) => assert.rejects(p, (e) => { assert.equal(e.name, 'FirewallError'); if (rule) assert.equal(e.rule, rule); return true; });

test('sha256 matches node:crypto', () => {
  for (const s of ['', 'abc', 'é✓🙂', 'x'.repeat(10000)]) assert.equal(C.sha256(s), crypto.createHash('sha256').update(s).digest('hex'));
});

test('canonical JSON is key-order independent', () => {
  assert.equal(C.canonical({ b: 1, a: [1, { d: 2, c: 3 }] }), C.canonical({ a: [1, { c: 3, d: 2 }], b: 1 }));
});

test.describe('epistemic firewall', () => {
  test('INFERRED without provenance is rejected', async () => {
    const { L } = await seeded();
    await rejects(L.append({ source: 'x', class: 'INFERRED', kind: 'h', data: { alternatives: ['a'] }, confidence: 0.5 }), 'F7');
  });
  test('INFERRED citing only INFERRED is rejected', async () => {
    const { L, der } = await seeded();
    const inf = await L.append({ source: 'x', class: 'INFERRED', kind: 'h', data: { alternatives: ['a'] }, provenance: [der.id], confidence: 0.6 });
    await rejects(L.append({ source: 'x', class: 'INFERRED', kind: 'h2', data: { alternatives: ['a'] }, provenance: [inf.id], confidence: 0.6 }), 'F7');
  });
  test('INFERRED citing SPECULATIVE is rejected even with grounded support', async () => {
    const { L, obs } = await seeded();
    const sp = await L.append({ source: 'x', class: 'SPECULATIVE', kind: 's', provenance: [obs.id], confidence: 0.2 });
    await rejects(L.append({ source: 'x', class: 'INFERRED', kind: 'h', data: { alternatives: ['a'] }, provenance: [obs.id, sp.id], confidence: 0.6 }), 'F7');
  });
  test('INFERRED must list alternatives and have 0<c<1', async () => {
    const { L, der } = await seeded();
    await rejects(L.append({ source: 'x', class: 'INFERRED', kind: 'h', data: {}, provenance: [der.id], confidence: 0.6 }), 'F7');
    await rejects(L.append({ source: 'x', class: 'INFERRED', kind: 'h', data: { alternatives: ['a'] }, provenance: [der.id], confidence: 1 }), 'F3');
    await rejects(L.append({ source: 'x', class: 'INFERRED', kind: 'h', data: { alternatives: ['a'] }, provenance: [der.id] }), 'F3');
  });
  test('valid INFERRED citing DERIVED is accepted', async () => {
    const { L, der, obs } = await seeded();
    const inf = await L.append({ source: 'x', class: 'INFERRED', kind: 'h', data: { alternatives: ['a'] }, provenance: [der.id, obs.id], confidence: 0.7 });
    assert.equal(inf.class, 'INFERRED');
    assert.deepEqual(L.groundTruthOf(inf.id), [obs.id]);
  });
  test('nothing can be upgraded to OBSERVED', async () => {
    const { L, der, obs } = await seeded();
    const inf = await L.append({ source: 'x', class: 'INFERRED', kind: 'h', data: { alternatives: ['a'] }, provenance: [der.id], confidence: 0.7 });
    // OBSERVED with provenance (i.e. computed from something) is rejected
    await rejects(L.append({ source: 'x', class: 'OBSERVED', kind: 'o', provenance: [inf.id] }), 'F5');
    await rejects(L.append({ source: 'x', class: 'OBSERVED', kind: 'o', provenance: [obs.id] }), 'F5');
    // OBSERVED superseding an INFERRED/DERIVED (relabel) is rejected
    await rejects(L.append({ source: 'x', class: 'OBSERVED', kind: 'o', supersedes: inf.id }), 'F9');
    await rejects(L.append({ source: 'x', class: 'OBSERVED', kind: 'o', supersedes: der.id }), 'F9');
    // DERIVED superseding INFERRED is also a reclass -> rejected
    await rejects(L.append({ source: 'x', class: 'DERIVED', kind: 'd', provenance: [obs.id], supersedes: inf.id }), 'F9');
  });
  test('DERIVED may not cite INFERRED (no laundering)', async () => {
    const { L, der } = await seeded();
    const inf = await L.append({ source: 'x', class: 'INFERRED', kind: 'h', data: { alternatives: ['a'] }, provenance: [der.id], confidence: 0.7 });
    await rejects(L.append({ source: 'x', class: 'DERIVED', kind: 'd', provenance: [inf.id] }), 'F6');
    await rejects(L.append({ source: 'x', class: 'DERIVED', kind: 'd' }), 'F6');
  });
  test('unknown class, missing source, bad confidence, SPECULATIVE > 0.5', async () => {
    const { L, obs } = await seeded();
    await rejects(L.append({ source: 'x', class: 'FACT', kind: 'k' }), 'F1');
    await rejects(L.append({ source: '', class: 'UNKNOWN', kind: 'k' }), 'F2');
    await rejects(L.append({ source: 'x', class: 'UNKNOWN', kind: 'k', confidence: 1.5 }), 'F3');
    await rejects(L.append({ source: 'x', class: 'SPECULATIVE', kind: 'k', provenance: [obs.id], confidence: 0.9 }), 'F3');
  });
  test('rejected appends leave the ledger untouched', async () => {
    const { L, store } = await seeded();
    const head = L.head;
    await rejects(L.append({ source: 'x', class: 'INFERRED', kind: 'h', data: { alternatives: ['a'] }, confidence: 0.5 }));
    assert.equal(L.size, 2); assert.equal(L.head, head); assert.equal(await store.count(), 2);
    // and the queue keeps working afterwards
    await L.append({ source: 'x', class: 'UNKNOWN', kind: 'k' });
    assert.equal(L.size, 3);
  });
});

test.describe('provenance integrity', () => {
  test('unknown, duplicate, and self provenance ids are rejected', async () => {
    const { L, obs } = await seeded();
    await rejects(L.append({ source: 'x', class: 'DERIVED', kind: 'd', provenance: ['nope'] }), 'F4');
    await rejects(L.append({ source: 'x', class: 'DERIVED', kind: 'd', provenance: [obs.id, obs.id] }), 'F4');
  });
  test('tampering with stored data is detected on reload', async () => {
    const { store } = await seeded();
    store.rows[0].data.g = 99; // simulate on-disk tampering
    const L2 = new C.Ledger({ store });
    await assert.rejects(L2.boot(), /hash mismatch/);
    assert.equal(L2.size, 0);
  });
  test('forward reference (citing a later entry) is rejected on import', async () => {
    const { L } = await seeded();
    const ex = L.exportJSON();
    const swapped = ex.entries.map((e) => ({ ...e }));
    [swapped[0].seq, swapped[1].seq] = [1, 0];
    await assert.rejects(new C.Ledger().loadVerified(swapped), /integrity|firewall/);
  });
  test('verify() passes on an intact ledger and reports head', async () => {
    const { L } = await seeded();
    const v = L.verify(); assert.equal(v.ok, true); assert.equal(v.count, 2); assert.equal(v.head, L.head);
  });
});

test.describe('append-only behaviour', () => {
  test('entries are frozen and the ledger exposes no update/delete-one API', async () => {
    const { L, obs } = await seeded();
    assert.throws(() => { 'use strict'; obs.data.g = 2; }, TypeError);
    assert.throws(() => { 'use strict'; obs.class = 'INFERRED'; }, TypeError);
    for (const m of ['update', 'delete', 'remove', 'set', 'put', 'edit']) assert.equal(typeof L[m], 'undefined');
    // entries() returns a copy; mutating it does not change the ledger
    const arr = L.entries(); arr.pop(); assert.equal(L.size, 2);
  });
  test('hash chain links every entry to its predecessor', async () => {
    const { L } = await seeded();
    const es = L.entries();
    assert.equal(es[0].prevHash, C.GENESIS);
    assert.equal(es[1].prevHash, es[0].hash);
    assert.deepEqual(es.map((e) => e.seq), [0, 1]);
  });
  test('store refuses to overwrite an existing seq', async () => {
    const { store, L } = await seeded();
    await assert.rejects(store.add({ ...L.entries()[0] }));
  });
  test('supersession is append-only: original remains, marked superseded, cannot be superseded twice', async () => {
    const { L, der, obs } = await seeded();
    const a = await L.append({ source: 'x', class: 'INFERRED', kind: 'h', data: { alternatives: ['a'], v: 1 }, provenance: [der.id], confidence: 0.6 });
    const b = await L.append({ source: 'x', class: 'INFERRED', kind: 'h', data: { alternatives: ['a'], v: 2 }, provenance: [der.id, obs.id], confidence: 0.8, supersedes: a.id });
    assert.equal(L.get(a.id).data.v, 1);
    assert.equal(L.status(a), 'superseded'); assert.equal(L.supersededBy(a.id), b.id);
    await rejects(L.append({ source: 'x', class: 'INFERRED', kind: 'h', data: { alternatives: ['a'] }, provenance: [der.id], confidence: 0.6, supersedes: a.id }), 'F9');
  });
  test('concurrent appends are serialized into a consistent chain', async () => {
    const L = new C.Ledger({ store: new C.MemoryStore(), clock: clock() });
    await Promise.all(Array.from({ length: 20 }, (_, i) => L.append({ source: 's', class: 'OBSERVED', kind: 'k', data: { i } })));
    assert.equal(L.size, 20); assert.equal(L.verify().ok, true);
  });
  test('export -> import round trip verifies; import into a non-empty ledger is refused', async () => {
    const { L } = await seeded();
    const json = JSON.parse(JSON.stringify(L.exportJSON()));
    const L2 = new C.Ledger({ store: new C.MemoryStore() });
    assert.equal(await L2.loadVerified(json.entries, true), 2);
    assert.equal(L2.head, L.head); assert.equal(await L2.store.count(), 2);
    await assert.rejects(L2.loadVerified(json.entries), /empty ledger/);
  });
  test('wipe deletes everything and returns a verified receipt', async () => {
    const { L, store } = await seeded();
    const head = L.head;
    const r = await L.wipe();
    assert.equal(r.verified, true); assert.equal(r.deletedCount, 2); assert.equal(r.headBefore, head);
    assert.equal(r.postCount, 0); assert.equal(await store.count(), 0); assert.equal(L.size, 0);
    assert.match(r.receiptHash, /^[0-9a-f]{64}$/);
  });
});

test.describe('expiry and staleness', () => {
  test('fresh -> stale -> expired over time', async () => {
    const clk = clock(); const L = new C.Ledger({ clock: clk });
    const e = await L.append({ source: 's', class: 'OBSERVED', kind: 'k', freshness: 1000, expiry: clk() + 5000 });
    assert.equal(L.status(e), 'fresh');
    clk.advance(1001); assert.equal(L.status(e), 'stale');
    clk.advance(4000); assert.equal(L.status(e), 'expired');
    assert.equal(C.statusOf(e, e.ts), 'fresh');
  });
  test('class defaults are applied', async () => {
    const clk = clock(); const L = new C.Ledger({ clock: clk });
    const e = await L.append({ source: 's', class: 'OBSERVED', kind: 'k' });
    assert.equal(e.freshness, C.DEFAULTS_BY_CLASS.OBSERVED.freshness);
    assert.equal(e.expiry, e.ts + C.DEFAULTS_BY_CLASS.OBSERVED.ttl);
    assert.equal(e.confidence, 1); assert.equal(e.supersedes, null);
  });
  test('citing an expired entry is rejected; invalid freshness/expiry rejected', async () => {
    const clk = clock(); const L = new C.Ledger({ clock: clk });
    const e = await L.append({ source: 's', class: 'OBSERVED', kind: 'k', expiry: clk() + 100 });
    clk.advance(200);
    await rejects(L.append({ source: 'd', class: 'DERIVED', kind: 'd', provenance: [e.id] }), 'F8');
    await rejects(L.append({ source: 's', class: 'OBSERVED', kind: 'k', freshness: 0 }), 'F10');
    await rejects(L.append({ source: 's', class: 'OBSERVED', kind: 'k', expiry: clk() - 1 }), 'F10');
  });
  test('timestamps are monotonic even if the clock goes backwards', async () => {
    const clk = clock(); const L = new C.Ledger({ clock: clk });
    const a = await L.append({ source: 's', class: 'OBSERVED', kind: 'k' });
    clk.advance(-5000);
    const b = await L.append({ source: 's', class: 'OBSERVED', kind: 'k' });
    assert.ok(b.ts >= a.ts);
  });
});

test.describe('ring buffer', () => {
  test('keeps the most recent N items in order', () => {
    const r = new C.RingBuffer(3);
    [1, 2, 3, 4, 5].forEach((x) => r.push(x));
    assert.deepEqual(r.toArray(), [3, 4, 5]); assert.equal(r.last(), 5); assert.equal(r.length, 3);
    r.clear(); assert.deepEqual(r.toArray(), []);
  });
});

test.describe('detector on synthetic traces', () => {
  test('1 m drop: one drop event, free fall and peak measured, high confidence', () => {
    const tr = C.synth.drop({ heightM: 1 });
    const ev = C.detect(tr);
    assert.equal(ev.length, 1); assert.equal(ev[0].type, 'drop');
    assert.ok(ev[0].freefallMs > 400 && ev[0].freefallMs < 470, String(ev[0].freefallMs));
    assert.ok(ev[0].peakG > 4.5);
    const a = C.analyzeWindow(C.windowFor(tr, ev[0].tImpact));
    assert.ok(a.features.estDropHeightM > 0.8 && a.features.estDropHeightM < 1.1);
    assert.equal(a.features.cameToRest, true);
    assert.ok(a.interpretation.confidence >= 0.8 && a.interpretation.confidence < 1);
    assert.ok(a.interpretation.alternatives.length >= 3);
  });
  test('short (20 cm) drop is detected with lower confidence than a 1 m drop', () => {
    const hi = C.analyzeWindow(C.synth.drop({ heightM: 1, preMs: 1500, postMs: 1500 }));
    const lo = C.analyzeWindow(C.synth.drop({ heightM: 0.2, preMs: 1500, postMs: 1500 }));
    assert.equal(lo.event.type, 'drop');
    assert.ok(lo.interpretation.confidence < hi.interpretation.confidence);
  });
  test('walking produces no events (several seeds)', () => {
    for (let s = 1; s <= 10; s++) assert.deepEqual(C.detect(C.synth.walk({ seed: s, ms: 20000 })), []);
  });
  test('stillness produces no events', () => {
    assert.deepEqual(C.detect(C.synth.still({ ms: 30000 })), []);
  });
  test('below-threshold free fall (3 cm) is not a drop', () => {
    assert.deepEqual(C.detect(C.synth.drop({ heightM: 0.03 })).filter((e) => e.type === 'drop'), []);
  });
  test('caught phone (no impact spike) produces no drop', () => {
    assert.deepEqual(C.detect(C.synth.drop({ caught: true })), []);
  });
  test('isolated spike without free fall is an impact, not a drop', () => {
    const tr = C.synth.still({ ms: 4000 });
    tr[120] = { ...tr[120], az: -4.5 * C.G };
    const ev = C.detect(tr);
    assert.equal(ev.length, 1); assert.equal(ev[0].type, 'impact');
    const a = C.analyzeWindow(C.windowFor(tr, ev[0].tImpact));
    assert.match(a.interpretation.hypothesis, /struck|knocked/);
  });
  test('thresholds are explicit parameters (raising impactG suppresses the drop)', () => {
    const tr = C.synth.drop({ peakG: 3 });
    assert.equal(C.detect(tr).length, 1);
    assert.equal(C.detect(tr, { ...C.DEFAULT_PARAMS, impactG: 3.5, impactAloneG: 9 }).length, 0);
  });
  test('two drops separated by more than the refractory period are both found', () => {
    const a = C.synth.drop({ t0: 1.7e12 }); const last = a[a.length - 1].t;
    const b = C.synth.drop({ t0: last + 17, seed: 9 });
    assert.equal(C.detect(a.concat(b)).length, 2);
  });
  test('data gap lowers confidence', () => {
    const tr = C.synth.drop({ preMs: 1500, postMs: 1500 });
    const base = C.analyzeWindow(tr).interpretation.confidence;
    const gapped = tr.filter((s, i) => i < 20 || i > 40);
    const g = C.analyzeWindow(gapped);
    assert.equal(g.features.dataGap, true);
    assert.ok(g.interpretation.confidence < base);
  });
});

test.describe('pipeline + replay determinism', () => {
  async function recorded(n = 3) {
    const L = new C.Ledger({ store: new C.MemoryStore(), clock: clock() });
    for (let i = 0; i < n; i++) {
      const tr = C.synth.drop({ seed: 10 + i, heightM: 0.3 + 0.3 * i, t0: 1.7e12 + i * 1e5 });
      const ev = C.detect(tr)[0];
      const r = await C.recordEvent(L, { samples: C.windowFor(tr, ev.tImpact), source: 'simulator', synthetic: true, context: { headingDeg: 12 } });
      assert.ok(r);
      assert.deepEqual(r.inferred.provenance, [r.derived.id, r.observed.id]);
    }
    return L;
  }
  test('recordEvent writes OBSERVED -> DERIVED -> INFERRED with correct classes', async () => {
    const L = await recorded(1);
    assert.deepEqual(L.entries().map((e) => e.class), ['OBSERVED', 'DERIVED', 'INFERRED']);
    assert.equal(L.verify().ok, true);
  });
  test('recordEvent returns null when nothing is detected (nothing written)', async () => {
    const L = new C.Ledger();
    assert.equal(await C.recordEvent(L, { samples: C.synth.still({ ms: 3000 }) }), null);
    assert.equal(L.size, 0);
  });
  test('replay from OBSERVED reproduces every DERIVED and INFERRED entry', async () => {
    const L = await recorded(3);
    const r = C.replay(L);
    assert.equal(r.checked, 3); assert.equal(r.matched, 3);
  });
  test('replay is identical after export/JSON/import round trip and repeated runs', async () => {
    const L = await recorded(3);
    const L2 = new C.Ledger();
    await L2.loadVerified(JSON.parse(JSON.stringify(L.exportJSON())).entries);
    const a = C.replay(L), b = C.replay(L2), c = C.replay(L2);
    assert.equal(C.canonical(a), C.canonical(b)); assert.equal(C.canonical(b), C.canonical(c));
    assert.equal(b.matched, 3);
  });
  test('replay flags a ledger whose interpretation does not follow from its observations', async () => {
    // Build a ledger by hand where the INFERRED claims something the OBSERVED window does not support.
    const L = new C.Ledger({ clock: clock() });
    const tr = C.synth.drop({ preMs: 1500, postMs: 1500 });
    const a = C.analyzeWindow(tr);
    const o = await L.append({ source: 'devicemotion', class: 'OBSERVED', kind: 'motion.window', data: { samples: tr } });
    const d = await L.append({ source: 'detector', class: 'DERIVED', kind: 'motion.features', data: { features: a.features, params: C.DEFAULT_PARAMS }, provenance: [o.id] });
    await L.append({ source: 'interp', class: 'INFERRED', kind: 'event.interpretation', data: { ...a.interpretation, confidence: 0.95 }, provenance: [d.id], confidence: 0.95 });
    const r = C.replay(L);
    assert.equal(r.matched, 0); assert.match(r.results[0].problems.join(';'), /interpretation differs/);
  });
});

test('index.html inlines exactly the tested core module', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const core = fs.readFileSync(path.join(__dirname, '..', 'src', 'core.js'), 'utf8');
  assert.ok(html.includes(core), 'index.html is out of date: run node build.js');
  assert.ok(!/<script[^>]+src=|<link[^>]+href="https?:/i.test(html), 'no external scripts/styles');
});
