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

def parse_block(block: str):
    """
    Parse a single pasted block.
    Expected keys:
      PHRASE: <string>
      WIDTH: <int>
      HEIGHT: <int>
      WORDS:
        lines of 'H row=<r> col=<c> word=<LETTERS>' or 'V row=<r> col=<c> word=<LETTERS>'
    """
    # Extract PHRASE
    m_phrase = re.search(r'(?mi)^\s*PHRASE:\s*(.+)\s*$', block)
    if not m_phrase:
        raise ValueError("Missing PHRASE: line.")
    phrase_display = m_phrase.group(1).strip()
    if not phrase_display:
        raise ValueError("PHRASE is empty.")

    # Extract WIDTH/HEIGHT
    m_w = re.search(r'(?mi)^\s*WIDTH:\s*(\d+)\s*$', block)
    m_h = re.search(r'(?mi)^\s*HEIGHT:\s*(\d+)\s*$', block)
    if not m_w or not m_h:
        raise ValueError("Missing WIDTH or HEIGHT line.")
    width = int(m_w.group(1))
    height = int(m_h.group(1))
    if width <= 0 or height <= 0:
        raise ValueError("WIDTH and HEIGHT must be positive integers.")

    # Extract WORDS section
    m_words_hdr = re.search(r'(?mi)^\s*WORDS:\s*$', block)
    if not m_words_hdr:
        raise ValueError("Missing WORDS: section header.")

    words_lines = []
    # Grab everything after WORDS: until end
    after = block[m_words_hdr.end():]
    for line in after.splitlines():
        line_stripped = line.strip()
        if not line_stripped:
            continue
        # Accept comment lines starting with '#'
        if line_stripped.startswith('#'):
            continue
        # Parse H/V rows
        m = WORD_LINE_RE.match(line)
        if m:
            orient = m.group(1).upper()
            row = int(m.group(2))
            col = int(m.group(3))
            word = m.group(4).upper()
            words_lines.append((orient, row, col, word))
        else:
            # If the line doesn't match H/V row= col= word=, ignore blank/comment; otherwise error
            # Be lenient: allow trailing sections or notes starting with non H/V
            # But if it looks like a malformed H/V entry, raise.
            if line_stripped[0:1] in ('H', 'V'):
                raise ValueError(f"Malformed WORDS line: {line.strip()}")

    if not words_lines:
        raise ValueError("No WORDS entries found under WORDS: header.")

    return phrase_display, width, height, words_lines

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

    # Sort by topIndex for stable downstream (optional)
    # Here we keep row-major order in the list but JSON consumers don't rely on order.
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

    # We need to assign a permutation of remaining_tiles to remaining_slots
    # such that for each slot s with target letter Ls, assigned tile t has letter Lt != Ls.
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
    # Fallback: simple rotate if possible
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

    # Snap seeded positions
    after = initial[:]
    # For each seeded index i: ensure tileId i is placed at index (i-1)
    for i in sorted(seeded_correct_ids):
        # find tileId i in after, swap into position i-1
        pos = after.index(i)
        if pos != (i - 1):
            after[pos], after[i - 1] = after[i - 1], after[pos]

    # Now derange the non-seeded indices among themselves (avoid any tile sitting at its own index)
    unlocked_positions = [p for p in range(N) if (p + 1) not in seeded_correct_ids]
    # Simple pass: if any unlocked position p has tileId == p+1, try to swap with another unlocked position
    for p in unlocked_positions:
        if after[p] == p + 1:
            for q in unlocked_positions:
                if q != p and after[q] != q + 1 and after[q] != p + 1:
                    after[p], after[q] = after[q], after[p]
                    break
    # If still any fixed points remain among unlocked, accept (low impact on game), but we tried.

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

    # 4) Map each filled cell to a topIndex (1..N), handling duplicates
    bottom_cells = assign_top_indices(phrase_letters, grid_map, width, height)

    # Validate coverage count
    if len(bottom_cells) != len(phrase_letters):
        raise ValueError("Filled cells count != number of letters in phrase.")

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
    top_index_for_tile_id = [None] + [i for i in range(1, N + 1)]  # identity
    top_init, top_after = build_top_orders(N, seeded3)

    # 8) Final JSON object
    obj = {
        "schemaVersion": 3,
        "layout": {
            "width": width,
            "height": height,
            "hasMiddle": False  # retained for compatibility; not used by complex grids
        },
        "topPhrase": phrase_display,
        "tiles": tiles,
        "bottomCells": bottom_cells,
        "startPositions": start_positions,  # ensure index 0 is null
        "seededCorrectSlotIds": seeded3,
        "topIndexForTileId": top_index_for_tile_id,
        "topOrderInitialDeranged": top_init,
        "topOrderAfterInitialSnap": top_after,
        # Human-only snapshot:
        "asciiSolution": ascii_solution
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
            # Support both old and new formats (use topPhrase if present)
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
    # Make randomness less surprising within a session
    random.seed()

    root = Tk()
    app = App(root)
    root.mainloop()

if __name__ == "__main__":
    main()
