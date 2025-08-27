'use client';
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';


/**
 * Daily Letter Frame — page.js (JSON schema V2)
 * - Reads /puzzles.json
 * - Uses startPositions (1-based), seededCorrectSlotIds, tiles[], topIndexForTileId[],
 *   topOrderAfterInitialSnap[] for the top reveal, and mirrors swaps by tileId.
 * - Correctness/locking is letter-based (any matching letter in a target slot locks).
 * - Tap–tap and simple pointer drag–drop swapping; moves count only on an actual change.
 * - Reset, Help, Win (with share), and Today/Yesterday toggle (+ ?idx=N for selection).
 */


export default function DailyLetterFrame() {
  // ---------------------------------------------------------------------------
  // LOAD PUZZLES
  // ---------------------------------------------------------------------------
  const [puzzles, setPuzzles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(0); // 0-based index into puzzles[]
  
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/puzzles.json', { cache: 'no-store' });
        const data = await res.json();
        if (!cancelled) setPuzzles(Array.isArray(data) ? data : []);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // STEP 2: read ?idx= from the URL (1-based) and select that puzzle.
  // If missing/invalid, default to 1 (first). Store as 0-based in state.
  useEffect(() => {
    if (!Array.isArray(puzzles) || puzzles.length === 0) return;

    const applyFromURL = () => {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get('idx');
      const n = parseInt(raw ?? '1', 10);
      const clamped = Number.isFinite(n) ? Math.min(Math.max(n, 1), puzzles.length) : 1;
      setSelectedIdx(clamped - 1); // convert to 0-based
    };

    applyFromURL(); // on load
    window.addEventListener('popstate', applyFromURL); // if URL changes via back/forward
    return () => window.removeEventListener('popstate', applyFromURL);
  }, [puzzles]);

  // ---------------------------------------------------------------------------
  // SELECT ACTIVE PUZZLE: ?idx=N overrides; else last as Today, prev as Yesterday
  // ---------------------------------------------------------------------------
  const [useYesterday, setUseYesterday] = useState(false);

  const pickIndices = useMemo(() => {
    const n = puzzles.length;
    if (n === 0) return { today: -1, yesterday: -1 };
    let idxFromURL = -1;
    if (typeof window !== 'undefined') {
      const sp = new URLSearchParams(window.location.search);
      const raw = sp.get('idx');
      if (raw != null && /^\\d+$/.test(raw)) {
        const v = parseInt(raw, 10);
        if (v >= 0 && v < n) idxFromURL = v;
      }
    }
    const today = idxFromURL >= 0 ? idxFromURL : (n - 1);
    const yesterday = Math.max(0, today - 1);
    return { today, yesterday };
  }, [puzzles]);

  const activeIndex = useMemo(() => {
    if (!puzzles.length) return -1;
    return useYesterday ? pickIndices.yesterday : pickIndices.today;
  }, [puzzles, pickIndices, useYesterday]);

  const activePuzzle = puzzles[selectedIdx] || null;

  // ---------------------------------------------------------------------------
  // DERIVED CONSTANTS FROM PUZZLE
  // ---------------------------------------------------------------------------
  const derived = useMemo(() => {
    if (!activePuzzle) return null;
    if (activePuzzle.schemaVersion !== 2) {
      return { error: 'Unsupported schemaVersion. Expected 2.' };
    }
    const layout = activePuzzle.layout || {};
    const tiles = Array.isArray(activePuzzle.tiles) ? activePuzzle.tiles : [];
    const N = tiles.length;
    const width = layout.width || 0;
    const height = layout.height || 0;
    const hasMiddle = !!layout.hasMiddle;

    // Target letters by slotId (1..N): tiles array is canonical slot order, tileId == targetSlotId
    const targetLetterForSlot = (slotId) => {
      if (slotId < 1 || slotId > N) return null;
      return String(tiles[slotId - 1]?.letter || '').toUpperCase();
    };

    // Map of tileId -> letter
    const tileLetter = (tileId) => {
      if (tileId == null) return null;
      const t = tiles[(tileId - 1)];
      return t ? String(t.letter || '').toUpperCase() : null;
    };

    // Phrase handling
    const phrase = String(activePuzzle.topPhrase || '');
    const topIndexForTileId = Array.isArray(activePuzzle.topIndexForTileId) ? activePuzzle.topIndexForTileId : [];
    const topOrderAfterInitialSnap = Array.isArray(activePuzzle.topOrderAfterInitialSnap) ? activePuzzle.topOrderAfterInitialSnap : [];

    // Build canonical slot coordinates (for layout)
    const slots = enumerateSlots(width, height, hasMiddle); // [{slotId,row,col}]
    return {
      N, width, height, hasMiddle,
      phrase,
      targetLetterForSlot, tileLetter,
      topIndexForTileId, topOrderAfterInitialSnap,
      slots,
    };
  }, [activePuzzle]);

  const derivedError = derived && derived.error ? derived.error : null;

  // ---------------------------------------------------------------------------
  // STATE
  // positions[slotId] = tileId (1-based), topOrder (tileId[]), moves, modals
  // ---------------------------------------------------------------------------
  const [positions, setPositions] = useState(null);
  const [topOrder, setTopOrder] = useState([]);
  const [moveCount, setMoveCount] = useState(0);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isWin, setIsWin] = useState(false);
  const draggingRef = useRef(false);

  // Initialize positions & topOrder on puzzle change
  useEffect(() => {
    if (!activePuzzle || !derived) return;
    const start = Array.isArray(activePuzzle.startPositions) ? activePuzzle.startPositions.slice() : null;
    if (!start || start.length !== derived.N + 1) {
      setPositions(null);
      return;
    }
    setPositions(start);
    setTopOrder(derived.topOrderAfterInitialSnap.slice());
    setMoveCount(0);
    setSelectedSlot(null);
    setIsWin(false);
  }, [activePuzzle, derived]);

  // ---------------------------------------------------------------------------
  // HELPERS: locking (letter-based) and win check
  // ---------------------------------------------------------------------------
  const isLocked = useCallback((slotId) => {
    if (!positions || !derived) return false;
    const tid = positions[slotId];
    if (!tid) return false;
    const letter = derived.tileLetter(tid);
    return letter != null && letter === derived.targetLetterForSlot(slotId);
  }, [positions, derived]);

  const checkWin = useCallback(() => {
    if (!positions || !derived) return false;
    for (let s = 1; s <= derived.N; s++) {
      const tid = positions[s];
      const letter = derived.tileLetter(tid);
      if (!letter || letter !== derived.targetLetterForSlot(s)) return false;
    }
    return true;
  }, [positions, derived]);

  useEffect(() => {
    if (!positions || !derived) return;
    if (checkWin()) setIsWin(true);
  }, [positions, derived, checkWin]);

  // ---------------------------------------------------------------------------
  // SWAP + TOP MIRROR
  // Top rule: do not move tiles that are already at their phrase index.
  // Only swap indices in topOrder if neither involved tile is currently at its phrase index.
  // ---------------------------------------------------------------------------
  // Mirror swap up top, then snap locked tiles to their phrase indices,
  // then keep all remaining (unlocked) tiles deranged (no tile at its own index).
  // Mirror swap up top, then lock by LOCATION (phrase index for a correct bottom slot),
// then keep all remaining (unlocked) positions deranged (no tile at its own index).
  const mirrorSwapUpTop = useCallback((tileA, tileB, nextPositions) => {
    if (!derived) return;

    setTopOrder((prev) => {
      if (!Array.isArray(prev) || prev.length !== derived.N) return prev;
      let next = prev.slice();

      // Build the set of LOCKED top indices (locations) from the *next* bottom positions.
      // For each bottom slot s that is letter-correct, lock its phrase index:
      //   idx = topIndexForTileId[s]   <-- location-based
      // and the required tile for that index is whatever tile sits in slot s on the bottom.
      const lockedIndexSet = new Set();                 // indices that are locked
      const requiredTileForIndex = new Map();           // idx -> tileId that must occupy it
      if (nextPositions) {
        for (let s = 1; s <= derived.N; s++) {
          const tid = nextPositions[s];
          if (!tid) continue;
          const letter = derived.tileLetter(tid);
          if (letter && letter === derived.targetLetterForSlot(s)) {
            const idx = derived.topIndexForTileId[s];   // lock by LOCATION of slot s
            lockedIndexSet.add(idx);
            requiredTileForIndex.set(idx, tid);         // the bottom tile at s must show at idx up top
          }
        }
      }

      // 1) Mirror the bottom swap **only if** both involved positions are UNLOCKED up top.
      const idxA = next.indexOf(tileA);
      const idxB = next.indexOf(tileB);
      if (idxA >= 0 && idxB >= 0 && !lockedIndexSet.has(idxA) && !lockedIndexSet.has(idxB)) {
        [next[idxA], next[idxB]] = [next[idxB], next[idxA]];
      }

      // 2) Snap: ensure each LOCKED index holds its required tile (by location).
      const lockedIndicesSorted = Array.from(lockedIndexSet).sort((a, b) => a - b);
      for (const idx of lockedIndicesSorted) {
        const requiredTid = requiredTileForIndex.get(idx);
        const j = next.indexOf(requiredTid);
        if (j !== idx) {
          const displaced = next[idx];
          next[idx] = requiredTid;
          next[j] = displaced;
        }
      }

      // 3) Derange the remaining (UNLOCKED) positions:
      // For every unlocked index i, ensure the tile there is not at its own phrase index.
      const isUnlockedIndex = (i) => !lockedIndexSet.has(i);
      for (let i = 0; i < next.length; i++) {
        if (!isUnlockedIndex(i)) continue;
        const tid = next[i];
        const targetI = derived.topIndexForTileId[tid];
        if (targetI === i) {
          // find a partner j that's also unlocked, and swapping doesn't place either on their own index
          let j = -1;
          for (let k = 0; k < next.length; k++) {
            if (k === i || !isUnlockedIndex(k)) continue;
            const tk = next[k];
            const targetK = derived.topIndexForTileId[tk];
            if (targetK !== i && targetI !== k) { j = k; break; }
          }
          if (j >= 0) [next[i], next[j]] = [next[j], next[i]];
        }
      }

      return next;
    });
  }, [derived]);



  const doSwap = useCallback((slotA, slotB) => {
    if (!positions || !derived) return false;
    if (slotA === slotB) return false;
    if (isLocked(slotA) || isLocked(slotB)) return false;

    const next = positions.slice();
    const tileA = next[slotA];
    const tileB = next[slotB];
    [next[slotA], next[slotB]] = [tileB, tileA];

    // Only count as move if changed
    let changed = false;
    for (let i = 1; i < next.length; i++) {
      if (next[i] !== positions[i]) { changed = true; break; }
    }
    if (changed) {
      setPositions(next);
      setMoveCount((m) => m + 1);
      setSelectedSlot(null);
      mirrorSwapUpTop(tileA, tileB, next);
      return true;
    }
    return false;
  }, [positions, derived, isLocked, mirrorSwapUpTop]);

  // Tap–tap swap
  const handleTileTap = useCallback((slotId) => {
    if (!positions) return;
    if (isLocked(slotId)) return; // can't start on a locked tile
    if (selectedSlot == null) {
      setSelectedSlot(slotId);
      return;
    }
    doSwap(selectedSlot, slotId);
  }, [positions, selectedSlot, doSwap, isLocked]);

  // Pointer-based drag–drop swap (simple: down and up over a different tile)
  const [dragStartSlotId, setDragStartSlotId] = useState(null);
  const [dragPointerId, setDragPointerId] = useState(null);

  const onPointerDown = useCallback((e, slotId) => {
    if (isLocked(slotId)) return;
    draggingRef.current = true;
    setDragStartSlotId(slotId);
    setDragPointerId(e.pointerId);
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [isLocked]);

  const onPointerUp = useCallback((e, slotId) => {
    if (!draggingRef.current) return;
    if (dragPointerId !== e.pointerId) return;
    draggingRef.current = false;
    setDragPointerId(null);

    const start = dragStartSlotId;
    setDragStartSlotId(null);
    if (start != null && start !== slotId) {
      doSwap(start, slotId);
    }
  }, [dragPointerId, dragStartSlotId, doSwap]);

  // ---------------------------------------------------------------------------
  // RESET / SHARE
  // ---------------------------------------------------------------------------
  const resetAll = () => {
    if (!activePuzzle || !derived) return;
    setPositions(activePuzzle.startPositions.slice());
    setTopOrder(derived.topOrderAfterInitialSnap.slice());
    setMoveCount(0);
    setSelectedSlot(null);
    setIsWin(false);
  };

  const shareResults = () => {
    const base = (typeof window !== 'undefined') ? window.location.origin : '';
    const msg = `Solved today's puzzle in ${moveCount} moves 🎉 — Play at ${base}`;
    if (navigator.share) {
      navigator.share({ title: 'Daily Letter Frame', text: msg }).catch(() => {
        navigator.clipboard.writeText(msg).catch(() => {});
      });
    } else {
      navigator.clipboard.writeText(msg).catch(() => {});
      alert('Results copied to clipboard');
    }
  };

  // ---------------------------------------------------------------------------
  // RENDER HELPERS
  // ---------------------------------------------------------------------------
  const Tile = ({ slotId }) => {
    if (!positions || !derived) return null;
    const tileId = positions[slotId];
    const slotNumber = (derived.topIndexForTileId[slotId] ?? 0) + 1; // fixed location number
    if (!tileId) return null;

    const locked = isLocked(slotId); // letter-based
    const isCorrect = locked;
    const bg = isCorrect ? 'bg-blue-800 text-white' : 'bg-yellow-400 text-gray-900';
    const selected = selectedSlot === slotId && !locked;

    return (
      <button
        data-slot-id={slotId}
        data-tile-id={tileId}
        data-locked={locked ? 'true' : 'false'}
        onClick={() => handleTileTap(slotId)}
        onPointerDown={(e) => onPointerDown(e, slotId)}
        onPointerUp={(e) => onPointerUp(e, slotId)}
        className={`relative flex items-center justify-center rounded-md ${bg} ${selected ? 'ring-2 ring-black' : ''}`}
        style={{ width: 48, height: 48, touchAction: 'none' }}
        disabled={locked}
        aria-label={`Tile ${tileId}`}
      >
        <span className="font-bold text-lg select-none">{derived.tileLetter(tileId)}</span>
        <span className="absolute top-0.5 left-0.5 text-[10px] leading-none">
          <span className="px-1 py-[1px] rounded bg-black/25 text-white">{slotNumber}</span>
        </span>
      </button>
    );
  };

  const TopPhrase = () => {
    if (!derived) return null;
    const phrase = derived.phrase;

    // Build tokens (letters, spaces, punct). Letters draw from current topOrder/tileIds.
    const tokens = [];
    let letterCursor = 0;

    // Locked top LOCATIONS (phrase indices) computed from bottom correctness
    const lockedIndexSet = new Set();
    if (positions && derived) {
      for (let s = 1; s <= derived.N; s++) {
        const tid = positions[s];
        if (!tid) continue;
        const letter = derived.tileLetter(tid);
        if (letter && letter === derived.targetLetterForSlot(s)) {
          const idx = derived.topIndexForTileId[s]; // lock by location (slot s → phrase index)
          lockedIndexSet.add(idx);
        }
      }
    }

    for (let i = 0; i < phrase.length; i++) {
      const ch = phrase[i];
      if (/[A-Za-z]/.test(ch)) {
        const phraseIndex = letterCursor; // fixed location in the phrase (0-based)
        const tileId = topOrder[phraseIndex] || null;
        const isTopLocked = lockedIndexSet.has(phraseIndex); // lock by location
        const displayLetter = tileId ? derived.tileLetter(tileId) || ch.toUpperCase() : ch.toUpperCase();
        tokens.push({ type: 'letter', display: displayLetter, tileId, isTopLocked, phraseIndex });
        letterCursor++;
      } else if (ch === ' ') {
        tokens.push({ type: 'space', display: ' ' });
      } else {
        tokens.push({ type: 'punct', display: ch });
      }
    }

    // --- Word-aware wrapping (no mid-word splits) ---
    const LETTERS_PER_ROW = 9; // target letters per line (spaces/punct not counted)

    // 1) Split tokens into words. A "word" = consecutive letter/punct tokens.
    //    Spaces separate words. Punctuation stays attached to its word.
    const words = [];
    let curWord = [];
    let curLetters = 0;

    for (const tk of tokens) {
      if (tk.type === 'letter' || tk.type === 'punct') {
        curWord.push(tk);
        if (tk.type === 'letter') curLetters += 1; // count letters only
      } else if (tk.type === 'space') {
        if (curWord.length) {
          words.push({ tokens: curWord, letters: curLetters });
          curWord = [];
          curLetters = 0;
        }
      }
    }
    // push last word if any
    if (curWord.length) {
      words.push({ tokens: curWord, letters: curLetters });
    }

    // 2) Greedy line fill: add words until the next would exceed LETTERS_PER_ROW.
    //    Insert a space token between words on the same line.
    const rows = [];
    let row = [];
    let rowLetters = 0;

    const makeSpace = () => ({ type: 'space', display: ' ' });

    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (rowLetters === 0) {
        // start a new row with this word
        row.push(...w.tokens);
        rowLetters += w.letters;
      } else if (rowLetters + 1 + w.letters <= LETTERS_PER_ROW) {
        // add a space, then the word
        row.push(makeSpace(), ...w.tokens);
        rowLetters += 1 + w.letters;
      } else {
        // wrap before this word
        rows.push(row);
        row = [...w.tokens];
        rowLetters = w.letters;
      }
    }
    // push last row
    if (row.length) rows.push(row);


    return (
      <div className="w-full flex flex-col items-center gap-1 px-3 py-2">
        {rows.map((row, idx) => (
          <div key={idx} className="flex items-center justify-center gap-1">
            {row.map((tk, j) => {
              if (tk.type === 'letter') {
                const color = tk.isTopLocked ? 'bg-blue-800 text-white' : 'bg-yellow-400 text-gray-900';
                return (
                  <div key={j} className={`relative rounded-sm ${color}`} style={{ width: 28, height: 28 }}>
                    <div className="w-full h-full flex items-center justify-center text-sm font-semibold select-none">{tk.display}</div>
                    <span className="absolute top-0.5 left-0.5 text-[10px] leading-none">
                      <span className="px-1 py-[1px] rounded bg-black/25 text-white">
                        {tk.phraseIndex + 1}
                      </span>
                    </span>
                  </div>
                );
              } else if (tk.type === 'space') {
                return <div key={j} style={{ width: 14 }} />;
              } else {
                return (
                  <div key={j} className="rounded-sm bg-gray-200 text-gray-800" style={{ width: 18, height: 18 }}>
                    <div className="w-full h-full flex items-center justify-center text-[11px] select-none">{tk.display}</div>
                  </div>
                );
              }
            })}
          </div>
        ))}
      </div>
    );
  };

  // Build bottom board slots in canonical order -> absolute grid positions
  const Board = () => {
    if (!derived || !positions) return null;
    const W = derived.width, H = derived.height;
    const slotCoords = derived.slots; // [{slotId,row,col}]

    return (
      <div
        className="relative mx-auto"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${W}, 48px)`,
          gridTemplateRows: `repeat(${H}, 48px)`,
          gap: '6px',
        }}
      >
        {slotCoords.map(({ slotId, row, col }) => (
          <div key={slotId} style={{ gridColumn: col + 1, gridRow: row + 1 }}>
            <Tile slotId={slotId} />
          </div>
        ))}
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  if (loading) return <div className="p-4 text-center">Loading…</div>;
  if (error) return <div className="p-4 text-center text-red-600">{String(error)}</div>;
  if (!activePuzzle || !derived || derivedError) return <div className="p-4 text-center">{derivedError || 'No puzzle'}</div>;

  return (
  <div className="min-h-screen w-full bg-white text-gray-900 flex flex-col">
    {/* Portrait-only / Landscape blocker */}
    <style jsx global>{`
      @media screen and (orientation: landscape) {
        .portrait-only { display: none !important; }
        .landscape-blocker { display: flex !important; }
      }
      @media screen and (orientation: portrait) {
        .portrait-only { display: block !important; }
        .landscape-blocker { display: none !important; }
      }
    `}</style>

    {/* Full-screen overlay shown in landscape to block play */}
    <div className="landscape-blocker fixed inset-0 z-50 hidden items-center justify-center bg-black text-white p-6 text-center">
      <div className="max-w-xs space-y-3">
        <div className="text-lg font-semibold">Please rotate your device</div>
        <div className="text-sm opacity-80">This game is portrait-only.</div>
      </div>
    </div>

        {/* Game content (portrait only) */}
    <div className="portrait-only">

      {/* Top bar */}
      <div className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b border-gray-200">
        <div className="max-w-md mx-auto px-3 py-2 flex items-center justify-between">
          <div className="font-black tracking-tight">DLF</div>
          <div className="flex items-center gap-2">
            <button onClick={() => setShowHelp(true)} className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300">?</button>
            <button onClick={() => setShowResetConfirm(true)} className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300">Reset</button>
            <button onClick={() => setUseYesterday((v) => !v)} className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300">
              {useYesterday ? 'Today' : 'Yesterday'}
            </button>
          </div>
        </div>
      </div>

      {/* Top phrase */}
      <div className="max-w-md mx-auto w-full">
        <TopPhrase />
      </div>

      {/* Moves counter */}
      <div className="max-w-md mx-auto w-full px-3 py-1 text-center font-semibold">Moves: {moveCount}</div>

      {/* Bottom board — centered */}
      <div className="w-full flex justify-center px-2 py-2">
        <div className="inline-block">
          <Board />
        </div>
      </div>

      {/* Win modal */}
      {isWin && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-20">
          <div className="bg-white rounded-lg shadow-lg p-4 w-[90%] max-w-sm text-center">
            <div className="text-xl font-bold mb-1">Congratulations!</div>
            <div className="mb-3">Solved in {moveCount} moves</div>
            <div className="flex gap-2 justify-center">
              <button onClick={shareResults} className="px-3 py-1 rounded bg-blue-800 text-white">Copy Results</button>
              <button onClick={() => setIsWin(false)} className="px-3 py-1 rounded bg-gray-200">Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Reset confirm */}
      {showResetConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-20">
          <div className="bg-white rounded-lg shadow-lg p-4 w-[90%] max-w-sm">
            <div className="font-semibold mb-3">Reset the puzzle to its starting arrangement? Moves will be set to 0.</div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowResetConfirm(false)} className="px-3 py-1 rounded bg-gray-200">Cancel</button>
              <button onClick={() => { setShowResetConfirm(false); resetAll(); }} className="px-3 py-1 rounded bg-blue-800 text-white">Reset</button>
            </div>
          </div>
        </div>
      )}

      {/* Help modal */}
      {showHelp && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-20">
          <div className="bg-white rounded-lg shadow-lg p-4 w-[90%] max-w-sm text-sm">
            <div className="font-semibold mb-2">How to play</div>
            <ul className="list-disc pl-5 space-y-1 text-left">
              <li>Swap tiles to place every letter in the correct slot.</li>
              <li>Tap two tiles to swap, or drag one tile onto another.</li>
              <li>Blue = correct; Yellow = not yet correct.</li>
              <li>Reset returns to the starting board; Moves reset to 0.</li>
              <li>Small corner numbers are slot positions; they match top and bottom.</li>
            </ul>
            <div className="text-right mt-3">
              <button onClick={() => setShowHelp(false)} className="px-3 py-1 rounded bg-blue-800 text-white">Close</button>
            </div>
          </div>
        </div>
      )}
    </div> {/* close .portrait-only */}
  </div>   {/* close top-level */}
);          // close return
}           // close function
