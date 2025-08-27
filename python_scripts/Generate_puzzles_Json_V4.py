# Generate_puzzles_Json_V1.py  (drop-in replacement)
# One-file GUI app: paste puzzle block (PHRASE/WIDTH/HEIGHT/WORDS/THEME) → validate → append to puzzles.json.
# - No external modules beyond Python stdlib.
# - Guarantees exactly K seeded greens by letter (handles duplicates) using Hungarian-based constrained matching.
# - Includes Hungarian algorithm, min_moves via Hungarian + cycles, duplicate detection, atomic write & timestamped backups.
# - Default puzzles.json: C:\Alloquest_Photos\panama-v2\public\puzzles.json
#
# Usage:
#   Double-click or: python Generate_puzzles_Json_V1.py
#   Paste your block, click "Validate & Preview", then "Append to puzzles.json".
#
# Duplicate rule:
#   Duplicate if normalized phrase letters (A–Z only, in order) match an existing entry.
#   On duplicate, choose Overwrite or Cancel.
#
# Data invariants:
#   - Grid letter count must equal normalized phrase letter count.
#   - start_state.scramble is a permutation of 1..N with exactly K seeded greens (by LETTER), even with duplicates.
#   - start_state.correct_positions are the seeded locations (1..N) that begin correct.
#   - start_state.min_moves computed via Hungarian + cycle decomposition.

from __future__ import annotations
import json, os, re, shutil, tempfile, time, unicodedata, random, math, sys, webbrowser
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
from dataclasses import dataclass
from typing import List, Tuple, Dict, Any, Optional

# ---------------- Defaults ----------------

DEFAULT_PUZZLES_PATH = r"C:\Alloquest_Photos\panama-v2\public\puzzles.json"

TEMPLATE = (
    "PHRASE: \"It's déjà vu all over again.\"\n"
    "WIDTH: 7\n"
    "HEIGHT: 6\n"
    "\n"
    "WORDS:\n"
    "  H row=2 col=0 word=ANGLERS\n"
    "  H row=4 col=0 word=VIVALDI\n"
    "  V row=0 col=1 word=JUNKIE\n"
    "  V row=0 col=3 word=ITALIA\n"
    "  V row=0 col=5 word=LAREDO\n"
    "\n"
    "THEME:\n"
    "This phrase is one of Yogi’s Yogi-isms...\n"
    "Add as many paragraphs as you like.\n"
)

# ---------------- Data classes ----------------

@dataclass
class WordSpec:
    text: str
    dir: str  # 'H' or 'V'
    row: int
    col: int

@dataclass
class GridSpec:
    width: int
    height: int

@dataclass
class ParsedBlock:
    phrase: str
    width: int
    height: int
    words: List[WordSpec]
    theme: str

# ---------------- Normalization ----------------

def normalize_letters(phrase: str) -> str:
    """Normalize display phrase to gameplay A–Z only (uppercase, accents stripped)."""
    s = unicodedata.normalize("NFD", phrase).upper()
    return re.sub(r"[^A-Z]", "", s)

# ---------------- Parsing ----------------

def parse_block(text: str) -> ParsedBlock:
    lines = [ln.rstrip("\r") for ln in text.splitlines()]
    src = "\n".join(lines)

    m_phrase = re.search(r"^PHRASE:\s*(.+)$", src, re.MULTILINE)
    if not m_phrase:
        raise ValueError("Missing PHRASE: line")
    phrase_raw = m_phrase.group(1).strip()
    if (phrase_raw.startswith('"') and phrase_raw.endswith('"')) or (phrase_raw.startswith("'") and phrase_raw.endswith("'")):
        phrase = phrase_raw[1:-1]
    else:
        phrase = phrase_raw

    m_width = re.search(r"^WIDTH:\s*(\d+)\s*$", src, re.MULTILINE)
    m_height = re.search(r"^HEIGHT:\s*(\d+)\s*$", src, re.MULTILINE)
    if not m_width or not m_height:
        raise ValueError("Missing WIDTH or HEIGHT")
    width = int(m_width.group(1)); height = int(m_height.group(1))

    m_words_start = re.search(r"^WORDS:\s*$", src, re.MULTILINE)
    m_theme_start = re.search(r"^THEME:\s*$", src, re.MULTILINE)
    if not m_words_start or not m_theme_start:
        raise ValueError("Missing WORDS: or THEME: section")

    words_section = src[m_words_start.end(): m_theme_start.start()]
    word_specs: List[WordSpec] = []
    for ln in words_section.splitlines():
        ln = ln.strip()
        if not ln: continue
        m = re.match(r"^(H|V)\s+row=(\d+)\s+col=(\d+)\s+word=([A-Za-z]+)$", ln)
        if not m:
            raise ValueError(f"Bad WORDS line: {ln}")
        d,row,col,wtext = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4).upper()
        word_specs.append(WordSpec(text=wtext, dir=d, row=row, col=col))

    theme_text = src[m_theme_start.end():].lstrip("\n")

    return ParsedBlock(phrase=phrase, width=width, height=height, words=word_specs, theme=theme_text)

# ---------------- Grid validation & enumeration ----------------

def validate_word_placement_and_build_cells(words: List[WordSpec], width: int, height: int) -> Tuple[List[Tuple[int,int]], List[str]]:
    grid_letter_at: Dict[Tuple[int,int], str] = {}
    cells: List[Tuple[int,int]] = []
    solution_letters: List[str] = []
    for w in words:
        text = w.text.upper(); d = w.dir.upper()
        if d not in ("H","V"): raise ValueError(f"Invalid dir {w.dir!r}; must be H or V")
        if not (0 <= w.row < height) or not (0 <= w.col < width):
            raise ValueError(f"Word start out of bounds: row={w.row} col={w.col}")
        if d == "H":
            if w.col + len(text) > width:
                raise ValueError(f"Word {text} exceeds width at row={w.row}, col={w.col}")
        else:
            if w.row + len(text) > height:
                raise ValueError(f"Word {text} exceeds height at row={w.row}, col={w.col}")
        for i, ch in enumerate(text):
            r = w.row if d == "H" else w.row + i
            c = w.col + i if d == "H" else w.col
            if (r,c) in grid_letter_at:
                if grid_letter_at[(r,c)] != ch:
                    raise ValueError(f"Intersection conflict at {(r,c)}: {grid_letter_at[(r,c)]} vs {ch}")
            else:
                grid_letter_at[(r,c)] = ch
                cells.append((r,c))
                solution_letters.append(ch)
    return cells, solution_letters

# ---------------- Target mapping ----------------

def build_target_mapping(phrase_letters: str, solution_letters: List[str]) -> List[int]:
    if len(phrase_letters) != len(solution_letters):
        raise ValueError(f"Phrase letters ({len(phrase_letters)}) != grid letters ({len(solution_letters)})")
    N = len(phrase_letters)
    used = [False]*N
    target_for_tile = [0]*N
    for i, L in enumerate(phrase_letters):
        assigned = False
        for j, solL in enumerate(solution_letters):
            if not used[j] and solL == L:
                target_for_tile[i] = j+1
                used[j] = True
                assigned = True
                break
        if not assigned:
            raise ValueError(f"No available cell for phrase letter {L} at index {i+1}")
    return target_for_tile

# ---------------- Hungarian algorithm ----------------

def hungarian(cost: List[List[int]]) -> List[int]:
    n = len(cost)
    u = [0]*(n+1); v = [0]*(n+1); p = [0]*(n+1); way = [0]*(n+1)
    for i in range(1, n+1):
        p[0] = i; j0 = 0
        minv = [float("inf")]*(n+1); used = [False]*(n+1)
        while True:
            used[j0] = True; i0 = p[j0]; delta = float("inf"); j1 = 0
            for j in range(1, n+1):
                if not used[j]:
                    cur = cost[i0-1][j-1] - u[i0] - v[j]
                    if cur < minv[j]: minv[j] = cur; way[j] = j0
                    if minv[j] < delta: delta = minv[j]; j1 = j
            for j in range(0, n+1):
                if used[j]:
                    u[p[j]] += delta; v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0: break
        while True:
            j1 = way[j0]; p[j0] = p[j1]; j0 = j1
            if j0 == 0: break
    assignment = [0]*n
    for j in range(1, n+1):
        if p[j] != 0: assignment[p[j]-1] = j-1
    return assignment

# ---------------- Scramble with exactly K seeded greens (LETTER-based) ----------------

def generate_scramble_with_k_greens(
    target_for_tile: List[int],
    phrase_letters: str,
    k_correct: int = 3,
    max_seed_attempts: int = 400
) -> Tuple[List[int], List[int]]:
    """
    Produce a scramble with exactly K green locations by LETTER (handles duplicates).
    Method:
      - Randomly sample K seed locations (uniform).
      - Build a single assignment for all tiles → locations where:
           * if loc is a seed: tile letter == required letter at loc
           * else           : tile letter != required letter at loc
      - Solve via Hungarian with 0 for allowed edges and BIG for forbidden.
      - If any chosen edge is forbidden (cost==BIG), resample seeds and retry.
    Returns:
      - scramble[t-1] = assigned location for tile t  (1..N)
      - correct_positions = the seed locations (sorted)  (1..N)
    """
    N = len(target_for_tile)
    if k_correct < 0 or k_correct > N:
        raise ValueError("k_correct out of range")

    # Letter helpers
    def tile_letter(t: int) -> str:
        return phrase_letters[t-1]

    # required letter at loc = letter of the tile whose target is that loc
    req_letter_at_loc: Dict[int, str] = {}
    for t in range(1, N+1):
        loc = target_for_tile[t-1]
        req_letter_at_loc[loc] = tile_letter(t)

    indices = list(range(1, N+1))
    BIG = 10**6

    for _attempt in range(max_seed_attempts):
        # Random K seeds
        seeds = set(random.sample(indices, k_correct)) if k_correct > 0 else set()

        # Build cost matrix (tiles as rows, locations as cols)
        cost = [[BIG]*N for _ in range(N)]
        for t in range(1, N+1):
            tl = tile_letter(t)
            for loc in range(1, N+1):
                rl = req_letter_at_loc[loc]
                # Allowed edge if (seed and letters equal) OR (non-seed and letters different)
                allowed = (loc in seeds and tl == rl) or (loc not in seeds and tl != rl)
                if allowed:
                    cost[t-1][loc-1] = 0  # all allowed edges equal (uniform randomization comes from resampling & tie structure)

        assignment = hungarian(cost)

        # Verify all chosen edges are allowed (cost 0)
        ok = True
        for t in range(1, N+1):
            loc = assignment[t-1] + 1
            if cost[t-1][loc-1] >= BIG:
                ok = False
                break
        if not ok:
            continue

        # Build scramble from assignment
        scramble = [0]*N
        for t in range(1, N+1):
            scramble[t-1] = assignment[t-1] + 1

        # Verify exactly K greens, and they are exactly the seeds
        greens = []
        for loc in range(1, N+1):
            # tile currently at loc:
            t = next(tt for tt in range(1, N+1) if scramble[tt-1] == loc)
            if tile_letter(t) == req_letter_at_loc[loc]:
                greens.append(loc)

        if len(greens) == k_correct and set(greens) == seeds:
            return scramble, sorted(greens)

    raise RuntimeError("Could not generate a letter-derangement scramble with exactly K seeded greens; try again or adjust K.")

# ---------------- Min moves via Hungarian + cycles ----------------

def calculate_min_moves(scramble: List[int], phrase_letters: str, target_for_tile: List[int]) -> int:
    """
    TRUE minimum # of swaps to make every location's LETTER correct.
    Tiles are letter-fungible (duplicates allowed). Operation is any two-tile swap.

    Method:
      1) Work only on M = {loc | current_letter(loc) != required_letter(loc)}.
      2) Allowed edge a->b iff the letter currently at a equals the required letter at b.
      3) Find a cycle cover on M (permutation using only allowed edges).
      4) Swaps = |M| - (#cycles in the cover).
         We bias toward 2-cycles and try a few randomized tie-breaks to avoid long cycles.
    """
    N = len(phrase_letters)

    # Required letter at each location (from the "target" mapping 1..N)
    req_letter_at_loc: Dict[int, str] = {}
    for loc in range(1, N+1):
        t_req = next((t for t in range(1, N+1) if target_for_tile[t-1] == loc), None)
        if t_req is None:
            raise RuntimeError("Internal mapping error (target_for_tile not a permutation)")
        req_letter_at_loc[loc] = phrase_letters[t_req - 1]

    # Current letter at each location from the scramble
    tile_at_location = [0]*(N+1)  # 1..N -> tile id
    for t in range(1, N+1):
        loc = scramble[t-1]
        tile_at_location[loc] = t
    cur_letter_at_loc: Dict[int, str] = {loc: phrase_letters[tile_at_location[loc] - 1] for loc in range(1, N+1)}

    # Mismatch set (greens excluded)
    mismatch_locs = [loc for loc in range(1, N+1) if cur_letter_at_loc[loc] != req_letter_at_loc[loc]]
    m = len(mismatch_locs)
    if m == 0:
        return 0

    # Build a cost matrix for Hungarian on mismatch-only indices.
    # Allowed edge i->j if letter at loc_i equals required at loc_j.
    # We bias toward 2-cycles: if reciprocal (i->j and j->i) possible, cost = 0; else cost = 1.
    # To break ties that could yield long cycles, we add tiny randomized jitter and keep the best cover.
    BIG = 10**6
    best_cycles = -1

    # Precompute letter tables for speed
    req_by = {loc: req_letter_at_loc[loc] for loc in mismatch_locs}
    cur_by = {loc: cur_letter_at_loc[loc] for loc in mismatch_locs}
    idx_of = {loc: i for i, loc in enumerate(mismatch_locs)}

    # Up to a handful of randomized runs (fast; m <= N <= ~39)
    for attempt in range(8):
        # Base cost 1 for allowed edges, 0 if reciprocal; BIG if not allowed.
        cost = [[BIG]*m for _ in range(m)]
        # Tiny deterministic jitter seeded by attempt to alter tie-breaking
        seed = (attempt + m*31) & 0xFFFFFFFF
        rnd = random.Random(seed)
        for i, a in enumerate(mismatch_locs):
            la = cur_by[a]
            for j, b in enumerate(mismatch_locs):
                if req_by[b] == la:
                    reciprocal = (req_by[a] == cur_by[b])
                    base = 0 if reciprocal else 1
                    # jitter in [0,1e-6) so Hungarian can pick different equal-cost matchings
                    cost[i][j] = base + rnd.random()*1e-6

        # Solve assignment on M
        assignment = hungarian(cost)  # returns j for each i, length m

        # Build permutation map on locations in M
        loc_map: Dict[int, int] = {}
        valid = True
        for i, a in enumerate(mismatch_locs):
            j = assignment[i]
            if not (0 <= j < m) or cost[i][j] >= BIG:
                valid = False
                break
            b = mismatch_locs[j]
            loc_map[a] = b
        if not valid:
            continue

        # Count cycles in the permutation over M
        visited = set()
        cycles = 0
        for start in mismatch_locs:
            if start in visited:
                continue
            cur = start
            clen = 0
            while cur not in visited:
                visited.add(cur)
                clen += 1
                cur = loc_map[cur]
            if clen > 0:
                cycles += 1

        if cycles > best_cycles:
            best_cycles = cycles
            # Early exit if everything became 2-cycles: cycles == m/2 when m even and fully paired.
            if best_cycles >= (m // 2):
                break

    if best_cycles < 0:
        # Should not happen if data is consistent; fallback: treat as one big cycle.
        best_cycles = 1

    return m - best_cycles


# ---------------- File I/O ----------------

def load_or_init_puzzles(path: str) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {
            "version": "1.0",
            "config": {"default_correct_tiles": 3, "grid_max_width": 7, "grid_max_height": 6},
            "puzzles": []
        }
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)

def atomic_write_json(path: str, data: Dict[str, Any]) -> None:
    folder = os.path.dirname(path) or "."
    os.makedirs(folder, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix="puzzles_", suffix=".tmp", dir=folder, text=True)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        if os.path.exists(path):
            ts = time.strftime("%Y%m%d_%H%M%S")
            backup = f"{path}.bak_{ts}"
            shutil.copy2(path, backup)
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            try: os.remove(tmp_path)
            except: pass

def find_duplicate_index(data: Dict[str, Any], normalized_phrase: str) -> Optional[int]:
    for idx, p in enumerate(data.get("puzzles", [])):
        existing_norm = normalize_letters(p.get("phrase",""))
        if existing_norm == normalized_phrase:
            return idx
    return None

# ---------------- Build puzzle object ----------------

def build_puzzle_object(phrase: str, theme: str, grid: GridSpec, words: List[WordSpec], seeded_greens: Optional[int]) -> Dict[str, Any]:
    phrase_letters = normalize_letters(phrase)
    if not phrase_letters:
        raise ValueError("Phrase has no letters after normalization")
    cells, solution_letters = validate_word_placement_and_build_cells(words, grid.width, grid.height)
    if len(solution_letters) != len(phrase_letters):
        raise ValueError(f"Grid letter count ({len(solution_letters)}) must equal normalized phrase letters ({len(phrase_letters)})")
    target = build_target_mapping(phrase_letters, solution_letters)
    # Map from the builder's cell-index locations (1..N) to the spec's Location IDs (1..N)
    # target[t-1] is the cell index (1..N) that tile t should go to in the SOLVED state.
    # In the spec, that same cell is assigned Location ID = t (Top slot t ⇄ that cell).
    N = len(phrase_letters)
    cell_to_spec_loc = [0] * (N + 1)   # index by cell index, value = spec Location ID
    for t in range(1, N + 1):
        cell_idx = target[t - 1]       # 1..N (builder's cell numbering)
        cell_to_spec_loc[cell_idx] = t # that cell is Location = t in the spec
    k = seeded_greens if seeded_greens is not None else 3

    # NEW: letter-aware scramble guaranteeing exactly K greens (builder's cell-index space)
    scramble_cell, correct_positions_cell = generate_scramble_with_k_greens(
        target_for_tile=target,          # tile -> cell index in SOLVED state
        phrase_letters=phrase_letters,
        k_correct=k
    )

    # Convert to the spec's Location-ID space (Top slot i ⇄ Bottom Location i)
    # scramble_spec[t-1] must be a number in 1..N meaning: "tile t currently sits at Location <that number>"
    scramble_spec = [cell_to_spec_loc[loc_cell] for loc_cell in scramble_cell]
    correct_positions_spec = sorted(cell_to_spec_loc[loc_cell] for loc_cell in correct_positions_cell)

    # In spec space, the SOLVED target is simply 1..N (tile i -> Location i)
    target_spec = list(range(1, N + 1))

    # Compute min_moves using the spec numbering
    min_moves = calculate_min_moves(scramble_spec, phrase_letters, target_spec)

    # Emit JSON in spec numbering
    return {
        "phrase": phrase,
        "theme_info": theme.strip(),
        "grid": {"width": grid.width, "height": grid.height},
        "words": [{"text": w.text.upper(), "dir": w.dir.upper(), "row": int(w.row), "col": int(w.col)} for w in words],
        "start_state": {
            "scramble": scramble_spec,
            "correct_positions": correct_positions_spec,
            "min_moves": int(min_moves),
        },
    }


def append_or_overwrite(puzzles_path: str, puzzle_obj: Dict[str, Any]) -> str:
    data = load_or_init_puzzles(puzzles_path)
    norm_phrase = normalize_letters(puzzle_obj["phrase"])
    dup_idx = find_duplicate_index(data, norm_phrase)
    if dup_idx is not None:
        if messagebox.askyesno("Duplicate detected", "A puzzle with the same normalized phrase letters already exists.\n\nOverwrite it?"):
            existing = data["puzzles"][dup_idx]
            puzzle_obj["id"] = existing.get("id", dup_idx+1)
            data["puzzles"][dup_idx] = puzzle_obj
            atomic_write_json(puzzles_path, data)
            return "overwrote"
        else:
            return "cancelled"
    next_id = 1 + max([p.get("id",0) for p in data.get("puzzles",[])], default=0)
    puzzle_obj["id"] = next_id
    data.setdefault("puzzles", []).append(puzzle_obj)
    atomic_write_json(puzzles_path, data)
    return "appended"

# ---------------- GUI ----------------

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Puzzle JSON Builder — Single File")
        self.geometry("1100x780")

        # Top controls
        top = ttk.Frame(self); top.pack(fill="x", padx=10, pady=8)
        ttk.Label(top, text="puzzles.json:").pack(side="left")
        self.path_var = tk.StringVar(value=DEFAULT_PUZZLES_PATH)
        ttk.Entry(top, textvariable=self.path_var, width=80).pack(side="left", padx=6)
        ttk.Button(top, text="Browse…", command=self.choose_path).pack(side="left", padx=4)
        ttk.Button(top, text="Open File", command=self.open_file).pack(side="left", padx=4)

        row2 = ttk.Frame(self); row2.pack(fill="x", padx=10, pady=4)
        ttk.Label(row2, text="Seeded greens (K):").pack(side="left")
        self.seed_var = tk.StringVar(value="")
        ttk.Entry(row2, textvariable=self.seed_var, width=6).pack(side="left", padx=6)
        ttk.Label(row2, text="(blank = use default 3)").pack(side="left")

        # Main panes
        paned = ttk.PanedWindow(self, orient="horizontal"); paned.pack(fill="both", expand=True, padx=10, pady=10)
        left = ttk.Frame(paned); right = ttk.Frame(paned)
        paned.add(left, weight=3); paned.add(right, weight=2)

        ttk.Label(left, text="Paste puzzle block:").pack(anchor="w")
        self.text = tk.Text(left, wrap="word", font=("Consolas", 11))
        self.text.pack(fill="both", expand=True)
        self.text.insert("1.0", TEMPLATE)

        # Right side tabs
        self.tabs = ttk.Notebook(right); self.tabs.pack(fill="both", expand=True)
        prev = ttk.Frame(self.tabs); self.tabs.add(prev, text="Preview")
        self.tree = ttk.Treeview(prev, columns=("value",), show="tree headings", height=8)
        self.tree.heading("#0", text="Field"); self.tree.heading("value", text="Value")
        self.tree.column("#0", width=220, anchor="w"); self.tree.column("value", width=360, anchor="w")
        self.tree.pack(fill="x", padx=6, pady=6)

        ttk.Label(prev, text="Theme Preview:").pack(anchor="w", padx=6)
        self.theme_preview = tk.Text(prev, wrap="word", font=("Segoe UI", 10), height=12, state="disabled")
        self.theme_preview.pack(fill="both", expand=True, padx=6, pady=(0,6))

        val = ttk.Frame(self.tabs); self.tabs.add(val, text="Validation")
        self.val_text = tk.Text(val, wrap="word", font=("Consolas", 10), state="disabled")
        self.val_text.pack(fill="both", expand=True, padx=6, pady=6)

        btns = ttk.Frame(self); btns.pack(fill="x", padx=10, pady=8)
        ttk.Button(btns, text="Validate & Preview", command=self.on_validate).pack(side="left")
        ttk.Button(btns, text="Append to puzzles.json", command=self.on_append).pack(side="left", padx=8)
        ttk.Button(btns, text="Exit", command=self.destroy).pack(side="right")

        status = ttk.Frame(self); status.pack(fill="x", side="bottom")
        self.status_var = tk.StringVar(value="Ready.")
        ttk.Label(status, textvariable=self.status_var, relief="sunken", anchor="w").pack(fill="x", side="left", expand=True)
        self.prog = ttk.Progressbar(status, mode="indeterminate", length=180)
        self.prog.pack(side="right")

    def choose_path(self):
        initial = os.path.dirname(self.path_var.get()) or os.getcwd()
        path = filedialog.asksaveasfilename(
            initialdir=initial,
            initialfile=os.path.basename(self.path_var.get()),
            title="Select puzzles.json",
            defaultextension=".json",
            filetypes=[("JSON Files","*.json"),("All Files","*.*")]
        )
        if path: self.path_var.set(path)

    def open_file(self):
        path = self.path_var.get()
        if not os.path.exists(path):
            messagebox.showwarning("File not found", f"{path}\ndoes not exist yet.")
            return
        try:
            os.startfile(path)
        except Exception:
            webbrowser.open(f"file:///{path}")

    def set_validation_text(self, text: str):
        self.val_text.configure(state="normal")
        self.val_text.delete("1.0", "end")
        self.val_text.insert("1.0", text)
        self.val_text.configure(state="disabled")

    def update_preview(self, parsed: ParsedBlock):
        for item in self.tree.get_children():
            self.tree.delete(item)
        self.tree.insert("", "end", text="Phrase", values=(parsed.phrase,), iid="phrase")
        self.tree.insert("", "end", text="Grid Width", values=(parsed.width,), iid="width")
        self.tree.insert("", "end", text="Grid Height", values=(parsed.height,), iid="height")
        words_id = self.tree.insert("", "end", text=f"Words ({len(parsed.words)})", values=("",), iid="words")
        for i, w in enumerate(parsed.words, start=1):
            self.tree.insert(words_id, "end", text=f"{i}. {w.dir} row={w.row} col={w.col}", values=(w.text,))
        self.theme_preview.configure(state="normal")
        self.theme_preview.delete("1.0", "end")
        self.theme_preview.insert("1.0", parsed.theme)
        self.theme_preview.configure(state="disabled")

    def on_validate(self):
        try:
            block = parse_block(self.text.get("1.0", "end").strip())
            norm = normalize_letters(block.phrase)
            grid_letters = sum(len(w.text) for w in block.words)
            report = [
                "VALID ✅",
                "",
                f"Display phrase: {block.phrase}",
                f"Normalized letters (A–Z only): {norm}",
                f"Letters in phrase (normalized): {len(norm)}",
                f"Letters in grid words: {grid_letters}",
                f"Grid size: {block.width} × {block.height}",
                f"Words: {len(block.words)}",
                "",
                "Tip: counts must match exactly.",
            ]
            if len(norm) != grid_letters:
                report.append("⚠️ Mismatch: grid letters must equal normalized phrase letters.")
            self.set_validation_text("\n".join(report))
            self.update_preview(block)
            self.status_var.set("Validation OK.")
        except Exception as e:
            self.set_validation_text(f"ERROR ❌\n\n{e}")
            self.status_var.set("Validation failed.")

    def on_append(self):
        try:
            block = parse_block(self.text.get("1.0", "end").strip())
        except Exception as e:
            messagebox.showerror("Invalid input", str(e)); return

        puzzles_path = self.path_var.get().strip()
        seed_txt = self.seed_var.get().strip()
        seeded = None
        if seed_txt:
            try:
                seeded = int(seed_txt)
                if seeded < 0: raise ValueError
            except ValueError:
                messagebox.showerror("Seeded greens", "Seeded greens (K) must be a non-negative integer or blank.")
                return

        try:
            puzzle = build_puzzle_object(
                phrase=block.phrase,
                theme=block.theme,
                grid=GridSpec(width=block.width, height=block.height),
                words=block.words,
                seeded_greens=seeded
            )
        except Exception as e:
            messagebox.showerror("Validation error", str(e))
            return

        self.prog.start(16); self.status_var.set("Writing…")
        self.after(50, lambda: self._finish_append(puzzles_path, puzzle))

    def _finish_append(self, puzzles_path: str, puzzle: Dict[str, Any]):
        try:
            action = append_or_overwrite(puzzles_path, puzzle)
            if action == "cancelled":
                self.prog.stop(); self.status_var.set("Cancelled by user (duplicate).")
                return
            messagebox.showinfo("Success", f"{action.title()}.\n\npuzzles.json:\n{os.path.abspath(puzzles_path)}")
            self.status_var.set(f"{action.title()} to {os.path.abspath(puzzles_path)}")
        except Exception as e:
            messagebox.showerror("Error", str(e))
            self.status_var.set("Append failed.")
        finally:
            self.prog.stop()

# ---------------- Entry ----------------

def main():
    app = App()
    app.mainloop()

if __name__ == "__main__":
    main()
