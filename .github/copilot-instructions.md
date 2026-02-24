# Star Track – Copilot Instructions

## Architecture

Vanilla JS PWA (no framework, no bundler). Loads as plain `<script>` tags — order matters.

| File | Role |
|---|---|
| `js/astronomy.js` | Coordinate math (`raDecToAltAz`, `altAzToRaDec`) + astronomy-engine wrappers. Defines globals `DEG`, `RAD`, and formatting helpers used everywhere. Loaded first. |
| `js/data/stars.js` / `constellations.js` | Static catalogs exposing `STARS` and `CONSTELLATIONS` globals. Star objects: `{ ra, dec, mag, name, spectral, con }`. Constellation lines: `[ra1, dec1, ra2, dec2]`. |
| `js/renderer.js` | `SkyRenderer` class — Canvas 2D rendering. Two modes: **map** (stereographic, full hemisphere) and **ar** (gnomonic tangent-plane projection). Receives pre-computed `{ alt, az }` arrays from app.js. |
| `js/app.js` | Main controller (IIFE). Owns state, sensor handling, animation loop, search, selection, PWA setup. Calls `computePositions()` every 30 s to reproject all objects. |
| `css/style.css` | LCARS (Star Trek) theme. All colours via `--lc-*` custom properties. All geometry via `--header-h`, `--sidebar-w`, `--elbow-r`, `--bar-r`, `--btn-r`. |
| `sw.js` | Service worker. Cache-first local, network-first CDN. Bump `CACHE_VERSION` on every release. |

## Key Patterns

### Coordinate Flow
All sky positions flow: **RA/Dec → Alt/Az** (in `computePositions`) → **screen x,y** (via `project()` closures in renderer). Never store screen coords — they're computed at render time from alt/az.

### AR Sensor Smoothing (critical to get right)
`applyDeviceOrientation()` in app.js uses a 3-layer filter:
1. **Spike rejection** — per-axis thresholds (`SPIKE_A/B/G`) drop single-frame jumps
2. **Adaptive LERP** — interpolation factor scales with angular velocity (`LERP_MIN`→`LERP_MAX`). Slow = noise rejection, fast = responsive
3. **Deadband** — sub-threshold deltas (`DEADBAND_A/B/G`) are zeroed

Altitude formula: `alt = smoothBeta - 90` (beta 90°=horizon, 180°=zenith). Clamped to [-90, 90].

### Rendering Performance
- Dim stars (mag ≥ 2.0) are **batched by spectral color** into single `beginPath/fill` calls — do not add per-star `save/restore` to this path.
- Constellation lines use a **single batched path** (1 stroke call total).
- Constellation label centroids are **precomputed** in `computePositions()` (fields `labelAlt`, `labelAz`), not recalculated per frame.
- Bright stars and selected objects go through `_drawStar()` individually (need glow gradients / selection rings).

### PWA & Service Worker
- Registration uses relative path `'sw.js'` (not absolute `/sw.js`) so the app works in subdirectories.
- Update flow: new SW waits → update banner shown → user clicks → `postMessage({ type: 'SKIP_WAITING' })` → `controllerchange` reloads.
- **Always bump `CACHE_VERSION`** in `sw.js` after any file change, or users won't see updates.

## LCARS Theme Rules
- Use `--lc-*` CSS variables for all colours — never hardcode hex in new rules.
- Buttons: `.lcars-btn` + `.btn-orange|purple|blue|teal|yellow|red`. Fully rounded (`border-radius: var(--btn-r)`).
- Sidebar elements use pill-end radius on the right: `border-radius: 0 var(--bar-r) var(--bar-r) 0`.
- The font stack is `--font-lcars` (Antonio) for UI and `--font-mono` (Share Tech Mono) for data readouts (class `mono`).

## Developer Workflow
```bash
# Serve locally (any static server works, no build step)
python -m http.server 8765

# No test framework — validate visually in browser
# Use DevTools > Application > Service Workers to force-update during dev
```

## Conventions
- All JS uses `'use strict'` (app.js IIFE, renderer.js class body is strict by default).
- No modules/imports — all files share the global scope via script order.
- Angles are in **degrees** everywhere except inside trig calls (multiply by `DEG`).
- `console.warn` only for non-critical astronomy-engine failures — no `console.log` in production paths.
- CSS sections are marked with `═══` banner comments; JS sections with `───` separators.
- Accessibility: canvas has `role="img" aria-label`, inputs have `aria-label`, `prefers-reduced-motion` disables all animations.
