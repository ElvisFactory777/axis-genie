# AXIS · Single-phone minimum viable genie: milestone 1

This is a self-contained web app (PWA) for **one iPhone with no other hardware**. It implements the
"NEXT BOOT SEQUENCE" from the AXIS status report (18 Nov 2026):

| Boot step | Where it lives |
|---|---|
| Enumerate every accessible sensor | `Sensors` panel: 21 rows, each shown as active / not started / denied / unsupported / stale |
| Record synchronized measurements | 4096-sample ring buffer of DeviceMotion samples, each with an epoch-ms timestamp. Each event window also captures a context snapshot of heading, sound level, brightness, location, battery and visibility, with the age of each value |
| Detect one meaningful physical event | **Drop** (free fall followed by impact) and **impact** (a spike with no free fall), using explicit thresholds in `DEFAULT_PARAMS` |
| Evidence-labelled interpretation | OBSERVED raw window → DERIVED features (peak g, free-fall ms, estimated height, came-to-rest, data gaps) → INFERRED hypothesis with a confidence and 4 competing explanations |
| Persistent local ledger | IndexedDB, append-only and hash-chained. Each entry has `id, ts, source, class, kind, data, provenance, confidence, freshness, expiry, supersedes, prevHash, hash` |
| Living visual interface | Glyph orb + live \|a\| trace. **Blue** = sensing, **gold** = verified by replay or chain check, **white** = attention (new event), **red** = exception or firewall block, **grey** = stale or idle |
| Reproduce reasoning from evidence | **Replay** re-runs detection and interpretation from the stored OBSERVED windows alone and compares the result with the ledger byte-for-byte (canonical JSON) |

Privacy (report §08): there is no network code. A Content-Security-Policy (`connect-src 'self'`) blocks
requests to any other host. The service worker only caches the app's own files. Data leaves the
phone only if you tap **Export** and then share the file yourself. **Delete all** clears IndexedDB,
re-counts it, and stores a deletion receipt: the count, the head hash before deletion, a post-count
of 0, and a receipt hash.

## Files

```
index.html              the app (built: inline CSS + JS, no CDN, no external requests)
sw.js                   offline cache (same-origin only)
manifest.webmanifest    PWA manifest; icon-192/512.png, apple-touch-icon.png
src/core.js             ledger, epistemic firewall, ring buffer, detector, interpreter, replay, synthetic traces
src/app.html            UI template; `node build.js` inlines core.js -> index.html
test/core.test.js       node:test suite (no dependencies)
test/smoke.mjs          headless-Chrome smoke test with mocked iOS sensor APIs
```

Run `node build.js && node --test test/core.test.js && node test/smoke.mjs`.

## Epistemic firewall (enforced in `src/core.js`, before any write)

- **F1–F3.** The class must be a known class, and source and kind are required. Confidence must be in [0,1]. **INFERRED needs 0 < c < 1**: an inference is never certain. SPECULATIVE needs c ≤ 0.5.
- **F4.** Every provenance id must already exist in the ledger. No unknown ids, no forward references, no duplicates, no self-citation.
- **F5.** **OBSERVED entries cannot have provenance.** Anything computed is not an observation.
- **F6.** DERIVED must cite only OBSERVED or DERIVED entries. An inference cannot be laundered into a "fact".
- **F7.** **INFERRED must cite at least one OBSERVED or DERIVED entry**, may not rest on SPECULATIVE entries, and must list competing explanations.
- **F8.** No entry may cite an expired entry.
- **F9.** `supersedes` must point to an entry of the **same class**, which has not already been superseded. Combined with F5, this means **nothing can ever be upgraded to OBSERVED**.
- **F10.** Freshness and expiry must be valid.
- Integrity checks: seq order, `prevHash` chain, SHA-256 per entry, and monotonic `ts`. The whole chain is re-verified when the app boots from IndexedDB and on import. A tampered store is refused and not loaded. Entries are frozen in memory, and the IndexedDB adapter only uses `add()`, so nothing is overwritten. There is no API to update or delete a single entry.
- The **Test firewall** button tries 4 illegal writes on the phone and shows each one being blocked.

## Detector parameters (`DEFAULT_PARAMS`, version `drop-v1`)

| Parameter | Value | Meaning |
|---|---|---|
| freefallG | 0.4 g | \|a\| below this counts as free fall |
| minFreefallMs | 100 ms | minimum free-fall time (about 5 cm of drop) |
| impactG | 2.0 g | minimum peak within `maxImpactDelayMs` (300 ms) after the free fall |
| impactAloneG | 3.0 g | a spike with no free fall is classed as an "impact" event |
| settleMs / stillWindowMs / stillStdG | 400 ms / 600 ms / 0.06 g | test for whether the phone came to rest after impact |
| preMs / postMs | 1500 / 1500 ms | OBSERVED window kept around the impact. An event is confirmed only once postMs has passed |
| refractoryMs | 2000 ms | minimum spacing between events |
| maxGapFactor | 3 | a gap longer than 3× the median sample interval is flagged as a data gap, which lowers confidence |

Confidence is a fixed, deterministic formula:
0.3 + 0.25·(free-fall score) + 0.15·(impact score) + 0.2·(came to rest) − 0.25·(data gap), clamped to [0.05, 0.95].
It is a calibrated-by-hand heuristic, **not** a learned probability.

## Getting it onto the iPhone

The sensor APIs (motion, camera, microphone, geolocation) only work over **HTTPS**. Opening `index.html`
from the Files app will not work. You need the folder served from an HTTPS URL, then you open that URL
in Safari.

**IndexedDB is tied to the URL's origin.** If you change the hosting URL later, the app starts with an
empty ledger on the new URL. Use Export and Import to move the ledger across.

| Option | How | Tradeoffs |
|---|---|---|
| **GitHub Pages** (recommended) | Push this folder to a repo and turn on Pages for it. The URL is `https://<user>.github.io/<repo>/` | Free. The URL is stable, so the ledger persists, and redeploying is just a push. Needs a GitHub account. The repo, and the code, is public on the free plan, but your ledger data is never in the repo. Updates take about 1 minute to go live |
| **Netlify Drop** | Drag the folder onto app.netlify.com/drop | The fastest option, about 30 seconds. Anonymous drops expire unless you claim them with an account. Dragging needs a desktop-style browser |
| **Cloudflare quick tunnel** | From any computer: `npx http-server -p 8080` plus `cloudflared tunnel --url http://localhost:8080` | No account and gives HTTPS at once. The URL changes every run, so the ledger is effectively reset each time. The serving machine must stay on |
| Any static HTTPS host (Vercel, Cloudflare Pages, S3+CloudFront) | Upload the folder | All fine. It's static files only, with no server code |

On the phone:
1. Open the URL in **Safari**.
2. Tap Share → **Add to Home Screen**. This gives a full-screen app, offline use via the service worker, and storage that isn't evicted under Safari's 7-day rule for websites.
3. Open the app from the Home Screen and tap **Wake sensors**. Allow Motion & Orientation, then Location, Microphone and Camera. Each prompt is independent, so you can deny any of them and the rest keep working.
4. To test, tap **Simulate drop** (labelled `simulator` / `synthetic: true` in the ledger). Then drop the phone about 0.5 m onto a bed or sofa. Then tap **Replay**, **Verify chain**, and **Test firewall**.

If you deny Motion by mistake: iOS remembers the choice for that site. Go to Settings → Apps → Safari →
Advanced → Website Data and remove the site, or reinstall the Home Screen app. Then tap Wake again.

## What iOS Safari can and cannot reach

| Reachable from Safari | Notes |
|---|---|
| Accelerometer (incl. gravity), gyroscope | `devicemotion`, about 60 Hz. iOS 13+ needs `DeviceMotionEvent.requestPermission()` on a tap; this is done in the Wake handler |
| Orientation and compass heading | `deviceorientation` + `webkitCompassHeading` / `webkitCompassAccuracy`. This is the only window onto the magnetometer |
| Location | `watchPosition`. Only works with the app in the foreground |
| Microphone level | `getUserMedia` + `AnalyserNode` gives RMS in **dBFS**. This is uncalibrated and **not** dB SPL |
| Camera brightness | Mean luma (0–255) of the rear camera. Auto-exposure normalises it, so it is a **relative** scene-change signal and **not** a lux measurement |
| Screen orientation, visibility, online state, touch (force only on 3D-Touch models), storage quota, high-resolution clock | |

| **Not reachable** from Safari | Notes |
|---|---|
| Battery | `getBattery` is not implemented in Safari. The row shows "unsupported" |
| Ambient light sensor, raw magnetometer (µT), barometer/altimeter, proximity | Generic Sensor APIs are not implemented, and there is no barometer or proximity API |
| LiDAR / depth, UWB, NFC (Web NFC), Bluetooth (Web Bluetooth), Watch | Need a native app (ARKit, NearbyInteraction, CoreNFC, CoreBluetooth, HealthKit) |
| Haptics | `navigator.vibrate` is not supported on iOS |
| Thermal / power telemetry | Not exposed |
| **Background sensing** | All sensing pauses when the screen locks or the app leaves the foreground. This is the biggest limit of the web path |

Those rows match the report's §03 sensorium. About half of it requires a native Swift app, which
requires a Mac (or a cloud Mac / Xcode Cloud) for a future milestone.

## Known limitations

- **Not tested on a real iPhone.** It was verified with Node unit tests and in headless Chrome, with the iOS permission APIs, compass, motion events and media devices mocked or faked. Sampling rate, the accelerometer's range limit, `webkitCompassHeading` behaviour and the permission prompt flow need checking on the device.
- At about 60 Hz, short impact peaks are under-sampled, so the reported peak g is a lower bound. The device's range limit may also clip hard impacts (unverified). The free-fall time is measured from first to last sub-threshold sample, so it under-reads by up to one sample interval (about 17 ms).
- A phone that tumbles while falling can read above 0.4 g during the fall, because of rotation. A short spinning fall may then be missed or classed as an "impact".
- Only the event windows (about 3 s, roughly 180 samples, about 15 KB each) are stored. The continuous stream is not, in line with the report's minimization principle.
- Cross-modal corroboration (report §03: does an acoustic spike coincide with the impact?) is **not yet used in the confidence**. The context snapshot is stored, but at 10 Hz and 2 Hz rather than sample-aligned. This is the natural milestone 2.
- Expired entries are marked, not removed: the ledger is append-only. **Delete all** is the only removal path.
- If a future detector version changes `DEFAULT_PARAMS`, replay uses the params recorded in each DERIVED entry, so old records still replay faithfully.
