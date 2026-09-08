# Texas Datacenter Siting Advisor — demo

A tile-based siting tool: place a proposed datacenter, see a capacity score,
get a tier ("buildable now" through "try a nearby site"), and see what would
unlock a blocked or capped site — framed as collaboration with developers,
not a flat rejection.

## Run it

No build step, no API key, no server required.

```bash
open index.html        # macOS
# or just double-click index.html
```

For a closer-to-production feel (and to avoid any browser quirks with
`file://` origins if you later switch to `fetch`-loaded data), serve it
locally instead:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## What's real here and what's a stand-in

**Real:** the regulatory logic. SB6 (2025)'s ≥75MW interconnection/curtailment
threshold, Gov. Abbott's Aug 2026 pause on new grid-tied interconnections
(with the self-generation exemption), and the specific local actions named
in the brief — Fort Worth's and San Antonio's application pauses, Hill
County's moratorium, Hood County's two rejections — are all wired into the
scoring and shown as notes when they apply to a tile.

**Stand-in:** the map itself. `app.js` defines a 12×9 schematic grid
(`ROW_MASK`) shaped loosely like Texas, with ten named tiles placed at
roughly-correct relative positions and everything else scored by simple
grid-distance to the nearest "substation" tile. It is not pulled from real
geography, and it isn't meant to be — it's a placeholder for the actual
data layer, which this sandbox can't fetch (no network access to HIFLD,
TIGER, EIA, Electricity Maps, or LBNL's Queued Up from here).

## Wiring in the real data layer

The shape of the swap is: replace `ROW_MASK` + `NAMED` in `app.js` with a
real GeoJSON source, and change `evaluateTile()` to read from it instead of
grid-distance math. Concretely, before the event:

1. **County boundaries** — pull Texas counties from Census TIGER/Line, keep
   just the geometry + FIPS + name.
2. **Substations & lines** — HIFLD transmission lines and Open Infrastructure
   Map give you substation points; compute real distance with
   [Turf.js](https://turfjs.org) (`turf.distance`, `turf.booleanPointInPolygon`
   for the protected zones) instead of the row/col Euclidean stand-in.
3. **Capacity & queue** — LBNL's "Queued Up" 2026 and interconnection.fyi
   give you real queue depth per region to discount the capacity-fit score.
4. **Demand baseline** — EIA's Open Data API for regional load context.
5. **Carbon signal** — Electricity Maps for the carbon-intensity factor in
   the composite score.

Pre-process all of the above **once**, offline, into a few flat GeoJSON
files (a Python script with `geopandas` is the natural tool), and have the
frontend fetch those static files — never the live APIs — during the actual
demo. That was the right call in the original brief and it still is: it's
one less thing that can fail on a conference wifi network.

If you want an actual slippy map instead of the schematic grid, swap the
`.tile-grid` for [Mapbox GL JS](https://docs.mapbox.com/mapbox-gl-js/guides/)
or [react-map-gl](https://visgl.github.io/react-map-gl/) with a satellite
style, a real Mapbox token, and a GeoJSON `fill` layer using `feature-state`
for click/selection — the scoring and meter logic in `app.js` carries over
almost unchanged.

## Files

```
index.html   page shell
style.css    all styling
app.js       grid generation, scoring engine, regulatory rules, meters
```
