# Texas Datacenter Siting Advisor — demo

A siting tool built on real public infrastructure data: click anywhere in
Texas, see a capacity estimate, a tier ("buildable now" through "try a
nearby site"), and — when a site is blocked — what's blocking it and where
to look instead.

This build targets **standalone, self-directed learning** — there's no
instructor in the room, so the tool explains itself:

- **"How this works" overlay** (shown on first visit, reopenable from the
  topbar) walks through the five-gate model before a first-time user clicks
  anything.
- **Inline glossary chips** — click any jargon term in a gate's notes
  (`EIA-860`, `WUE`, `CEII`, `SB6`, `grid voltage`, ...) to expand a
  plain-language definition right there, no separate glossary page to lose
  your place in. Defined in `GLOSSARY` in `app.js`.
- **"Explore the data" panel** below the map computes real statistics —
  generation mix by technology, plant-size distribution, the single
  largest plant — directly from the same 1,532-plant EIA-860 file driving
  the map, in the browser, so a learner can look at the underlying dataset
  itself and not just the simulation's output.

## Run it

No build step, no API key required. The app fetches its data files at
runtime, so it needs to be served over HTTP (not opened as a `file://` URL):

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Architecture: sequential gates, not a weighted score

Per the project's data-source research, siting constraints are **sequential,
not weighted**: a site that fails on power access can't be rescued by
scoring well on water availability. `app.js` evaluates every site through
five gates, in order, and stops at the first one that blocks:

```
Power → Fiber → Regulation → Water → Land
```

Each gate is a real function in `app.js` (`gatePower`, `gateFiber`,
`gateRegulatory`, `gateWater`, `gateLand`) so the pipeline is real even
where the underlying dataset isn't wired in yet (see below).

## What's wired to real data, what's a documented estimate, and what's a placeholder

| Layer | Status | Source |
|---|---|---|
| County boundaries | **Real geometry** | US Census cartographic boundary files, 2023, 20m resolution |
| Power/transmission proxy | **Real data, labeled estimate** | EIA-860 (2025 annual) plants + generators |
| Regulatory rules | **Real facts, hand-curated** | Project research brief (SB6 2025, Gov. Abbott's Aug 2026 order, named local actions) |
| Water demand | **Real coefficients, no local supply data** | Shehabi/LBNL 2016 WUE figures, hard-coded |
| Land cost | **Real coefficients, no parcel data** | 2024 avg $/acre + campus size, hard-coded |
| Fiber/long-haul routes | **Not wired in** | Structural placeholder gate, always passes |

### Power — real data, but an estimate by necessity

The one thing this tool can't get from a public source is **substation
interconnection headroom** — it's CEII-restricted under 18 CFR 388.113 and
legally not public. `gatePower()` in `app.js` uses nearby generation
capacity and interconnected grid voltage from EIA-860 as a *proxy* for
transmission density instead, and every note it produces says so. Treat the
power score as directional, not authoritative.

`data/power_plants_tx.geojson` (1,532 Texas plants with coordinates) is
built by `scripts/build_power_layer.py` from the EIA-860 annual release
(Schedule 2 "Plant" + Schedule 3.1 "Generator, Operable"):
<https://www.eia.gov/electricity/data/eia860/>. It sums nameplate capacity
per plant and carries the plant's interconnected grid voltage(s).

### Regulation — real, from the project brief

`NAMED_REGULATORY` in `app.js` carries the specific facts from the research
brief onto their real counties: SB6 (2025)'s ≥75MW interconnection/
curtailment threshold, Gov. Abbott's Aug 2026 pause on new grid-tied
interconnections (with the self-generation exemption), Fort Worth's and San
Antonio's application pauses, Hill County's moratorium, and Hood County's
two rejections. There's no national dataset for local moratoria/pauses —
per the research doc, this has to be hand-curated per region, which is what
this is.

### Water and Land — real coefficients, no location-specific data yet

`gateWater()` computes an actual water-withdrawal estimate from the
proposed load and cooling type using published WUE figures (US average 1.8
L/kWh; a 100MW facility ≈ 1.1M gal/day; evaporative cooling consumes ~80%
of withdrawal). `gateLand()` surfaces the 2024 average $/acre and typical
campus size. Neither is checked against a real local dataset yet — EPA's
Clean Water System service area boundaries (water) and parcel/zoning data
(land) aren't fetched. Both gates always pass; they're informational.

### The second data hole: large-load interconnection queues

Per the research doc, the queue data centers actually file into (distinct
from generation interconnection queues, and excluded from LBNL's public
"Queued Up" tracker) isn't standardized or centrally published anywhere.
Parsing ERCOT's Large Load Working Group postings into a structured queue
layer is flagged in the research as the project's differentiator, not yet
attempted here.

## Rebuilding the data files

```bash
# Power plants (downloads ~24MB from eia.gov, extract first):
curl -O https://www.eia.gov/electricity/data/eia860/xls/eia8602025.zip
unzip eia8602025.zip -d /tmp/eia860
pip install openpyxl
python3 scripts/build_power_layer.py /tmp/eia860

# County boundaries (downloads ~900KB from census.gov, extract first):
curl -O https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_20m.zip
unzip cb_2023_us_county_20m.zip -d /tmp/counties
pip install pyshp
python3 scripts/build_county_layer.py /tmp/counties
```

Both scripts are pinned to a specific EIA/Census release in their source
URLs (2025 EIA-860, 2023 Census cartographic boundaries) — rerun against a
newer release by changing the download URL.

## Next steps (per the research doc's build order)

1. **EPA CWS service area boundaries** + **WRI Aqueduct** water-stress data
   — turn `gateWater()` from a demand estimate into a real supply check.
2. **FCC Broadband Data Collection** / **PeeringDB** — give `gateFiber()`
   something real to check against.
3. **gridstatus (ERCOT)** + **EIA-930** — live grid state instead of the
   static EIA-860 snapshot.
4. **ERCOT Large Load Working Group** queue parsing — the project's
   differentiator per the research doc; no public source exists yet, so
   this means structured scraping/parsing, not a data download.

## Files

```
index.html              page shell
style.css                all styling
app.js                    map rendering, gate pipeline, regulatory rules, meters
data/counties_tx.geojson         254 TX counties (Census cartographic boundary, 2023)
data/power_plants_tx.geojson     1,532 TX power plants (EIA-860, 2025)
scripts/build_county_layer.py    regenerates the county GeoJSON from a Census shapefile
scripts/build_power_layer.py     regenerates the power-plant GeoJSON from EIA-860 xlsx
vendor/leaflet/                   Leaflet 1.9.4, vendored (not CDN-loaded, so this
                                   works offline and isn't dependent on a third-party
                                   CDN being reachable)
```
