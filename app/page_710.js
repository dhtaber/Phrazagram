"use client";

import { useEffect, useMemo, useState, useRef } from "react";

/**
 * Daily Letter Frame — page.js (NYT Mini–style V3)
 * - TOP: multi-row phrase (≤9 letters/row, no word split). Letter tiles only; decorations as muted text.
 * - BOTTOM: full width×height grid; non-playable cells are invisible (no tile), playable tiles form a contiguous lattice with hairline separators.
 * - Numbers: upper-left index on BOTH top & bottom when incorrect/unlocked; hidden when correct.
 * - Drag & Drop: pointer-based swap with clear hover target. Tap-to-swap disabled to ensure 1 swap = +1 move.
 */

function useQueryParamInt(key, fallback) {
  const [value, setValue] = useState(fallback);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const v = url.searchParams.get(key);
    const n = v ? parseInt(v, 10) : NaN;
    setValue(Number.isFinite(n) ? n : fallback);
  }, [key, fallback]);
  return value;
}

export default function Page() {
  const [puzzles, setPuzzles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/puzzles.json", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (mounted) {
          setPuzzles(Array.isArray(data) ? data : []);
          setLoading(false);
        }
      } catch (e) {
        if (mounted) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();
    return () => { mounted = false; };
  }, []);

  const todayIndexDefault = useMemo(() => (puzzles.length ? puzzles.length - 1 : 0), [puzzles]);
  const qpIndex = useQueryParamInt("idx", todayIndexDefault);
  const safeIndex = useMemo(() => {
    if (!puzzles.length) return 0;
    if (qpIndex < 0) return 0;
    if (qpIndex >= puzzles.length) return puzzles.length - 1;
    return qpIndex;
  }, [puzzles, qpIndex]);

  if (loading) return <div className="min-h-screen p-6">Loading…</div>;
  if (error) return <div className="min-h-screen p-6 text-red-600">Error: {error}</div>;
  if (!puzzles.length) return <div className="min-h-screen p-6">No puzzles found.</div>;

  return <PuzzleView puzzle={puzzles[safeIndex]} index={safeIndex} total={puzzles.length} />;
}

/* ---------- Phrase tokenization & layout (no word splits, ≤9 letters per line) ---------- */
function lexPhraseToTokens(phrase) {
  const tokens = [];
  let i = 0;
  while (i < (phrase?.length || 0)) {
    const ch = phrase[i];
    if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < phrase.length && /[A-Za-z]/.test(phrase[j])) j++;
      tokens.push({ type: "word", text: phrase.slice(i, j) });
      i = j;
    }
    else {
      tokens.push({ type: "deco", char: ch });
      i++;
    }
  }
  return tokens;
}

function buildTopLines(phrase, maxLines = 4, maxLettersPerLine = 14) {
  const tokens = lexPhraseToTokens(phrase || "");
  const lines = [];
  let current = [];
  let lettersInLine = 0;
  let lineCount = 1;
  let nextTopIndex = 1; // index for letter slots
  let pendingDecos = [];

  const flushLine = () => {
    if (current.length) lines.push(current);
    current = [];
    lettersInLine = 0;
    lineCount += 1;
  };
  const pushDeco = (ch, atLineStart) => {
    if (atLineStart && ch === " ") return; // drop leading space at start of line
    current.push({ type: "deco", char: ch });
  };

  for (let idx = 0; idx < tokens.length; idx++) {
    const t = tokens[idx];
    if (t.type === "deco") { pendingDecos.push(t.char); continue; }


    const wlen = t.text.length; // word length (letters only)
    if (lettersInLine > 0 && lettersInLine + wlen > maxLettersPerLine && lineCount <= maxLines) {
      flushLine();
    }
    const atLineStart = current.length === 0;
    for (const d of pendingDecos) pushDeco(d, atLineStart);
    pendingDecos = [];
    for (let k = 0; k < wlen; k++) current.push({ type: "slot", index: nextTopIndex++ });
    lettersInLine += wlen;
  }

  if (pendingDecos.length) {
    const trailing = pendingDecos.filter((c, i, arr) => !(i === arr.length - 1 && c === " "));
    for (const d of trailing) pushDeco(d, current.length === 0);
  }
  if (current.length) lines.push(current);
  if (lines.length > maxLines) {
    const keep = lines.slice(0, maxLines - 1);
    const tail = lines.slice(maxLines - 1).flat();
    lines.length = 0; lines.push(...keep, tail);
  }
  return lines; // Array<Array<{type:'slot',index}|{type:'deco',char}>>
}

// NEW: Build top lines from puzzle.slots with glue semantics and letter-only wrap (≤ maxLettersPerLine)
function buildTopLinesFromSlots(slots, maxLines = 4, maxLettersPerLine = 13) {
  // Convert slots to a token stream with letter indices (1..N), punctuation, and spaces.
  const tokens = [];
  let nextIndex = 1;
  for (const s of (slots || [])) {
    if (!s) continue;
    if (s.is_decoration) {
      if (s.ch === " ") {
        tokens.push({ type: "space" });
      } else {
        tokens.push({ type: "punct", ch: s.ch, glue: s.glue || "free" });
      }
    } else {
      tokens.push({ type: "letter", index: nextIndex, ch: s.ch });
      nextIndex += 1;
    }
  }

  const lines = [];
  let currentLine = [];
  let lettersInLine = 0;

  let currentChunk = null;   // { tokens: [...], letters: number }
  let pendingLeading = [];   // punctuation that should attach to the start of the next chunk

  function flushChunk() {
    if (!currentChunk) return;
    const need = currentChunk.letters;
    if (lines.length === 0 && currentLine.length === 0) {
      // ok
    } else if (lettersInLine + need > maxLettersPerLine && currentLine.length > 0) {
      lines.push(currentLine);
      currentLine = [];
      lettersInLine = 0;
    }
    currentLine.push(...currentChunk.tokens);
    lettersInLine += need;
    currentChunk = null;
  }

  function maybeFlushLine() {
    if (currentLine.length) {
      lines.push(currentLine);
      currentLine = [];
      lettersInLine = 0;
    }
  }

  for (const t of tokens) {
    if (t.type === "space") {
      // space ends a chunk (does not count against letters)
      flushChunk();
      currentLine.push({ type: "space" });
      continue;
    }

    if (t.type === "punct") {
      if (t.glue === "attach_right") {
        pendingLeading.push(t);
        continue;
      }
      if (t.glue === "attach_left") {
        if (currentChunk) {
          currentChunk.tokens.push({ type: "punct", ch: t.ch });
        } else if (currentLine.length) {
          currentLine.push({ type: "punct", ch: t.ch });
        } else {
          // no prior content — treat as leading for the next chunk
          pendingLeading.push(t);
        }
        continue;
      }
      if (t.glue === "inner") {
        if (!currentChunk) {
          currentChunk = { tokens: [], letters: 0 };
          if (pendingLeading.length) {
            currentChunk.tokens.push(...pendingLeading.map(p => ({ type: "punct", ch: p.ch })));
            pendingLeading = [];
          }
        }
        currentChunk.tokens.push({ type: "punct", ch: t.ch });
        continue;
      }
      // free punctuation: can stand alone; doesn't count against letters
      flushChunk();
      currentLine.push({ type: "punct", ch: t.ch });
      continue;
    }

    if (t.type === "letter") {
      if (!currentChunk) {
        currentChunk = { tokens: [], letters: 0 };
        if (pendingLeading.length) {
          currentChunk.tokens.push(...pendingLeading.map(p => ({ type: "punct", ch: p.ch })));
          pendingLeading = [];
        }
      }
      currentChunk.tokens.push({ type: "letter", index: t.index });
      currentChunk.letters += 1;
      continue;
    }
  }

  // finalize
  flushChunk();
  maybeFlushLine();

  // Return up to maxLines (content should already fit by construction)
  return lines.slice(0, maxLines);
}



/* --------------------------------- Main View --------------------------------- */

// === Top Ribbon Tile (display-only) ===
// Stacks: LETTER → STATUS LINE → NUMBER (bottom). Non-interactive.
// Uses two distinct colors when correct: green letter + indigo status line.
// NOTE: We hardcode indigo here (#4F46E5) so this component doesn't depend on variables inside PuzzleView.

const TOP_TILE_COLORS = {
  letterDefault: "#1F4AA3",     // indigo (brand)
  letterCorrect: "#15803D",     // green-700
  lineDefault: "#1F4AA3",     // slate-500
  lineCorrect: "#4F46E5",     // indigo-600/700
  number: "#000000",     // slate-500
  punctLetter: "#475569E6",   // slate-600 @ ~90% opacity
  punctLine: "#94A3B899",   // slate-400 @ ~60% opacity
  numberDim: "#64748B99",   // slate-500 @ ~60% for muted numbers
};

function TopRibbonTile({
  ch,           // string (letter or punctuation)
  num,          // number or undefined/null (use EXACTLY what you already have)
  isCorrect,    // boolean
  isPunctuation // boolean (true for punctuation; spaces should be filtered upstream)
}) {
  // Colors
  const letterColor = isPunctuation
    ? TOP_TILE_COLORS.punctLetter
    : (isCorrect ? TOP_TILE_COLORS.letterCorrect : TOP_TILE_COLORS.letterDefault);

  const lineColor = isPunctuation
    ? TOP_TILE_COLORS.punctLine
    : (isCorrect ? TOP_TILE_COLORS.lineCorrect : TOP_TILE_COLORS.lineDefault);

  const numberColor = num == null
    ? "transparent"  // no number shown; space reserved
    : (isPunctuation ? TOP_TILE_COLORS.numberDim : TOP_TILE_COLORS.number);

  // Wrapper: remove rectangle border; keep compact height (short/fat)
  const wrapStyle = {
    position: "relative",
    display: "inline-flex",
    flexDirection: "column",
    justifyContent: "space-between",
    alignItems: "center",
    minWidth: 14,
    height: 32,                 // compact vertical footprint
    padding: isPunctuation ? "0 1px" : "0 3px",
    marginLeft: isPunctuation ? (ch === "." ? -8 : -8) : 0,  
    border: "none",             // <-- remove rectangular grid
    borderRadius: 0,
    background: "transparent",
    boxSizing: "border-box",
    userSelect: "none",
    cursor: "default",
  };

  // LETTER — larger, tighter tracking (closer letters), short/fat look
  const letterStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "35%",              // slightly more room for bigger letter
    fontWeight: 600,
    fontSize: "clamp(21px, 5.5vw, 24px)",  // larger
    lineHeight: 1.0,
    letterSpacing: "0em",
    color: letterColor,
    paddingTop: 0,
    paddingBottom: 0,
    pointerEvents: "none",
  };



  // NUMBER — larger, clearly below the line
  const numberStyle = {
    height: "20%",              // remaining space
    marginTop: 2,
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    marginTop: 0,               // ↓ push numbers lower below the letter
    paddingBottom: 2,
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: "-0.01em",
    color: numberColor,
    pointerEvents: "none",
  };


  return (
    <div style={wrapStyle}>
      <div style={letterStyle}>{ch || ""}</div>
      <div style={numberStyle}>{num == null ? "" : num}</div>
    </div>
  );
}






function PuzzleView({ puzzle, index, total }) {
  const { layout, topPhrase, tiles, bottomCells, startPositions, seededCorrectSlotIds } = puzzle;
  const width = layout?.width ?? 0;
  const height = layout?.height ?? 0;
  const N = tiles?.length ?? 0; // # of letters

  // target letter by top slot index (1..N)
  const targetLetterBySlot = useMemo(() => {
    const map = new Array(N + 1).fill(null);
    for (let i = 0; i < tiles.length; i++) map[tiles[i].targetSlotId] = tiles[i].letter;
    return map;
  }, [tiles, N]);
  // Display glyph (case/accents) by top slot index (1..N), derived from puzzle.slots
  const displayCharByTopIndex = useMemo(() => {
    const arr = new Array(N + 1).fill(null);
    let k = 1;
    const sl = (puzzle.slots || []);
    for (let i = 0; i < sl.length; i++) {
      const s = sl[i];
      if (s && !s.is_decoration) {
        arr[k] = s.ch; // exact display glyph as entered
        k += 1;
      }
    }
    return arr;
  }, [puzzle.slots, N]);


  // positions: index 1..N => tileId
  const [positions, setPositions] = useState(() => startPositions.slice());
  const [moveCount, setMoveCount] = useState(0);
  const [locked, setLocked] = useState(() => new Set(seededCorrectSlotIds || []));
  const [selectedSlot, setSelectedSlot] = useState(null);

  // Drag state
  const [dragging, setDragging] = useState(null); // { fromSlot, tileId, x, y }
  const [hoverSlot, setHoverSlot] = useState(null);
  const [showWin, setShowWin] = useState(false);
  const wasWinRef = useRef(false);
  const [showTbd, setShowTbd] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const slotRefs = useRef(new Map()); // topIndex => ref (playable bottom cells only)
  const upHandledRef = useRef(false);

  // Disable click-to-swap (drag-only) to avoid double-counting moves
  const CLICK_TO_SWAP = false;

  // Re-initialize local state any time we get a new puzzle object
  useEffect(() => {
    setPositions(Array.isArray(startPositions) ? startPositions.slice() : []);
    setLocked(new Set(seededCorrectSlotIds || []));
    setSelectedSlot(null);
    setDragging(null);
    setHoverSlot(null);
    setMoveCount(0);
  }, [puzzle, startPositions, seededCorrectSlotIds]);


  // Recompute locks on each move (letter-based locking)
  useEffect(() => {
    const next = new Set(seededCorrectSlotIds || []);
    for (let i = 1; i <= N; i++) {
      const tileId = positions[i];
      const letter = tileId ? tiles[tileId - 1]?.letter : null;
      if (letter && letter === targetLetterBySlot[i]) next.add(i);
    }
    setLocked(next);
  }, [positions, tiles, targetLetterBySlot, N, seededCorrectSlotIds]);

  // Map (row,col) -> topIndex for playable cells
  const playableIndexByRC = useMemo(() => {
    const m = new Map();
    for (const c of bottomCells) m.set(`${c.row},${c.col}`, c.topIndex);
    return m;
  }, [bottomCells]);

  const onReset = () => {
    setPositions(startPositions.slice());
    setLocked(new Set(seededCorrectSlotIds || []));
    setSelectedSlot(null);
    setDragging(null);
    setHoverSlot(null);
    setMoveCount(0);
    setShowWin(false);
    wasWinRef.current = false;
  };

  const trySwap = (a, b) => {
  if (!a || !b || a === b) return;
  if (locked.has(a) || locked.has(b)) return;

  // Read current state once (outside any updater)
  const tileA = positions[a];
  const tileB = positions[b];
  if (tileA === tileB) return;          // no-op

  // Compute next positions (outside any updater)
  const next = positions.slice();
  next[a] = tileB;
  next[b] = tileA;

  // Commit state, then increment ONCE
  setPositions(next);
  setMoveCount((m) => m + 1);
};

  // Click-to-swap (disabled via flag, but kept for future)
  const onCellClick = (slotIndex) => {
    if (!CLICK_TO_SWAP) return;
    if (dragging) return;
    if (locked.has(slotIndex)) return;
    if (selectedSlot == null) { setSelectedSlot(slotIndex); return; }
    if (locked.has(selectedSlot)) { setSelectedSlot(null); return; }
    if (selectedSlot === slotIndex) { setSelectedSlot(null); return; }
    trySwap(selectedSlot, slotIndex);
    setSelectedSlot(null);
  };

  // Pointer-based drag & drop
  useEffect(() => {
    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      const x = e.clientX ?? (e.touches && e.touches[0]?.clientX);
      const y = e.clientY ?? (e.touches && e.touches[0]?.clientY);
      if (x == null || y == null) return;
      setDragging((d) => (d ? { ...d, x, y } : d));

      // hit test
      let over = null;
      for (const [slotIndex, ref] of slotRefs.current.entries()) {
        const el = ref.current; if (!el) continue;
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { over = slotIndex; break; }
      }
      setHoverSlot(over && !locked.has(over) ? over : null);
    };
    const onUp = (e) => {
  if (upHandledRef.current) return;
  upHandledRef.current = true;
  if (!dragging) return;
      e.preventDefault();
      const from = dragging.fromSlot;
      const to = hoverSlot;
      if (to && !locked.has(to)) trySwap(from, to);
      setDragging(null); setHoverSlot(null); setSelectedSlot(null);
    };
    if (dragging) {
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp, { passive: false });
    }
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, hoverSlot, locked]);

  const beginDrag = (slotIndex) => (e) => {
    upHandledRef.current = false;
    if (locked.has(slotIndex)) return;
    const tileId = positions[slotIndex]; if (!tileId) return;
    const x = e.clientX ?? (e.touches && e.touches[0]?.clientX);
    const y = e.clientY ?? (e.touches && e.touches[0]?.clientY);
    if (x == null || y == null) return;
    setDragging({ fromSlot: slotIndex, tileId, x, y });
    setSelectedSlot(null);
  };

  const isWin = useMemo(() => {
    for (let i = 1; i <= N; i++) {
      const tileId = positions[i]; if (!tileId) return false;
      const letter = tiles[tileId - 1]?.letter;
      if (letter !== targetLetterBySlot[i]) return false;
    }
    return true;
  }, [positions, tiles, targetLetterBySlot, N]);


  useEffect(() => {
  if (isWin && !wasWinRef.current) {
    const t = setTimeout(() => setShowWin(true), 3000);
    wasWinRef.current = true;
    return () => clearTimeout(t);
  }
}, [isWin]);

  /* ----------------------------- Styling helpers ----------------------------- */
  const INDIGO = "#4F46E5";
  const LINE_GRAY = "#E5E7EB"; // hairline separators
  const DARK_TEXT = "#111827";

  // Bottom grid: lock cells to integer pixels so 1px borders align perfectly.
  const CELL_PX = 48; // tweak (e.g., 44–56) if you want bigger/smaller tiles
  const gridStyle = {
    display: "grid",
    gridTemplateColumns: `repeat(${width}, ${CELL_PX}px)`,
    gridTemplateRows: `repeat(${height}, ${CELL_PX}px)`,
    width: `${CELL_PX * width}px`,
    height: `${CELL_PX * height}px`,
    padding: 0,
    border: "none",
    borderRadius: 0,
    gap: 0,
    position: "relative",  // NEW: anchor for the absolute lattice overlay (bottom grid only)
  };

  const cellPosStyle = (row, col) => ({
    gridRowStart: row + 1,
    gridColumnStart: col + 1,
    position: "relative",
  });

  const cellBorderStyle = (r, c) => ({
    boxSizing: "border-box",             // ← keep borders uniform
    borderRight: "1px solid #000",
    borderBottom: "1px solid #000",
    borderLeft: c === 0 ? "1px solid #000" : "none",
    borderTop: r === 0 ? "1px solid #000" : "none",
    background: "transparent",           // ← default wrapper is see-through
  });

  const tileStyleBottom = (isLocked, isHover) => ({
    width: "100%",
    height: "100%",
    borderRadius: 0, // square corners
    background: isLocked ? "#15803D" : "#EEEEEE", // light gray for incorrect
    border: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: isLocked ? "#FFFFFF" : "#1F4AA3",
    fontWeight: 800,
    fontSize: "clamp(18px, 4.2vw, 26px)",
    transform: "translateY(1px)", // nudge letters down a bit
    userSelect: "none",
    cursor: isLocked ? "default" : "grab",
    boxShadow: isHover ? `inset 0 0 0 2px #3b82f6` : "none", // subtle inner ring on hover
    transition: "box-shadow 120ms ease",
    touchAction: "none",
  });

  const tileStyleTop = (isLocked) => ({
    position: "relative",
    minWidth: 26,
    height: 32,
    borderRadius: 0,
    background: isLocked ? INDIGO : "#F3F4F6",
    border: "1px solid #555555",  // always dark gray for all tiles
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    color: isLocked ? "#FFFFFF" : INDIGO,
    fontWeight: 800,
    fontSize: "clamp(12px, 2.2vw, 18px)",
    userSelect: "none",
    padding: "0 6px",
    transform: "translateY(1px)", // avoid overlapping corner number
  });

  const cornerNum = (n, small = false) => (
    <div style={{ position: "absolute", top: 2, left: 2, fontSize: small ? 11 : 12, fontWeight: 700, color: "#000000", lineHeight: 1, pointerEvents: "none" }}>{n}</div>
  );

  const floatingStyle = dragging ? {
    position: "fixed",
    left: dragging.x - 26,
    top: dragging.y - 26,
    width: 52,
    height: 52,
    zIndex: 50,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 0,
    background: "#F3F4F6",
    fontWeight: 900,
    fontSize: 24,
    color: INDIGO,
    boxShadow: "0 10px 20px rgba(0,0,0,0.18)",
    pointerEvents: "none",
  } : null;

  /* ---------------------------------- Render --------------------------------- */
  return (
    <div className="min-h-screen w-full bg-white text-gray-900 flex flex-col items-center p-4 gap-4">
      {/* TOP: multi-row phrase with decorations (no black squares) */}
      <div className="w-full max-w-3xl">

        {/* Top header: left puzzle name, right controls */}
        <div
  className="flex items-center justify-between py-2"
  style={{ width: "100%", maxWidth: 480, margin: "0 auto" }}
>
          {/* Left: puzzle name (placeholder for now) */}
          <div className="text-base font-semibold text-gray-900">Puzzle Name</div>

          {/* Right: three buttons (open modals) */}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowTbd(true)}
              className="px-3 py-1.5 rounded-xl border border-gray-300 text-sm"
            >
              TBD
            </button>

            <button
              onClick={() => setShowReset(true)}
              className="px-3 py-1.5 rounded-xl border border-gray-300 text-sm"
            >
              Reset
            </button>

            <button
              onClick={() => setShowHelp(true)}
              className="px-3 py-1.5 rounded-xl border border-gray-300 text-sm"
            >
              ?
            </button>
          </div>

          {/* === Modals === */}
          {showTbd && (
            <div className="fixed inset-0 z-50 flex items-center justify-center">
              <div className="absolute inset-0 bg-black/40" onClick={() => setShowTbd(false)} />
              <div className="relative z-10 w-[90%] max-w-sm rounded-2xl bg-white p-4 shadow-xl">
                <div className="text-base font-semibold mb-2">TBD</div>
                <div className="text-sm text-gray-600">
                  Placeholder content. (You can put anything here later.)
                </div>
                <div className="mt-4 flex justify-end">
                  <button onClick={() => setShowTbd(false)} className="px-3 py-1.5 rounded-xl border border-gray-300 text-sm">
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}

          {showReset && (
            <div className="fixed inset-0 z-50 flex items-center justify-center">
              <div className="absolute inset-0 bg-black/40" onClick={() => setShowReset(false)} />
              <div className="relative z-10 w-[90%] max-w-sm rounded-2xl bg-white p-4 shadow-xl">
                <div className="text-base font-semibold mb-2">Reset puzzle?</div>
                <div className="text-sm text-gray-600">
                  This will restore the starting layout. Your move count will reset.
                </div>
                <div className="mt-4 flex gap-2 justify-end">
                  <button onClick={() => setShowReset(false)} className="px-3 py-1.5 rounded-xl border border-gray-300 text-sm">
                    Cancel
                  </button>
                  <button
                    onClick={() => { onReset(); setShowReset(false); }}
                    className="px-3 py-1.5 rounded-xl bg-gray-900 text-white text-sm rounded-xl"
                  >
                    Reset
                  </button>
                </div>
              </div>
            </div>
          )}

          {showHelp && (
            <div className="fixed inset-0 z-50 flex items-center justify-center">
              <div className="absolute inset-0 bg-black/40" onClick={() => setShowHelp(false)} />
              <div className="relative z-10 w-[90%] max-w-sm rounded-2xl bg-white p-4 shadow-xl">
                <div className="text-base font-semibold mb-2">How to play</div>
                <div className="text-sm text-gray-600 space-y-2">
                  <p>Drag letters on the top row(s) to match their correct positions.</p>
                  <p>The bottom lattice shows the full grid. When every letter is correct, you win.</p>
                </div>
                <div className="mt-4 flex justify-end">
                  <button onClick={() => setShowHelp(false)} className="px-3 py-1.5 rounded-xl border border-gray-300 text-sm">
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}



        </div>
        <div style={{ border: "1px solid #EEE", borderRadius: 12, padding: "8px 8px 16px 8px", overflow: "visible", background: "#DDD", width: "100%", maxWidth: 480, margin: "12px auto 0" }}>
        {(() => {
          const lines = buildTopLinesFromSlots(puzzle.slots || [], 4, 13);
          const outer = { display: "flex", flexDirection: "column", gap: 7, marginTop: 8 };
          const row = { display: "flex", alignItems: "center", justifyContent: "center", gap: 2 };
          const deco = {
            // Punctuation/decoration tile (display-only) — NO rectangle
            position: "relative",
            display: "inline-flex",
            alignItems: "flex-start",
            justifyContent: "center",
            minWidth: 6,                // ↓ was 26
            height: 32,
            padding: "0 0px",            // ↓ was "0 6px"
            border: "none",              // remove box
            borderRadius: 0,
            background: "transparent",
            boxSizing: "border-box",
            userSelect: "none",
            cursor: "default",
            // Match top-letter feel (short/fat, closer tracking, muted color)
            fontWeight: 800,
            fontSize: "clamp(13px, 2.6vw, 20px)",
            lineHeight: 1.2,
            letterSpacing: "-0.03em",
            color: "#475569E6",          // muted Slate-600 @ ~90% opacity
          };

          const space = {
            // Visual spacer for top ribbon (no glyph, no border)
            display: "inline-block",
            width: 16,
            height: 32,
          };


          return (
            <div style={outer}>
              {lines.map((items, li) => (
                <div key={`row-${li}`} style={row}>
                  {items.map((t, i) => {
                    
          if (t.type === "space") {
            return <span key={`sp-${li}-${i}`} style={space} aria-hidden="true" />;
          }
                    if (t.type === "letter") {
                      const k = t.index;
                      const isLocked = locked.has(k);

                      // which tile is currently sitting in top slot k
                      const tileIdTop = positions[k];           // <-- name likely used in your file
                      // If your array is named differently (e.g. `positions` or `tileIdByTopIndex`),
                      // use the one that maps: top slot index (k) -> tileId currently there.

                      const base = tileIdTop ? (tiles[tileIdTop - 1]?.letter || "") : "";

                      // apply the slot’s case mask (lower/upper) to the current letter
                      const mask = displayCharByTopIndex[k] || "";
                      const ch = mask && mask === mask.toLowerCase() ? base.toLowerCase() : base.toUpperCase();

                      return (
                        <TopRibbonTile
                          key={`top-${k}`}
                          ch={ch}
                          num={isLocked ? null : k}
                          isCorrect={isLocked}
                          isPunctuation={false}
                        />
                      );
                    }

          if (t.type === "punct") {
            const ch = t.ch;
            return (
              <TopRibbonTile
                key={`deco-${li}-${i}`}
                ch={ch}
                num={null}
                isCorrect={false}
                isPunctuation={true}
              />
            );
          }
          return null;
    
                  })}
                </div>
              ))}
            </div>
          );
        })()}
        </div>
      </div>

      {/* Move counter (larger) */}
      <div className="text-xl text-gray-800 mt-2">Moves: <span className="font-extrabold text-gray-900 text-2xl">{moveCount}</span></div>

      {/* Par line */}
      <div className="text-sm text-gray-500 mt-1">the minimum number of moves needed to solve this puzzle is: <span className="font-semibold text-gray-700">{puzzle.min_swaps}</span></div>


      {/* BOTTOM: full grid with per-cell borders (no gap/background). 
          Borders live on the OUTER cell wrapper so lines are uniform. */}
      <div style={{ border: "1px solid #EEE", borderRadius: 12, padding: 15, overflow: "visible", marginTop: 8}}>
      <div style={gridStyle}>
        {/* Bottom-grid lattice overlay (lines only around playable cells, pixel-snapped with 1px overlap) */}
        {(() => {
          const lines = [];
          const W = width;
          const H = height;
          const S = Math.round(CELL_PX);  // SNAP: ensure integer pixel cell size
          const EDGE = "#bbb";

          const isPlayable = (rr, cc) =>
            playableIndexByRC.get(`${rr},${cc}`) != null;

          for (let r = 0; r < H; r++) {
            for (let c = 0; c < W; c++) {
              if (!isPlayable(r, c)) continue;

              const x = c * S;
              const y = r * S;

              // Left edge — +1px height to avoid hairline gap at joins
              lines.push(
                <div
                  key={`L-${r}-${c}`}
                  style={{
                    position: "absolute",
                    left: x,
                    top: y,
                    width: 1,
                    height: S + 1,           // +1 overlap
                    background: EDGE,
                  }}
                />
              );

              // Top edge — +1px width to avoid hairline gap at joins
              lines.push(
                <div
                  key={`T-${r}-${c}`}
                  style={{
                    position: "absolute",
                    left: x,
                    top: y,
                    width: S + 1,            // +1 overlap
                    height: 1,
                    background: EDGE,
                  }}
                />
              );

              // Right edge only if no playable immediately to the right
              if (!isPlayable(r, c + 1)) {
                lines.push(
                  <div
                    key={`R-${r}-${c}`}
                    style={{
                      position: "absolute",
                      left: x + S,
                      top: y,
                      width: 1,
                      height: S + 1,         // +1 overlap
                      background: EDGE,
                    }}
                  />
                );
              }

              // Bottom edge only if no playable immediately below
              if (!isPlayable(r + 1, c)) {
                lines.push(
                  <div
                    key={`B-${r}-${c}`}
                    style={{
                      position: "absolute",
                      left: x,
                      top: y + S,
                      width: S + 1,          // +1 overlap
                      height: 1,
                      background: EDGE,
                    }}
                  />
                );
              }
            }
          }

          return (
            <div
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 5,
                pointerEvents: "none",
              }}
              id="latticeOverlay"
            >
              {lines}
            </div>
          );
        })()}


        {Array.from({ length: height }).flatMap((_, r) =>
          Array.from({ length: width }).map((__, c) => {
            const key = `${r},${c}`;
            const topIndex = playableIndexByRC.get(key);
            const playable = topIndex != null;

            // Non-playable cell: no border at all
            if (!playable) {
              return (
                <div
                  key={`b-${key}`}
                  style={{
                    ...cellPosStyle(r, c),
                    background: "transparent",
                  }}
                />
              );
            }

            // Playable cell: wrapper draws the frame; inner tile has NO border
            const tileId = positions[topIndex];
            const letter = tileId ? tiles[tileId - 1]?.letter : "";
            const isLocked = locked.has(topIndex);
            const isHover = hoverSlot === topIndex;

            let ref = slotRefs.current.get(topIndex);
            if (!ref) { ref = { current: null }; slotRefs.current.set(topIndex, ref); }

            // Playable cell: draw borders on the OUTER wrapper using single-owner rules.
            // Goal: one crisp 1px lattice with no doubles and no gaps on irregular shapes.
            // Ownership:
            //   • Right edge -> owned by THIS cell (always draw)
            //   • Bottom edge -> owned by THIS cell (always draw)
            //   • Left edge -> draw only if there is NO playable neighbor to the left
            //   • Top edge -> draw only if there is NO playable neighbor above

            // Neighbor lookups (undefined/null means blank or off-grid)
            const leftIdx = playableIndexByRC.get(`${r},${c - 1}`);
            const rightIdx = playableIndexByRC.get(`${r},${c + 1}`);
            const topIdx = playableIndexByRC.get(`${r - 1},${c}`);
            const bottomIdx = playableIndexByRC.get(`${r + 1},${c}`);

            const EDGE_COLOR = "#000"; // 1px solid black, consistent across all cells

            const borderStyle = {
              ...cellPosStyle(r, c),
              boxSizing: "border-box",
              background: "transparent",  // no borders on wrappers; overlay draws all lines
            };

            return (
              <div key={`p-${key}`} style={borderStyle}>
                <div
                  ref={ref}                               // use the ref you already created above
                  style={tileStyleBottom(isLocked, isHover)}  // inner has no border
                  onClick={() => onCellClick(topIndex)}
                  onPointerDown={beginDrag(topIndex)}
                  title={`Slot #${topIndex}${isLocked ? " (locked)" : ""}`}
                >
                  {!isLocked && cornerNum(topIndex, false)}
                  <div style={{ position: "relative", zIndex: 1 }}>
                    {dragging && dragging.fromSlot === topIndex ? "" : letter}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {/* Floating tile during drag (letter only) */}
        {dragging && (
          <div style={floatingStyle}>{tiles[dragging.tileId - 1]?.letter}</div>
        )}
      </div>


      {/* Controls */}
      <div className="flex items-center gap-3 mt-2">

      </div>
    </div>
    {/* === Win Modal === */}
{showWin && (
  <div className="fixed inset-0 z-50 flex items-center justify-center">
    {/* backdrop */}
    <div className="absolute inset-0 bg-black/40" onClick={() => setShowWin(false)} />
    {/* dialog */}
    <div className="relative z-10 w-[90%] max-w-sm rounded-2xl bg-white p-4 shadow-xl">
      <div className="text-base font-semibold mb-2">Congrats! 🎉</div>
      <div className="text-sm text-gray-700">
        You solved the puzzle in <span className="font-bold">{moveCount}</span> moves.
      </div>

      {/* Share block (placeholder) */}
      <div className="mt-3">
        <div className="text-xs text-gray-500 mb-1">Share (placeholder):</div>
        <textarea
          readOnly
          rows={4}
          className="w-full text-xs bg-gray-50 border border-gray-200 rounded-lg p-2"
          value={`Daily Letter Frame — Solved in ${moveCount} moves
${topPhrase ? `"${topPhrase}"\n` : ""}#DailyLetterFrame`}
        />
      </div>

      <div className="mt-4 flex gap-2 justify-end">
        <button
          onClick={() => setShowWin(false)}
          className="px-3 py-1.5 rounded-xl border border-gray-300 text-sm"
        >
          Close
        </button>
        <button
          onClick={() => {
            const text = `Daily Letter Frame — Solved in ${moveCount} moves
${topPhrase ? `"${topPhrase}"\n` : ""}#DailyLetterFrame`;
            if (navigator?.clipboard?.writeText) navigator.clipboard.writeText(text);
          }}
          className="px-3 py-1.5 rounded-xl bg-gray-900 text-white text-sm"
        >
          Copy
        </button>
      </div>
    </div>
  </div>
)}
        </div>
  );
}
