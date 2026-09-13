/*
 * Texas Datacenter Siting Advisor — real-data build.
 *
 * Data sources (see data/*.geojson "metadata" blocks and README for full
 * provenance):
 *   - County geometry:   US Census cartographic boundary files (2023)
 *   - Power plants:      EIA-860 (2025 annual), Schedule 2 + Schedule 3.1
 *   - Regulatory facts:  hand-curated from the project research brief
 *                        (SB6 2025, Gov. Abbott's Aug 2026 interconnection
 *                        pause, named local pauses/moratoria/rejections)
 *
 * Architecture note (per the project research doc): siting constraints are
 * SEQUENTIAL, not a weighted composite. A site that fails an earlier gate
 * can't be rescued by scoring well on a later one. Gates run in this order:
 *
 *     Power -> Fiber -> Regulation -> Water -> Land
 *
 * "Power" is the only gate backed by a real, siting-relevant proxy dataset
 * right now (nearby EIA-860 generation + interconnected grid voltage,
 * standing in for substation headroom, which is CEII-restricted under 18
 * CFR 388.113 and not public — see README). "Fiber", "Water", and "Land"
 * are wired as real gates in the pipeline but currently always pass with
 * an informational note, because the underlying datasets (FCC BDC /
 * PeeringDB, EPA CWS service boundaries, parcel/zoning) aren't fetched
 * yet — see README "What's wired to real data" for the honest state of
 * each layer and how to extend it.
 */

// ---- regulatory facts, keyed by real Texas county name (see README) ----
var NAMED_REGULATORY = {
  "Tarrant": { status: "paused", reason: "Fort Worth has paused new datacenter applications." },
  "Hood": { status: "blocked", reason: "Hood County rejected two prior siting attempts." },
  "Hill": { status: "blocked", reason: "Hill County passed a moratorium on new datacenter development.", terms: ["moratorium"] },
  "Travis": { status: "blocked", reason: "Residential buffer zone — too close to dense residential development." },
  "Hays": { status: "blocked", reason: "Edwards Aquifer recharge zone — protected from new impervious development." },
  "Bexar": { status: "paused", reason: "San Antonio has paused new datacenter applications." },
  "Ector": { status: "notable", reason: "Dense transmission buildout serving Permian Basin oil & gas load." },
  "Harris": { status: "notable", reason: "Ship-channel industrial corridor — heavy existing interconnection capacity." },
  "Collin": { status: "notable", reason: "North Texas transmission-dense corridor." },
  "Nueces": { status: "notable", reason: "South Texas energy corridor, strong wind generation nearby." }
};

// ---- glossary: plain-language definitions for jargon used in gate notes ----
// Rendered as inline <details> chips next to the sentence that uses the term
// (see note() and appendNoteLi()) so a self-directed learner never has to
// leave the page to look something up.
var GLOSSARY = {
  "EIA-860": "The U.S. Energy Information Administration's annual survey of every power plant 1MW or larger in the country — location, capacity, fuel type, ownership. This app uses the 2025 edition.",
  "nameplate capacity": "The maximum power a generator is rated to produce under ideal conditions, in megawatts (MW). It's a ceiling, not what the plant produces on average — a solar plant's nameplate MW, for instance, only happens at solar noon on a clear day.",
  "grid voltage": "The voltage a plant is wired into, in kilovolts (kV). Higher voltage (230kV+) means long-distance, high-capacity transmission lines, not just local delivery wires — it's a rough signal of how much power a connection point can move.",
  "substation headroom": "How much additional load a substation can actually accept before it needs upgrades. This is the single most important number for a real siting decision — and it's legally non-public (see CEII).",
  "CEII": "Critical Energy Infrastructure Information — a federal designation (18 CFR 388.113) that keeps detailed grid-capacity data out of the public domain, for security reasons. It's why this tool has to estimate power access instead of looking it up.",
  "interconnection": "The physical and contractual process of connecting a new electricity user (or generator) to the grid. \"Grid-tied\" draws power from the shared grid; \"self-generated\" means the facility brings its own power plant.",
  "curtailment": "When a grid operator orders a large customer to temporarily reduce its power draw — usually during high demand — to keep the grid stable.",
  "SB6": "Texas Senate Bill 6 (2025) — requires large electricity users (≥75MW) to register with ERCOT and follow statewide interconnection and curtailment rules.",
  "ERCOT": "The Electric Reliability Council of Texas — runs the power grid for about 90% of the state. It's electrically isolated from the rest of the US grid, which limits Texas's ability to import power during a shortage.",
  "WUE": "Water Usage Effectiveness — liters of water used per kilowatt-hour of IT power delivered. Lower is more water-efficient; it depends heavily on the cooling method.",
  "evaporative cooling": "A cooling method that uses water evaporation to remove heat. It's cheap and energy-efficient but consumes far more water than air or liquid closed-loop cooling.",
  "moratorium": "A temporary, formal halt on new development or permitting in a given area, usually passed by a local government."
};

function note(text, terms) {
  return { text: text, terms: terms || [] };
}

function appendNoteLi(container, item) {
  var li = document.createElement("li");
  var n = (typeof item === "string") ? note(item) : item;
  li.appendChild(document.createTextNode(n.text));
  n.terms.forEach(function (term) {
    var def = GLOSSARY[term];
    if (!def) return;
    var details = document.createElement("details");
    details.className = "term-chip";
    var summary = document.createElement("summary");
    summary.textContent = "ⓘ " + term;
    details.appendChild(summary);
    var defEl = document.createElement("p");
    defEl.className = "term-def";
    defEl.textContent = def;
    details.appendChild(defEl);
    li.appendChild(details);
  });
  container.appendChild(li);
}

// ---- cooling trade-offs (relative units; see gateWater for the real WUE math) ----
var COOLING = {
  air:         { headroom: 16, waterMultiplier: 0.11, approval: 5 },
  evaporative: { headroom: 9,  waterMultiplier: 1.0,  approval: 8 },
  liquid:      { headroom: 7,  waterMultiplier: 0.22, approval: 4 }
};

// Real published coefficients from the project research doc — used for
// the Water and Land gates' informational estimates.
var COEFFICIENTS = {
  GAL_PER_DAY_PER_MW_AVG: 11000,   // 100MW facility ~= 1.1M gal/day at US-average WUE (1.8 L/kWh)
  EVAP_CONSUMED_FRACTION: 0.80,     // evaporative cooling: ~80% of withdrawal is consumed, not returned
  LAND_COST_PER_ACRE: 244000,       // 2024 average
  AVG_CAMPUS_ACRES: 244
};

var baseline = { headroom: 78, water: 64, approval: 72 };
var meters = { headroom: 78, water: 64, approval: 72 };

var state = {
  loadMW: 150,
  interconnect: "grid-tied",
  cooling: "air",
  selected: null,   // {lat, lng}
  placed: []        // [{lat, lng}]
};

var map, countyLayer, plantLayerGroup, selectedMarker, placedLayerGroup;
var countiesData = null;
var plantsData = null;
var countySites = []; // [{feature, centroid:{lat,lng}}] built once counties load

function tierFor(score) {
  if (score >= 75) return { label: "Buildable now", cls: "good" };
  if (score >= 50) return { label: "Minor upgrade", cls: "caution" };
  if (score >= 25) return { label: "Major upgrade", cls: "major" };
  return { label: "Try a nearby site", cls: "bad" };
}

// ---- geometry helpers (no turf.js dependency — plain ray casting) ----
function haversineMiles(lat1, lng1, lat2, lng2) {
  var R = 3958.8;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pointInRing(pt, ring) {
  var x = pt[0], y = pt[1], inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    var xi = ring[i][0], yi = ring[i][1];
    var xj = ring[j][0], yj = ring[j][1];
    var intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoords(pt, rings) {
  if (!pointInRing(pt, rings[0])) return false;
  for (var i = 1; i < rings.length; i++) {
    if (pointInRing(pt, rings[i])) return false; // inside a hole
  }
  return true;
}

function pointInGeometry(pt, geometry) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") return pointInPolygonCoords(pt, geometry.coordinates);
  if (geometry.type === "MultiPolygon") {
    for (var i = 0; i < geometry.coordinates.length; i++) {
      if (pointInPolygonCoords(pt, geometry.coordinates[i])) return true;
    }
  }
  return false;
}

function ringCentroid(ring) {
  var sx = 0, sy = 0;
  for (var i = 0; i < ring.length; i++) { sx += ring[i][0]; sy += ring[i][1]; }
  return [sx / ring.length, sy / ring.length];
}

function geometryCentroid(geometry) {
  var ring;
  if (geometry.type === "Polygon") ring = geometry.coordinates[0];
  else ring = geometry.coordinates[0][0]; // first ring of first part for MultiPolygon
  var c = ringCentroid(ring);
  return { lat: c[1], lng: c[0] };
}

function findCounty(lat, lng) {
  var pt = [lng, lat];
  for (var i = 0; i < countiesData.features.length; i++) {
    var f = countiesData.features[i];
    if (pointInGeometry(pt, f.geometry)) return f;
  }
  return null;
}

// ---- gate 1: Power (real EIA-860 proxy) ----
function nearbyPlants(lat, lng, radiusMiles) {
  var out = [];
  var feats = plantsData.features;
  for (var i = 0; i < feats.length; i++) {
    var c = feats[i].geometry.coordinates; // [lng, lat]
    var d = haversineMiles(lat, lng, c[1], c[0]);
    if (d <= radiusMiles) out.push({ feature: feats[i], distanceMiles: d });
  }
  return out;
}

function gatePower(lat, lng) {
  var nearby100 = nearbyPlants(lat, lng, 100);
  if (nearby100.length === 0) {
    return {
      pass: false,
      blocked: true,
      reason: note("No EIA-860 generation facility within 100 miles — proxy suggests very weak transmission access here.", ["EIA-860"]),
      notes: []
    };
  }
  nearby100.sort(function (a, b) { return a.distanceMiles - b.distanceMiles; });
  var nearest = nearby100[0];

  var within25 = nearby100.filter(function (p) { return p.distanceMiles <= 25; });
  var totalNearbyMW = within25.reduce(function (s, p) { return s + (p.feature.properties.nameplate_mw || 0); }, 0);

  var highVoltage = nearby100.filter(function (p) { return (p.feature.properties.max_grid_voltage_kv || 0) >= 230; });
  var nearestHighVoltage = highVoltage.length ? highVoltage[0] : null;

  var base = 100 - Math.min(90, nearest.distanceMiles * 1.2);
  var capacityBoost = Math.min(20, totalNearbyMW / 500);
  var score = Math.max(5, Math.min(95, Math.round(base + capacityBoost)));

  var notes = [];
  notes.push(note(
    "Estimate: nearest EIA-860 plant is " + nearest.feature.properties.name + " (" +
    nearest.feature.properties.nameplate_mw + " MW), " + nearest.distanceMiles.toFixed(1) +
    " mi away. This is a proxy for grid density, not real substation headroom (CEII-restricted, not public).",
    ["EIA-860", "nameplate capacity", "substation headroom", "CEII"]
  ));
  if (nearestHighVoltage) {
    notes.push(note(
      nearestHighVoltage.feature.properties.max_grid_voltage_kv + "kV+ interconnection nearby: " +
      nearestHighVoltage.feature.properties.name + ", " + nearestHighVoltage.distanceMiles.toFixed(1) + " mi.",
      ["grid voltage"]
    ));
  } else {
    notes.push(note("No 230kV+ interconnected plant found within 100 miles — likely a distribution-only area.", ["grid voltage"]));
  }
  notes.push(note(Math.round(totalNearbyMW).toLocaleString() + " MW of nameplate generation capacity within 25 miles (proxy for local grid strength).", ["nameplate capacity"]));

  if (state.loadMW >= 75) {
    notes.push(note("SB6 (2025): loads ≥75MW are subject to statewide interconnection/curtailment rules.", ["SB6", "ERCOT"]));
  }
  if (state.interconnect === "grid-tied" && score >= 75) {
    score -= 15;
    notes.push(note("Gov. Abbott's Aug 2026 order pauses new grid-tied interconnections pending audit — this cap lifts once the audit clears, or switch to self-generated.", ["interconnection"]));
  }
  if (state.interconnect === "self-generated") {
    notes.push(note("Self-generated facilities are exempt from the Aug 2026 grid-tied interconnection pause.", ["interconnection"]));
  }

  return { pass: true, blocked: false, score: score, notes: notes };
}

// ---- gate 2: Fiber (not wired to real data yet) ----
function gateFiber() {
  return {
    pass: true,
    blocked: false,
    notes: [note("Fiber/long-haul route data (FCC BDC, PeeringDB) is not wired in yet — this gate is a structural placeholder and doesn't affect the score.")]
  };
}

// ---- gate 3: Regulation (real, hand-curated from the research brief) ----
function gateRegulatory(county) {
  if (!county) {
    return { pass: true, blocked: false, notes: [note("Outside a recognized Texas county boundary.")] };
  }
  var name = county.properties.name;
  var reg = NAMED_REGULATORY[name];
  if (!reg) {
    return { pass: true, blocked: false, notes: [], countyName: name };
  }
  if (reg.status === "blocked") {
    return { pass: false, blocked: true, reason: note(reg.reason, reg.terms), notes: [], countyName: name };
  }
  if (reg.status === "paused") {
    return { pass: true, blocked: false, capScore: 55, notes: [note(reg.reason + " Score capped pending local reopening.", reg.terms)], countyName: name };
  }
  // "notable" — informational context from the brief, not a constraint
  return { pass: true, blocked: false, notes: [note(reg.reason, reg.terms)], countyName: name };
}

// ---- gate 4: Water (real published coefficients, no local supply-boundary data yet) ----
function gateWater() {
  var cooling = COOLING[state.cooling];
  var galPerDay = Math.round(state.loadMW * COEFFICIENTS.GAL_PER_DAY_PER_MW_AVG * cooling.waterMultiplier);
  var notes = [
    note(
      "Estimated withdrawal at " + state.loadMW + "MW with " + state.cooling + " cooling: ~" +
      galPerDay.toLocaleString() + " gal/day (US-average WUE coefficient, 1.8 L/kWh, Shehabi/LBNL 2016).",
      ["WUE"]
    ),
    note("Local water-system capacity (EPA CWS service area boundaries) isn't wired in yet — this is a demand estimate only, not checked against real supply.")
  ];
  if (state.cooling === "evaporative") {
    notes.push(note("Evaporative cooling: ~" + Math.round(COEFFICIENTS.EVAP_CONSUMED_FRACTION * 100) + "% of withdrawal is consumed rather than returned to the source.", ["evaporative cooling"]));
  }
  return { pass: true, blocked: false, notes: notes, galPerDay: galPerDay };
}

// ---- gate 5: Land (real published coefficients, no parcel/zoning data yet) ----
function gateLand() {
  var estCost = COEFFICIENTS.LAND_COST_PER_ACRE * COEFFICIENTS.AVG_CAMPUS_ACRES;
  return {
    pass: true,
    blocked: false,
    notes: [
      note(
        "Reference baseline: a " + COEFFICIENTS.AVG_CAMPUS_ACRES + "-acre campus at $" +
        COEFFICIENTS.LAND_COST_PER_ACRE.toLocaleString() + "/acre (2024 avg) ≈ $" +
        (estCost / 1e6).toFixed(0) + "M land cost — not adjusted for this specific site; parcel/zoning data isn't wired in yet."
      )
    ]
  };
}

// ---- sequential gate-then-explain evaluation ----
// Power -> Fiber -> Regulation -> Water -> Land. A site failing an earlier
// gate is blocked regardless of how later gates would score — see the
// architecture note at the top of this file.
function evaluateSite(lat, lng) {
  var county = findCounty(lat, lng);
  var countyName = county ? county.properties.name : null;
  var name = countyName ? (countyName + " County") : ("Unnamed site (" + lat.toFixed(2) + ", " + lng.toFixed(2) + ")");

  var gates = [
    { key: "power", label: "Power", result: gatePower(lat, lng) },
  ];
  gates.push({ key: "fiber", label: "Fiber", result: gateFiber() });
  var regResult = gateRegulatory(county);
  gates.push({ key: "regulatory", label: "Regulation", result: regResult });
  if (regResult.countyName) name = regResult.countyName + " County";

  for (var i = 0; i < gates.length; i++) {
    if (gates[i].result.blocked) {
      return { blocked: true, name: name, blockingGate: gates[i].label, reason: gates[i].result.reason, gates: gates };
    }
  }

  gates.push({ key: "water", label: "Water", result: gateWater() });
  gates.push({ key: "land", label: "Land", result: gateLand() });

  var score = gates[0].result.score;
  if (typeof regResult.capScore === "number") score = Math.min(score, regResult.capScore);
  var tier = tierFor(score);

  return { blocked: false, name: name, score: score, tier: tier, gates: gates };
}

function randomFrom(arr) {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}

// Pools for the demo buttons, re-evaluated on each click (evaluateSite
// depends on the current load/interconnect/cooling controls) so the demo
// stays consistent with whatever the user has dialed in, and so repeated
// clicks land on a different real example instead of always the same one.
function blockedCountySites() {
  return countySites.filter(function (s) {
    var reg = NAMED_REGULATORY[s.feature.properties.name];
    return reg && reg.status === "blocked";
  });
}

function goodCountySites() {
  return countySites.filter(function (s) {
    var ev = evaluateSite(s.centroid.lat, s.centroid.lng);
    return !ev.blocked && ev.tier.cls === "good";
  });
}

function suggestNearby(lat, lng) {
  var best = null, bestScore = -1, bestDist = Infinity;
  countySites.forEach(function (site) {
    var ev = evaluateSite(site.centroid.lat, site.centroid.lng);
    if (ev.blocked) return;
    var dist = haversineMiles(lat, lng, site.centroid.lat, site.centroid.lng);
    if (ev.score > bestScore || (ev.score === bestScore && dist < bestDist)) {
      best = ev; bestScore = ev.score; bestDist = dist;
    }
  });
  return best;
}

// ---- map rendering ----
function countyFillClass(feature) {
  var name = feature.properties.name;
  var reg = NAMED_REGULATORY[name];
  if (reg && reg.status === "blocked") return "bad";
  if (reg && reg.status === "paused") return "paused";
  var c = geometryCentroid(feature.geometry);
  var pw = gatePower(c.lat, c.lng);
  if (!pw.pass) return "bad";
  return tierFor(pw.score).cls;
}

var FILL_COLORS = { good: "#4fbf8b", caution: "#e8a33d", major: "#d9793d", bad: "#e0614a", paused: "#8a7fd0" };

function styleCounty(feature) {
  var cls = countyFillClass(feature);
  return {
    fillColor: FILL_COLORS[cls] || "#2a3947",
    fillOpacity: 0.35,
    color: "#2a3947",
    weight: 1
  };
}

function initMap() {
  map = L.map("map", { scrollWheelZoom: true }).setView([31.4, -99.3], 6);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    maxZoom: 12
  }).addTo(map);

  countyLayer = L.geoJSON(countiesData, {
    style: styleCounty,
    onEachFeature: function (feature, layer) {
      layer.on("click", function (e) {
        L.DomEvent.stopPropagation(e);
        onMapClick(e.latlng.lat, e.latlng.lng);
      });
      layer.bindTooltip(feature.properties.name + " County", { sticky: true });
    }
  }).addTo(map);

  plantLayerGroup = L.layerGroup().addTo(map);
  plantsData.features.forEach(function (f) {
    var mw = f.properties.nameplate_mw || 0;
    var r = Math.max(2, Math.min(14, Math.sqrt(mw) * 0.6));
    var marker = L.circleMarker([f.geometry.coordinates[1], f.geometry.coordinates[0]], {
      radius: r,
      color: "#5fc9d9",
      weight: 1,
      fillOpacity: 0.35,
      opacity: 0.7
    });
    marker.bindTooltip(f.properties.name + " — " + mw + " MW (" + (f.properties.technologies || []).join(", ") + ")");
    marker.addTo(plantLayerGroup);
  });

  placedLayerGroup = L.layerGroup().addTo(map);

  map.on("click", function (e) { onMapClick(e.latlng.lat, e.latlng.lng); });

  document.getElementById("togglePlants").addEventListener("change", function (e) {
    if (e.target.checked) map.addLayer(plantLayerGroup);
    else map.removeLayer(plantLayerGroup);
  });
}

function repaintCounties() {
  if (countyLayer) countyLayer.setStyle(styleCounty);
}

// ---- side panel ----
function renderTilePanel() {
  var empty = document.getElementById("tileEmpty");
  var detail = document.getElementById("tileDetail");
  if (!state.selected) {
    empty.style.display = "block";
    detail.style.display = "none";
    return;
  }
  var ev = evaluateSite(state.selected.lat, state.selected.lng);
  empty.style.display = "none";
  detail.style.display = "block";

  document.getElementById("tileName").textContent = ev.name;
  var scoreEl = document.getElementById("tileScore");
  var tierEl = document.getElementById("tileTier");
  var notesEl = document.getElementById("tileNotes");
  var gateListEl = document.getElementById("gateList");
  notesEl.innerHTML = "";
  gateListEl.innerHTML = "";
  var placeBtn = document.getElementById("placeBtn");

  ev.gates.forEach(function (g) {
    var row = document.createElement("div");
    row.className = "gate-row" + (g.result.blocked ? " gate-blocked" : "");
    row.textContent = g.label + (g.result.blocked ? " — blocked" : (g.result.score !== undefined ? " — " + g.result.score : " — ok"));
    gateListEl.appendChild(row);
  });

  if (ev.blocked) {
    scoreEl.textContent = "—";
    scoreEl.style.color = "var(--bad)";
    tierEl.textContent = "Blocked at " + ev.blockingGate + " gate";
    tierEl.style.color = "var(--bad)";
    appendNoteLi(notesEl, ev.reason);

    var nearEv = suggestNearby(state.selected.lat, state.selected.lng);
    if (nearEv) {
      appendNoteLi(notesEl, "Nearest viable alternative: " + nearEv.name + " (" + nearEv.tier.label + ").");
    }
    placeBtn.disabled = true;
    placeBtn.textContent = "Can't place — blocked";
  } else {
    scoreEl.textContent = ev.score;
    scoreEl.style.color = "var(--" + ev.tier.cls + ")";
    tierEl.textContent = ev.tier.label;
    tierEl.style.color = "var(--" + ev.tier.cls + ")";
    ev.gates.forEach(function (g) {
      g.result.notes.forEach(function (n) {
        appendNoteLi(notesEl, n);
      });
    });
    var alreadyPlaced = state.placed.some(function (p) { return p.lat === state.selected.lat && p.lng === state.selected.lng; });
    placeBtn.disabled = alreadyPlaced;
    placeBtn.textContent = alreadyPlaced ? "Placed" : "Place datacenter here";
  }
}

function onMapClick(lat, lng) {
  state.selected = { lat: lat, lng: lng };
  if (selectedMarker) map.removeLayer(selectedMarker);
  selectedMarker = L.circleMarker([lat, lng], { radius: 8, color: "#e7edf2", weight: 2, fillOpacity: 0 }).addTo(map);
  renderTilePanel();
}

// ---- meters ----
function renderMeters() {
  document.getElementById("headroomVal").textContent = meters.headroom;
  document.getElementById("waterVal").textContent = meters.water;
  document.getElementById("approvalVal").textContent = meters.approval;
  document.getElementById("headroomFill").style.width = meters.headroom + "%";
  document.getElementById("waterFill").style.width = meters.water + "%";
  document.getElementById("approvalFill").style.width = meters.approval + "%";
}

function placeDatacenter() {
  if (!state.selected) return;
  var ev = evaluateSite(state.selected.lat, state.selected.lng);
  if (ev.blocked) return;

  var cooling = COOLING[state.cooling];
  var loadFactor = state.loadMW / 150;
  var headroomDrain = cooling.headroom * loadFactor + (state.interconnect === "grid-tied" ? 6 : 0);
  var waterGate = ev.gates.filter(function (g) { return g.key === "water"; })[0];
  var waterDrain = waterGate ? Math.min(30, waterGate.result.galPerDay / 200000) : 0;
  var approvalDrain = cooling.approval + (ev.tier.cls === "paused" ? 6 : 0) - (state.interconnect === "self-generated" ? 3 : 0);

  meters.headroom = Math.max(0, Math.round(meters.headroom - headroomDrain));
  meters.water = Math.max(0, Math.round(meters.water - waterDrain));
  meters.approval = Math.max(0, Math.round(meters.approval - approvalDrain));

  state.placed.push(state.selected);
  L.circleMarker([state.selected.lat, state.selected.lng], { radius: 6, color: "#e7edf2", weight: 2, fillColor: "#e7edf2", fillOpacity: 0.9 }).addTo(placedLayerGroup);

  renderMeters();
  renderTilePanel();
}

function resetSimulation() {
  state.selected = null;
  state.placed = [];
  meters = Object.assign({}, baseline);
  if (selectedMarker) { map.removeLayer(selectedMarker); selectedMarker = null; }
  if (placedLayerGroup) placedLayerGroup.clearLayers();
  renderMeters();
  renderTilePanel();
}

// ---- controls ----
function wireControls() {
  var loadSlider = document.getElementById("loadMW");
  loadSlider.addEventListener("input", function () {
    state.loadMW = +loadSlider.value;
    document.getElementById("loadMWVal").textContent = state.loadMW;
    repaintCounties();
    renderTilePanel();
  });

  document.querySelectorAll("#interconnectToggle .toggle-opt").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#interconnectToggle .toggle-opt").forEach(function (b) { b.classList.remove("selected"); });
      btn.classList.add("selected");
      state.interconnect = btn.dataset.value;
      repaintCounties();
      renderTilePanel();
    });
  });

  document.querySelectorAll("#coolingToggle .toggle-opt").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#coolingToggle .toggle-opt").forEach(function (b) { b.classList.remove("selected"); });
      btn.classList.add("selected");
      state.cooling = btn.dataset.value;
      renderTilePanel();
    });
  });

  document.getElementById("placeBtn").addEventListener("click", placeDatacenter);
  document.getElementById("resetBtn").addEventListener("click", resetSimulation);

  document.getElementById("loadBadBtn").addEventListener("click", function () {
    resetSimulation();
    var site = randomFrom(blockedCountySites());
    if (site) { map.setView([site.centroid.lat, site.centroid.lng], 8); onMapClick(site.centroid.lat, site.centroid.lng); }
  });
  document.getElementById("loadGoodBtn").addEventListener("click", function () {
    resetSimulation();
    var site = randomFrom(goodCountySites());
    if (site) { map.setView([site.centroid.lat, site.centroid.lng], 8); onMapClick(site.centroid.lat, site.centroid.lng); }
  });
}

// ---- data explorer (educational): real stats computed from the loaded ----
// EIA-860 dataset, so a self-directed learner can look at the raw data
// feeding the simulation, not just the tool's output.
function buildDataExplorer() {
  var feats = plantsData.features;
  var totalMW = 0;
  var techMW = {};
  var buckets = [
    { label: "under 10 MW", test: function (mw) { return mw < 10; }, count: 0 },
    { label: "10–50 MW", test: function (mw) { return mw >= 10 && mw < 50; }, count: 0 },
    { label: "50–200 MW", test: function (mw) { return mw >= 50 && mw < 200; }, count: 0 },
    { label: "200–1,000 MW", test: function (mw) { return mw >= 200 && mw < 1000; }, count: 0 },
    { label: "1,000 MW or more", test: function (mw) { return mw >= 1000; }, count: 0 }
  ];
  var largest = null;

  feats.forEach(function (f) {
    var mw = f.properties.nameplate_mw || 0;
    totalMW += mw;
    var techs = f.properties.technologies && f.properties.technologies.length ? f.properties.technologies : ["Unknown"];
    techs.forEach(function (t) { techMW[t] = (techMW[t] || 0) + mw / techs.length; });
    buckets.forEach(function (b) { if (b.test(mw)) b.count++; });
    if (!largest || mw > (largest.properties.nameplate_mw || 0)) largest = f;
  });

  var topTech = Object.keys(techMW)
    .map(function (k) { return { name: k, mw: techMW[k] }; })
    .sort(function (a, b) { return b.mw - a.mw; })
    .slice(0, 8);
  var maxTechMW = topTech.length ? topTech[0].mw : 1;
  var maxBucketCount = Math.max.apply(null, buckets.map(function (b) { return b.count; }));

  document.getElementById("explorerSummary").textContent =
    feats.length.toLocaleString() + " Texas power plants in EIA-860 (2025), totaling " +
    Math.round(totalMW).toLocaleString() + " MW of nameplate capacity. Largest: " +
    largest.properties.name + " (" + largest.properties.nameplate_mw.toLocaleString() + " MW, " + largest.properties.county + " County).";

  var techEl = document.getElementById("explorerTech");
  techEl.innerHTML = "";
  topTech.forEach(function (t) {
    var row = document.createElement("div");
    row.className = "bar-row";
    var pct = Math.max(2, Math.round((t.mw / maxTechMW) * 100));
    row.innerHTML =
      '<div class="bar-label" title="' + t.name.replace(/"/g, "&quot;") + '">' + t.name + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="bar-value">' + Math.round(t.mw).toLocaleString() + ' MW</div>';
    techEl.appendChild(row);
  });

  var bucketEl = document.getElementById("explorerBuckets");
  bucketEl.innerHTML = "";
  buckets.forEach(function (b) {
    var row = document.createElement("div");
    row.className = "bar-row";
    var pct = Math.max(2, Math.round((b.count / maxBucketCount) * 100));
    row.innerHTML =
      '<div class="bar-label">' + b.label + '</div>' +
      '<div class="bar-track"><div class="bar-fill bar-fill-alt" style="width:' + pct + '%"></div></div>' +
      '<div class="bar-value">' + b.count.toLocaleString() + ' plants</div>';
    bucketEl.appendChild(row);
  });
}

// ---- intro walkthrough (educational): shown once for first-time,
// self-directed visitors; dismissal remembered in localStorage. ----
function wireIntro() {
  var overlay = document.getElementById("introOverlay");
  if (!overlay) return;
  var seen = false;
  try { seen = localStorage.getItem("dcAdvisorSeenIntro") === "1"; } catch (e) { /* private browsing etc. */ }
  if (!seen) overlay.hidden = false;

  function dismiss() {
    overlay.hidden = true;
    try { localStorage.setItem("dcAdvisorSeenIntro", "1"); } catch (e) { /* ignore */ }
  }
  document.getElementById("introDismiss").addEventListener("click", dismiss);
  document.getElementById("helpBtn").addEventListener("click", function () { overlay.hidden = false; });
}

// ---- init ----
function setStatus(msg) {
  var el = document.getElementById("mapStatus");
  if (el) el.textContent = msg;
}

Promise.all([
  fetch("data/counties_tx.geojson").then(function (r) { return r.json(); }),
  fetch("data/power_plants_tx.geojson").then(function (r) { return r.json(); })
]).then(function (results) {
  countiesData = results[0];
  plantsData = results[1];
  countySites = countiesData.features.map(function (f) {
    return { feature: f, centroid: geometryCentroid(f.geometry) };
  });
  initMap();
  wireControls();
  wireIntro();
  buildDataExplorer();
  renderMeters();
  renderTilePanel();
  setStatus(countiesData.features.length + " counties, " + plantsData.features.length + " power plants loaded (real data — see README).");
}).catch(function (err) {
  setStatus("Failed to load data/*.geojson — serve this over HTTP (python3 -m http.server), not file://. " + err);
  console.error(err);
});
