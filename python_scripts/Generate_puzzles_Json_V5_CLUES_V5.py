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
import hashlib
from tkinter import ttk, messagebox, filedialog
from dataclasses import dataclass
from typing import List, Tuple, Dict, Any, Optional

# ---------------- Defaults ----------------

DEFAULT_PUZZLES_PATH = r"C:\Alloquest_Photos\panama-v2\public\puzzles.json"

TEMPLATE = """PHRASE: "It's deja vu all over again."
WIDTH: 7
HEIGHT: 6

WORDS:
  H row=2 col=0 word=ANGLERS
  H row=4 col=0 word=VIVALDI
  V row=0 col=1 word=JUNKIE
  V row=0 col=3 word=ITALIA
  V row=0 col=5 word=LAREDO

CLUES:
  Fisherfolk
  "Four Seasons" composer
  Addicted person
  European country in Italian
  Texas border city

THEME:
This phrase is one of Yogi’s Yogi-isms...
Add as many paragraphs as you like.
"""

# ---------------- Data classes ----------------

@dataclass
class WordSpec:
    text: str
    dir: str  # 'H' or 'V'
    row: int
    col: int
    clue: str = ""

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
    m_clues_start = re.search(r"^CLUES:\s*$", src, re.MULTILINE)
    m_theme_start = re.search(r"^THEME:\s*$", src, re.MULTILINE)
    if not m_words_start or not m_clues_start or not m_theme_start:
        raise ValueError("Missing WORDS:, CLUES:, or THEME: section")

    words_section = src[m_words_start.end(): m_clues_start.start()]
    clues_section = src[m_clues_start.end(): m_theme_start.start()]
    word_specs: List[WordSpec] = []
    for ln in words_section.splitlines():
        ln = ln.strip()
        if not ln: continue
        m = re.match(r"^(H|V)\s+row=(\d+)\s+col=(\d+)\s+word=([A-Za-z]+)$", ln)
        if not m:
            raise ValueError(f"Bad WORDS line: {ln}")
        d,row,col,wtext = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4).upper()
        word_specs.append(WordSpec(text=wtext, dir=d, row=row, col=col))

    # Support NEW labeled clues ("WORD: clue") and fallback to OLD unlabeled list
    clue_map = {}     # NEW format bucket
    clues_list = []   # OLD format bucket

    for ln in clues_section.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        m = re.match(r"^([A-Za-z]+)\s*:\s*(.+)$", ln)  # WORD: clue
        if m:
            wtxt = m.group(1).upper()
            clue = m.group(2).strip()
            if wtxt in clue_map:
                raise ValueError(f"Duplicate labeled clue for word '{wtxt}'.")
            clue_map[wtxt] = clue
        else:
            # Treat as an unlabeled line (OLD behavior)
            clues_list.append(ln)

    if clue_map:
        # NEW format in use: verify 1:1 coverage with WORDS and no extras
        words_in_grid = {w.text.upper() for w in word_specs}
        missing = [w.text for w in word_specs if w.text.upper() not in clue_map]
        extras  = [k for k in clue_map.keys() if k not in words_in_grid]
        if missing:
            raise ValueError("Missing labeled clues for: " + ", ".join(missing))
        if extras:
            raise ValueError("Unknown word(s) in CLUES: " + ", ".join(extras))
        # Assign by name, not position
        for w in word_specs:
            w.clue = clue_map[w.text.upper()]
    else:
        # OLD format fallback: must match count and assign by position
        if len(clues_list) != len(word_specs):
            raise ValueError(f"CLUES count ({len(clues_list)}) must match WORDS count ({len(word_specs)})")
        for i, w in enumerate(word_specs):
            w.clue = clues_list[i]

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
    max_attempts: int = 400
) -> Tuple[List[int], List[int]]:
    """
    Purely random scramble subject to:
      - exactly k_correct 'green' locations by LETTER
      - all other locations are wrong by LETTER
    No Hungarian is used here. We:
      1) Randomly choose K seed locations and lock matching letters there (by letter, tiles are fungible).
      2) Randomly assign remaining tiles to remaining locations and repair any accidental matches
         via swaps/3-cycles. If repair fails, reshuffle and retry.

    Returns:
      - scramble[t-1] = assigned location for tile t (1..N)
      - correct_positions = the seed locations (sorted) (1..N)
    """
    N = len(target_for_tile)
    if k_correct < 0 or k_correct > N:
        raise ValueError("k_correct out of range")

    # Helper: required letter at each location (1..N) in the SOLVED state
    # Using tile->target mapping, but letters are fungible by value.
    req_letter_at_loc: Dict[int, str] = {}
    for t in range(1, N+1):
        loc = target_for_tile[t-1]    # cell index 1..N
        req_letter_at_loc[loc] = phrase_letters[t-1]

    indices = list(range(1, N+1))
    rnd = random

    # Build letter→tiles pool (which tiles carry letter L?)
    tiles_by_letter: Dict[str, List[int]] = {}
    for t in range(1, N+1):
        L = phrase_letters[t-1]
        tiles_by_letter.setdefault(L, []).append(t)

    for _ in range(max_attempts):
        # Copy pools we can mutate this attempt
        pool = {L: lst[:] for L, lst in tiles_by_letter.items()}
        # 1) Randomly choose K seed locations
        seeds = set(rnd.sample(indices, k_correct)) if k_correct > 0 else set()

        # 2) Assign seeds with correct letters
        scramble = [0] * N  # tile -> location
        used_tiles = set()
        ok = True
        for loc in seeds:
            need = req_letter_at_loc[loc]
            avail = pool.get(need, [])
            if not avail:
                ok = False
                break
            t = avail.pop()           # take any tile with that letter
            used_tiles.add(t)
            scramble[t-1] = loc
        if not ok:
            # Not enough tiles to satisfy chosen seeds (rare with duplicates); retry fresh seeds
            continue

        # 3) Prepare remaining tiles/locations
        remain_tiles = [t for t in range(1, N+1) if t not in used_tiles]
        remain_locs  = [loc for loc in indices if loc not in seeds]
        if not remain_tiles:
            # Everything is seeded (k_correct == N)
            greens = sorted(seeds)
            return scramble, greens

        # Fast lookup helpers
        def t_letter(ti: int) -> str:
            return phrase_letters[ti-1]

        def repair_derangement(order_tiles: List[int], locs: List[int]) -> Optional[List[int]]:
            """
            Given equal-length lists:
              order_tiles: tiles to place (permutation of remain_tiles)
              locs:       target locations for those slots (remain_locs)
            Try to ensure t_letter(order_tiles[i]) != req_letter_at_loc[locs[i]] for all i
            by swapping / 3-cycling. Return a valid order or None.
            """
            m = len(locs)
            # Build conflict set
            def conflicts_for(order):
                return [i for i in range(m) if t_letter(order[i]) == req_letter_at_loc[locs[i]]]

            # Attempt limited number of local repairs
            for _ in range(64):
                bad = conflicts_for(order_tiles)
                if not bad:
                    return order_tiles
                # Try to resolve conflicts by swapping pairs first
                progressed = False
                for i in bad:
                    Li = t_letter(order_tiles[i]); Ri = req_letter_at_loc[locs[i]]
                    for j in range(m):
                        if i == j: continue
                        Lj = t_letter(order_tiles[j]); Rj = req_letter_at_loc[locs[j]]
                        # Swap if it fixes both i and j simultaneously
                        if (Lj != Ri) and (Li != Rj):
                            order_tiles[i], order_tiles[j] = order_tiles[j], order_tiles[i]
                            progressed = True
                            break
                    if progressed:
                        break
                if progressed:
                    continue
                # If pairwise swap didn't work, try a 3-cycle to break deadlocks
                # Find i (conflict), pick j,k distinct where rotation resolves i
                for i in bad:
                    Ri = req_letter_at_loc[locs[i]]
                    for j in range(m):
                        if j == i: continue
                        for k in range(m):
                            if k == i or k == j: continue
                            a, b, c = order_tiles[i], order_tiles[j], order_tiles[k]
                            # Try rotation i<-j<-k<-i (a<-b<-c)
                            if (t_letter(b) != Ri and
                                t_letter(c) != req_letter_at_loc[locs[j]] and
                                t_letter(a) != req_letter_at_loc[locs[k]]):
                                order_tiles[i], order_tiles[j], order_tiles[k] = b, c, a
                                progressed = True
                                break
                        if progressed: break
                    if progressed: break
                if not progressed:
                    # Give up on local repair; caller will reshuffle
                    return None
            return None

        # 4) Randomly assign remaining tiles to remaining locations and repair if needed
        success = False
        for _try in range(128):
            order = remain_tiles[:]
            rnd.shuffle(order)
            fixed = repair_derangement(order, remain_locs)
            if fixed is None:
                continue
            # Fill scramble
            for idx, loc in enumerate(remain_locs):
                t = fixed[idx]
                scramble[t-1] = loc
            # Sanity check: exactly K greens
            greens = []
            for loc in indices:
                # tile currently at loc:
                t_here = next(tt for tt in range(1, N+1) if scramble[tt-1] == loc)
                if t_letter(t_here) == req_letter_at_loc[loc]:
                    greens.append(loc)
            if len(greens) == k_correct and set(greens) == seeds:
                return scramble, sorted(greens)
        # Could not make it this attempt with these seeds; try new seeds
        continue

    raise RuntimeError("Could not build random scramble with exactly K seeded greens; try again or adjust K.")


# ---------------- Min moves via Hungarian + cycles ----------------

def calculate_min_moves(scramble: List[int], phrase_letters: str, target_for_tile: List[int]) -> int:
    """
    EXACT minimum # of swaps to make every location's LETTER correct.
    Tiles are letter-fungible (duplicates allowed). Operation is any two-tile swap.

    Method (location model matches the app/top ribbon):
      1) Work only on M = {loc | current_letter(loc) != required_letter(loc)}.
      2) Allowed edge a→b iff the letter currently at 'a' equals the required letter at 'b'.
      3) Find a *cycle cover* on M that maximizes the number of cycles (deterministic DFS with pruning).
      4) Swaps = |M| − (#cycles in that cover).
    """
    from typing import Dict, List, Set

    N = len(phrase_letters)
    if N == 0:
        return 0

    # Required letter at each location 'loc' (1..N), via tile->target mapping
    # target_for_tile[t-1] = solved location for tile t
    # Find tile that belongs at 'loc' and read its letter.
    req_letter_at_loc: Dict[int, str] = {}
    # Build inverse map: solved_loc -> tile
    tile_for_solved_loc = [0] * (N + 1)
    for t in range(1, N + 1):
        loc = target_for_tile[t - 1]
        tile_for_solved_loc[loc] = t
    for loc in range(1, N + 1):
        t_req = tile_for_solved_loc[loc]
        req_letter_at_loc[loc] = phrase_letters[t_req - 1]

    # Current letter at each location from the scramble (tile t sits at loc = scramble[t-1])
    tile_at_location = [0] * (N + 1)  # 1..N -> tile id
    for t in range(1, N + 1):
        loc = scramble[t - 1]
        tile_at_location[loc] = t
    cur_letter_at_loc: Dict[int, str] = {loc: phrase_letters[tile_at_location[loc] - 1] for loc in range(1, N + 1)}

    # Mismatch set (greens excluded)
    mismatch_locs: List[int] = [loc for loc in range(1, N + 1) if cur_letter_at_loc[loc] != req_letter_at_loc[loc]]
    m = len(mismatch_locs)
    if m == 0:
        return 0

    # Allowed edges a -> b iff letter at 'a' equals required letter at 'b'
    req_by = {loc: req_letter_at_loc[loc] for loc in mismatch_locs}
    cur_by = {loc: cur_letter_at_loc[loc] for loc in mismatch_locs}
    allowed: Dict[int, List[int]] = {a: [b for b in mismatch_locs if req_by[b] == cur_by[a]] for a in mismatch_locs}

    # Degree-ordered nodes (smallest branching first) to keep DFS tiny in practice
    nodes: List[int] = sorted(mismatch_locs, key=lambda a: (len(allowed[a]), a))

    used_targets: Set[int] = set()
    current_map: Dict[int, int] = {}
    best_cycles = -1
    best_map: Dict[int, int] = {}

    # Fast starvation check: if any remaining node has no available targets, prune
    def has_starvation(from_k: int) -> bool:
        for a2 in nodes[from_k:]:
            if any(b not in used_targets for b in allowed[a2]):
                continue
            return True
        return False

    def dfs(k: int) -> None:
        nonlocal best_cycles, best_map
        if k == len(nodes):
            # Count cycles in current_map over M
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
                    cur = current_map[cur]
                if clen > 0:
                    cycles += 1
            if cycles > best_cycles:
                best_cycles = cycles
                best_map = dict(current_map)
            return

        a = nodes[k]
        options = [b for b in allowed[a] if b not in used_targets]
        if not options:
            return

        # Prefer reciprocal-friendly and scarce targets
        def score(b: int):
            recip = a in allowed.get(b, ())
            deg_b = len(allowed.get(b, ()))
            return (0 if recip else 1, deg_b, b)
        options.sort(key=score)

        for b in options:
            used_targets.add(b)
            current_map[a] = b
            if not has_starvation(k + 1):
                dfs(k + 1)
            used_targets.remove(b)
            del current_map[a]

    dfs(0)

    # Safety: if something went wrong (shouldn’t), fall back to zero cycles
    if best_cycles < 0:
        best_cycles = 0

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

    # SAFETY CHECK: seeded greens must match actual greens-by-letter from this scramble.
    # Required letter at Location i is phrase_letters[i-1]; current letter is phrase_letters[tile_at_loc[i]-1].
    tile_at_loc = [0] * (N + 1)
    for t in range(1, N + 1):
        loc = scramble_spec[t - 1]
        tile_at_loc[loc] = t
    greens_actual = sorted(i for i in range(1, N + 1) if phrase_letters[tile_at_loc[i] - 1] == phrase_letters[i - 1])
    if greens_actual != correct_positions_spec:
        raise RuntimeError(
            f"Safety check failed: seeded greens {correct_positions_spec} "
            f"!= actual greens-by-letter {greens_actual}. Regenerate and retry."
        )

    # Compute min_moves using the spec numbering
    min_moves = calculate_min_moves(scramble_spec, phrase_letters, target_spec)

    # Compute deterministic clue order (1..n) from normalized phrase hash
    n_words = len(words)
    rng_seed = int(hashlib.sha256(phrase_letters.encode("utf-8")).hexdigest(), 16) & ((1<<64)-1)
    rng = random.Random(rng_seed)
    clue_order = list(range(1, n_words+1))
    rng.shuffle(clue_order)

    # Emit JSON in spec numbering
    return {
        "phrase": phrase,
        "theme_info": theme.strip(),
        "clue_order": clue_order,
        "grid": {"width": grid.width, "height": grid.height},
        "words": [{"text": w.text.upper(), "dir": w.dir.upper(), "row": int(w.row), "col": int(w.col), "clue": str(w.clue)} for w in words],
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
            self.tree.insert(words_id, "end", text=f"{i}. {w.dir} row={w.row} col={w.col}", values=(f"{w.text}  —  {w.clue}",))
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
