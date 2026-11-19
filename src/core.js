/* AXIS genie-mvp core: ledger, epistemic firewall, detector, interpretation, replay.
 * Pure JS, no dependencies. Runs in Node (CommonJS) and in the browser (window.GenieCore).
 * Nothing in this module does I/O; persistence is injected as a "store" adapter. */
(function (root, factory) {
  var m = factory();
  if (typeof module === 'object' && module.exports) module.exports = m;
  else root.GenieCore = m;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '0.1.0';
  var G = 9.80665;
  var CLASSES = Object.freeze(['OBSERVED', 'DERIVED', 'INFERRED', 'SPECULATIVE', 'UNKNOWN']);
  var GENESIS = '0'.repeat(64);

  // ---------------------------------------------------------------- utilities
  function round(x, d) { var p = Math.pow(10, d == null ? 4 : d); return Math.round(x * p) / p; }
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  /** Canonical JSON: sorted keys, undefined dropped, non-finite numbers -> null. Used for hashing and replay comparison. */
  function canonical(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    if (typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).filter(function (k) { return v[k] !== undefined; }).sort()
      .map(function (k) { return JSON.stringify(k) + ':' + canonical(v[k]); }).join(',') + '}';
  }

  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
    }
    return o;
  }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

  // ---------------------------------------------------------------- SHA-256 (sync, UTF-8)
  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function sha256(str) {
    var bytes = new TextEncoder().encode(str), l = bytes.length;
    var n = ((l + 9 + 63) >> 6) << 6, buf = new Uint8Array(n);
    buf.set(bytes); buf[l] = 0x80;
    var dv = new DataView(buf.buffer);
    dv.setUint32(n - 4, (l * 8) >>> 0); dv.setUint32(n - 8, Math.floor(l / 0x20000000));
    var h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var w = new Uint32Array(64);
    for (var off = 0; off < n; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var a15 = w[i - 15], a2 = w[i - 2];
        var s0 = ((a15 >>> 7) | (a15 << 25)) ^ ((a15 >>> 18) | (a15 << 14)) ^ (a15 >>> 3);
        var s1 = ((a2 >>> 17) | (a2 << 15)) ^ ((a2 >>> 19) | (a2 << 13)) ^ (a2 >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var A = h[0], B = h[1], C = h[2], D = h[3], E = h[4], F = h[5], Gg = h[6], H = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));
        var ch = (E & F) ^ (~E & Gg);
        var t1 = (H + S1 + ch + K[i] + w[i]) >>> 0;
        var S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));
        var mj = (A & B) ^ (A & C) ^ (B & C);
        var t2 = (S0 + mj) >>> 0;
        H = Gg; Gg = F; F = E; E = (D + t1) >>> 0; D = C; C = B; B = A; A = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + A) >>> 0; h[1] = (h[1] + B) >>> 0; h[2] = (h[2] + C) >>> 0; h[3] = (h[3] + D) >>> 0;
      h[4] = (h[4] + E) >>> 0; h[5] = (h[5] + F) >>> 0; h[6] = (h[6] + Gg) >>> 0; h[7] = (h[7] + H) >>> 0;
    }
    return h.map(function (x) { return ('00000000' + x.toString(16)).slice(-8); }).join('');
  }

  // ---------------------------------------------------------------- epistemic firewall
  function FirewallError(rule, message) {
    var e = new Error('[firewall ' + rule + '] ' + message);
    e.name = 'FirewallError'; e.rule = rule;
    return e;
  }
  function LedgerIntegrityError(message) {
    var e = new Error('[integrity] ' + message); e.name = 'LedgerIntegrityError'; return e;
  }

  /**
   * Firewall rules (all enforced before anything is written):
   *  F1 class must be one of CLASSES.
   *  F2 source and kind must be non-empty strings.
   *  F3 confidence in [0,1] (or null). INFERRED needs 0 < c < 1 (an inference is never certain).
   *     SPECULATIVE needs c <= 0.5.
   *  F4 provenance: array of unique ids, no self-citation, every id already in the ledger (no forward refs).
   *  F5 OBSERVED has empty provenance: an observation is never derived from anything, so nothing
   *     computed or inferred can be (re)labelled OBSERVED.
   *  F6 DERIVED must cite >=1 entry and may cite only OBSERVED or DERIVED (no laundering inferences into "facts").
   *  F7 INFERRED must cite >=1 OBSERVED or DERIVED entry, may not cite SPECULATIVE, and must carry
   *     data.alternatives (non-empty list of competing explanations).
   *  F8 nothing may cite an entry that has expired at the time of writing.
   *  F9 supersedes: target must exist, have the SAME class (so no upgrade, e.g. INFERRED -> OBSERVED),
   *     and must not already be superseded.
   *  F10 freshness is a positive number of ms (or null); expiry is null or later than ts.
   */
  function firewallCheck(e, view) {
    if (CLASSES.indexOf(e['class']) < 0) throw FirewallError('F1', 'unknown class ' + JSON.stringify(e['class']));
    if (typeof e.source !== 'string' || !e.source) throw FirewallError('F2', 'source required');
    if (typeof e.kind !== 'string' || !e.kind) throw FirewallError('F2', 'kind required');
    var c = e.confidence;
    if (c !== null && (typeof c !== 'number' || !(c >= 0 && c <= 1))) throw FirewallError('F3', 'confidence must be in [0,1] or null');
    if (e['class'] === 'INFERRED' && !(typeof c === 'number' && c > 0 && c < 1)) throw FirewallError('F3', 'INFERRED needs 0 < confidence < 1');
    if (e['class'] === 'SPECULATIVE' && !(typeof c === 'number' && c <= 0.5)) throw FirewallError('F3', 'SPECULATIVE needs confidence <= 0.5');

    var prov = e.provenance;
    if (!Array.isArray(prov)) throw FirewallError('F4', 'provenance must be an array');
    var seen = {};
    var cited = prov.map(function (id) {
      if (typeof id !== 'string') throw FirewallError('F4', 'provenance ids must be strings');
      if (seen[id]) throw FirewallError('F4', 'duplicate provenance id ' + id);
      seen[id] = 1;
      if (id === e.id) throw FirewallError('F4', 'self-citation');
      var p = view.get(id);
      if (!p) throw FirewallError('F4', 'provenance id not in ledger: ' + id);
      if (p.expiry != null && p.expiry <= e.ts) throw FirewallError('F8', 'cites expired entry ' + id);
      return p;
    });
    var classes = cited.map(function (p) { return p['class']; });
    var grounded = classes.filter(function (k) { return k === 'OBSERVED' || k === 'DERIVED'; }).length;

    if (e['class'] === 'OBSERVED' && prov.length) throw FirewallError('F5', 'OBSERVED entries cannot have provenance (cannot be derived/upgraded into an observation)');
    if (e['class'] === 'DERIVED') {
      if (!prov.length) throw FirewallError('F6', 'DERIVED must cite its inputs');
      if (grounded !== prov.length) throw FirewallError('F6', 'DERIVED may cite only OBSERVED/DERIVED, got ' + classes.join(','));
    }
    if (e['class'] === 'INFERRED') {
      if (!grounded) throw FirewallError('F7', 'INFERRED must cite at least one OBSERVED or DERIVED entry');
      if (classes.indexOf('SPECULATIVE') >= 0) throw FirewallError('F7', 'INFERRED may not rest on SPECULATIVE entries');
      if (!e.data || !Array.isArray(e.data.alternatives) || !e.data.alternatives.length)
        throw FirewallError('F7', 'INFERRED must list competing explanations in data.alternatives');
    }
    if (e.supersedes != null) {
      var t = view.get(e.supersedes);
      if (!t) throw FirewallError('F9', 'supersedes unknown id ' + e.supersedes);
      if (t['class'] !== e['class']) throw FirewallError('F9', 'cannot supersede ' + t['class'] + ' with ' + e['class'] + ' (no class change / upgrade)');
      if (view.supersededBy(t.id)) throw FirewallError('F9', t.id + ' already superseded');
    }
    if (e.freshness !== null && !(typeof e.freshness === 'number' && e.freshness > 0)) throw FirewallError('F10', 'freshness must be > 0 ms or null');
    if (e.expiry !== null && !(typeof e.expiry === 'number' && e.expiry > e.ts)) throw FirewallError('F10', 'expiry must be null or after ts');
    return true;
  }

  // ---------------------------------------------------------------- ledger
  var DEFAULTS_BY_CLASS = {
    OBSERVED: { freshness: 60e3, ttl: 30 * 864e5 },
    DERIVED: { freshness: 60e3, ttl: 30 * 864e5 },
    INFERRED: { freshness: 5 * 60e3, ttl: 30 * 864e5 },
    SPECULATIVE: { freshness: 5 * 60e3, ttl: 7 * 864e5 },
    UNKNOWN: { freshness: 60e3, ttl: 7 * 864e5 }
  };
  var ENTRY_FIELDS = ['seq', 'id', 'ts', 'source', 'class', 'kind', 'data', 'provenance', 'confidence', 'freshness', 'expiry', 'supersedes', 'prevHash'];

  function hashEntry(e) {
    var o = {}; ENTRY_FIELDS.forEach(function (k) { o[k] = e[k]; });
    return sha256(canonical(o));
  }

  /** In-memory store adapter (tests / fallback). Browser uses an IndexedDB adapter with the same shape. */
  function MemoryStore() { this.rows = []; }
  MemoryStore.prototype.add = function (e) {
    if (this.rows.some(function (r) { return r.seq === e.seq; })) return Promise.reject(new Error('seq exists'));
    this.rows.push(clone(e)); return Promise.resolve();
  };
  MemoryStore.prototype.all = function () { return Promise.resolve(this.rows.map(clone)); };
  MemoryStore.prototype.clear = function () { this.rows = []; return Promise.resolve(); };
  MemoryStore.prototype.count = function () { return Promise.resolve(this.rows.length); };

  /**
   * Append-only, hash-chained ledger. There is no update or delete-one API. Entries are frozen.
   * The only destructive operation is wipe(), which removes everything and returns a verifiable receipt.
   */
  function Ledger(opts) {
    opts = opts || {};
    this.store = opts.store || null;
    this.clock = opts.clock || function () { return Date.now(); };
    this._reset();
  }
  Ledger.prototype._reset = function () {
    this._entries = []; this._byId = new Map(); this._supersededBy = new Map(); this._q = Promise.resolve();
  };
  Object.defineProperty(Ledger.prototype, 'size', { get: function () { return this._entries.length; } });
  Object.defineProperty(Ledger.prototype, 'head', { get: function () { var n = this._entries.length; return n ? this._entries[n - 1].hash : GENESIS; } });
  Ledger.prototype.get = function (id) { return this._byId.get(id) || null; };
  Ledger.prototype.supersededBy = function (id) { return this._supersededBy.get(id) || null; };
  Ledger.prototype.entries = function () { return this._entries.slice(); };
  Ledger.prototype.byClass = function (k) { return this._entries.filter(function (e) { return e['class'] === k; }); };

  /** Build a sealed entry from a draft (does not validate or write). */
  Ledger.prototype.seal = function (d) {
    var k = d['class'];
    var def = DEFAULTS_BY_CLASS[k] || DEFAULTS_BY_CLASS.UNKNOWN;
    var last = this._entries[this._entries.length - 1];
    var ts = Math.max(Math.round(this.clock()), last ? last.ts : 0);
    var e = {
      seq: this._entries.length,
      id: null,
      ts: ts,
      source: d.source,
      'class': k,
      kind: d.kind,
      data: d.data === undefined ? null : clone(d.data),
      provenance: (d.provenance || []).slice(),
      confidence: d.confidence === undefined ? (k === 'OBSERVED' ? 1 : null) : d.confidence,
      freshness: d.freshness === undefined ? def.freshness : d.freshness,
      expiry: d.expiry === undefined ? ts + def.ttl : d.expiry,
      supersedes: d.supersedes == null ? null : d.supersedes,
      prevHash: this.head
    };
    e.id = (k ? String(k).charAt(0) : 'X') + String(e.seq).padStart(6, '0') + '-' +
      sha256(canonical({ seq: e.seq, ts: e.ts, source: e.source, kind: e.kind, data: e.data, prevHash: e.prevHash })).slice(0, 8);
    e.hash = hashEntry(e);
    return e;
  };

  /** Validate a sealed entry against current state: chain integrity + firewall. Throws on violation. */
  Ledger.prototype._admit = function (e) {
    var n = this._entries.length, last = this._entries[n - 1];
    if (e.seq !== n) throw LedgerIntegrityError('expected seq ' + n + ', got ' + e.seq);
    if (e.prevHash !== this.head) throw LedgerIntegrityError('prevHash mismatch at seq ' + e.seq);
    if (hashEntry(e) !== e.hash) throw LedgerIntegrityError('hash mismatch at seq ' + e.seq + ' (entry was altered)');
    if (this._byId.has(e.id)) throw LedgerIntegrityError('duplicate id ' + e.id);
    if (typeof e.ts !== 'number' || (last && e.ts < last.ts)) throw LedgerIntegrityError('non-monotonic ts at seq ' + e.seq);
    firewallCheck(e, this);
  };
  Ledger.prototype._commit = function (e) {
    deepFreeze(e);
    this._entries.push(e); this._byId.set(e.id, e);
    if (e.supersedes) this._supersededBy.set(e.supersedes, e.id);
  };

  /** Append a draft {source, class, kind, data, provenance, confidence, freshness?, expiry?, supersedes?}. Serialized. */
  Ledger.prototype.append = function (draft) {
    var self = this;
    var p = this._q.then(function () {
      var e = self.seal(draft);
      self._admit(e);
      return (self.store ? self.store.add(e) : Promise.resolve()).then(function () { self._commit(e); return e; });
    });
    this._q = p.catch(function () {});
    return p;
  };

  /** Load (and fully re-verify) entries, e.g. from IndexedDB at boot or from an imported file. Ledger must be empty. */
  Ledger.prototype.loadVerified = function (entries, persist) {
    var self = this;
    if (this._entries.length) return Promise.reject(LedgerIntegrityError('loadVerified requires an empty ledger'));
    var sorted = entries.slice().sort(function (a, b) { return a.seq - b.seq; });
    try { sorted.forEach(function (raw) { var e = clone(raw); self._admit(e); self._commit(e); }); }
    catch (err) { this._reset(); return Promise.reject(err); }
    if (!persist || !this.store) return Promise.resolve(this.size);
    return sorted.reduce(function (pr, e) { return pr.then(function () { return self.store.add(e); }); }, Promise.resolve())
      .then(function () { return self.size; });
  };

  Ledger.prototype.boot = function () {
    var self = this;
    return this.store.all().then(function (rows) { return self.loadVerified(rows, false); });
  };

  /** Re-verify the whole chain from scratch (hashes, links, firewall, provenance). */
  Ledger.prototype.verify = function () {
    var probe = new Ledger({ clock: this.clock });
    try { this._entries.forEach(function (e) { probe._admit(e); probe._commit(e); }); }
    catch (err) { return { ok: false, error: err.message, count: probe.size }; }
    return { ok: true, count: probe.size, head: probe.head };
  };

  Ledger.prototype.status = function (e, now) {
    now = now == null ? this.clock() : now;
    if (this._supersededBy.has(e.id)) return 'superseded';
    return statusOf(e, now);
  };
  function statusOf(e, now) {
    if (e.expiry != null && now >= e.expiry) return 'expired';
    if (e.freshness != null && now - e.ts > e.freshness) return 'stale';
    return 'fresh';
  }

  /** Transitive provenance closure; returns the OBSERVED roots an entry ultimately rests on. */
  Ledger.prototype.groundTruthOf = function (id) {
    var out = [], seen = {}, self = this;
    (function walk(i) {
      if (seen[i]) return; seen[i] = 1;
      var e = self.get(i); if (!e) return;
      if (e['class'] === 'OBSERVED') out.push(e.id);
      e.provenance.forEach(walk);
    })(id);
    return out;
  };

  Ledger.prototype.exportJSON = function () {
    return { format: 'axis-genie-ledger', version: VERSION, exportedAt: Math.round(this.clock()), count: this.size, head: this.head, entries: this.entries() };
  };

  /** Wipe everything (memory + store) and verify the store is empty afterwards. Returns a deletion receipt. */
  Ledger.prototype.wipe = function () {
    var self = this, before = { count: this.size, head: this.head };
    return this._q.then(function () {
      return (self.store ? self.store.clear().then(function () { return self.store.count(); }) : Promise.resolve(0));
    }).then(function (postCount) {
      self._reset();
      var receipt = { at: Math.round(self.clock()), deletedCount: before.count, headBefore: before.head, postCount: postCount, memoryCount: self.size, verified: postCount === 0 && self.size === 0 };
      receipt.receiptHash = sha256(canonical(receipt));
      return receipt;
    });
  };

  // ---------------------------------------------------------------- ring buffer
  function RingBuffer(capacity) { this.cap = capacity; this.buf = new Array(capacity); this.start = 0; this.length = 0; }
  RingBuffer.prototype.push = function (x) {
    var i = (this.start + this.length) % this.cap;
    this.buf[i] = x;
    if (this.length < this.cap) this.length++; else this.start = (this.start + 1) % this.cap;
  };
  RingBuffer.prototype.toArray = function () {
    var out = new Array(this.length);
    for (var i = 0; i < this.length; i++) out[i] = this.buf[(this.start + i) % this.cap];
    return out;
  };
  RingBuffer.prototype.last = function () { return this.length ? this.buf[(this.start + this.length - 1) % this.cap] : null; };
  RingBuffer.prototype.clear = function () { this.start = 0; this.length = 0; };

  // ---------------------------------------------------------------- detector
  /** Samples: {t (ms, epoch), ax, ay, az (accelerationIncludingGravity, m/s^2), rx, ry, rz (deg/s, optional)} */
  var DEFAULT_PARAMS = deepFreeze({
    version: 'drop-v1',
    freefallG: 0.4,        // |a| below this (in g) counts as free fall
    minFreefallMs: 100,    // free fall must last this long (~5 cm drop height)
    impactG: 2.0,          // impact peak after free fall must reach this (60 Hz sampling under-reads true peaks)
    maxImpactDelayMs: 300, // impact must start within this time after free fall ends
    impactAloneG: 3.0,     // spike without preceding free fall => 'impact' (bump/knock) event
    settleMs: 400,         // ignore ringing this long after the impact peak
    stillWindowMs: 600,    // window after settle used to test "came to rest"
    stillStdG: 0.06,       // std of |a| below this => at rest
    preMs: 1500,           // OBSERVED window before impact
    postMs: 1500,          // OBSERVED window after impact (event confirmed only after this has elapsed)
    refractoryMs: 2000,    // minimum spacing between events
    maxGapFactor: 3        // a sample gap > factor * median interval is flagged as a data gap
  });

  function magG(s) { return Math.sqrt(s.ax * s.ax + s.ay * s.ay + s.az * s.az) / G; }

  function detect(samples, params) {
    var P = params || DEFAULT_PARAMS, n = samples.length, events = [];
    var m = samples.map(magG);
    var i = 0;
    while (i < n) {
      if (m[i] < P.freefallG) {
        var j = i; while (j < n && m[j] < P.freefallG) j++;
        var ffStart = samples[i].t, ffEnd = samples[j - 1].t, ffMs = ffEnd - ffStart;
        if (ffMs >= P.minFreefallMs && j < n) {
          var k = j, best = -1;
          while (k < n && samples[k].t - ffEnd <= P.maxImpactDelayMs) { if (best < 0 || m[k] > m[best]) best = k; k++; }
          if (best >= 0 && m[best] >= P.impactG) {
            var minFF = Infinity; for (var q = i; q < j; q++) minFF = Math.min(minFF, m[q]);
            events.push({ type: 'drop', tImpact: samples[best].t, peakG: round(m[best]), freefallMs: round(ffMs, 2), ffStart: ffStart, ffEnd: ffEnd, minFreefallG: round(minFF) });
            i = skipTo(samples, best, samples[best].t + P.refractoryMs); continue;
          }
        }
        i = j; continue;
      }
      if (m[i] >= P.impactAloneG) {
        var b = i, z = i; while (z < n && samples[z].t - samples[i].t <= 50) { if (m[z] > m[b]) b = z; z++; }
        events.push({ type: 'impact', tImpact: samples[b].t, peakG: round(m[b]), freefallMs: 0, ffStart: null, ffEnd: null, minFreefallG: null });
        i = skipTo(samples, b, samples[b].t + P.refractoryMs); continue;
      }
      i++;
    }
    return events;
  }
  function skipTo(samples, from, t) { var i = from; while (i < samples.length && samples[i].t <= t) i++; return i; }

  function stats(xs) {
    if (!xs.length) return { mean: null, std: null };
    var mu = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
    var v = xs.reduce(function (a, b) { return a + (b - mu) * (b - mu); }, 0) / xs.length;
    return { mean: mu, std: Math.sqrt(v) };
  }
  function median(xs) { if (!xs.length) return null; var s = xs.slice().sort(function (a, b) { return a - b; }); var h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; }

  /** DERIVED features of one event within an OBSERVED window. Deterministic. */
  function features(samples, ev, params) {
    var P = params || DEFAULT_PARAMS;
    var dts = []; for (var i = 1; i < samples.length; i++) dts.push(samples[i].t - samples[i - 1].t);
    var medDt = median(dts) || 0, maxGap = dts.length ? Math.max.apply(null, dts) : 0;
    var ps = samples[0].t, post = samples.filter(function (s) { return s.t >= ev.tImpact + P.settleMs && s.t <= ev.tImpact + P.settleMs + P.stillWindowMs; }).map(magG);
    var st = stats(post);
    var rot = samples.filter(function (s) { return typeof s.rx === 'number'; }).map(function (s) { return Math.sqrt(s.rx * s.rx + s.ry * s.ry + s.rz * s.rz); });
    var t = ev.freefallMs / 1000;
    return {
      eventType: ev.type,
      tImpact: ev.tImpact,
      tImpactOffsetMs: round(ev.tImpact - ps, 2),
      peakG: ev.peakG,
      freefallMs: ev.freefallMs,
      minFreefallG: ev.minFreefallG,
      estDropHeightM: round(0.5 * G * t * t, 3),
      postImpactStdG: st.std == null ? null : round(st.std),
      postImpactMeanG: st.mean == null ? null : round(st.mean),
      postSamples: post.length,
      cameToRest: st.std != null && post.length >= 5 && st.std <= P.stillStdG,
      peakRotationDps: rot.length ? round(Math.max.apply(null, rot), 2) : null,
      sampleCount: samples.length,
      medianIntervalMs: round(medDt, 3),
      sampleRateHz: medDt ? round(1000 / medDt, 2) : null,
      maxGapMs: round(maxGap, 3),
      dataGap: medDt > 0 && maxGap > P.maxGapFactor * medDt
    };
  }

  /** INFERRED interpretation: hypothesis + confidence + competing explanations. Deterministic. */
  function interpret(f, params) {
    var P = params || DEFAULT_PARAMS, alts, c, hyp, why = [];
    var still = f.cameToRest ? 1 : (f.postImpactStdG != null && f.postImpactStdG <= 3 * P.stillStdG ? 0.5 : 0);
    var gapPen = f.dataGap ? 0.25 : 0;
    if (f.eventType === 'drop') {
      var ff = clamp((f.freefallMs - P.minFreefallMs) / (400 - P.minFreefallMs), 0, 1);
      var imp = clamp((f.peakG - P.impactG) / (6 - P.impactG), 0, 1);
      c = 0.3 + 0.25 * ff + 0.15 * imp + 0.2 * still - gapPen;
      hyp = 'Phone fell ~' + f.estDropHeightM + ' m and struck a surface';
      why.push('free fall ' + f.freefallMs + ' ms (|a| < ' + P.freefallG + ' g)', 'impact peak ' + f.peakG + ' g', still === 1 ? 'came to rest after impact' : 'still moving after impact');
      alts = [
        { label: 'Tossed and caught (no surface impact)', plausibility: round(clamp(0.15 + 0.4 * (1 - still), 0, 1), 2), why: 'caught phone keeps moving after the spike' },
        { label: 'Placed down hard / slammed on a table', plausibility: round(clamp(0.1 + 0.4 * (1 - ff), 0, 1), 2), why: 'short free fall is consistent with a fast set-down' },
        { label: 'Thrown or deliberate drop test', plausibility: 0.1, why: 'kinematically identical to an accidental fall' },
        { label: 'Sensor artefact (missing samples)', plausibility: round(f.dataGap ? 0.4 : 0.05, 2), why: f.dataGap ? 'data gap of ' + f.maxGapMs + ' ms in window' : 'no data gap found' }
      ];
    } else {
      var imp2 = clamp((f.peakG - P.impactAloneG) / (8 - P.impactAloneG), 0, 1);
      c = 0.3 + 0.3 * imp2 + 0.1 * still - gapPen;
      hyp = 'Phone was struck or knocked (no free fall)';
      why.push('spike ' + f.peakG + ' g without preceding free fall');
      alts = [
        { label: 'Very short drop (< 5 cm)', plausibility: 0.3, why: 'free fall shorter than ' + P.minFreefallMs + ' ms is not detected' },
        { label: 'Hard tap / gesture by the user', plausibility: 0.3, why: 'hand motion can exceed ' + P.impactAloneG + ' g' },
        { label: 'Vehicle or surface jolt', plausibility: 0.2, why: 'external shock transmitted to the phone' },
        { label: 'Sensor artefact (missing samples)', plausibility: round(f.dataGap ? 0.4 : 0.05, 2), why: f.dataGap ? 'data gap in window' : 'no data gap found' }
      ];
    }
    return { hypothesis: hyp, eventType: f.eventType, confidence: round(clamp(c, 0.05, 0.95), 3), rationale: why, alternatives: alts, paramsVersion: P.version };
  }

  /** Full deterministic pipeline on one OBSERVED window. Picks the event nearest the window anchor (start + preMs). */
  function analyzeWindow(samples, params) {
    var P = params || DEFAULT_PARAMS;
    if (!samples || samples.length < 3) return null;
    var evs = detect(samples, P);
    if (!evs.length) return null;
    var anchor = samples[0].t + P.preMs;
    var ev = evs.slice().sort(function (a, b) { return Math.abs(a.tImpact - anchor) - Math.abs(b.tImpact - anchor); })[0];
    var f = features(samples, ev, P);
    return { event: ev, features: f, interpretation: interpret(f, P) };
  }

  /** Slice the OBSERVED window for an event out of a longer stream. */
  function windowFor(samples, tImpact, params) {
    var P = params || DEFAULT_PARAMS;
    return samples.filter(function (s) { return s.t >= tImpact - P.preMs && s.t <= tImpact + P.postMs; });
  }

  /** Append OBSERVED -> DERIVED -> INFERRED for one window. Returns the three entries (or null if nothing detected). */
  function recordEvent(ledger, opts) {
    var P = opts.params || DEFAULT_PARAMS;
    var a = analyzeWindow(opts.samples, P);
    if (!a) return Promise.resolve(null);
    var obs, der;
    return ledger.append({
      source: opts.source || 'devicemotion', 'class': 'OBSERVED', kind: 'motion.window',
      data: { samples: opts.samples, units: { a: 'm/s^2 incl. gravity', r: 'deg/s', t: 'ms epoch' }, context: opts.context || null, synthetic: !!opts.synthetic }
    }).then(function (o) {
      obs = o;
      return ledger.append({ source: 'detector/' + P.version, 'class': 'DERIVED', kind: 'motion.features', data: { features: a.features, params: P }, provenance: [o.id], confidence: 1 });
    }).then(function (d) {
      der = d;
      return ledger.append({ source: 'interpreter/' + P.version, 'class': 'INFERRED', kind: 'event.interpretation', data: a.interpretation, provenance: [d.id, obs.id], confidence: a.interpretation.confidence });
    }).then(function (inf) { return { observed: obs, derived: der, inferred: inf }; });
  }

  /**
   * Replay: re-run detection + interpretation from the stored OBSERVED windows alone and compare against
   * the DERIVED / INFERRED entries recorded in the ledger. Read-only.
   */
  function replay(ledger, params) {
    var results = [], entries = ledger.entries();
    entries.filter(function (e) { return e['class'] === 'OBSERVED' && e.kind === 'motion.window'; }).forEach(function (obs) {
      var der = entries.filter(function (e) { return e['class'] === 'DERIVED' && e.kind === 'motion.features' && e.provenance.indexOf(obs.id) >= 0; });
      var P = (der[0] && der[0].data && der[0].data.params) || params || DEFAULT_PARAMS;
      var fresh = analyzeWindow(clone(obs.data.samples), P);
      var r = { observedId: obs.id, derivedId: der[0] ? der[0].id : null, inferredIds: [], match: false, problems: [] };
      if (!der.length) r.problems.push('no DERIVED entry for this window');
      if (!fresh) r.problems.push('replay detected no event');
      if (der.length && fresh && canonical(fresh.features) !== canonical(der[0].data.features)) r.problems.push('features differ');
      if (der.length) {
        var infs = entries.filter(function (e) { return e['class'] === 'INFERRED' && e.provenance.indexOf(der[0].id) >= 0; });
        r.inferredIds = infs.map(function (e) { return e.id; });
        if (!infs.length) r.problems.push('no INFERRED entry for this window');
        infs.forEach(function (inf) {
          if (!fresh || canonical(fresh.interpretation) !== canonical(inf.data)) r.problems.push('interpretation differs for ' + inf.id);
          else if (inf.confidence !== fresh.interpretation.confidence) r.problems.push('confidence differs for ' + inf.id);
        });
      }
      r.match = r.problems.length === 0;
      results.push(r);
    });
    return { checked: results.length, matched: results.filter(function (r) { return r.match; }).length, results: results };
  }

  // ---------------------------------------------------------------- synthetic traces (tests + in-app simulator)
  function mulberry32(seed) {
    return function () { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; var t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function mk(t, gx, gy, gz, rnd, noise) {
    var nz = function () { return (rnd() - 0.5) * 2 * noise; };
    return { t: round(t, 3), ax: round(gx + nz()), ay: round(gy + nz()), az: round(gz + nz()), rx: round(nz() * 10), ry: round(nz() * 10), rz: round(nz() * 10) };
  }
  var synth = {
    still: function (o) {
      o = o || {}; var r = mulberry32(o.seed || 1), hz = o.hz || 60, n = Math.round((o.ms || 5000) * hz / 1000), t0 = o.t0 || 1.7e12, out = [];
      for (var i = 0; i < n; i++) out.push(mk(t0 + i * 1000 / hz, 0, 0, -G, r, o.noise == null ? 0.03 : o.noise));
      return out;
    },
    walk: function (o) {
      o = o || {}; var r = mulberry32(o.seed || 2), hz = o.hz || 60, n = Math.round((o.ms || 8000) * hz / 1000), t0 = o.t0 || 1.7e12, out = [];
      var f = o.stepHz || 1.9, amp = o.ampG == null ? 0.35 : o.ampG;
      for (var i = 0; i < n; i++) {
        var t = i / hz, v = amp * Math.sin(2 * Math.PI * f * t) + 0.1 * Math.sin(4 * Math.PI * f * t + 1);
        var s = mk(t0 + i * 1000 / hz, 0.15 * G * Math.sin(Math.PI * f * t), 0.1 * G, -(1 + v) * G, r, 0.4);
        s.rx = round(40 * Math.sin(2 * Math.PI * f * t)); out.push(s);
      }
      return out;
    },
    drop: function (o) {
      o = o || {}; var r = mulberry32(o.seed || 3), hz = o.hz || 60, t0 = o.t0 || 1.7e12, h = o.heightM == null ? 1.0 : o.heightM;
      var ffMs = Math.sqrt(2 * h / G) * 1000, pre = o.preMs == null ? 2000 : o.preMs, post = o.postMs == null ? 2500 : o.postMs;
      var peak = o.peakG == null ? 5 : o.peakG, caught = !!o.caught, out = [];
      var total = pre + ffMs + post, n = Math.round(total * hz / 1000);
      for (var i = 0; i < n; i++) {
        var tm = i * 1000 / hz, z, noise = 0.05;
        if (tm < pre) z = 1;                                  // held in hand
        else if (tm < pre + ffMs) { z = 0.05; noise = 0.02; } // free fall
        else {
          var dt = tm - pre - ffMs;
          if (caught) { z = 1 + 0.6 * Math.sin(dt / 60) * Math.exp(-dt / 2000); noise = 0.6; }
          else if (dt < 1000 / hz) z = peak;                     // impact sample
          else if (dt < 250) { z = 1 + (peak / 3) * Math.exp(-dt / 40) * Math.cos(dt / 8); noise = 0.3; } // bounce / ringing
          else { z = 1; noise = 0.02; }                          // at rest
        }
        out.push(mk(t0 + tm, 0, 0, -z * G, r, noise));
      }
      return out;
    }
  };

  return {
    VERSION: VERSION, G: G, CLASSES: CLASSES, GENESIS: GENESIS, DEFAULT_PARAMS: DEFAULT_PARAMS, DEFAULTS_BY_CLASS: DEFAULTS_BY_CLASS,
    canonical: canonical, sha256: sha256, round: round, deepFreeze: deepFreeze,
    firewallCheck: firewallCheck, Ledger: Ledger, MemoryStore: MemoryStore, statusOf: statusOf,
    RingBuffer: RingBuffer, magG: magG, detect: detect, features: features, interpret: interpret,
    analyzeWindow: analyzeWindow, windowFor: windowFor, recordEvent: recordEvent, replay: replay,
    synth: synth, mulberry32: mulberry32
  };
});
