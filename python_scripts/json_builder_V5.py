# json_builder_V1.py
# One-block JSON builder for Daily Letter Frame (complex grids)
#
# Summary (for non-programmers): Paste one text block describing the phrase,
# grid size, and placed words. Click Build & Save. This creates/updates
# puzzles.json with a ready-to-play puzzle entry.
#
# What this script does:
# - Accepts ONE pasted block with:
#     PHRASE: <display phrase with spaces/punct>
#     WIDTH: <int>
#     HEIGHT: <int>
#     WORDS:
#       H row=<r> col=<c> word=<LETTERS>
#       V row=<r> col=<c> word=<LETTERS>
#       ...
# - Validates the block (bounds, crossings, counts)
# - Converts it into a full game JSON entry:
#     - layout, topPhrase, bottomCells (row/col/topIndex for each letter)
#     - tiles, startPositions (exactly 3 correct; no other accidental matches)
#     - seededCorrectSlotIds, topIndexForTileId, top order arrays
#     - asciiSolution (human-only snapshot of solved grid)
# - Appends to puzzles.json (or asks to overwrite if phrase (letters-only) exists)
# - Prints a short summary with the output location

import json
import os
import random
import re
import sys
import unicodedata
from dataclasses import dataclass
from tkinter import Tk, Text, Button, END, messagebox, Label, filedialog, Scrollbar, RIGHT, Y, LEFT, BOTH, Frame

# -----------------------------
# Helpers: text parsing & utils
# -----------------------------

WORD_LINE_RE = re.compile(
    r'^\s*([HV])\s+row=(\d+)\s+col=(\d+)\s+word=([A-Za-z]+)\s*$'
)

def letters_only_upper(s: str) -> str:
    """Normalize to A-Z only, uppercased. Removes accents & punctuation."""
    # Normalize accents, then keep only A-Z
    s_norm = unicodedata.normalize('NFKD', s)
    # Build letters-only
    return ''.join(ch for ch in s_norm.upper() if 'A' <= ch <= 'Z')

# -----------------------------
# Parse the pasted input block
# -----------------------------
def parse_block(block_text):
    """
    Expected format in the text box:

    PHRASE: "It's like déjà vu all over again."
    WIDTH: 7
    HEIGHT: 6

    WORDS:
      H row=2 col=0 word=ANGLERS
      H row=4 col=0 word=VIVALDI
      V row=0 col=1 word=JUNKIE
      V row=0 col=3 word=ITALIA
      V row=0 col=5 word=LAREDO
    """
    lines = [ln.rstrip() for ln in block_text.splitlines()]

    phrase_display = None
    width = None
    height = None
    words = []
    in_words = False

    for raw in lines:
        line = raw.strip()
        if not line:
            continue

        # Header keys
        if not in_words and line.upper().startswith("PHRASE:"):
            # Keep EXACTLY what the user typed after "PHRASE:" (including quotes/accents/punctuation)
            phrase_display = raw.split(":", 1)[1].strip()
            continue

        if not in_words and line.upper().startswith("WIDTH:"):
            width = int(raw.split(":", 1)[1].strip())
            continue

        if not in_words and line.upper().startswith("HEIGHT:"):
            height = int(raw.split(":", 1)[1].strip())
            continue

        # Switch to WORDS mode
        if line.upper().startswith("WORDS:"):
            in_words = True
            continue

        # Parse word lines once we're in WORDS:
        if in_words:
            m = WORD_LINE_RE.match(line)
            if not m:
                raise ValueError(f"Bad WORDS line: {raw}\nExpected like: H row=2 col=0 word=ANGLERS")
            orient, row, col, word = m.groups()
            words.append((orient, int(row), int(col), word.upper()))

    if phrase_display is None:
        raise ValueError("Missing PHRASE: line.")
    if width is None or height is None:
        raise ValueError("Missing WIDTH or HEIGHT.")
    if not words:
        raise ValueError("No WORDS provided.")

    return phrase_display, width, height, words


# -----------------------------
# NEW: display slots + min_swaps helpers (ADDITIVE ONLY)
# -----------------------------

def _normalize_logic_char(ch):
    """Map a single display character to its logic A–Z letter (uppercase). None for decorations."""
    if not ch or not ch.isalpha():
        return None
    s_norm = unicodedata.normalize('NFKD', ch)
    letters = [c for c in s_norm.upper() if 'A' <= c <= 'Z']
    return letters[0] if letters else None

def build_slots_for_display(phrase_display):
    """
    Build per-character slots used for display/layout (page can ignore for now).
    Each slot: {
      'ch': exact display char,
      'is_decoration': bool,            # letters (incl. accented) = False; others True
      'logic_char': 'A'..'Z' or None,   # normalized mapping for letters
      'glue': 'attach_left'|'attach_right'|'inner'|'free'
    }
    """
    slots = []
    s = phrase_display
    n = len(s)

    def is_letter(c): return bool(c) and c.isalpha()
    def prev_char(i): return s[i-1] if i-1 >= 0 else ''
    def next_char(i): return s[i+1] if i+1 < n else ''

    opening_quotes = {'“', '‘'}
    closing_quotes = {'”', '’'}
    punct_trailing = {',', '.', '!', '?', ';', ':', '…'}
    open_brackets = {'(', '[', '{'}
    close_brackets = {')', ']', '}'}
    dashes = {'-', '-', '–', '—'}

    for i, ch in enumerate(s):
        deco = not is_letter(ch)
        logic_char = None if deco else _normalize_logic_char(ch)
        glue = "free"

        if deco:
            if ch.isspace():
                glue = "free"
            elif ch in opening_quotes or ch in open_brackets:
                glue = "attach_right"
            elif ch in closing_quotes or ch in close_brackets or ch in punct_trailing:
                glue = "attach_left"
            elif ch in dashes:
                p, q = prev_char(i), next_char(i)
                if is_letter(p) and is_letter(q):
                    glue = "inner"
                elif (p and p.isspace()) and (q and q.isspace()):
                    glue = "free"
                elif is_letter(p):
                    glue = "attach_left"
                elif is_letter(q):
                    glue = "attach_right"
                else:
                    glue = "free"
            elif ch == '"':
                p = prev_char(i)
                glue = "attach_right" if (i == 0 or (p and (p.isspace() or p in open_brackets or p in dashes))) else "attach_left"
            elif ch == "'":
                p, q = prev_char(i), next_char(i)
                if is_letter(p) and is_letter(q):
                    glue = "inner"
                elif is_letter(p):
                    glue = "attach_left"
                elif is_letter(q):
                    glue = "attach_right"
                else:
                    glue = "free"

        slots.append({
            "ch": ch,
            "is_decoration": bool(deco),
            "logic_char": logic_char,
            "glue": glue
        })
    return slots

def _hungarian_min_cost(cost):
    """Hungarian (Kuhn–Munkres) for square cost matrix. Returns col_of_row assignment."""
    n = len(cost)
    INF = 10**9
    u = [0]*(n+1); v = [0]*(n+1)
    p = [0]*(n+1); way = [0]*(n+1)
    for i in range(1, n+1):
        p[0] = i; j0 = 0
        minv = [INF]*(n+1); used = [False]*(n+1)
        while True:
            used[j0] = True
            i0 = p[j0]; delta = INF; j1 = 0
            for j in range(1, n+1):
                if not used[j]:
                    cur = cost[i0-1][j-1] - u[i0] - v[j]
                    if cur < minv[j]: minv[j] = cur; way[j] = j0
                    if minv[j] < delta: delta = minv[j]; j1 = j
            for j in range(0, n+1):
                if used[j]: u[p[j]] += delta; v[j] -= delta
                else: minv[j] -= delta
            j0 = j1
            if p[j0] == 0: break
        while True:
            j1 = way[j0]; p[j0] = p[j1]; j0 = j1
            if j0 == 0: break
    col_of_row = [0]*n
    for j in range(1, n+1):
        if p[j] > 0: col_of_row[p[j]-1] = j-1
    return col_of_row

def compute_min_swaps_from_positions(phrase_letters, start_positions):
    """
    Compute minimum swaps over the letters-only permutation from this start.
    Uses assignment -> cycle count (handles duplicates optimally).
    """
    N = len(phrase_letters)
    # U = mismatched (incorrect) slots, 1..N
    U = []
    for i in range(1, N+1):
        tile_id = start_positions[i]
        have = phrase_letters[tile_id-1]
        need = phrase_letters[i-1]
        if have != need:
            U.append(i)
    m = len(U)
    if m == 0:
        return 0

    have_at = {i: phrase_letters[start_positions[i]-1] for i in U}
    need_at = {i: phrase_letters[i-1] for i in U}
    INF = 10**6
    cost = [[INF]*m for _ in range(m)]
    for r,i in enumerate(U):
        for c,j in enumerate(U):
            if have_at[i] == need_at[j]:
                # prefer mutual pairs (2-cycles) when possible
                mutual = (have_at[j] == need_at[i])
                cost[r][c] = 0 if mutual else 1

    assign = _hungarian_min_cost(cost)
    to_index = {U[r]: U[assign[r]] for r in range(m)}

    # Count cycles
    visited = set(); cycles = 0
    for node in U:
        if node in visited: continue
        cur = node
        while cur not in visited:
            visited.add(cur)
            cur = to_index[cur]
        cycles += 1
    return m - cycles

# -----------------------------
# Grid construction & validate
# -----------------------------

@dataclass(frozen=True)
class Cell:
    row: int
    col: int

def lay_down_words(width: int, height: int, words):
    """
    Place words on a WIDTH x HEIGHT grid.
    Returns: dict[(row,col)] = letter
    Errors if out-of-bounds or crossing conflicts occur.
    """
    grid = {}
    for orient, row, col, word in words:
        if row < 0 or row >= height or col < 0 or col >= width:
            raise ValueError(f"Word start out of bounds at row={row}, col={col}.")

        if orient == 'H':
            end_col = col + len(word) - 1
            if end_col >= width:
                raise ValueError(f"Horizontal word '{word}' overflows grid at row={row}, col={col}.")
            for i, ch in enumerate(word):
                r, c = row, col + i
                prev = grid.get((r, c))
                if prev and prev != ch:
                    raise ValueError(f"Letter conflict at (row={r}, col={c}): '{prev}' vs '{ch}'.")
                grid[(r, c)] = ch
        else:  # 'V'
            end_row = row + len(word) - 1
            if end_row >= height:
                raise ValueError(f"Vertical word '{word}' overflows grid at row={row}, col={col}.")
            for i, ch in enumerate(word):
                r, c = row + i, col
                prev = grid.get((r, c))
                if prev and prev != ch:
                    raise ValueError(f"Letter conflict at (row={r}, col={c}): '{prev}' vs '{ch}'.")
                grid[(r, c)] = ch
    return grid

def assign_top_indices(phrase_letters: str, grid_map: dict, width: int, height: int):
    """
    Map each filled cell to a topIndex (1..N) in a deterministic way that handles duplicates.
    Strategy:
      - Build a queue of top indices for each letter from the phrase (left→right).
      - Scan the grid row-major (r=0..H-1, c=0..W-1), and for each filled cell with letter L,
        assign the next available top index for L.
    Returns: bottomCells list of dicts {row, col, topIndex}, sorted row-major.
    """
    # Build pools of indices per letter from phrase
    pools = {chr(ord('A') + i): [] for i in range(26)}
    for idx, ch in enumerate(phrase_letters, start=1):
        pools[ch].append(idx)

    # Row-major scan
    filled = [(r, c, grid_map[(r, c)]) for r in range(height) for c in range(width) if (r, c) in grid_map]
    bottom_cells = []
    used_indices = set()

    for r, c, ch in filled:
        pool = pools.get(ch)
        if not pool:
            raise ValueError(f"Grid uses letter '{ch}' not found in phrase letters.")
        k = pool.pop(0)
        if k in used_indices:
            raise ValueError(f"Internal error: duplicate assignment for index {k}.")
        used_indices.add(k)
        bottom_cells.append({"row": r, "col": c, "topIndex": k})

    # Validate coverage
    if len(bottom_cells) != len(phrase_letters):
        raise ValueError("Number of filled cells does not match number of letters in the phrase.")

    return bottom_cells

# -----------------------------
# Start positions with exactly 3 correct (letter-based)
# -----------------------------

def build_start_positions_exactly_three(phrase_letters: str):
    """
    Build an initial placement array positions[1..N] = tileId
    Such that:
      - Exactly 3 indices i have letter(tileId) == letter(i)
      - All others are NOT letter-matches.
    Note: tileId and topIndex both range 1..N, with letter(tileId) = phrase_letters[tileId-1].
    """
    N = len(phrase_letters)
    indices = list(range(1, N + 1))

    # Choose 3 unique seeded indices
    seeded = sorted(random.sample(indices, k=3))

    # First, map seeded i -> i
    placement = {i: i for i in seeded}

    # Remaining indices
    remaining_slots = [i for i in indices if i not in seeded]
    remaining_tiles = [i for i in indices if i not in seeded]

    target_letter = lambda i: phrase_letters[i - 1]

    # Try randomized permutations until a valid one is found
    for _attempt in range(2000):
        random.shuffle(remaining_tiles)
        ok = True
        temp = {}
        for s, t in zip(remaining_slots, remaining_tiles):
            if target_letter(s) == target_letter(t):
                ok = False
                break
            temp[s] = t
        if ok:
            placement.update(temp)
            # Build positions array 1..N
            positions = [None] * (N + 1)
            for s in indices:
                positions[s] = placement[s]
            # Final strict check: exactly 3 letter matches
            matches = sum(1 for s in indices if target_letter(s) == target_letter(positions[s]))
            if matches == 3:
                return positions, seeded

    raise ValueError("Could not generate a starting arrangement with exactly 3 letter-based matches. Try adjusting the grid/phrase.")

# -----------------------------
# Top reveal arrays
# -----------------------------

def derangement(seq):
    """Return a derangement of seq (no fixed points). Retries a few times."""
    for _ in range(2000):
        arr = seq[:]
        random.shuffle(arr)
        if all(a != b for a, b in zip(arr, seq)):
            return arr
    if len(seq) > 1:
        return seq[1:] + seq[:1]
    return seq[:]

def build_top_orders(N: int, seeded_correct_ids):
    """
    Build topOrderInitialDeranged and topOrderAfterInitialSnap arrays of tileIds.
    - initial: a full derangement of [1..N]
    - after snap: put seeded indices' tileIds into their phrase indices, derange the rest
    """
    base = list(range(1, N + 1))
    initial = derangement(base)

    after = initial[:]
    for i in sorted(seeded_correct_ids):
        pos = after.index(i)
        if pos != (i - 1):
            after[pos], after[i - 1] = after[i - 1], after[pos]

    unlocked_positions = [p for p in range(N) if (p + 1) not in seeded_correct_ids]
    for p in unlocked_positions:
        if after[p] == p + 1:
            for q in unlocked_positions:
                if q != p and after[q] != q + 1 and after[q] != p + 1:
                    after[p], after[q] = after[q], after[p]
                    break
    return initial, after

# -----------------------------
# JSON assembly
# -----------------------------

def assemble_puzzle_json(phrase_display: str, width: int, height: int, words_lines):
    # 1) Normalize phrase to letters-only (A-Z)
    phrase_letters = letters_only_upper(phrase_display)
    if not phrase_letters:
        raise ValueError("Phrase must contain at least one A-Z letter.")

    # 2) Lay down words on grid
    grid_map = lay_down_words(width, height, words_lines)

    # 3) Build asciiSolution (for humans)
    ascii_rows = []
    for r in range(height):
        row_chars = []
        for c in range(width):
            ch = grid_map.get((r, c), '.')
            row_chars.append(ch)
        ascii_rows.append(''.join(row_chars))
    ascii_solution = "\n".join(ascii_rows)

    # 4) Map each filled cell to a topIndex (1..N)
    bottom_cells = assign_top_indices(phrase_letters, grid_map, width, height)

    if len(bottom_cells) != len(phrase_letters):
        raise ValueError("Filled cells count != number of letters in the phrase.")

    N = len(phrase_letters)

    # 5) Build tiles (tileId == topIndex; targetSlotId == same)
    tiles = []
    for i in range(1, N + 1):
        tiles.append({
            "tileId": i,
            "targetSlotId": i,
            "letter": phrase_letters[i - 1]
        })

    # 6) Start positions with exactly 3 letter-based matches
    start_positions, seeded3 = build_start_positions_exactly_three(phrase_letters)

    # 7) topIndexForTileId, top order arrays
    top_index_for_tile_id = [None] + [i for i in range(1, N + 1)]
    top_init, top_after = build_top_orders(N, seeded3)

    # 8) NEW: compute min_swaps + build slots + counts
    min_swaps = compute_min_swaps_from_positions(phrase_letters, start_positions)
    slots = build_slots_for_display(phrase_display)
    letterCount = sum(1 for s in slots if not s["is_decoration"])
    decorationCount = len(slots) - letterCount

    # 9) Final JSON object (all existing fields unchanged; new fields appended)
    obj = {
        "schemaVersion": 3,
        "layout": {
            "width": width,
            "height": height,
            "hasMiddle": False
        },
        "topPhrase": phrase_display,
        "tiles": tiles,
        "bottomCells": bottom_cells,
        "startPositions": start_positions,   # index 0 is None
        "seededCorrectSlotIds": seeded3,
        "topIndexForTileId": top_index_for_tile_id,
        "topOrderInitialDeranged": top_init,
        "topOrderAfterInitialSnap": top_after,
        "asciiSolution": ascii_solution,

        # NEW FIELDS (additive)
        "min_swaps": int(min_swaps),
        "slots": slots,
        "counts": {"letterCount": letterCount, "decorationCount": decorationCount}
    }
    return obj, phrase_letters

# -----------------------------
# Puzzles file I/O
# -----------------------------

def load_puzzles(path: str):
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        try:
            data = json.load(f)
            if isinstance(data, list):
                return data
            return []
        except json.JSONDecodeError:
            return []

def save_puzzles(path: str, puzzles: list):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(puzzles, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

# -----------------------------
# GUI
# -----------------------------

DEFAULT_PATH = r"C:\Alloquest_Photos\panama-v2\public\puzzles.json"

class App:
    def __init__(self, master):
        self.master = master
        master.title("Daily Letter Frame — JSON Builder (V1)")

        # File picker
        self.path = DEFAULT_PATH
        topbar = Frame(master)
        topbar.pack(fill='x')
        Label(topbar, text="Output file: ").pack(side=LEFT)
        self.path_label = Label(topbar, text=self.path)
        self.path_label.pack(side=LEFT, padx=4)
        Button(topbar, text="Change...", command=self.change_path).pack(side=LEFT, padx=6)

        # Text area + scrollbar
        self.text = Text(master, height=24, width=100, wrap='word')
        scroll = Scrollbar(master, command=self.text.yview)
        self.text.configure(yscrollcommand=scroll.set)
        self.text.pack(side=LEFT, fill=BOTH, expand=True)
        scroll.pack(side=RIGHT, fill=Y)

        # Buttons
        btnbar = Frame(master)
        btnbar.pack(fill='x')
        Button(btnbar, text="Build & Save", command=self.build_and_save, height=2).pack(side=LEFT, padx=6, pady=6)
        Button(btnbar, text="Quit", command=master.quit).pack(side=LEFT, padx=6, pady=6)

        # Prefill with a template
        self.text.insert(END,
"""PHRASE: My name is Inigo Montoya

WIDTH: 7
HEIGHT: 6

WORDS:
  H row=1 col=0 word=NOSEGAY
  H row=3 col=1 word=MINIM
  V row=0 col=1 word=MINETA
  V row=1 col=3 word=AEON
  V row=0 col=5 word=ONIONY
""")

    def change_path(self):
        newpath = filedialog.asksaveasfilename(
            title="Choose puzzles.json",
            defaultextension=".json",
            initialfile=os.path.basename(self.path),
            filetypes=[("JSON files", "*.json"), ("All files", "*.*")]
        )
        if newpath:
            self.path = newpath
            self.path_label.config(text=self.path)

    def build_and_save(self):
        block = self.text.get("1.0", END)
        try:
            phrase_display, width, height, words_lines = parse_block(block)
            # Parse & validate words
            grid_obj, phrase_letters = assemble_puzzle_json(phrase_display, width, height, words_lines)
        except Exception as e:
            messagebox.showerror("Error", str(e))
            return

        # Load existing
        puzzles = load_puzzles(self.path)

        # Letters-only duplicate check
        key_new = letters_only_upper(phrase_display)
        idx_existing = -1
        for i, p in enumerate(puzzles):
            existing_phrase = p.get("topPhrase") or ""
            if letters_only_upper(existing_phrase) == key_new:
                idx_existing = i
                break

        # Overwrite or append
        if idx_existing >= 0:
            if not messagebox.askyesno("Overwrite?", "A puzzle with the same letters-only phrase already exists.\nOverwrite it?"):
                messagebox.showinfo("Cancelled", "No changes made.")
                return
            puzzles[idx_existing] = grid_obj
            action = "overwritten"
        else:
            puzzles.append(grid_obj)
            action = "appended"

        try:
            save_puzzles(self.path, puzzles)
        except Exception as e:
            messagebox.showerror("Save Error", str(e))
            return

        # Final summary
        N = len(letters_only_upper(phrase_display))
        messagebox.showinfo(
            "Success",
            f"Puzzle {action}.\n\n"
            f"Phrase: {phrase_display}\n"
            f"Letters (A–Z only): {N}\n"
            f"Grid: {width}×{height}\n"
            f"Output: {os.path.abspath(self.path)}"
        )
        print("=== RUN COMPLETE ===")
        print(f"Phrase: {phrase_display}")
        print(f"Letters-only length: {N}")
        print(f"Grid size: {width} x {height}")
        print(f"Action: {action}")
        print(f"Output location: {os.path.abspath(self.path)}")

def main():
    random.seed()
    root = Tk()
    app = App(root)
    root.mainloop()

if __name__ == "__main__":
    main()
