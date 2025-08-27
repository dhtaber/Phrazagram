"use client";

/**
 * Word Game — page.js (v1)
 * ------------------------------------------------------------
 * Implements:
 *  - Load /puzzles.json (from /public)
 *  - ?puzzle=<id> selection; Level 1/2 (in-page)
 *  - Normalization & deterministic Location ID mapping
 *  - Seeded scramble & greens, move counter, persistence
 *  - Monospaced top ribbon (<=13 letters/line, <=3 lines)
 *  - Bottom grid with 1px lattice, rectangular yellow bands (L1 only)
 *  - Pointer-based drag&drop with 50% overlap commit
 *  - TBD / Reset (confirm) / Help modals (accessible)
 *
 * No external libraries; pure React + CSS-in-file.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

/* ===========================
   0) Utilities & Constants
   =========================== */

// Monospace font stack for ribbon
const RIBBON_MONO =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

// Colors (align with spec)
const COLOR = {
  gridLine: "#C9CED7", // 1px lattice
  cellBG: "#ECEFF3", // incorrect
  letterBlue: "#1C479F", // incorrect letter
  green: "#208040", // locked bg
  white: "#FFFFFF", // locked text
  number: "#222222", // small location IDs
  bandYellow: "#F7D448", // rectangular bands (L1)
};

// Layout constants (responsive sizing is done in CSS)
const CELL_SIZE_MIN = 40;
const CELL_SIZE_MAX = 56;

// Yellow band geometry
const BAND_THICKNESS_PCT = 0.4; // 40% of cell
const BAND_INSET = 2; // px

// Drag tuning
const DRAG_PICKUP_MOVE_PX = 6;
const DRAG_PICKUP_HOLD_MS = 120;
const OVERLAP_THRESHOLD = 0.5; // ≥50%

// LocalStorage keys
const saveKey = (puzzleId, level) => `puzzle-${puzzleId}-L${level}`;

// Normalize a whole phrase to gameplay letters (A–Z only)
function normalizePhrase(phrase) {
  const nfd = phrase.normalize("NFD").toUpperCase();
  // Remove everything not A-Z
  return nfd.replace(/[^A-Z]/g, "");
}

// Normalize a single visible character to decide if it’s a letter slot
function normalizeCharToLetter(ch) {
  const nfd = ch.normalize("NFD").toUpperCase();
  const match = nfd.match(/[A-Z]/);
  return match ? match[0] : ""; // return single letter or ""
}

// Split phrase into tokens with punctuation glue rules for wrapping
function tokenizePhraseForWrapping(displayPhrase) {
  // We treat "leading punctuation" as sticking to the next word
  // and "trailing punctuation" as sticking to the previous word.
  // A practical approach: first split by spaces, then fold leading/trailing punctuation into tokens.
  // This is a best-effort tokenizer aligned with the spec.
  const raw = displayPhrase.split(/(\s+)/); // keep spaces as separate tokens
  const tokens = [];

  // Helper to push a token
  const pushToken = (text) => {
    if (text === "") return;
    tokens.push({
      text,
      lettersOnlyCount: normalizePhrase(text).length, // letters-only length
      slotCount: text.length, // visual width (monospace slot count)
    });
  };

  // Merge rules:
  // - Space tokens stay as-is.
  // - Leading punctuation ” “ ‘ ( [ — attaches to the following non-space token.
  // - Trailing punctuation . , ! ? : ; … ) ] ” ’ attaches to preceding non-space token.
  // For simplicity, we’ll process runs and join with neighbors.
  // However, since we center by slot count and wrap by letters-only count,
  // retaining spaces as their own tokens is fine as long as we keep them intact on the line.

  // First pass: collapse sequences into tokens preserving spaces as tokens
  raw.forEach((piece) => {
    if (piece === "") return;
    pushToken(piece);
  });

  // Second pass: enforce "no split" by later wrapping algo (we won't actually split tokens across lines).
  return tokens;
}

// Greedy wrapping by letters-only count (≤ 13 per line), max 3 lines.
// We never split a token across lines.
// Centering later is by total slotCount of each constructed line.
function wrapTokensToLines(tokens, maxLines = 3, maxLettersPerLine = 13) {
  const lines = [];
  let current = [];
  let currentLetters = 0;

  for (const t of tokens) {
    // If token is purely space and current is empty, drop leading space for neatness
    const isSpace = /^\s+$/.test(t.text);
    const tokenLetters = t.lettersOnlyCount;

    if (isSpace && current.length === 0) {
      // skip leading space in a line
      continue;
    }

    if (currentLetters + tokenLetters <= maxLettersPerLine || current.length === 0) {
      current.push(t);
      currentLetters += tokenLetters;
    } else {
      // line break
      lines.push(current);
      if (lines.length >= maxLines) break;
      current = [];
      currentLetters = 0;

      // start next line; avoid leading space
      if (!isSpace) {
        current.push(t);
        currentLetters += tokenLetters;
      }
    }
  }

  if (current.length > 0 && lines.length < maxLines) {
    lines.push(current);
  }

  return lines;
}

// Enumerate unique bottom cells from words[] in deterministic order.
function enumerateCells(words, width, height) {
  const seen = new Set(); // key: "r,c"
  const cells = []; // [{row,col}]
  const solutionLetters = []; // ["A"..]

  const letterAt = {}; // for conflict check: "r,c" -> char

  for (const w of words) {
    const text = (w.text || "").toUpperCase().replace(/[^A-Z]/g, "");
    const dir = (w.dir || "H").toUpperCase();
    const row = w.row | 0;
    const col = w.col | 0;

    if (dir !== "H" && dir !== "V") {
      throw new Error(`Invalid word direction '${w.dir}' (must be H or V).`);
    }

    if (dir === "H" && col + text.length > width) {
      throw new Error(`Word '${w.text}' exceeds grid width at row=${row}, col=${col}.`);
    }
    if (dir === "V" && row + text.length > height) {
      throw new Error(`Word '${w.text}' exceeds grid height at row=${row}, col=${col}.`);
    }

    for (let i = 0; i < text.length; i++) {
      const r = dir === "H" ? row : row + i;
      const c = dir === "H" ? col + i : col;
      const key = `${r},${c}`;
      const ch = text[i];

      if (letterAt[key] && letterAt[key] !== ch) {
        throw new Error(
          `Intersection conflict at (${key}): '${letterAt[key]}' vs '${ch}'.`
        );
      }
      if (!seen.has(key)) {
        seen.add(key);
        letterAt[key] = ch;
        cells.push({ row: r, col: c });
        solutionLetters.push(ch);
      }
    }
  }

  return { cells, solutionLetters };
}

// Assign permanent Location IDs (Top slot i ⇄ Bottom Location i) using first-fit by letter
function assignLocations(lettersTop, solutionLetters, cells) {
  if (lettersTop.length !== solutionLetters.length) {
    throw new Error(
      `Letter count mismatch: phrase ${lettersTop.length} vs grid ${solutionLetters.length}`
    );
  }
  const N = lettersTop.length;

  const used = new Array(N).fill(false);
  const cellForLocation = new Array(N + 1); // 1..N -> {row,col}
  const requiredLetterAt = new Array(N + 1); // 1..N -> 'A'..'Z'
  const locationForCell = {}; // "r,c" -> i

  for (let i = 0; i < N; i++) {
    const L = lettersTop[i];
    let assigned = false;
    for (let j = 0; j < N; j++) {
      if (!used[j] && solutionLetters[j] === L) {
        const loc = i + 1;
        used[j] = true;
        cellForLocation[loc] = { row: cells[j].row, col: cells[j].col };
        requiredLetterAt[loc] = L;
        locationForCell[`${cells[j].row},${cells[j].col}`] = loc;
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      throw new Error(`No available cell for phrase letter '${L}' at index ${i + 1}`);
    }
  }

  return { cellForLocation, requiredLetterAt, locationForCell };
}

// Build 1px lattice segments as unique edges across all letter cells
function buildLatticeSegments(cells, cellSize, offsetX, offsetY) {
  // Each cell contributes 4 edges; we dedupe by a normalized edge key.
  const edges = new Set();

  const addEdge = (x1, y1, x2, y2) => {
    // Normalize so (x1,y1) <= (x2,y2) lexicographically
    const k =
      x1 < x2 || (x1 === x2 && y1 <= y2)
        ? `${x1},${y1}-${x2},${y2}`
        : `${x2},${y2}-${x1},${y1}`;
    edges.add(k);
  };

  for (const { row, col } of cells) {
    const x0 = offsetX + col * cellSize;
    const y0 = offsetY + row * cellSize;
    const x1 = x0 + cellSize;
    const y1 = y0 + cellSize;

    addEdge(x0, y0, x1, y0); // top
    addEdge(x0, y1, x1, y1); // bottom
    addEdge(x0, y0, x0, y1); // left
    addEdge(x1, y0, x1, y1); // right
  }

  // Convert set to array of edges
  const segments = [];
  for (const k of edges) {
    const [a, b] = k.split("-");
    const [x1, y1] = a.split(",").map(Number);
    const [x2, y2] = b.split(",").map(Number);
    segments.push({ x1, y1, x2, y2 });
  }
  return segments;
}

// Compute rectangular yellow bands (no arrowheads) for Level 1
function computeYellowBands(
  words,
  requiredLetterAt,
  tileAtLocation,
  isGreenLocked,
  locationForCell,
  lettersTop
) {
  // Returns: { bandH: Set<loc>, bandV: Set<loc> }
  const bandH = new Set();
  const bandV = new Set();

  // Helper to resolve the current letter sitting at a location
  const currentLetterAt = (loc) => {
    const tileId = tileAtLocation[loc];  // 1..N
    return lettersTop[tileId - 1];       // 'A'..'Z'
  };

  // Process each word independently (Wordle-style caps per word)
  for (const w of words) {
    const dir = (w.dir || "H").toUpperCase();
    const text = (w.text || "").toUpperCase().replace(/[^A-Z]/g, "");

    // Gather this word's locations in reading order
    const locs = [];
    for (let i = 0; i < text.length; i++) {
      const r = dir === "H" ? w.row : w.row + i;
      const c = dir === "H" ? w.col + i : w.col;
      const key = `${r},${c}`;
      const loc = locationForCell[key];
      if (loc) locs.push(loc);
    }

    // Required letters (solution) along this word
    const sol = locs.map((loc) => requiredLetterAt[loc]);

    // Count “greens” to cap duplicates
    const uniqueLetters = Array.from(new Set(sol));
    for (const L of uniqueLetters) {
      const requiredCount = sol.filter((x) => x === L).length;
      const greens = locs.filter(
        (loc) => isGreenLocked[loc] && requiredLetterAt[loc] === L
      ).length;
      let need = requiredCount - greens;
      if (need <= 0) continue;

      // Candidates: wrong-spot cells where current letter equals L and not green
      const candidates = locs.filter(
        (loc) => !isGreenLocked[loc] && currentLetterAt(loc) === L
      );

      // Mark yellow on first `need` candidates in reading order
      for (let i = 0; i < candidates.length && need > 0; i++) {
        const loc = candidates[i];
        if (dir === "H") bandH.add(loc);
        else bandV.add(loc);
        need--;
      }
    }
  }

  return { bandH, bandV };
}



// Rectangle overlap ratio of A over B (A is dragged tile's rect, B is candidate target rect)
// Return areaIntersection / areaA
function overlapRatio(rectA, rectB) {
  const x1 = Math.max(rectA.left, rectB.left);
  const y1 = Math.max(rectA.top, rectB.top);
  const x2 = Math.min(rectA.right, rectB.right);
  const y2 = Math.min(rectA.bottom, rectB.bottom);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const areaA = (rectA.right - rectA.left) * (rectA.bottom - rectA.top);
  if (areaA <= 0) return 0;
  return inter / areaA;
}

/* =========================================
   1) Main Component
   ========================================= */

export default function Page() {
  const search = useSearchParams();
  const [puzzles, setPuzzles] = useState(null);
  const [error, setError] = useState("");
  const [activePuzzle, setActivePuzzle] = useState(null); // resolved Puzzle
  const [level, setLevel] = useState(1); // 1 or 2

  // Immutable per puzzle (computed once per loaded puzzle)
  const [mapping, setMapping] = useState(null);
  // mapping = {
  //   N, lettersTop, cellForLocation[1..N], requiredLetterAt[1..N], locationForCell,
  //   cells (array for lattice), gridWidth, gridHeight, words (normalized directions/letters)
  // }

  // Mutable per level
  const [stateByLevel, setStateByLevel] = useState({
    1: null,
    2: null,
  });

  // Drag state
  const dragRef = useRef({
    isDragging: false,
    fromLoc: null,
    pointerId: null,
    startX: 0,
    startY: 0,
    tileStartX: 0,
    tileStartY: 0,
    holdTimer: null,
    picked: false,
  });

  // Grid layout refs for pixel math
  const gridRef = useRef(null);
  const [cellSize, setCellSize] = useState(48); // will be clamped between min/max
  const [gridOffset, setGridOffset] = useState({ x: 0, y: 0 }); // px top-left

  // Modal state
  const [modal, setModal] = useState(null); // 'tbd' | 'reset' | 'help' | null

  // Fetch puzzles.json
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/puzzles.json", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!alive) return;
        setPuzzles(data);
      } catch (e) {
        setError(`Failed to load puzzles.json: ${e.message}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Resolve active puzzle by ?puzzle=<id> or default first
  useEffect(() => {
    if (!puzzles) return;
    const idParam = search.get("puzzle");
    let chosen = null;
    if (idParam) {
      const pid = Number(idParam);
      chosen = puzzles.puzzles.find((p) => p.id === pid) || null;
    }
    if (!chosen) {
      chosen = puzzles.puzzles[0] || null;
    }
    if (!chosen) {
      setError("No puzzles available in puzzles.json.");
      return;
    }
    setActivePuzzle(chosen);
    setLevel(1); // default to Level 1 on puzzle change
  }, [puzzles, search]);

  // Build mapping (normalization, cells, locations) once per active puzzle
  useEffect(() => {
    if (!activePuzzle) return;
    try {
      const lettersTop = normalizePhrase(activePuzzle.phrase);
      if (lettersTop.length === 0) throw new Error("Phrase normalizes to zero letters.");

      const wordsNorm = activePuzzle.words.map((w) => ({
        text: (w.text || "").toUpperCase().replace(/[^A-Z]/g, ""),
        dir: (w.dir || "H").toUpperCase(),
        row: w.row | 0,
        col: w.col | 0,
      }));

      const { cells, solutionLetters } = enumerateCells(
        wordsNorm,
        activePuzzle.grid.width,
        activePuzzle.grid.height
      );

      if (solutionLetters.length !== lettersTop.length) {
        throw new Error(
          `Grid letters (${solutionLetters.length}) ≠ normalized phrase letters (${lettersTop.length}).`
        );
      }

      const { cellForLocation, requiredLetterAt, locationForCell } = assignLocations(
        lettersTop,
        solutionLetters,
        cells
      );

      const N = lettersTop.length;

      setMapping({
        N,
        lettersTop,
        cellForLocation,
        requiredLetterAt,
        locationForCell,
        cells,
        gridWidth: activePuzzle.grid.width,
        gridHeight: activePuzzle.grid.height,
        words: wordsNorm,
      });
    } catch (e) {
      setError(`Mapping error: ${e.message}`);
    }
  }, [activePuzzle]);

  // Initialize per-level state (from localStorage or JSON start_state)
  useEffect(() => {
    if (!activePuzzle || !mapping) return;

    // Always initialize from puzzles.json start_state (ignore any saved state for now)
const initLevel = (lvl) => {
  const start = activePuzzle.start_state;
  const N = mapping.N;

  // tileAtLocation[loc] = tileId (1..N)
  const tileAtLocation = new Array(N + 1);
  for (let i = 1; i <= N; i++) {
    const loc = start.scramble[i - 1];
    tileAtLocation[loc] = i;
  }

  // Only the seeded positions start green/locked
  const isGreenLocked = new Array(N + 1).fill(false);
  for (const loc of start.correct_positions) {
    isGreenLocked[loc] = true;
  }

  return {
    tileAtLocation,
    isGreenLocked,
    moveCount: 0,
    isComplete: isGreenLocked.slice(1).every(Boolean),
  };
};


    setStateByLevel({
      1: initLevel(1),
      2: initLevel(2),
    });
  }, [activePuzzle, mapping]);

  // Persist on state changes (per-level)
  useEffect(() => {
    if (!activePuzzle || !mapping) return;
    const st = stateByLevel[level];
    if (!st) return;
    try {
      localStorage.setItem(
        saveKey(activePuzzle.id, level),
        JSON.stringify({
          tileAtLocation: st.tileAtLocation,
          moveCount: st.moveCount,
          isComplete: st.isComplete,
        })
      );
    } catch (_) {
      // ignore
    }
  }, [stateByLevel, level, activePuzzle, mapping]);

  // Compute yellow bands for current level (Level 1 only); memoized for performance
  const bands = useMemo(() => {
    if (!activePuzzle || !mapping) return { bandH: new Set(), bandV: new Set() };
    const st = stateByLevel[level];
    if (!st) return { bandH: new Set(), bandV: new Set() };
    if (level !== 1) return { bandH: new Set(), bandV: new Set() }; // Level 2 has no bands

    return computeYellowBands(
      mapping.words,
      mapping.requiredLetterAt,
      st.tileAtLocation,
      st.isGreenLocked,
      mapping.locationForCell,
      mapping.lettersTop
    );

  }, [activePuzzle, mapping, stateByLevel, level]);
    /* ===========================
     Top Ribbon: build lines (always run this hook)
     =========================== */
  const ribbon = useMemo(() => {
    // If we don't have data yet, return an empty array to keep hooks order stable
    if (!activePuzzle || !mapping) return [];

    const Nloc = mapping.N;
    const display = activePuzzle.phrase || "";
    const tokens = tokenizePhraseForWrapping(display);
    const lines = wrapTokensToLines(tokens, 3, 13); // ≤3 lines, ≤13 letters/line

    // Build per-character structure with optional locationId
    let letterIndex = 0;
    const perLine = lines.map((toks) => {
      const lineText = toks.map((t) => t.text).join("");
      const chars = Array.from(lineText).map((ch) => {
        const L = normalizeCharToLetter(ch);
        if (L) {
          letterIndex += 1;
          return { ch, loc: letterIndex }; // letter slot -> Location ID
        } else {
          return { ch, loc: 0 }; // punctuation/space
        }
      });
      return { text: lineText, chars };
    });

    // Optional: warn if authoring / runtime mismatch
    if (letterIndex !== Nloc) {
      console.warn("Ribbon letter count mismatch", { letterIndex, N: Nloc });
    }

    return perLine;
  }, [activePuzzle, mapping]);



  // Compute grid pixel layout on resize
  useEffect(() => {
    const resize = () => {
      const el = gridRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // compute cell size to fit width (gridWidth * size) with some padding
      const cols = mapping?.gridWidth || 7;
      let size = Math.floor(rect.width / (cols + 0.0));
      size = Math.max(CELL_SIZE_MIN, Math.min(CELL_SIZE_MAX, size));
      setCellSize(size);

      // top-left offset (center vertically inside container)
      setGridOffset({ x: 0, y: 0 });
    };
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [mapping]);

  if (error) {
    return (
      <div style={{ padding: 24 }}>
        <h2>Oops</h2>
        <p>{error}</p>
      </div>
    );
  }
  if (!activePuzzle || !mapping || !stateByLevel[1] || !stateByLevel[2]) {
    return <div style={{ padding: 24 }}>Loading puzzle…</div>;
  }

  const N = mapping.N;
  const st = stateByLevel[level];

  // Convenience resolvers
  const letterAtTile = (tileId) => mapping.lettersTop[tileId - 1];
  const letterAtLocation = (loc) => letterAtTile(st.tileAtLocation[loc]);

  // Recompute green locks for a set of locations (after swap)
  const recomputeGreens = (locs) => {
    const nextLocked = st.isGreenLocked.slice();
    let anyChange = false;
    for (const loc of locs) {
      const cur = letterAtLocation(loc);
      const req = mapping.requiredLetterAt[loc];
      const nowGreen = cur === req;
      if (nextLocked[loc] !== nowGreen) {
        nextLocked[loc] = nowGreen;
        anyChange = true;
      }
    }
    const isComplete = nextLocked.slice(1).every(Boolean);
    setStateByLevel((prev) => ({
      ...prev,
      [level]: {
        ...prev[level],
        isGreenLocked: nextLocked,
        isComplete,
      },
    }));
  };

  // Reset current level (with confirm modal)
  const confirmReset = () => setModal("reset");
  const performReset = () => {
    // Build from JSON start_state
    const start = activePuzzle.start_state;
    const tileAtLocation = new Array(N + 1);
    for (let i = 1; i <= N; i++) {
      const loc = start.scramble[i - 1];
      tileAtLocation[loc] = i;
    }
    const isGreenLocked = new Array(N + 1).fill(false);
    for (const loc of start.correct_positions) {
      isGreenLocked[loc] = true;
    }
    setStateByLevel((prev) => ({
      ...prev,
      [level]: {
        tileAtLocation,
        isGreenLocked,
        moveCount: 0,
        isComplete: isGreenLocked.slice(1).every(Boolean),
      },
    }));
    try {
      localStorage.removeItem(saveKey(activePuzzle.id, level));
    } catch (_) {}
    setModal(null);
  };

  // Save helpers
  const setMoveCount = (mc) =>
    setStateByLevel((prev) => ({ ...prev, [level]: { ...prev[level], moveCount: mc } }));


  /* ===========================
     Drag & Drop Handlers
     =========================== */

  // Convert a grid location -> pixel rect for overlap math
  const rectForLocation = (loc) => {
    const { row, col } = mapping.cellForLocation[loc];
    const x = gridOffset.x + col * cellSize;
    const y = gridOffset.y + row * cellSize;
    return { left: x, top: y, right: x + cellSize, bottom: y + cellSize };
  };

  const onPointerDownTile = (e, loc) => {
    if (st.isComplete) return;
    if (st.isGreenLocked[loc]) return; // locked cannot be dragged
    const dr = dragRef.current;
    const tileRect = e.currentTarget.getBoundingClientRect();

    dr.isDragging = true;
    dr.fromLoc = loc;
    dr.pointerId = e.pointerId;
    dr.startX = e.clientX;
    dr.startY = e.clientY;
    dr.tileStartX = tileRect.left;
    dr.tileStartY = tileRect.top;
    dr.picked = false;

    e.currentTarget.setPointerCapture(e.pointerId);

    // Hold timer OR move threshold to "pick up"
    dr.holdTimer = setTimeout(() => {
      dr.picked = true;
      e.currentTarget.classList.add("drag-picked");
    }, DRAG_PICKUP_HOLD_MS);
  };

  const onPointerMoveTile = (e) => {
  const dr = dragRef.current;
  if (!dr.isDragging || dr.pointerId !== e.pointerId) return;

  const dx = e.clientX - dr.startX;
  const dy = e.clientY - dr.startY;

  // pick up quickly once the pointer has moved enough
  if (!dr.picked && Math.hypot(dx, dy) >= DRAG_PICKUP_MOVE_PX) {
    dr.picked = true;
    e.currentTarget.classList.add("drag-picked");
  }

  // IMPORTANT: scope the drag offsets to THIS tile only
  e.currentTarget.style.setProperty("--drag-dx", `${dx}px`);
  e.currentTarget.style.setProperty("--drag-dy", `${dy}px`);
};


  const onPointerUpTile = (e) => {
    const dr = dragRef.current;
    if (!dr.isDragging || dr.pointerId !== e.pointerId) return;

    // Clear hold timer
    if (dr.holdTimer) {
      clearTimeout(dr.holdTimer);
      dr.holdTimer = null;
    }

    // Determine if we have a valid target (≥50% overlap with an unlocked tile)
    const from = dr.fromLoc;
    const fromRect = rectForLocation(from);
    const dx = e.clientX - dr.startX;
    const dy = e.clientY - dr.startY;
    const draggedRect = {
      left: fromRect.left + dx,
      top: fromRect.top + dy,
      right: fromRect.right + dx,
      bottom: fromRect.bottom + dy,
    };

    // collect candidate targets (unlocked, not same as from)
    let bestLoc = null;
    let bestOverlap = 0;
    for (let loc = 1; loc <= N; loc++) {
      if (loc === from) continue;
      if (st.isGreenLocked[loc]) continue;
      const rect = rectForLocation(loc);
      const ratio = overlapRatio(draggedRect, rect);
      if (ratio >= OVERLAP_THRESHOLD && ratio > bestOverlap) {
        bestOverlap = ratio;
        bestLoc = loc;
      }
    }

    // Reset CSS transform vars
    // Reset CSS transform vars on THIS tile only
    e.currentTarget.style.setProperty("--drag-dx", "0px");
    e.currentTarget.style.setProperty("--drag-dy", "0px");
    e.currentTarget.classList.remove("drag-picked");

    // Commit swap if valid
    if (bestLoc != null) {
      // swap tiles
      const a = from;
      const b = bestLoc;
      const next = st.tileAtLocation.slice();
      const tmp = next[a];
      next[a] = next[b];
      next[b] = tmp;

      setStateByLevel((prev) => ({
        ...prev,
        [level]: { ...prev[level], tileAtLocation: next, moveCount: prev[level].moveCount + 1 },
      }));

      // Re-evaluate correctness for a & b
      setTimeout(() => {
        recomputeGreens([a, b]);
      }, 0);
    }

    // Cleanup
    dr.isDragging = false;
    dr.fromLoc = null;
    dr.pointerId = null;
    dr.picked = false;
  };

  // Level switch handler
  const onSwitchLevel = (lvl) => {
    if (lvl === level) return;
    setLevel(lvl);
  };

  // Build lattice segments (no hook: safe across loading states)
const latticeSegments =
  !mapping || !cellSize || !gridOffset
    ? []
    : buildLatticeSegments(
        mapping.cells,
        cellSize,
        gridOffset.x,
        gridOffset.y
      );


  // Min moves
  const minimumMoves = activePuzzle.start_state?.min_moves ?? 0;

  return (
    <div className="page-root">
      {/* Top Row */}
      <header className="top-row">
        <div className="game-name" aria-label="Game Name">
          Alloquest Word Grid
        </div>
        <div className="top-buttons">
          <button className="btn secondary" onClick={() => setModal("tbd")} aria-label="TBD (placeholder)">
            TBD
          </button>
          <button className="btn secondary" onClick={confirmReset} aria-label="Reset board">
            Reset
          </button>
          <button className="btn secondary" onClick={() => setModal("help")} aria-label="Help / instructions">
            ?
          </button>
        </div>
      </header>

      {/* Level Buttons */}
      <div className="levels" role="radiogroup" aria-label="Level select">
        <button
          className={`level-btn ${level === 1 ? "active" : ""}`}
          role="radio"
          aria-checked={level === 1}
          onClick={() => onSwitchLevel(1)}
        >
          Level 1
        </button>
        <button
          className={`level-btn ${level === 2 ? "active" : ""}`}
          role="radio"
          aria-checked={level === 2}
          onClick={() => onSwitchLevel(2)}
        >
          Level 2
        </button>
      </div>

      {/* Top Letter Ribbon */}
      <section className="ribbon" aria-label="Target phrase">
        {ribbon.map((line, idx) => {
          // Center line by slot count using monospace; numbers under letters only
          return (
            <div key={idx} className="ribbon-line">
              {line.chars.map((cell, i) => {
                const isLetter = cell.loc > 0;
                const loc = cell.loc;
                const isGreen = isLetter ? st.isGreenLocked[loc] : false;
                return (
                  <div key={i} className="ribbon-slot">
                    <div
                      className={`ribbon-char ${isLetter ? (isGreen ? "green" : "blue") : "punct"}`}
                      style={{ fontFamily: RIBBON_MONO }}
                    >
                      {cell.ch}
                    </div>
                    {isLetter && !isGreen && (
                      <div className="ribbon-num" aria-hidden="true">
                        {loc}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </section>

      {/* Move Counter */}
      <section className="moves">
        <div className="moves-primary">Moves: {st.moveCount}</div>
        <div className="moves-secondary">Minimum moves needed to solve: {minimumMoves}</div>
      </section>

      {/* Bottom Grid */}
      <section className="grid-wrap" ref={gridRef} aria-label="Puzzle grid">
        {/* Cell backgrounds (greens/incorrect) & numbers & letters */}
        {Array.from({ length: N }, (_, idx) => {
          const loc = idx + 1;
          const { row, col } = mapping.cellForLocation[loc];
          const x = gridOffset.x + col * cellSize;
          const y = gridOffset.y + row * cellSize;
          const isGreen = st.isGreenLocked[loc];
          const tileId = st.tileAtLocation[loc];
          const letter = mapping.lettersTop[tileId - 1];

          // Yellow bands (rectangular, Level 1 only, only when incorrect)
          const showBandH = level === 1 && !isGreen && bands.bandH.has(loc);
          const showBandV = level === 1 && !isGreen && bands.bandV.has(loc);

          return (
            <div
              key={loc}
              className="cell"
              style={{
                left: x,
                top: y,
                width: cellSize,
                height: cellSize,
                background: isGreen ? COLOR.green : COLOR.cellBG,
              }}
            >
              {/* Bands under lattice */}
              {showBandH && (
                <div
                  className="bandH"
                  style={{
                    left: BAND_INSET,
                    right: BAND_INSET,
                    top: (cellSize * (1 - BAND_THICKNESS_PCT)) / 2,
                    height: cellSize * BAND_THICKNESS_PCT,
                    background: COLOR.bandYellow,
                  }}
                />
              )}
              {showBandV && (
                <div
                  className="bandV"
                  style={{
                    top: BAND_INSET,
                    bottom: BAND_INSET,
                    left: (cellSize * (1 - BAND_THICKNESS_PCT)) / 2,
                    width: cellSize * BAND_THICKNESS_PCT,
                    background: COLOR.bandYellow,
                  }}
                />
              )}

              {/* Numbers (only when incorrect) */}
              {!isGreen && (
                <div className="cell-num" style={{ color: COLOR.number }}>
                  {loc}
                </div>
              )}

              {/* Letter glyph (blue or white) */}
              <div
                className={`tile ${st.isGreenLocked[loc] ? "locked" : "unlocked"}`}
                style={{
                  color: isGreen ? COLOR.white : COLOR.letterBlue,
                }}
                // Pointer events for drag only on unlocked
                onPointerDown={(e) => onPointerDownTile(e, loc)}
                onPointerMove={onPointerMoveTile}
                onPointerUp={onPointerUpTile}
              >
                {letter}
              </div>
            </div>
          );
        })}

        {/* Lattice SVG (always on top of bands, under numbers/letters) */}
        <svg className="lattice" aria-hidden="true">
          <g
            stroke={COLOR.gridLine}
            strokeWidth="1"
            shapeRendering="crispEdges"
            vectorEffect="non-scaling-stroke"
          >
            {latticeSegments.map((seg, i) => {
              // Align to 0.5 to reduce anti-alias blur
              const x1 = seg.x1 + 0.5;
              const y1 = seg.y1 + 0.5;
              const x2 = seg.x2 + 0.5;
              const y2 = seg.y2 + 0.5;
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
            })}
          </g>
        </svg>
      </section>

      {/* Modals */}
      {modal === "tbd" && (
        <Modal title="Feature coming soon" onClose={() => setModal(null)}>
          <p>This button is reserved for a future feature. Nothing to do here yet.</p>
          <div className="modal-actions">
            <button className="btn primary" onClick={() => setModal(null)}>Close</button>
          </div>
        </Modal>
      )}
      {modal === "help" && (
        <Modal title="How to play" onClose={() => setModal(null)}>
          <ul className="help-list">
            <li>Drag a tile to swap with another <strong>unlocked</strong> tile (≥ 50% overlap).</li>
            <li>Green squares are correct &amp; locked; numbers hide on greens.</li>
            <li>Level 1 shows yellow hint bands; Level 2 does not.</li>
            <li>Top slots mirror bottom locations; duplicates are fungible (any matching letter satisfies).</li>
            <li>Reset restores the original scramble for the current level and sets Moves to 0.</li>
          </ul>
          <div className="modal-actions">
            <button className="btn primary" onClick={() => setModal(null)}>Close</button>
          </div>
        </Modal>
      )}
      {modal === "reset" && (
        <Modal title="Reset this level?" onClose={() => setModal(null)}>
          <p>
            This will restore this puzzle’s <strong>current level</strong> to its original start state
            (same scramble and seeded greens) and reset <strong>Moves</strong> to 0. You can’t undo this.
          </p>
          <div className="modal-actions">
            <button className="btn secondary" autoFocus onClick={() => setModal(null)}>
              Cancel
            </button>
            <button className="btn danger" onClick={performReset}>
              Reset
            </button>
          </div>
        </Modal>
      )}

      <style jsx>{`
        .page-root {
          max-width: 920px;
          margin: 0 auto;
          padding: 16px 12px 48px;
        }

        /* Top Row */
        .top-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 12px;
          gap: 12px;
        }
        .game-name {
          font-weight: 700;
          font-size: 18px;
        }
        .top-buttons {
          display: flex;
          gap: 8px;
        }

        /* Buttons */
        .btn {
          height: 40px;
          padding: 0 14px;
          border-radius: 8px;
          border: 1px solid #ccd1d9;
          background: #f9fafb;
          color: #111;
          cursor: pointer;
        }
        .btn.secondary:hover { background: #f2f4f7; }
        .btn.primary {
          border-color: #1c479f;
          background: #1c479f;
          color: #fff;
        }
        .btn.danger {
          border-color: #b42318;
          background: #b42318;
          color: #fff;
        }

        /* Level buttons */
        .levels {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          margin: 8px 0 8px;
        }
        .level-btn {
          min-width: 120px;
          height: 44px;
          border: 1px solid #ccd1d9;
          border-radius: 10px;
          background: #fff;
          cursor: pointer;
        }
        .level-btn.active {
          background: #1c479f;
          color: #fff;
          border-color: #1c479f;
          font-weight: 700;
        }

        /* Ribbon */
        .ribbon {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          margin: 10px 0 8px;
        }
        .ribbon-line {
          display: flex;
          justify-content: center;
          align-items: flex-end;
          gap: 0; /* monospaced; each slot is a fixed width due to font */
          white-space: pre;
        }
        .ribbon-slot {
          display: inline-flex;
          flex-direction: column;
          align-items: center;
          justify-content: flex-end;
          margin: 0 1px;
        }
        .ribbon-char {
          font-size: clamp(20px, 3.2vw, 26px);
          line-height: 1.0;
          letter-spacing: 0;
        }
        .ribbon-char.blue { color: #1240a0; }
        .ribbon-char.green { color: #fff; background: #208040; border-radius: 4px; padding: 0 2px; }
        .ribbon-char.punct { color: #111; }
        .ribbon-num {
          font-size: 0.6em;
          color: ${COLOR.number};
          margin-top: 6px; /* baseline gap letters→numbers */
          transform: translateY(1px); /* sit below descenders */
          user-select: none;
        }

        /* Moves */
        .moves {
          text-align: center;
          margin: 10px 0 14px;
        }
        .moves-primary { font-weight: 700; font-size: 18px; }
        .moves-secondary { font-size: 13px; color: #555; margin-top: 2px; }

        /* Grid */
        .grid-wrap {
          position: relative;
          width: min(100%, 560px);
          margin: 0 auto;
          /* height grows to fit content; lattice SVG is absolute full-cover */
        }
        .cell {
          position: absolute;
          box-sizing: border-box;
          /* No rounding; cells abut perfectly. */
        }

        /* Yellow rectangular bands (no heads) */
        .bandH, .bandV {
          position: absolute;
          pointer-events: none;
          border-radius: 0;
        }

        /* Numbers in bottom cells */
        .cell-num {
          position: absolute;
          left: 6px;
          top: 4px;
          font-size: 12px;
          line-height: 1;
          user-select: none;
        }

        /* Tile glyph */
        .tile {
          position: absolute;
          left: 50%;
          top: 50%;
          transform: translate(calc(-50% + var(--drag-dx, 0px)), calc(-50% + var(--drag-dy, 0px)));
          font-size: clamp(22px, 4.2vw, 28px);
          font-weight: 800;
          user-select: none;
          touch-action: none; /* allow pointer events */
          will-change: transform;
        }
        .tile.locked {
          pointer-events: none; /* not draggable */
        }

        /* Lattice SVG overlay */
        .lattice {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          pointer-events: none;
        }

        /* Modal base */
        .modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.35);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 999;
        }
        .modal {
          background: #fff;
          border-radius: 12px;
          padding: 16px 18px;
          width: min(520px, 92vw);
          box-shadow: 0 10px 40px rgba(0,0,0,0.18);
        }
        .modal h3 {
          margin: 4px 0 10px;
          font-size: 18px;
        }
        .modal-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 12px;
        }
        .help-list { margin: 6px 0 0 18px; }
      `}</style>
    </div>
  );
}

/* ===========================
   Modal Component (accessible)
   =========================== */

function Modal({ title, children, onClose }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    const prev = document.activeElement;
    // Focus first focusable
    setTimeout(() => {
      const el = dialogRef.current;
      if (!el) return;
      const btn = el.querySelector("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      if (btn) btn.focus();
    }, 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Return focus to previous
      if (prev && prev.focus) prev.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div
        className="modal"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        aria-labelledby="modal-title"
      >
        <h3 id="modal-title">{title}</h3>
        <div>{children}</div>
      </div>
    </div>
  );
}
