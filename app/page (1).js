/*
FILE: app/page.js
SUMMARY: Mobile-first Phrazagram page with Level‑1 word‑tied cluing + highlight, Level‑2 randomized cluing, and a per‑level Hide/Show clues toggle with two‑line wrapped clue text.
FEATURES:
- Derives grid from puzzles.json (A–Z only) and renders draggable tiles with greens lock and lattice.
- Level 1: clue bar uses `clue_order`; active word tiles get a subtle blue outline; non‑green tiles in the active word invert background/text colors.
- Level 2: adds a clue bar that cycles clues in randomized order (from JSON) without word highlighting.
- New Hide/Show clues toggle appears above the Next button on both levels; session‑only.
- Clue text clamps/wraps to two lines on small screens (e.g., iPhone SE).
*/
"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/* ----------------------------- tiny utils ----------------------------- */

// NFD → strip accents → uppercase → A–Z only
function normalizeAZ(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

// enumerate unique grid cells in deterministic order (Spec §1.2)
function enumerateCells(words) {
  const seen = new Set();
  const cells = [];
  const solutionLetters = [];
  for (const w of words || []) {
    const t = normalizeAZ(w.text);
    const horiz = w.dir === "H";
    for (let i = 0; i < t.length; i++) {
      const r = w.row + (horiz ? 0 : i);
      const c = w.col + (horiz ? i : 0);
      const key = `${r},${c}`; // 0-based keys
      if (!seen.has(key)) {
        seen.add(key);
        cells.push({ row: r, col: c });
        solutionLetters.push(t[i]);
      } else {
        const idx = cells.findIndex((p) => p.row === r && p.col === c);
        if (idx >= 0 && solutionLetters[idx] !== t[i]) {
          throw new Error(
            `Grid conflict at (${r},${c}): '${solutionLetters[idx]}' vs '${t[i]}'`
          );
        }
      }
    }
  }
  return { cells, solutionLetters };
}

// assign first-fit locations (Spec §1.3)
function assignLocations(lettersTop, solutionLetters, cells) {
  const N = lettersTop.length;
  const claimed = new Array(solutionLetters.length).fill(false);
  const cellForLocation = new Array(N + 1);
  const requiredLetterAt = new Array(N + 1);
  const locationForCell = {}; // "r,c" -> i

  for (let i = 1; i <= N; i++) {
    const L = lettersTop[i - 1];
    let pick = -1;
    for (let j = 0; j < solutionLetters.length; j++) {
      if (!claimed[j] && solutionLetters[j] === L) {
        pick = j;
        claimed[j] = true;
        break;
      }
    }
    if (pick === -1) throw new Error(`No free cell for letter '${L}' (i=${i})`);
    const cell = cells[pick];
    cellForLocation[i] = cell;
    requiredLetterAt[i] = solutionLetters[pick];
    locationForCell[`${cell.row},${cell.col}`] = i;
  }

  return { cellForLocation, requiredLetterAt, locationForCell };
}

// turn scramble (length N, values 1..N) into tileAtLocation (1..N -> tileId)
function placementFromScramble(scramble) {
  const N = scramble.length;
  const tileAtLocation = new Array(N + 1).fill(0);
  for (let i = 1; i <= N; i++) {
    const loc = scramble[i - 1];
    tileAtLocation[loc] = i;
  }
  return tileAtLocation;
}

// Build top-ribbon lines from the display phrase (keep case/accents/punct),
// wrap ≤13 letters/line (letters-only), never split tokens.
function makeRibbonLines(phrase) {
  const tokens = String(phrase || "").trim().length
    ? String(phrase).trim().split(/\s+/)
    : [];

  const maxLetters = 13;
  const lines = [];
  let cur = [];
  let curLetters = 0;

  const letterCount = (tok) =>
    tok
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z]/g, "").length;

  for (const tok of tokens) {
    const add = letterCount(tok);
    if (cur.length > 0 && curLetters + add > maxLetters) {
      lines.push(cur);
      cur = [tok];
      curLetters = add;
    } else {
      cur.push(tok);
      curLetters += add;
    }
  }
  if (cur.length) lines.push(cur);

  let nextIndex = 1;
  return lines.map((toks) => {
    const chars = [];
    toks.forEach((tok, idx) => {
      for (let i = 0; i < tok.length; i++) {
        const ch = tok[i];
        const norm = ch
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toUpperCase();
        const isLetter = /^[A-Z]$/.test(norm);
        const topIndex = isLetter ? nextIndex++ : null;
        chars.push({ ch, isLetter, topIndex });
      }
      if (idx < toks.length - 1) {
        chars.push({ ch: " ", isLetter: false, topIndex: null });
      }
    });
    return { chars };
  });
}

/* ---------------------------- per-puzzle derive ---------------------------- */
// Packs ALL derived data for a puzzle so Level 1/2 switch instantly with no duplication.
function derivePuzzleData(puzzle) {
  if (!puzzle) return null;

  const phrase = puzzle.phrase || "";
  const lettersTop = normalizeAZ(phrase);
  const N = lettersTop.length;

  const { cells, solutionLetters } = enumerateCells(puzzle.words || []);
  if (N !== cells.length) throw new Error(`N (${N}) != cells (${cells.length})`);

  const { requiredLetterAt, cellForLocation } = assignLocations(
    lettersTop,
    solutionLetters,
    cells
  );

  // Ribbon + map tileId (Top index) -> display char (accented) for that tile
  const ribbonLines = makeRibbonLines(phrase);
  const displayCharByTopIndex = [];
  for (const line of ribbonLines) {
    for (const cell of line.chars) {
      if (cell.isLetter && cell.topIndex != null) {
        displayCharByTopIndex[cell.topIndex] = cell.ch;
      }
    }
  }

  // (row,col)->loc map from cellForLocation (0-based)
  const locByKey = {};
  for (let i = 1; i <= N; i++) {
    const cell = cellForLocation[i];
    if (cell) locByKey[`${cell.row},${cell.col}`] = i;
  }

  
  // Per-word location-id lists by original words[] index (for Level 1 word highlighting)
  const wordLocsByIndex = [];
  for (const w of puzzle.words || []) {
    const t = normalizeAZ(w.text);
    const horiz = w.dir === "H";
    const locs = [];
    for (let i = 0; i < t.length; i++) {
      const r = w.row + (horiz ? 0 : i);
      const c = w.col + (horiz ? i : 0);
      const key = `${r},${c}`;
      const loc = locByKey[key];
      if (!loc) throw new Error(\`Missing location for cell \${key}\`);
      locs.push(loc);
    }
    wordLocsByIndex.push(locs);
  }
// Per-word location-id lists in reading order (for yellow bands)
  const wordsIndex = { H: [], V: [] };
  for (const w of puzzle.words || []) {
    const t = normalizeAZ(w.text);
    const horiz = w.dir === "H";
    const locs = [];
    for (let i = 0; i < t.length; i++) {
      const r = w.row + (horiz ? 0 : i);
      const c = w.col + (horiz ? i : 0);
      const key = `${r},${c}`;
      const loc = locByKey[key];
      if (!loc) throw new Error(`Missing location for cell ${key}`);
      locs.push(loc);
    }
    if (horiz) wordsIndex.H.push({ locs });
    else wordsIndex.V.push({ locs });
  }

  // Startup placement from JSON
  const scramble = puzzle?.start_state?.scramble || [];
  const tileAtLocationStart = placementFromScramble(scramble);
  const correctPositionsJSON = puzzle?.start_state?.correct_positions || [];
  const minMoves = puzzle?.start_state?.min_moves;

  // Grid dims
  const gridW = puzzle?.grid?.width || 0;
  const gridH = puzzle?.grid?.height || 0;
  const rows = Array.from({ length: gridH }, (_, r) => r); // 0-based
  const cols = Array.from({ length: gridW }, (_, c) => c); // 0-based

  return {
    puzzle,
    phrase,
    lettersTop,
    N,
    requiredLetterAt,
    cellForLocation,
    locByKey,
    wordLocsByIndex,
    wordsIndex, // kept (bands now disabled for L1 per spec)
    ribbonLines,
    displayCharByTopIndex,
    tileAtLocationStart,
    correctPositionsJSON,
    minMoves,
    gridW,
    gridH,
    rows,
    cols,
  };
}


// Simple, tweakable rating tiers based on how close you are to the theoretical minimum.
function ratingLabel(moves, min) {
  // Guard against weird inputs
  if (!Number.isFinite(min) || min < 0) min = 0;
  if (!Number.isFinite(moves) || moves < 0) moves = 0;

  // Absolute step thresholds from min, step = 3 moves
  const d = moves - min;
  if (d <= 0) return "Out of This World";
  if (d <= 3) return "Cream of the Crop";
  if (d <= 6) return "The Cat's Pajamas";
  if (d <= 9) return "A cut above";
  if (d <= 12) return "Right as Rain";
  if (d <= 15) return "Run of the Mill";
  return "Don't give up the ship";
}


/* --------------------------------- Page --------------------------------- */

export default function Page() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  // Load puzzles.json once
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/puzzles.json", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        const puzzles = Array.isArray(raw) ? raw : raw?.puzzles;
        if (!Array.isArray(puzzles) || puzzles.length === 0)
          throw new Error("No puzzles found");
        setData({ raw, puzzles });
      } catch (e) {
        setErr(String(e?.message || e));
      }
    })();
  }, []);

  const puzzles = data?.puzzles ?? [];

  // ?idx=<array index> (0-based). Level 1 = idx, Level 2 = idx+1 (clamped)
  const qpIdx =
    typeof window !== "undefined"
      ? Number(new URL(window.location.href).searchParams.get("idx"))
      : NaN;
  const baseIndex = Number.isFinite(qpIdx) ? qpIdx : 0;
  const idx1 = Math.max(0, Math.min(baseIndex, puzzles.length - 1));
  const idx2 = Math.max(0, Math.min(baseIndex + 1, puzzles.length - 1));

  // Derive BOTH puzzles (memoized), then instant toggle
  const derived1 = useMemo(
    () => (puzzles[idx1] ? derivePuzzleData(puzzles[idx1]) : null),
    [puzzles, idx1]
  );
  const derived2 = useMemo(
    () => (puzzles[idx2] ? derivePuzzleData(puzzles[idx2]) : null),
    [puzzles, idx2]
  );

  // Level selection (instant toggle; URL does NOT change)
  const [activeLevel, setActiveLevel] = useState(1);

  // Per-level tiles & moves; initialize when that level's puzzle changes
  const [byLevel, setByLevel] = useState({ 1: null, 2: null });

  useEffect(() => {
    if (!derived1) return;
    setByLevel((prev) => ({
      ...prev,
      1: {
        tileAtLocation: derived1.tileAtLocationStart.slice(),
        moveCount: 0,
      },
    }));
  }, [derived1?.puzzle?.id]);

  useEffect(() => {
    if (!derived2) return;
    setByLevel((prev) => ({
      ...prev,
      2: {
        tileAtLocation: derived2.tileAtLocationStart.slice(),
        moveCount: 0,
      },
    }));
  }, [derived2?.puzzle?.id]);

  /* ---------- ALWAYS define derived view + hooks BEFORE any early return ---------- */
  const D = useMemo(() => {
    const fallback = {
      puzzle: null,
      phrase: "",
      lettersTop: "",
      N: 0,
      requiredLetterAt: [],
      cellForLocation: [],
      locByKey: {},
      wordLocsByIndex: [],
      wordsIndex: { H: [], V: [] },
      ribbonLines: [],
      displayCharByTopIndex: [],
      tileAtLocationStart: [],
      correctPositionsJSON: [],
      minMoves: 0,
      gridW: 0,
      gridH: 0,
      rows: [],
      cols: [],
    };
    const pick = activeLevel === 1 ? derived1 : (derived2 || derived1);
    return pick || fallback;
  }, [activeLevel, derived1, derived2]);

  const selectedTileAtLocation = useMemo(() => {
    const arr = byLevel[activeLevel]?.tileAtLocation;
    return Array.isArray(arr) ? arr : (D.tileAtLocationStart || []);
  }, [byLevel, activeLevel, D.tileAtLocationStart]);

  const greensComputed = useMemo(() => {
    const out = [];
    const N = D.N || 0;
    const letters = D.lettersTop || "";
    const req = D.requiredLetterAt || [];
    for (let loc = 1; loc <= N; loc++) {
      const t = selectedTileAtLocation[loc];
      if (t && letters[t - 1] === req[loc]) out.push(loc);
    }
    return out;
  }, [selectedTileAtLocation, D.N, D.lettersTop, D.requiredLetterAt]);

  const greensSet = useMemo(() => new Set(greensComputed), [greensComputed]);

  // Detect completion and show a single Congrats modal per level
  useEffect(() => {
    if (!D.N) return;
    const solved = greensSet.size === D.N;
    setByLevel((prev) => {
      const cur = prev[activeLevel];
      if (!cur) return prev;
      if (solved && !cur.isComplete) {
        const copy = { ...prev, [activeLevel]: { ...cur, isComplete: true } };
        // open modal next tick to avoid setState-while-render warnings
        Promise.resolve().then(() => openModal("congrats"));
        return copy;
      }
      return prev;
    });
  }, [greensSet, D.N, activeLevel]);

  /* -------------------- NEW: Level-1 clue bar state & derive -------------------- */

  // Show/Hide clues per-level (session-only)
  const [showCluesByLevel, setShowCluesByLevel] = useState({ 1: true, 2: true });
  const showClues = Boolean(showCluesByLevel[activeLevel]);
  const toggleShowClues = () =>
    setShowCluesByLevel((prev) => ({ ...prev, [activeLevel]: !prev[activeLevel] }));
  const [clueIndex, setClueIndex] = useState(0);
  // Reset clue index whenever Level 1 puzzle changes or user switches levels
  useEffect(() => {
    setClueIndex(0);
  }, [activeLevel, derived1?.puzzle?.id, derived2?.puzzle?.id]);

  const allClues = useMemo(() => {
    const words = D.puzzle?.words || [];
    return words.map((w) => w?.clue || "");
  }, [D.puzzle]);

  const clueOrder0 = useMemo(() => {
    if (!Array.isArray(allClues) || allClues.length === 0) return [];
    const ord = Array.isArray(D.puzzle?.clue_order)
      ? D.puzzle.clue_order
      : null;
    if (ord && ord.length === allClues.length) {
      // stored as 1-based in JSON
      return ord.map((n) => (n | 0) - 1).filter((i) => i >= 0 && i < allClues.length);
    }
    // fallback: natural order
    return allClues.map((_, i) => i);
  }, [allClues, D.puzzle]);

  const currentClue = useMemo(() => {
    if (!allClues.length || !clueOrder0.length) return "";
    const i = clueOrder0[(clueIndex % clueOrder0.length + clueOrder0.length) % clueOrder0.length];
    return allClues[i] || "";
  }, [allClues, clueOrder0, clueIndex]);

  /* --------------------------- Bands (now disabled for L1) --------------------------- */
  // We keep the structure, but we no longer show yellow bands on Level 1 per your spec.
  const { bandH, bandV } = useMemo(() => {
    const N = D.N || 0;
    const outH = new Array(N + 1).fill(false);
    const outV = new Array(N + 1).fill(false);

    // Historically, Level 1 had bands and Level 2 didn't.
    // New behavior: NO BANDS on Level 1 either. Level 2 stays as before (no bands).
    // So we always return all-false arrays.
    return { bandH: outH, bandV: outV };
  }, [D.N]);

  /* ------------------------- Bottom grid helpers + lattice -------------------------- */
  const cellSize = "clamp(48px, 12.5vw, 64px)";
  const getLocId = (r, c) => {
    const key = `${r},${c}`;
    const loc = D.locByKey?.[key];
    return typeof loc === "number" ? loc : 0;
  };

  // Build a set of unique edges (so interior lines are drawn once, not doubled).
  const { edgesH, edgesV } = useMemo(() => {
    const occ = new Set(Object.keys(D.locByKey || {})); // "r,c" for letter cells
    const H = new Set();
    const V = new Set();

    for (const key of occ) {
      const [r, c] = key.split(",").map(Number);

      // top & bottom edges
      H.add(`H|${r}|${c}|${c + 1}`);
      H.add(`H|${r + 1}|${c}|${c + 1}`);

      // left & right edges
      V.add(`V|${c}|${r}|${r + 1}`);
      V.add(`V|${c + 1}|${r}|${r + 1}`);
    }

    const edgesH = Array.from(H).map((s) => {
      const [, y, x1, x2] = s.split("|").map(Number);
      return { y, x1, x2 };
    });
  // Active word index for Level 1 based on clue_order and clueIndex
  const activeWordIndexL1 = useMemo(() => {
    if (activeLevel !== 1) return -1;
    if (!allClues.length || !clueOrder0.length) return -1;
    const i = clueOrder0[(clueIndex % clueOrder0.length + clueOrder0.length) % clueOrder0.length];
    return i;
  }, [activeLevel, allClues, clueOrder0, clueIndex]);

  const activeWordLocSet = useMemo(() => {
    if (activeLevel !== 1) return new Set();
    const idx = activeWordIndexL1;
    const locs = (D.wordLocsByIndex && D.wordLocsByIndex[idx]) || [];
    return new Set(locs);
  }, [activeLevel, activeWordIndexL1, D.wordLocsByIndex]);

    const edgesV = Array.from(V).map((s) => {
      const [, x, y1, y2] = s.split("|").map(Number);
      return { x, y1, y2 };
    });

    return { edgesH, edgesV };
  }, [D.locByKey]);

  /* ----------------------------- Refs, drag, modals ----------------------------- */
  const cellRefs = useRef({}); // loc -> HTMLElement
  const [drag, setDrag] = useState({
    active: false,
    srcLoc: 0,
    tileId: 0,
    startX: 0,
    startY: 0,
    dx: 0,
    dy: 0,
    originRect: null,
  });

  // --- Modals ---
  const [modal, setModal] = useState(null); // 'tbd' | 'reset' | 'help' | 'congrats' | null
  const lastFocusRef = useRef(null);

  function openModal(type, fromEl) {
    lastFocusRef.current = fromEl || null;
    setModal(type);
  }
  function closeModal() {
    setModal(null);
    lastFocusRef.current?.focus?.();
  }

  // Esc closes dialog
  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") closeModal();
    }
    if (modal) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  // Reset current level to JSON start state
  function doResetCurrentLevel() {
    setByLevel((prev) => {
      const copy = { ...prev };
      const lvl = { ...(copy[activeLevel] || {}) };
      lvl.tileAtLocation = D.tileAtLocationStart.slice();
      lvl.moveCount = 0;
      lvl.isComplete = false;
      copy[activeLevel] = lvl;
      return copy;
    });
    closeModal();
  }

  // begin drag: only from unlocked (non-green) letter cells
  function onTilePointerDown(e, loc) {
    if (!loc || greensSet.has(loc)) return;
    const el = cellRefs.current[loc];
    if (!el) return;
    try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { }
    const rect = el.getBoundingClientRect();
    const tileId = selectedTileAtLocation[loc] || 0;
    if (!tileId) return;
    setDrag({
      active: true,
      srcLoc: loc,
      tileId,
      startX: e.clientX,
      startY: e.clientY,
      dx: 0,
      dy: 0,
      originRect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
    });
  }

  // helper rect functions
  function shiftedRect(base, dx, dy) {
    return {
      left: base.left + dx,
      top: base.top + dy,
      right: base.right + dx,
      bottom: base.bottom + dy,
      width: base.width,
      height: base.height,
    };
  }
  function intersectionArea(a, b) {
    const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return w * h;
  }

  // attach global listeners while dragging
  useEffect(() => {
    if (!drag.active) return;

    function onMove(ev) {
      setDrag((d) => ({ ...d, dx: ev.clientX - d.startX, dy: ev.clientY - d.startY }));
    }

    function onUp() {
      // compute best overlap with other UNLOCKED tiles (>= 50%)
      const moved = shiftedRect(drag.originRect, drag.dx, drag.dy);
      const areaDragged = moved.width * moved.height;

      let bestLoc = 0;
      let bestRatio = 0;

      for (let loc = 1; loc <= (D.N || 0); loc++) {
        if (loc === drag.srcLoc) continue;
        if (greensSet.has(loc)) continue; // cannot drop onto green
        const el = cellRefs.current[loc];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const ratio = intersectionArea(moved, r) / areaDragged;
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestLoc = loc;
        }
      }

      if (bestLoc && bestRatio >= 0.33) {
        // commit swap in ACTIVE LEVEL
        setByLevel((prev) => {
          const copy = { ...prev };
          const lvl = { ...(copy[activeLevel] || {}) };
          const arr = (lvl.tileAtLocation || D.tileAtLocationStart || []).slice();
          const a = drag.srcLoc, b = bestLoc;
          const tmp = arr[a]; arr[a] = arr[b]; arr[b] = tmp;
          lvl.tileAtLocation = arr;
          lvl.moveCount = (lvl.moveCount || 0) + 1;
          copy[activeLevel] = lvl;
          return copy;
        });
      }

      setDrag({
        active: false,
        srcLoc: 0,
        tileId: 0,
        startX: 0,
        startY: 0,
        dx: 0,
        dy: 0,
        originRect: null,
      });
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag.active, drag.dx, drag.dy, drag.originRect, drag.srcLoc, D.N, greensSet, activeLevel, D.tileAtLocationStart]);

  /* --------------------------- Early guards (after hooks) --------------------------- */
  if (err) return <div className="p-6 text-red-600">Error: {err}</div>;
  if (!derived1) return <div className="p-6">Loading…</div>;

  /* -------------------------------- UI -------------------------------- */
  return (
    <div className="min-h-screen w-full bg-white text-gray-900 p-4">
      <div className="max-w-xl mx-auto space-y-5">

<style jsx global>{`
  :root {
    /* Phones / default (keep what you liked) */
    --band-y1: #F7D448;
    --band-y2: #F6D24A;
  }
  /* Desktop/laptop heuristic: mouse/trackpad present */
  @media (hover: hover) and (pointer: fine) {
    :root {
      /* Slightly toned down from phone, not too golden */
      --band-y1: #F3CD3F;
      --band-y2: #E6BC33;
    }
  }
`}</style>

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">Phrazagram</div>
          <div className="flex items-center gap-2">
            {/* Right button group: TBD · Reset · Help */}
            <button
              type="button"
              className="px-2 py-1 text-sm rounded border border-gray-300 hover:bg-gray-50"
              onClick={(e) => openModal("tbd", e.currentTarget)}
              aria-haspopup="dialog"
            >
              TBD
            </button>
            <button
              type="button"
              className="px-2 py-1 text-sm rounded border border-gray-300 hover:bg-gray-50"
              onClick={(e) => openModal("reset", e.currentTarget)}
              aria-haspopup="dialog"
            >
              Reset
            </button>
            <button
              type="button"
              className="px-2 py-1 text-sm rounded border border-gray-300 hover:bg-gray-50"
              onClick={(e) => openModal("help", e.currentTarget)}
              aria-haspopup="dialog"
            >
              Help
            </button>
          </div>
        </div>

        {/* Level selector (instant; URL does NOT change) */}
        <div
          role="radiogroup"
          aria-label="Level"
          className="flex items-center justify-center gap-2"
        >
          <button
            type="button"
            role="radio"
            aria-checked={activeLevel === 1}
            onClick={() => setActiveLevel(1)}
            className={
              activeLevel === 1
                ? "px-3 py-1 rounded-full bg-blue-600 text-white text-sm"
                : "px-3 py-1 rounded-full border border-gray-300 text-sm"
            }
          >
            Level 1
          </button>

          <button
            type="button"
            role="radio"
            aria-checked={activeLevel === 2}
            disabled={!derived2}
            onClick={() => derived2 && setActiveLevel(2)}
            className={
              activeLevel === 2
                ? "px-3 py-1 rounded-full bg-blue-600 text-white text-sm"
                : "px-3 py-1 rounded-full border border-gray-300 text-sm"
            }
          >
            Level 2
          </button>
        </div>

        {/* Top Ribbon (lowercase, accented; numbers hide on greens) */}
        <div className="pt-2 pb-0 px-3">
          <div className="space-y-2">
            {D.ribbonLines.map((line, li) => (
              <div
                key={li}
                className="flex justify-center gap-[0.9ch]"
                style={{
                  fontFamily:
                    'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Noto Sans Mono", "Liberation Mono", "DejaVu Sans Mono", monospace',
                  fontKerning: "none",
                  fontVariantLigatures: "none",
                  fontFeatureSettings: '"liga" 0, "calt" 0',
                  WebkitFontSmoothing: "antialiased",
                  MozOsxFontSmoothing: "grayscale",
                }}
              >
                {line.chars.map((cell, ci) => {
                  const isGreen =
                    cell.isLetter &&
                    cell.topIndex != null &&
                    greensSet.has(cell.topIndex);
                  const showNumber = cell.isLetter && !isGreen;
                  const colorClass = cell.isLetter
                    ? isGreen
                      ? "text-[#208040]"
                      : "text-[#1240A0]"
                    : "text-gray-700";

                  // Show the TILE’s glyph, but match case to TARGET slot
                  let glyph = cell.ch;
                  if (cell.isLetter && cell.topIndex != null) {
                    const tileId = selectedTileAtLocation[cell.topIndex] || 0;
                    const tileGlyph = tileId ? (D.displayCharByTopIndex[tileId] || "") : "";
                    const targetGlyph = D.displayCharByTopIndex[cell.topIndex] || "";
                    const isUpper =
                      targetGlyph &&
                      targetGlyph.toLocaleUpperCase() === targetGlyph &&
                      targetGlyph.toLocaleLowerCase() !== targetGlyph;
                    const isLower =
                      targetGlyph &&
                      targetGlyph.toLocaleLowerCase() === targetGlyph &&
                      targetGlyph.toLocaleUpperCase() !== targetGlyph;
                    glyph = isUpper
                      ? tileGlyph.toLocaleUpperCase()
                      : isLower
                        ? tileGlyph.toLocaleLowerCase()
                        : tileGlyph;
                  }

                  return (
                    <div key={ci} className="flex flex-col items-center" style={{ minWidth: "1ch" }}>
                      <span
                        className={`leading-none font-semibold ${colorClass}`}
                        style={{ fontSize: "clamp(18px, 4.2vw, 26px)" }}
                      >
                        {glyph}
                      </span>
                      <span
                        className={`leading-[1.0] ${showNumber ? "opacity-100" : "opacity-0"}`}
                        style={{ fontSize: "10px", marginTop: "2px" }}
                      >
                        {showNumber ? cell.topIndex : " "}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* CENTER BAR:
            - Level 1: Clue bar (cycles clues in puzzle.clue_order; no Moves/Minimum)
            - Level 2: Original Moves + Minimum (unchanged)
        */}
        {activeLevel === 1 ? (
  <div className="w-full max-w-2xl mx-auto">
    {/* Moves line */}
    <div className="text-center select-none my-3">
      <span className="text-sm text-gray-700">
        Moves:{" "}
        <span className="text-xl font-semibold text-black">
          {byLevel[activeLevel]?.moveCount ?? 0}
        </span>
      </span>
      <span className="text-xs text-gray-500 ml-3">
        (minimum needed: {D.minMoves})
      </span>
    </div>

    {/* Clue bar */}
    {showClues ? (
      <div className="flex items-start justify-between px-2 py-1 border border-gray-300 rounded bg-white shadow my-3">
        {/* Clue text (two-line clamp) */}
        <div className="pr-2 min-w-0 flex-1 text-sm">
          <div
            className="font-normal"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden"
            }}
            title={currentClue || "—"}
          >
            <span className="font-semibold">{clueIndex + 1}.</span>{" "}
            {currentClue || "—"}
          </div>
        </div>

        {/* Right controls: Hide (top), Next (bottom) */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          <button
            className="px-2 py-1 text-xs bg-gray-100 rounded border border-gray-300 leading-none"
            onClick={toggleShowClues}
            aria-pressed={!showClues}
            aria-label="Hide clues"
            title="Hide all clues"
          >
            Hide clues
          </button>
          <button
            className="px-2 py-1 bg-gray-100 rounded border border-gray-300 text-base leading-none"
            onClick={() => {
              if (allClues.length > 0) {
                setClueIndex((prev) => (prev + 1) % allClues.length);
              }
            }}
            aria-label="Next clue"
            title="Next clue"
          >
            ▸
          </button>
        </div>
      </div>
    ) : (
      // Minimal shell with only 'Show clues' in top-right
      <div className="flex items-center justify-end my-3">
        <button
          className="px-2 py-1 text-xs bg-gray-100 rounded border border-gray-300 leading-none"
          onClick={toggleShowClues}
          aria-pressed={!showClues}
          aria-label="Show clues"
          title="Show all clues"
        >
          Show clues
        </button>
      </div>
    )}
  </div>
) : (
  /* Level 2 block starts here… */
            <div className="text-center select-none mb-5">
              <span className="text-sm text-gray-700">
                Moves:{" "}
                <span className="text-xl font-semibold text-black">
                  {byLevel[activeLevel]?.moveCount ?? 0}
                </span>
              </span>
              <span className="text-xs text-gray-500 ml-3">
                (minimum needed: {D.minMoves})
              </span>
            </div>

            {/* Clue bar (Level 2 randomized order) */}
            {showClues ? (
              <div className="flex items-start justify-between px-2 py-1 border border-gray-300 rounded bg-white shadow my-3">
                <div className="pr-2 min-w-0 flex-1 text-sm">
                  <div
                    className="font-normal"
                    style={{
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden"
                    }}
                    title={currentClue || "—"}
                  >
                    <span className="font-semibold">{clueIndex + 1}.</span>{" "}
                    {currentClue || "—"}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <button
                    className="px-2 py-1 text-xs bg-gray-100 rounded border border-gray-300 leading-none"
                    onClick={toggleShowClues}
                    aria-pressed={!showClues}
                    aria-label="Hide clues"
                    title="Hide all clues"
                  >
                    Hide clues
                  </button>
                  <button
                    className="px-2 py-1 bg-gray-100 rounded border border-gray-300 text-base leading-none"
                    onClick={() => {
                      if (allClues.length > 0) {
                        setClueIndex((prev) => (prev + 1) % allClues.length);
                      }
                    }}
                    aria-label="Next clue"
                    title="Next clue"
                  >
                    ▸
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-end my-3">
                <button
                  className="px-2 py-1 text-xs bg-gray-100 rounded border border-gray-300 leading-none"
                  onClick={toggleShowClues}
                  aria-pressed={!showClues}
                  aria-label="Show clues"
                  title="Show all clues"
                >
                  Show clues
                </button>
              </div>
            )}

        )}

        {/* Bottom Grid (UPPERCASE, A–Z only; greens locked; DRAGGABLE; bands disabled on L1; lattice overlay) */}
        <div className="pt-0 pb-3 px-3">
          <div
            className="mx-auto"
            style={{ width: `calc(${D.gridW} * ${cellSize})`, ["--cell-size"]: cellSize }}
          >
            <div className="relative">
              {/* The grid of tiles (no borders; background is transparent) */}
              <div
                className="grid"
                style={{
                  gridTemplateColumns: `repeat(${D.gridW}, ${cellSize})`,
                  gridTemplateRows: `repeat(${D.gridH}, ${cellSize})`,
                }}
              >
                {D.rows.map((r) =>
                  D.cols.map((c) => {
                    const loc = getLocId(r, c);
                    const isLetterCell = loc > 0;

                    const tileId = isLetterCell ? (selectedTileAtLocation[loc] || 0) : 0;

                    const isGreen =
                      isLetterCell &&
                      tileId > 0 &&
                      D.lettersTop[tileId - 1] === D.requiredLetterAt[loc];

                    const showNumber = isLetterCell && !isGreen;

                    // Use normalized gameplay letter (A–Z only), no accents.
                    const glyph =
                      isLetterCell && tileId > 0
                        ? (D.lettersTop[tileId - 1] || "")
                        : "";

                    const isDraggingThis = drag.active && drag.srcLoc === loc;
                    // Active-word highlight (Level 1 only, when clues are visible)
                    const isActiveWordTile = activeLevel === 1 && showClues && activeWordLocSet.has(loc);

                    // Colors
                    let bgColor = isGreen ? "#208040" : "#ECEFF3";
                    let glyphColor = isGreen ? "#FFFFFF" : "#1240A0";
                    if (isActiveWordTile && !isGreen) {
                      bgColor = "#1240A0";     // flip
                      glyphColor = "#ECEFF3";
                    }


                    // Yellow bands: DISABLED for Level 1 per spec; Level 2 already had none.
                    const showBandH = false;
                    const showBandV = false;

                    return (
                      <div
                        key={`${r}-${c}`}
                        ref={(el) => {
                          if (loc) cellRefs.current[loc] = el;
                        }}
                        className="relative select-none"
                        style={{
                          width: cellSize,
                          height: cellSize,
                          background: "transparent",
                        }}
                      >
                        {/* Full-tile wrapper: background + bands + letter + number move together */}
                        {isLetterCell && (
                          <div
                            className="absolute inset-0 flex flex-col items-center justify-center touch-none"
                            onPointerDown={(e) => (!isGreen ? onTilePointerDown(e, loc) : null)}
                            style={{
                              background: bgColor,
                              cursor: !isGreen ? (isDraggingThis ? "grabbing" : "grab") : "default",
                              transform: isDraggingThis
                                ? `translate(${drag.dx}px, ${drag.dy}px) scale(1.06)`
                                : "none",
                              transition: isDraggingThis ? "none" : "transform 180ms ease",
                              willChange: isDraggingThis ? "transform" : "auto",
                              filter: isDraggingThis ? "drop-shadow(0 6px 10px rgba(0,0,0,0.25))" : "none",
                              zIndex: isDraggingThis ? 4 : 1,
                            }}
                          >
                            {/* (Bands removed for Level 1) */}
                            {showBandH && (
                              <div
                                aria-hidden
                                className="absolute"
                                style={{
                                  left: "0px",
                                  right: "0px",
                                  top: "30%",
                                  height: "40%",
                                  background: "linear-gradient(var(--band-y1), var(--band-y2))",
                                  zIndex: 1,
                                }}
                              />
                            )}
                            {showBandV && (
                              <div
                                aria-hidden
                                className="absolute"
                                style={{
                                  top: "0px",
                                  bottom: "0px",
                                  left: "30%",
                                  width: "40%",
                                  background: "linear-gradient(var(--band-y1), var(--band-y2))",
                                  zIndex: 1,
                                }}
                              />
                            )}

                            
                            {/* Active word ring */}
                            {isActiveWordTile && (
                              <div
                                aria-hidden
                                className="absolute inset-0 pointer-events-none"
                                style={{ boxShadow: "inset 0 0 0 2px #3B82F6", borderRadius: "2px", zIndex: 2 }}
                              />
                            )}
{/* Letter glyph (above lattice) */}
                            <span
                              className="leading-none font-semibold"
                              style={{ fontSize: "clamp(18px, 4.2vw, 26px)", position: "relative", zIndex: 3, color: glyphColor }}
                            >
                              {glyph}
                            </span>

                            {/* Location number (hidden on greens; above lattice) */}
                            <span
                              className={`leading-[1.0] ${showNumber ? "opacity-100" : "opacity-0"}`}
                              style={{ fontSize: "10px", marginTop: "6px", color: "#222", position: "relative", zIndex: 3 }}
                            >
                              {showNumber ? loc : " "}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* LATTICE OVERLAY: a single 1px grid, only around letter cells */}
              <div
                className="pointer-events-none absolute inset-0"
                style={{ zIndex: 2 }}
                aria-hidden
              >
                {/* Horizontal edges */}
                {edgesH.map(({ y, x1, x2 }, i) => (
                  <div
                    key={`h-${i}`}
                    style={{
                      position: "absolute",
                      left: `calc(${x1} * var(--cell-size))`,
                      top: `calc(${y} * var(--cell-size) - 0.5px)`,
                      width: `calc(${x2 - x1} * var(--cell-size))`,
                      height: "1px",
                      background: "#9AA3B2",
                    }}
                  />
                ))}
                {/* Vertical edges */}
                {edgesV.map(({ x, y1, y2 }, i) => (
                  <div
                    key={`v-${i}`}
                    style={{
                      position: "absolute",
                      left: `calc(${x} * var(--cell-size) - 0.5px)`,
                      top: `calc(${y1} * var(--cell-size))`,
                      width: "1px",
                      height: `calc(${y2 - y1} * var(--cell-size))`,
                      background: "#9AA3B2",
                    }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Modals */}
        {modal && (
          <div
            className="fixed inset-0 z-[999] flex items-center justify-center"
            aria-hidden={false}
          >
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/40"
              onClick={closeModal}
            />
            {/* Dialog */}
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="modal-title"
              className="relative z-[1000] w-[min(92vw,520px)] max-w-lg rounded-xl bg-white shadow-xl border border-gray-200 p-4"
            >
              {/* Close X */}
              <button
                onClick={closeModal}
                className="absolute right-2 top-2 p-1 rounded hover:bg-gray-100"
                aria-label="Close"
              >
                ✕
              </button>

              {/* Content by type */}
              {modal === "tbd" && (
                <>
                  <h2 id="modal-title" className="text-lg font-semibold mb-2">Placeholder</h2>
                  <p className="text-sm text-gray-700">
                    To be used to access past puzzles
                  </p>
                  <div className="mt-4 flex justify-end">
                    <button
                      className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
                      onClick={closeModal}
                    >
                      Close
                    </button>
                  </div>
                </>
              )}

              {modal === "help" && (
                <>
  <h2 id="modal-title" className="text-lg font-semibold mb-2">How to Play</h2>

  <div className="text-sm text-gray-800 space-y-3">
    <div>
      <div className="font-semibold">Objective</div>
      <p>Complete the puzzle by arranging all the tiles in their correct positions to reveal the phrase or theme (shown at the top). Fewer moves = higher rating.</p>
    </div>

    <div>
      <div className="font-semibold">Swapping tiles</div>
      <p>Drag one letter onto another in the bottom grid to swap them. Letters in their correct location (green) are locked and can’t be moved.</p>
    </div>

    <div>
      <div className="font-semibold">Relationship between top and bottom</div>
      <p>Each numbered slot in the top ribbon corresponds to the same numbered square in the bottom grid. Example: placing an “A” in square 7 below puts an “A” in slot 7 above. Likewise, if you know slot 12 should be a certain letter, move that letter into square 12.</p>
    </div>

    <div>
      <div className="font-semibold">Level 1</div>
      <p>Alongside the phrase, you’ll see clues for each grid word. They appear one at a time in no particular order so you don’t know which clue belongs to which word. Cycle through them with the arrow.</p>
    </div>

    <div>
      <div className="font-semibold">Level 2</div>
      <p>Clues appear in random order (not tied to specific words). Use the arrow to cycle.</p>
    </div>

    <div>
      <div className="font-semibold">Starting position</div>
      <p>Some squares begin highlighted in green, meaning those letters are already correctly placed. These give you a head start.</p>
    </div>
  </div>

  <div className="mt-4 flex justify-end">
    <button
      className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
      onClick={closeModal}
    >
      Close
    </button>
  </div>
</>

              )}

              {modal === "reset" && (
                <>
                  <h2 id="modal-title" className="text-lg font-semibold mb-2">Reset this level?</h2>
                  <p className="text-sm text-gray-700">
                    This restores the current level to its original start state (same scramble and seeded greens) and sets Moves to 0. You can’t undo this.
                  </p>
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
                      onClick={closeModal}
                      autoFocus
                    >
                      Cancel
                    </button>
                    <button
                      className="px-3 py-1 rounded bg-red-600 text-white hover:bg-red-700"
                      onClick={doResetCurrentLevel}
                    >
                      Reset
                    </button>
                  </div>
                </>
              )}

              {modal === "congrats" && (() => {
  const moves = byLevel[activeLevel]?.moveCount ?? 0;
  const min = D.minMoves;
  const label = ratingLabel(moves, min);

  const otherLevel = activeLevel === 1 ? 2 : 1;
  const otherExists = otherLevel === 2 ? Boolean(derived2) : Boolean(derived1);
  const otherSolved = Boolean(byLevel[otherLevel]?.isComplete);

  function shareText() {
    return `I solved today’s Phrazagram and was officially designated: “${label}.” Play here: <link TBD>`;
  }

  function onShare() {
    const txt = shareText();
    navigator.clipboard?.writeText(txt)
      .then(() => alert("Share text copied to clipboard!"))
      .catch(() => {
        // Fallback if clipboard is blocked
        window.prompt("Copy your share text:", txt);
      });
  }

  return (
    <>
      {/* Title */}
      <h2 id="modal-title" className="text-lg font-semibold mb-1">Congratulations!</h2>

      {/* Body line */}
      <div className="text-sm text-gray-800">
        You solved <span className="font-semibold">Level {activeLevel}</span> in{" "}
        <span className="font-mono font-semibold">{moves}</span> moves (min{" "}
        <span className="font-mono">{min}</span>).
      </div>

      {/* Designation */}
      <div className="mt-1 text-base font-semibold">
        You’re officially: {label}
      </div>

      {/* Actions */}
      <div className="mt-3 flex items-center gap-2">
        {/* Show Play Level {other} only if the other level exists and is NOT already solved */}
        {!otherSolved && otherExists && (
          <button
            className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
            onClick={() => {
              setActiveLevel(otherLevel);
              closeModal();
            }}
          >
            Play Level {otherLevel}
          </button>
        )}
        <button
          className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
          onClick={onShare}
        >
          Share results
        </button>
      </div>

      {/* Divider */}
      <div className="mt-4 border-t pt-3">
        {/* Theme section (optional) */}
        {D.puzzle?.theme_info?.trim() ? (
          <>
            <div className="font-semibold mb-2">
              About {D.puzzle.phrase}…
            </div>
            {(D.puzzle.theme_info || "")
              .split(/\n{2,}/)
              .map((para, i) => (
                <p key={i} className="text-sm text-gray-700 mb-2 last:mb-0">
                  {para}
                </p>
              ))}
          </>
        ) : (
          <div className="text-sm text-gray-500">No theme notes.</div>
        )}
      </div>

      {/* Close */}
      <div className="mt-4 flex justify-end">
        <button
          className="px-3 py-1 rounded border border-gray-300 hover:bg-gray-50"
          onClick={closeModal}
          autoFocus
        >
          Close
        </button>
      </div>
    </>
  );
})()}

            </div>
          </div>
        )}

      </div>
    </div>
  );
}
