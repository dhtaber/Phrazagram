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
    wordsIndex, // <-- used for bands
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





  // ---- Level-1 Yellow Hint Bands (duplicate-cap per word) ----
  const { bandH, bandV } = useMemo(() => {
    const N = D.N || 0;
    const outH = new Array(N + 1).fill(false);
    const outV = new Array(N + 1).fill(false);

    // Level 2 has no bands
    if (activeLevel !== 1) return { bandH: outH, bandV: outV };
    if (!N) return { bandH: outH, bandV: outV };

    // Precompute current letters at each location from placement
    const curLetterAt = new Array(N + 1).fill("");
    for (let loc = 1; loc <= N; loc++) {
      const t = selectedTileAtLocation[loc];
      curLetterAt[loc] = t ? D.lettersTop[t - 1] : "";
    }

    function applyBandsFor(wordsArr, isH) {
      for (const w of wordsArr || []) {
        const locs = w.locs || [];
        if (!locs.length) continue;

        // Count required & greens per letter for this word
        const requiredCount = new Map();
        const greensCount = new Map();
        for (const loc of locs) {
          const L = D.requiredLetterAt[loc];
          requiredCount.set(L, (requiredCount.get(L) || 0) + 1);
          if (greensSet.has(loc)) {
            greensCount.set(L, (greensCount.get(L) || 0) + 1);
          }
        }

        // For each distinct letter, mark first 'need' candidates in reading order
        for (const [L, reqCount] of requiredCount.entries()) {
          const greenCount = greensCount.get(L) || 0;
          const need = reqCount - greenCount;
          if (need <= 0) continue;

          const candidates = [];
          for (const loc of locs) {
            if (greensSet.has(loc)) continue; // greens never show bands
            if (curLetterAt[loc] === L) candidates.push(loc);
          }

          for (let i = 0; i < need && i < candidates.length; i++) {
            const loc = candidates[i];
            if (isH) outH[loc] = true;
            else outV[loc] = true;
          }
        }
      }
    }

    applyBandsFor(D.wordsIndex?.H, true);
    applyBandsFor(D.wordsIndex?.V, false);

    return { bandH: outH, bandV: outV };
  }, [activeLevel, D, selectedTileAtLocation, greensSet]);

  // Bottom grid helpers + lattice edges
  const cellSize = "clamp(48px, 12.5vw, 64px)";
  const getLocId = (r, c) => {
    const key = `${r},${c}`;
    const loc = D.locByKey?.[key];
    return typeof loc === "number" ? loc : 0;
  };

  // Build a set of unique edges (so interior lines are drawn once, not doubled).
  // Horizontal edge key:   `H|y|x1|x2`  where y is row line, [x1,x2] spans columns
  // Vertical edge key:     `V|x|y1|y2`  where x is col line, [y1,y2] spans rows
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
    const edgesV = Array.from(V).map((s) => {
      const [, x, y1, y2] = s.split("|").map(Number);
      return { x, y1, y2 };
    });

    return { edgesH, edgesV };
  }, [D.locByKey]);


  /* ----------------------------- Drag & Drop ----------------------------- */
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
    // return focus to the button that opened the modal
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
  <div className="text-lg font-semibold">Word Game</div>
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
                        style={{ fontSize: "10px", marginTop: "8px" }}
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

        {/* Moves + Minimum (centered, extra tight) */}
        <div className="py-0 text-center select-none">
          <div
            className="leading-none font-semibold text-black"
            style={{ fontSize: "clamp(18px, 4.2vw, 26px)" }}
          >
            Moves: {byLevel[activeLevel]?.moveCount ?? 0}
          </div>
          <div className="mt-0 text-[11px] text-gray-600">
            Minimum moves needed to solve:{" "}
            <span className="font-mono">{D.minMoves}</span>
          </div>
        </div>



        {/* Bottom Grid (UPPERCASE, A–Z only; greens locked; DRAGGABLE; bands on L1 only; lattice overlay) */}
        <div className="pt-0 pb-3 px-3">
          <div
            className="mx-auto"
            // expose cell size as a CSS var so the lattice overlay can position precisely
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

                    // Yellow bands for Level 1 only (bandH / bandV)
                    const showBandH = activeLevel === 1 && isLetterCell && !isGreen && bandH[loc];
                    const showBandV = activeLevel === 1 && isLetterCell && !isGreen && bandV[loc];

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
                              background: isGreen ? "#208040" : "#ECEFF3",
                              cursor: !isGreen ? (isDraggingThis ? "grabbing" : "grab") : "default",
                              transform: isDraggingThis
                                ? `translate(${drag.dx}px, ${drag.dy}px) scale(1.06)`
                                : "none",
                              transition: isDraggingThis ? "none" : "transform 180ms ease",
                              willChange: isDraggingThis ? "transform" : "auto",
                              filter: isDraggingThis ? "drop-shadow(0 6px 10px rgba(0,0,0,0.25))" : "none",
                              zIndex: isDraggingThis ? 4 : 1, // 1: bands/bg, 2: lattice, 3: text, 4: drag
                            }}
                          >
                            {/* Yellow hint bands (rectangular, 40% thickness, 2px inset) */}
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
                                  zIndex: 1, // under the lattice (lines stay visible)
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
                                  zIndex: 1, // under lattice
                                }}
                              />
                            )}

                            {/* Letter glyph (above lattice) */}
                            <span
                              className={`leading-none font-semibold ${isGreen ? "text-white" : "text-[#1240A0]"}`}
                              style={{ fontSize: "clamp(18px, 4.2vw, 26px)", position: "relative", zIndex: 3 }}
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
          <h2 id="modal-title" className="text-lg font-semibold mb-2">Feature coming soon</h2>
          <p className="text-sm text-gray-700">
            This button is reserved for a future feature. Nothing to do here yet.
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
          <h2 id="modal-title" className="text-lg font-semibold mb-2">How to play</h2>
          <ul className="text-sm text-gray-700 list-disc pl-5 space-y-1">
            <li>Drag to swap two unlocked tiles (≥ 50% overlap).</li>
            <li>Correct letters turn green and lock; numbers hide.</li>
            <li>Level 1 shows yellow hint bands; Level 2 doesn’t.</li>
            <li>Top slots mirror bottom Locations; duplicate letters are fungible.</li>
          </ul>
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

      {modal === "congrats" && (
        <>
          <h2 id="modal-title" className="text-lg font-semibold mb-1">Congratulations!</h2>
          <div className="text-sm text-gray-800">
            You solved it in{" "}
            <span className="font-mono font-semibold">
              {byLevel[activeLevel]?.moveCount ?? 0}
            </span>{" "}
            moves (min: <span className="font-mono">{D.minMoves}</span>).
          </div>
          <div className="mt-1 text-base font-semibold">
            {ratingLabel(byLevel[activeLevel]?.moveCount ?? 0, D.minMoves)}
          </div>

          {/* Theme info at the bottom */}
          {D.puzzle?.theme_info && (
            <div className="mt-4 border-t pt-3">
              {(D.puzzle.theme_info || "")
                .split(/\n{2,}/)
                .map((para, i) => (
                  <p key={i} className="text-sm text-gray-700 mb-2 last:mb-0">
                    {para}
                  </p>
                ))}
            </div>
          )}

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
      )}
    </div>
  </div>
)}


      </div>
    </div>
  );
}
