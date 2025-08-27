"use client";

import { useEffect, useMemo, useState } from "react";

/* ----------------------------- tiny utils ----------------------------- */

// NFD → strip accents → uppercase → A–Z only
function normalizeAZ(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}

// enumerate unique grid cells in deterministic order (Spec 1.2)
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
      const key = `${r},${c}`;
      if (!seen.has(key)) {
        seen.add(key);
        cells.push({ row: r, col: c });
        solutionLetters.push(t[i]);
      } else {
        const idx = cells.findIndex((p) => p.row === r && p.col === c);
        if (idx >= 0 && solutionLetters[idx] !== t[i]) {
          throw new Error(`Grid conflict at (${r},${c})`);
        }
      }
    }
  }
  return { cells, solutionLetters };
}

// assign first-fit locations (Spec 1.3)
function assignLocations(lettersTop, solutionLetters, cells) {
  const N = lettersTop.length;
  const claimed = new Array(solutionLetters.length).fill(false);
  const cellForLocation = new Array(N + 1);
  const requiredLetterAt = new Array(N + 1);
  const locationForCell = {};
  for (let i = 1; i <= N; i++) {
    const L = lettersTop[i - 1];
    let pick = -1;
    for (let j = 0; j < solutionLetters.length; j++) {
      if (!claimed[j] && solutionLetters[j] === L) { pick = j; claimed[j] = true; break; }
    }
    if (pick === -1) throw new Error(`No free cell for '${L}' (i=${i})`);
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
    tok.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z]/g, "").length;

  for (const tok of tokens) {
    const add = letterCount(tok);
    if (cur.length > 0 && curLetters + add > maxLetters) {
      lines.push(cur); cur = [tok]; curLetters = add;
    } else {
      cur.push(tok); curLetters += add;
    }
  }
  if (cur.length) lines.push(cur);

  let nextIndex = 1;
  return lines.map((toks) => {
    const chars = [];
    toks.forEach((tok, idx) => {
      for (let i = 0; i < tok.length; i++) {
        const ch = tok[i];
        const norm = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
        const isLetter = /^[A-Z]$/.test(norm);
        const topIndex = isLetter ? nextIndex++ : null;
        chars.push({ ch, isLetter, topIndex });
      }
      if (idx < toks.length - 1) chars.push({ ch: " ", isLetter: false, topIndex: null });
    });
    return { chars };
  });
}

/* ---------------------------- per-puzzle derive ---------------------------- */
// This packs ALL derived data for a puzzle into one object so Level 1/2 can switch instantly.
function derivePuzzleData(puzzle) {
  if (!puzzle) return null;
  const phrase = puzzle.phrase || "";
  const lettersTop = normalizeAZ(phrase);
  const N = lettersTop.length;
  const { cells, solutionLetters } = enumerateCells(puzzle.words || []);
  if (N !== cells.length) throw new Error(`N (${N}) != cells (${cells.length})`);
  const { requiredLetterAt, cellForLocation } = assignLocations(lettersTop, solutionLetters, cells);

  // Build ribbon & display chars (accented) by Top index
  const ribbonLines = makeRibbonLines(phrase);
  const displayCharByTopIndex = [];
  for (const line of ribbonLines) {
    for (const cell of line.chars) {
      if (cell.isLetter && cell.topIndex != null) displayCharByTopIndex[cell.topIndex] = cell.ch;
    }
  }

  // (row,col)->loc map from cellForLocation (0-based)
  const locByKey = {};
  for (let i = 1; i <= N; i++) {
    const cell = cellForLocation[i];
    if (cell) locByKey[`${cell.row},${cell.col}`] = i;
  }

  // Startup placement from JSON
  const scramble = puzzle?.start_state?.scramble || [];
  const tileAtLocationStart = placementFromScramble(scramble);
  const correctPositionsJSON = puzzle?.start_state?.correct_positions || [];
  const minMoves = puzzle?.start_state?.min_moves;

  // Grid dims
  const gridW = puzzle?.grid?.width || 0;
  const gridH = puzzle?.grid?.height || 0;
  const rows = Array.from({ length: gridH }, (_, r) => r);
  const cols = Array.from({ length: gridW }, (_, c) => c);

  return {
    puzzle, phrase, lettersTop, N,
    requiredLetterAt, cellForLocation, locByKey,
    ribbonLines, displayCharByTopIndex,
    tileAtLocationStart, correctPositionsJSON, minMoves,
    gridW, gridH, rows, cols,
  };
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
        if (!Array.isArray(puzzles) || puzzles.length === 0) throw new Error("No puzzles found");
        setData({ raw, puzzles });
      } catch (e) { setErr(String(e?.message || e)); }
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

  // Derive BOTH puzzles up-front (memoized), then instant toggle
  const derived1 = useMemo(() => (puzzles[idx1] ? derivePuzzleData(puzzles[idx1]) : null), [puzzles, idx1]);
  const derived2 = useMemo(() => (puzzles[idx2] ? derivePuzzleData(puzzles[idx2]) : null), [puzzles, idx2]);

  // Level selection (instant toggle)
  const [activeLevel, setActiveLevel] = useState(1);

  // Per-level tiles & moves; initialize when that level's puzzle changes
  const [byLevel, setByLevel] = useState({ 1: null, 2: null });
  useEffect(() => {
    if (!derived1) return;
    setByLevel((prev) => ({
      ...prev,
      1: { tileAtLocation: derived1.tileAtLocationStart.slice(), moveCount: 0 },
    }));
  }, [derived1?.puzzle?.id]);

  useEffect(() => {
    if (!derived2) return;
    setByLevel((prev) => ({
      ...prev,
      2: { tileAtLocation: derived2.tileAtLocationStart.slice(), moveCount: 0 },
    }));
  }, [derived2?.puzzle?.id]);

  // Early guards
  if (err) return <div className="p-6 text-red-600">Error: {err}</div>;
  if (!derived1) return <div className="p-6">Loading…</div>;

  // Active view picks one derived pack; UI logic is identical for both.
  const D = activeLevel === 1 ? derived1 : (derived2 || derived1);

  // Selected tiles for the active level (falls back to startup state)
  const selectedTileAtLocation =
    byLevel[activeLevel]?.tileAtLocation || D.tileAtLocationStart;

  // Greens for CURRENT view
  const greensComputed = useMemo(() => {
    const out = [];
    for (let loc = 1; loc <= D.N; loc++) {
      const t = selectedTileAtLocation[loc];
      if (t && D.lettersTop[t - 1] === D.requiredLetterAt[loc]) out.push(loc);
    }
    return out;
  }, [selectedTileAtLocation, D]);

  const greensSet = useMemo(() => new Set(greensComputed), [greensComputed]);

  // Bottom grid helpers
  const cellSize = "clamp(40px, 10vw, 56px)";
  const getLocId = (r, c) => {
    const key = `${r},${c}`;
    const loc = D.locByKey[key];
    return typeof loc === "number" ? loc : 0;
  };

  /* -------------------------------- UI -------------------------------- */
  return (
    <div className="min-h-screen w-full bg-white text-gray-900 p-4">
      <div className="max-w-xl mx-auto space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">Word Game</div>
          <div className="text-xs px-2 py-1 rounded-full bg-gray-100">
            idx={baseIndex} → L1: {idx1} / L2: {idx2}
          </div>
        </div>

        {/* Level selector (instant; URL does NOT change) */}
        <div className="flex items-center justify-center gap-2">
          <button
            type="button"
            aria-pressed={activeLevel === 1}
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
            aria-pressed={activeLevel === 2}
            onClick={() => setActiveLevel(2)}
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
        <div className="rounded-xl border border-gray-200 bg-white p-3">
          <div className="space-y-2">
            {D.ribbonLines.map((line, li) => (
              <div
                key={li}
                className="flex justify-center gap-[0.35ch] font-mono"
                style={{ fontVariantLigatures: "none", WebkitFontSmoothing: "antialiased" }}
              >
                {line.chars.map((cell, ci) => {
                  const isGreen = cell.isLetter && cell.topIndex != null && greensSet.has(cell.topIndex);
                  const showNumber = cell.isLetter && !isGreen;
                  const colorClass = cell.isLetter ? (isGreen ? "text-[#208040]" : "text-[#1240A0]") : "text-gray-700";
                  const tileId = cell.isLetter && cell.topIndex != null ? (selectedTileAtLocation[cell.topIndex] || 0) : 0;
                  const glyph = cell.isLetter && tileId > 0
                    ? (D.displayCharByTopIndex[tileId] || "").toLocaleLowerCase()
                    : cell.ch;

                  return (
                    <div key={ci} className="flex flex-col items-center" style={{ minWidth: "1ch" }}>
                      <span className={`leading-none ${colorClass}`} style={{ fontSize: "clamp(16px, 3.7vw, 22px)" }}>
                        {glyph}
                      </span>
                      <span
                        className={`leading-[1.0] ${showNumber ? "opacity-100" : "opacity-0"}`}
                        style={{ fontSize: "10px", marginTop: "6px" }}
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

        {/* Bottom Grid (UPPERCASE, accents kept; greens locked) */}
        <div className="rounded-xl border border-gray-200 bg-white p-3">
          <div className="mx-auto" style={{ width: `calc(${D.gridW} * ${cellSize})` }}>
            <div
              className="relative"
              style={{
                backgroundImage:
                  `repeating-linear-gradient(0deg, #C9CED7 0 1px, transparent 1px ${cellSize}),` +
                  `repeating-linear-gradient(90deg, #C9CED7 0 1px, transparent 1px ${cellSize})`,
              }}
            >
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
                      isLetterCell && tileId > 0 && D.lettersTop[tileId - 1] === D.requiredLetterAt[loc];

                    const showNumber = isLetterCell && !isGreen;

                    const glyph =
                      isLetterCell && tileId > 0
                        ? (D.displayCharByTopIndex[tileId] || "").toLocaleUpperCase()
                        : "";

                    return (
                      <div
                        key={`${r}-${c}`}
                        className="flex flex-col items-center justify-center"
                        style={{
                          width: cellSize,
                          height: cellSize,
                          background: isLetterCell ? (isGreen ? "#208040" : "#ECEFF3") : "transparent",
                        }}
                      >
                        <span
                          className={`leading-none ${
                            isLetterCell ? (isGreen ? "text-white" : "text-[#1240A0]") : "text-transparent"
                          }`}
                          style={{ fontSize: "clamp(16px, 3.7vw, 22px)" }}
                        >
                          {glyph}
                        </span>
                        <span
                          className={`leading-[1.0] ${showNumber ? "opacity-100" : "opacity-0"}`}
                          style={{ fontSize: "10px", marginTop: "6px", color: "#222" }}
                        >
                          {showNumber ? loc : " "}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Info / Moves */}
        <div className="text-center">
          <div className="text-base font-medium">
            Moves: <span className="font-mono">{byLevel[activeLevel]?.moveCount ?? 0}</span>
          </div>
          <div className="text-xs text-gray-600">
            Minimum moves needed to solve: <span className="font-mono">{D.minMoves}</span>
          </div>
        </div>

        {/* Debug (current level's puzzle) */}
        <div className="p-4 rounded-xl border border-gray-200 bg-gray-50 space-y-2">
          <div><span className="font-medium">Phrase:</span> <span className="font-serif">{D.puzzle?.phrase}</span></div>
          <div className="text-sm text-gray-700">
            <div>Normalized letters (N): <span className="font-mono">{D.N}</span></div>
            <div>Unique grid cells: <span className="font-mono">{D.cellForLocation.length - 1}</span></div>
            <div>Minimum swaps (from JSON): <span className="font-mono">{D.minMoves}</span></div>
          </div>
          <div className="pt-2 border-t border-gray-200">
            <div className="font-medium mb-1">Seeded greens consistency</div>
            <div className="text-sm">
              <div>Greens in JSON: <span className="font-mono">{JSON.stringify(D.correctPositionsJSON)}</span></div>
              <div>Greens from placement: <span className="font-mono">{JSON.stringify(greensComputed)}</span></div>
            </div>
            {D.correctPositionsJSON.length === greensComputed.length &&
            D.correctPositionsJSON.every((v, i) => v === greensComputed[i]) ? (
              <div className="mt-2 inline-flex items-center gap-2 px-3 py-1 rounded-lg bg-green-100 text-green-800 text-sm">
                ✅ Seeds align with first-fit mapping.
              </div>
            ) : (
              <div className="mt-2 space-y-1 text-sm text-red-700">
                <div className="font-medium">⚠️ Mismatch detected</div>
              </div>
            )}
          </div>
        </div>

        <div className="text-sm text-gray-500">
          Next: drag &amp; drop swap (≥50% overlap), +1 move per valid swap, greens lock. (We’ll add in one step.)
        </div>
      </div>
    </div>
  );
}
