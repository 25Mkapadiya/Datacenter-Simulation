/*
 * Texas Datacenter Siting Advisor — demo logic.
 *
 * Everything below runs client-side against the REGIONS data defined here.
 * REGIONS is a schematic 12x9 grid standing in for a real GeoJSON layer —
 * see README.md for how to replace it with actual HIFLD / TIGER / LBNL data.
 */

// ---- grid shape: which (row, col) cells exist, per row [startCol, endCol] ----
var ROW_MASK = [
  [4, 6],   // row 0 — panhandle
  [4, 7],   // row 1
  [3, 8],   // row 2 — north Texas / DFW band
  [2, 9],   // row 3
  [1, 10],  // row 4 — central Texas
  [0, 11],  // row 5 — widest band
  [1, 10],  // row 6 — south / coastal
  [2, 9],   // row 7
  [4, 7]    // row 8 — Rio Grande Valley
];
var COLS = 12, ROWS = ROW_MASK.length;

// ---- named tiles grounded in the real facts from the project brief ----
// key: "row,col"
var NAMED = {
  "2,5": { name: "Tarrant County (Fort Worth)", status: "paused",
    reason: "Fort Worth has paused new datacenter applications." },
  "3,4": { name: "Hood County", status: "blocked",
    reason: "Hood County rejected two prior siting attempts." },
  "4,5": { name: "Hill County", status: "blocked",
    reason: "Hill County passed a moratorium on new datacenter development." },
  "5,5": { name: "Travis County (Austin)", status: "blocked",
    reason: "Residential buffer zone — too close to dense residential development." },
  "5,4": { name: "Hays County", status: "blocked",
    reason: "Edwards Aquifer recharge zone — protected from new impervious development." },
  "6,4": { name: "Bexar County (San Antonio)", status: "paused",
    reason: "San Antonio has paused new datacenter applications." },
  "4,2": { name: "Ector County (Permian Basin)", status: "substation",
    reason: "Dense transmission buildout serving Permian Basin oil & gas load." },
  "5,9": { name: "Harris County (Houston)", status: "substation",
    reason: "Ship-channel industrial corridor — heavy existing interconnection capacity." },
  "2,7": { name: "Collin County", status: "substation",
    reason: "North Texas transmission-dense corridor." },
  "7,7": { name: "Nueces County (Coastal Bend)", status: "substation",
    reason: "South Texas energy corridor, strong wind generation nearby." }
};

var GOOD_EXAMPLE = "4,2";
var BAD_EXAMPLE = "3,4";

// ---- cooling and interconnection trade-offs ----
var COOLING = {
  air:         { headroom: 16, water: 2,  approval: 5 },
  evaporative: { headroom: 9,  water: 18, approval: 8 },
  liquid:      { headroom: 7,  water: 4,  approval: 4 }
};

var baseline = { headroom: 78, water: 64, approval: 72 };
var meters = { headroom: 78, water: 64, approval: 72 };

var state = {
  loadMW: 150,
  interconnect: "grid-tied",
  cooling: "air",
  selected: null,   // "row,col"
  placed: {}        // "row,col": true
};

var tiles = {}; // "row,col" -> DOM element

function tierFor(score) {
  if (score >= 75) return { label: "Buildable now", cls: "good" };
  if (score >= 50) return { label: "Minor upgrade", cls: "caution" };
  if (score >= 25) return { label: "Major upgrade", cls: "major" };
  return { label: "Try a nearby site", cls: "bad" };
}

function substationTiles() {
  return Object.keys(NAMED).filter(function (k) { return NAMED[k].status === "substation"; });
}

// core scoring: capacity fit (distance to nearest substation) discounted by
// local application pauses and the statewide grid-tied interconnection order.
function evaluateTile(key) {
  var named = NAMED[key];

  if (named && named.status === "blocked") {
    return { blocked: true, name: named.name, reason: named.reason };
  }

  var name = named ? named.name : "Unnamed county — tile " + key;
  var score;

  if (named && named.status === "substation") {
    score = 92;
  } else {
    var parts = key.split(",").map(Number);
    var row = parts[0], col = parts[1];
    var subs = substationTiles();
    var minDist = Math.min.apply(null, subs.map(function (sKey) {
      var sParts = sKey.split(",").map(Number);
      return Math.hypot(row - sParts[0], col - sParts[1]);
    }));
    score = Math.max(8, Math.min(90, Math.round(88 - minDist * 9)));
  }

  var notes = [];

  if (named && named.status === "paused") {
    score = Math.min(score, 55);
    notes.push(named.reason + " Score capped pending local reopening.");
  }

  if (state.interconnect === "grid-tied" && score >= 75) {
    score -= 15;
    notes.push("Gov. Abbott's Aug 2026 order pauses new grid-tied interconnections pending audit — this cap lifts once the audit clears, or switch to self-generated.");
  }
  if (state.interconnect === "self-generated") {
    notes.push("Self-generated facilities are exempt from the Aug 2026 grid-tied interconnection pause.");
  }
  if (state.loadMW >= 75) {
    notes.push("SB6 (2025): loads \u226575MW are subject to statewide interconnection/curtailment rules.");
  }

  var tier = tierFor(score);
  return { blocked: false, name: name, score: score, tier: tier, notes: notes };
}

function suggestNearby(key) {
  var parts = key.split(",").map(Number);
  var row = parts[0], col = parts[1];
  var best = null, bestScore = -1, bestDist = Infinity;
  Object.keys(tiles).forEach(function (k) {
    if (k === key) return;
    var ev = evaluateTile(k);
    if (ev.blocked) return;
    var kParts = k.split(",").map(Number);
    var dist = Math.hypot(row - kParts[0], col - kParts[1]);
    if (ev.score > bestScore || (ev.score === bestScore && dist < bestDist)) {
      best = k; bestScore = ev.score; bestDist = dist;
    }
  });
  return best;
}

// ---- grid rendering ----
function buildGrid() {
  var grid = document.getElementById("tileGrid");
  for (var row = 0; row < ROWS; row++) {
    for (var col = 0; col < COLS; col++) {
      var el = document.createElement("button");
      var inRow = col >= ROW_MASK[row][0] && col <= ROW_MASK[row][1];
      if (!inRow) {
        el.className = "tile empty";
        el.tabIndex = -1;
        grid.appendChild(el);
        continue;
      }
      var key = row + "," + col;
      el.className = "tile";
      el.dataset.key = key;
      var named = NAMED[key];
      if (named && named.status === "substation") el.classList.add("substation");
      el.setAttribute("aria-label", named ? named.name : "tile " + key);
      el.addEventListener("click", function (e) { onTileClick(e.currentTarget.dataset.key); });
      grid.appendChild(el);
      tiles[key] = el;
    }
  }
}

function paintTile(key) {
  var el = tiles[key];
  if (!el) return;
  el.classList.remove("good", "caution", "major", "bad", "paused", "selected");

  var named = NAMED[key];
  if (named && named.status === "blocked") {
    el.classList.add("bad");
  } else if (named && named.status === "paused") {
    el.classList.add("paused");
  } else {
    var ev = evaluateTile(key);
    if (!ev.blocked) el.classList.add(ev.tier.cls);
  }
  if (state.selected === key) el.classList.add("selected");
  el.classList.toggle("placed", !!state.placed[key]);
}

function paintAll() {
  Object.keys(tiles).forEach(paintTile);
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
  var ev = evaluateTile(state.selected);
  empty.style.display = "none";
  detail.style.display = "block";

  document.getElementById("tileName").textContent = ev.name;
  var scoreEl = document.getElementById("tileScore");
  var tierEl = document.getElementById("tileTier");
  var notesEl = document.getElementById("tileNotes");
  notesEl.innerHTML = "";
  var placeBtn = document.getElementById("placeBtn");

  if (ev.blocked) {
    scoreEl.textContent = "—";
    scoreEl.style.color = "var(--bad)";
    tierEl.textContent = "Blocked";
    tierEl.style.color = "var(--bad)";
    var li = document.createElement("li");
    li.textContent = ev.reason;
    notesEl.appendChild(li);

    var nearKey = suggestNearby(state.selected);
    if (nearKey) {
      var nearEv = evaluateTile(nearKey);
      var li2 = document.createElement("li");
      li2.textContent = "Nearest viable alternative: " + nearEv.name + " (" + nearEv.tier.label + ").";
      notesEl.appendChild(li2);
    }
    placeBtn.disabled = true;
    placeBtn.textContent = "Can't place — protected zone";
  } else {
    scoreEl.textContent = ev.score;
    scoreEl.style.color = "var(--" + ev.tier.cls + ")";
    tierEl.textContent = ev.tier.label;
    tierEl.style.color = "var(--" + ev.tier.cls + ")";
    ev.notes.forEach(function (n) {
      var l = document.createElement("li");
      l.textContent = n;
      notesEl.appendChild(l);
    });
    var alreadyPlaced = !!state.placed[state.selected];
    placeBtn.disabled = alreadyPlaced;
    placeBtn.textContent = alreadyPlaced ? "Placed" : "Place datacenter here";
  }
}

function onTileClick(key) {
  state.selected = key;
  paintAll();
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
  var ev = evaluateTile(state.selected);
  if (ev.blocked) return;

  var cooling = COOLING[state.cooling];
  var loadFactor = state.loadMW / 150;
  var headroomDrain = cooling.headroom * loadFactor + (state.interconnect === "grid-tied" ? 6 : 0);
  var waterDrain = cooling.water * loadFactor;
  var approvalDrain = cooling.approval + (ev.tier.cls === "paused" ? 6 : 0) - (state.interconnect === "self-generated" ? 3 : 0);

  meters.headroom = Math.max(0, Math.round(meters.headroom - headroomDrain));
  meters.water = Math.max(0, Math.round(meters.water - waterDrain));
  meters.approval = Math.max(0, Math.round(meters.approval - approvalDrain));

  state.placed[state.selected] = true;
  renderMeters();
  paintAll();
  renderTilePanel();
}

function resetSimulation() {
  state.selected = null;
  state.placed = {};
  meters = Object.assign({}, baseline);
  renderMeters();
  paintAll();
  renderTilePanel();
}

// ---- controls ----
function wireControls() {
  var loadSlider = document.getElementById("loadMW");
  loadSlider.addEventListener("input", function () {
    state.loadMW = +loadSlider.value;
    document.getElementById("loadMWVal").textContent = state.loadMW;
    paintAll();
    renderTilePanel();
  });

  document.querySelectorAll("#interconnectToggle .toggle-opt").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#interconnectToggle .toggle-opt").forEach(function (b) { b.classList.remove("selected"); });
      btn.classList.add("selected");
      state.interconnect = btn.dataset.value;
      paintAll();
      renderTilePanel();
    });
  });

  document.querySelectorAll("#coolingToggle .toggle-opt").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll("#coolingToggle .toggle-opt").forEach(function (b) { b.classList.remove("selected"); });
      btn.classList.add("selected");
      state.cooling = btn.dataset.value;
    });
  });

  document.getElementById("placeBtn").addEventListener("click", placeDatacenter);
  document.getElementById("resetBtn").addEventListener("click", resetSimulation);

  document.getElementById("loadBadBtn").addEventListener("click", function () {
    resetSimulation();
    onTileClick(BAD_EXAMPLE);
  });
  document.getElementById("loadGoodBtn").addEventListener("click", function () {
    resetSimulation();
    onTileClick(GOOD_EXAMPLE);
  });
}

// ---- init ----
buildGrid();
wireControls();
paintAll();
renderMeters();
renderTilePanel();
