# word_grid_solver_general_V9.py
# Grid-ranked solver for 5- & 6-word symmetric layouts with row/col purity and no-adjacent words.
# Families: 5-word -> {3H2V,2H3V,1H4V}; 6-word -> {3H3V,2H4V}; exclude plain rectangle.
# Ranks grids by duplicate squares (overlap cells), solves top-K, ensures unique grids & unique solutions.

import argparse
import os
import time
from collections import Counter, defaultdict, deque
from itertools import combinations, product
import random
from datetime import datetime
import unicodedata

# -----------------------------
# Config (edit as needed)
# -----------------------------
DEFAULT_DICT_PATH = r"C:\Alloquest_Photos\Word_Game\my-word-game\tools\latest_4.txt"
OUTPUT_DIR = "./solver_outputs"
DEFAULT_MAX_GRIDS = 50
DEFAULT_SOLUTIONS_PER_GRID = 5
PER_GRID_TIME_LIMIT = 5         # seconds per grid (soft cap for search)
DEFAULT_MIN_INTERSECTIONS = 0     # total crossing cells threshold; 0 = no extra filter
HEARTBEAT_SEC = 1.0               # progress ping unless --quiet

# -----------------------------
# Basic helpers
# -----------------------------
def clean_phrase(p: str) -> str:
    """
    Normalize accents to base ASCII letters and keep only A–Z.
    Uses length-preserving single-letter fallbacks for special Latin letters
    to avoid changing the total letter count (important for grid sizing).
    Examples: é→E, ñ→N, ø→O, æ→E, œ→E, ß→S, ł→L, þ→T.
    """
    # 1) Decompose accents (é -> e + ́), then drop combining marks
    norm = unicodedata.normalize("NFKD", p)
    no_marks = "".join(ch for ch in norm if not unicodedata.combining(ch))

    # 2) Map special letters that are not just "base + accent" to a single ASCII letter
    #    (length-preserving so phrase length stays stable)
    single_letter_map = {
        "ß": "S", "ẞ": "S",
        "Æ": "E", "æ": "e",
        "Œ": "E", "œ": "e",
        "Ø": "O", "ø": "o",
        "Ð": "D", "ð": "d",
        "Þ": "T", "þ": "t",
        "Ł": "L", "ł": "l",
        "Å": "A", "å": "a",
    }
    mapped = "".join(single_letter_map.get(ch, ch) for ch in no_marks)

    # 3) Uppercase, then keep only A–Z
    upper = mapped.upper()
    return "".join(ch for ch in upper if "A" <= ch <= "Z")

def load_dictionary(path: str, min_rating: int):
    """
    Load dictionary entries supporting two formats per line:
      - "RATING<TAB>entry"  (e.g., "9\tzoomers")
      - "entry"             (legacy; treated as unrated)
    Apply clean_phrase(entry), keep only cleaned length in [4..7].
    Include if (unrated) OR (rating >= min_rating).
    Deduplicate by cleaned word, keeping the highest rating seen.
    """
    # Stats for a friendly summary
    total_lines = 0
    parsed_rated = 0
    parsed_unrated = 0
    kept_rated_ge_min = 0
    kept_unrated = 0

    # Temporary map: cleaned_word -> highest_rating_or_None
    best_by_cleaned = {}

    def consider_entry(line: str):
        nonlocal parsed_rated, parsed_unrated, kept_rated_ge_min, kept_unrated
        line = line.strip()
        if not line:
            return
        rating = None
        entry = line

        # Try to parse "RATING<TAB>entry"
        if "\t" in line:
            left, right = line.split("\t", 1)
            left_stripped = left.strip()
            if left_stripped.isdigit():
                r = int(left_stripped)
                if 1 <= r <= 10:
                    rating = r
                    entry = right

        if rating is None:
            parsed_unrated += 1
        else:
            parsed_rated += 1

        cleaned = clean_phrase(entry)
        if not cleaned:
            return
        L = len(cleaned)
        # Keep only 4..7 letter words for this solver
        if L < 4 or L > 7:
            return

        # Inclusion rule
        include = (rating is None) or (rating >= min_rating)
        if not include:
            return

        # Deduplicate by keeping the highest rating
        if cleaned not in best_by_cleaned:
            best_by_cleaned[cleaned] = rating
        else:
            prev = best_by_cleaned[cleaned]
            if prev is None:
                # if previously unrated, replace if we now have a numeric rating
                if rating is not None:
                    best_by_cleaned[cleaned] = rating
            else:
                # both numeric: keep the maximum
                if rating is not None and rating > prev:
                    best_by_cleaned[cleaned] = rating

        # Count keeps
        if rating is None:
            kept_unrated += 1
        else:
            kept_rated_ge_min += 1

    by_len = defaultdict(list)
    try:
        with open(path, "r", encoding="utf-8") as f:
            for raw in f:
                total_lines += 1
                consider_entry(raw)
    except FileNotFoundError:
        print(f"[WARN] Dictionary not found at {path}. Using tiny fallback.")
        # Fallback pool (will also be trimmed by 4..7 rule)
        for w in ["TITLE","TENET","LEVEL","LILITH","DENIES","GUSTY","GUTSY","TATTY","ANYHOW","ANYHOO","WANT","WANTS"]:
            c = clean_phrase(w)
            if 4 <= len(c) <= 7:
                best_by_cleaned[c] = None

    # Build by_len buckets
    for w_cleaned in best_by_cleaned.keys():
        by_len[len(w_cleaned)].append(w_cleaned)

    # Summary
    unique_count = len(best_by_cleaned)
    kept_total = sum(len(v) for v in by_len.values())
    print(
        f"Dictionary load: read {total_lines} lines → kept {kept_total} entries "
        f"({unique_count} unique by cleaned form; "
        f"unrated kept={kept_unrated}; rated≥{min_rating} kept={kept_rated_ge_min}; "
        f"parsed unrated={parsed_unrated}; parsed rated={parsed_rated})"
    )

    return by_len

def nonadjacent(indices):
    s = sorted(indices)
    return all(s[i+1] - s[i] >= 2 for i in range(len(s)-1))

def symmetric_vertical_units(w):
    # vertical choices grouped into mirror units (+ center for odd widths)
    if w == 4:  return [(0,3)]
    if w == 5:  return [(0,4),(1,3),2]
    if w == 6:  return [(0,5),(1,4)]
    if w == 7:  return [(0,6),(1,5),(2,4),3]
    return []

def expand_units_to_cols(choice):
    cols = set()
    for u in choice:
        if isinstance(u, tuple): cols.update(u)
        else: cols.add(u)
    return tuple(sorted(cols))

def vertical_segment_options(h):
    # contiguous down length in [4..h], at any start
    return [(s, L) for L in range(4, h+1) for s in range(0, h-L+1)]

def horizontal_lengths_allowed(w):
    # centered spans to preserve L-R symmetry; parity must match width
    if w % 2 == 0:
        return [L for L in range(4, w+1) if L % 2 == 0]
    else:
        return [L for L in range(5, w+1) if L % 2 == 1]

def horizontal_segment_for_width(w, L):
    start = (w - L) // 2
    end = start + L - 1
    return start, end

def grid_id_from(mask, w, h, nH, nV):
    key = tuple(tuple(r) for r in mask)
    import zlib, pickle
    hsh = zlib.crc32(pickle.dumps(key)) & 0xFFFFFFFF
    return f"W{w}H{h}-{nH}H{nV}V-{hsh:08X}"

# -----------------------------
# Build slots & intersections
# -----------------------------
def build_slots_and_intersections(w,h, h_rows_with_len, v_cols_with_seg):
    slots = []
    # Across
    for r,Lh in sorted(h_rows_with_len):
        cs, ce = horizontal_segment_for_width(w, Lh)
        cells = [(r,c) for c in range(cs, ce+1)]
        slots.append({"id": f"H@R{r}:C{cs}-{ce}", "orient":"H", "length": len(cells), "cells": cells})
    # Down
    for c,(s,L) in sorted(v_cols_with_seg.items()):
        cells = [(r,c) for r in range(s, s+L)]
        slots.append({"id": f"V@C{c}:R{s}-{s+L-1}", "orient":"V", "length": len(cells), "cells": cells})
    # Intersections
    inter = []
    for i in range(len(slots)):
        a = slots[i]; ai = {cell:k for k,cell in enumerate(a["cells"])}
        for j in range(i+1, len(slots)):
            b = slots[j]
            for k,cell in enumerate(b["cells"]):
                if cell in ai:
                    inter.append({"slot_a": a["id"], "pos_a": ai[cell],
                                  "slot_b": b["id"], "pos_b": k, "cell": cell})
    return slots, inter

# -----------------------------
# Structural validators
# -----------------------------
def connected(mask):
    h = len(mask); w = len(mask[0])
    cells = [(r,c) for r in range(h) for c in range(w) if mask[r][c]==1]
    if not cells: return False
    seen=set(); dq=deque([cells[0]]); seen.add(cells[0])
    while dq:
        r,c=dq.popleft()
        for dr,dc in ((1,0),(-1,0),(0,1),(0,-1)):
            nr, nc = r+dr, c+dc
            if 0<=nr<h and 0<=nc<w and mask[nr][nc]==1 and (nr,nc) not in seen:
                seen.add((nr,nc)); dq.append((nr,nc))
    return len(seen)==len(cells)

def is_plain_rectangle(w,h,h_rows_with_len, v_cols_with_seg):
    top_full = any((r==0 and Lh==w) for (r,Lh) in h_rows_with_len)
    bot_full = any((r==h-1 and Lh==w) for (r,Lh) in h_rows_with_len)
    left_full  = (0 in v_cols_with_seg) and v_cols_with_seg[0] == (0,h)
    right_full = (w-1 in v_cols_with_seg) and v_cols_with_seg[w-1] == (0,h)
    return top_full and bot_full and left_full and right_full

def slot_purity_ok(h_rows_with_len, v_cols_with_seg, w):
    """
    Enforce BOTH purities:
      - Across row purity: On a row r with across span [cs..ce], there must be no filled cells
        outside [cs..ce] on that row.
      - Down column purity: On a column c with down span [s..e], there must be no filled cells
        outside [s..e] in that column.
    Implemented by checking H x V consistency both when c is inside [cs..ce] and when it is outside.
    """
    if not h_rows_with_len and not v_cols_with_seg:
        return False

    # Precompute row spans for across
    row_to_span = {}
    for (r, Lh) in h_rows_with_len:
        cs, ce = horizontal_segment_for_width(w, Lh)
        row_to_span[r] = (cs, ce)

    # Check every (r,c) where one orientation exists implies the other respects purity
    for c,(s,L) in v_cols_with_seg.items():
        e = s + L - 1
        for r,(cs,ce) in row_to_span.items():
            if cs <= c <= ce:
                # crossing allowed, but only if row r is within vertical span
                if not (s <= r <= e):
                    return False
            else:
                # vertical cannot place a filled cell on this H-row outside the across span
                if s <= r <= e:
                    return False

    # Also ensure that for vertical purity: if a row r is outside [s..e], the across must not cover c
    # (already implied by the else-branch above), and for across purity: if c inside [cs..ce], we enforced s<=r<=e.
    return True

# -----------------------------
# Layout enumeration
# -----------------------------
def enumerate_layouts(min_intersections=DEFAULT_MIN_INTERSECTIONS, total_words=5):
    """
    Enumerate valid symmetric layouts.
      total_words==5 -> {(3,2), (2,3), (1,4)}    # exclude 4H1V
      total_words==6 -> {(3,3), (2,4)}           # exclude 4H2V, 1H5V
    Constraints:
      - Left-right symmetry
      - Row & Column purity (as above)
      - No adjacent across rows; No adjacent down columns
      - Connectivity of union of slots
      - Exclude plain rectangle frame
      - min_intersections: minimum total crossing cells (0 by default)
    """
    if total_words == 5:
        allowed_fams = {(3,2), (2,3), (1,4)}
    elif total_words == 6:
        allowed_fams = {(3,3), (2,4)}
    else:
        raise ValueError("total_words must be 5 or 6")

    layouts = []
    for w in (4,5,6,7):
        for h in (4,5,6):
            units = symmetric_vertical_units(w)
            if not units:
                continue
            v_opts = vertical_segment_options(h)
            h_lens = horizontal_lengths_allowed(w)

            for (nH,nV) in allowed_fams:
                if nH > h:  # can't place more across rows than rows
                    continue

                # choose H rows (nonadjacent)
                hrow_sets = [rows for rows in combinations(range(h), nH) if nonadjacent(rows)]
                if not hrow_sets:
                    continue

                # choose V unit subsets producing exactly nV columns (nonadjacent)
                unit_subsets = []
                if nV > 0:
                    for k in range(1, len(units)+1):
                        for choice in combinations(units, k):
                            cols = expand_units_to_cols(choice)
                            if len(cols) != nV:
                                continue
                            if not nonadjacent(cols):
                                continue
                            unit_subsets.append(choice)
                    if not unit_subsets:
                        continue
                else:
                    unit_subsets = [()]

                # assign across lengths (centered, parity-correct)
                h_len_combos = list(product(h_lens, repeat=nH)) if nH > 0 else [()]

                for rows in hrow_sets:
                    for Ls in h_len_combos:
                        h_rows_with_len = list(zip(rows, Ls))

                        for v_choice in unit_subsets:
                            if nV == 0:
                                v_cols_with_seg = {}
                            else:
                                v_cols_with_seg = {}
                                for segs in product(v_opts, repeat=len(v_choice)):
                                    v_cols_with_seg = {}
                                    ok = True
                                    for u, seg in zip(v_choice, segs):
                                        s,L = seg
                                        if isinstance(u, tuple):
                                            for c in u:
                                                v_cols_with_seg[c] = (s,L)
                                        else:
                                            v_cols_with_seg[u] = (s,L)
                                    # slot-purity (both across & down)
                                    if not slot_purity_ok(h_rows_with_len, v_cols_with_seg, w):
                                        ok = False
                                    if not ok:
                                        continue

                                    # Build mask (union of slots)
                                    mask = [[0]*w for _ in range(h)]
                                    for (r,Lh) in h_rows_with_len:
                                        cs,ce = horizontal_segment_for_width(w, Lh)
                                        for c in range(cs,ce+1):
                                            mask[r][c] = 1
                                    for c,(s,L) in v_cols_with_seg.items():
                                        for r in range(s, s+L):
                                            mask[r][c] = 1

                                    if not connected(mask):
                                        continue
                                    if is_plain_rectangle(w,h,h_rows_with_len,v_cols_with_seg):
                                        continue

                                    slots, inter = build_slots_and_intersections(w,h,h_rows_with_len, v_cols_with_seg)
                                    if len(inter) < min_intersections:
                                        continue

                                    layouts.append((w,h,nH,nV,h_rows_with_len,dict(v_cols_with_seg),mask,
                                                    sum(sum(r) for r in mask),slots,inter))
                                continue  # end v_choice expansion

                            # nV == 0 (pure across case) – still enforce connectivity & others
                            mask = [[0]*w for _ in range(h)]
                            for (r,Lh) in h_rows_with_len:
                                cs,ce = horizontal_segment_for_width(w, Lh)
                                for c in range(cs,ce+1):
                                    mask[r][c] = 1
                            if not connected(mask):
                                continue
                            if is_plain_rectangle(w,h,h_rows_with_len,{}):
                                continue
                            slots, inter = build_slots_and_intersections(w,h,h_rows_with_len, {})
                            if len(inter) < min_intersections:
                                continue
                            layouts.append((w,h,nH,nV,h_rows_with_len,{},mask,sum(sum(r) for r in mask),slots,inter))

    # dedupe by mask
    seen = set(); uniq = []
    for lay in layouts:
        key = tuple(tuple(r) for r in lay[6])
        if key in seen:
            continue
        seen.add(key); uniq.append(lay)
    return uniq

# -----------------------------
# Candidate generation
# -----------------------------
def prefilter_candidates(words_by_len, slots, budget: Counter):
    cand = {}
    for s in slots:
        L = s["length"]
        pool = words_by_len.get(L, [])
        ok=[]
        for w in pool:
            cw = Counter(w)
            if all(cw[ch] <= budget[ch] for ch in cw):
                ok.append(w)
        cand[s["id"]] = ok
    return cand

def order_slots(slots, cand, intersections):
    inter_count = defaultdict(int)
    for x in intersections:
        inter_count[x["slot_a"]] += 1
        inter_count[x["slot_b"]] += 1
    return sorted(slots, key=lambda s: (len(cand[s["id"]]), -inter_count[s["id"]], s["length"]))

# -----------------------------
# Equivalence classes (dedupe)
# -----------------------------
def slot_equivalence_classes(slots, intersections):
    by_id = {s["id"]: s for s in slots}
    patterns = {}
    for s in slots:
        touches=[]
        for x in intersections:
            if x["slot_a"] == s["id"]:
                o = by_id[x["slot_b"]]
                touches.append( (o["orient"], o["length"], x["pos_a"]) )
            elif x["slot_b"] == s["id"]:
                o = by_id[x["slot_a"]]
                touches.append( (o["orient"], o["length"], x["pos_b"]) )
        patterns[s["id"]] = (s["orient"], s["length"], tuple(sorted(touches)))
    groups = defaultdict(list)
    for sid, pat in patterns.items():
        groups[pat].append(sid)
    eq_classes = []
    for pat, ids in groups.items():
        eq_classes.append( (pat, sorted(ids)) )
    eq_classes.sort(key=lambda x: (x[0][0], x[0][1], x[0][2], x[1]))
    sid_to_class = {}
    for i, (_, ids) in enumerate(eq_classes):
        for sid in ids:
            sid_to_class[sid] = i
    return eq_classes, sid_to_class

# -----------------------------
# Solve per grid (multi-unique)
# -----------------------------
def find_solutions_for_grid(slots, intersections, phrase_letters, cand, per_grid_time, max_solutions, quiet=False):
    """
    Returns a list of unique solutions (slot_id -> word).
    Budget is a multiset; shared cells consume once; final budget must be exactly zero.
    """
    start = time.time()
    deadline = (start + per_grid_time) if per_grid_time and per_grid_time > 0 else float("inf")

    budget = Counter(phrase_letters)
    cell_letter = {}
    cell_usage = defaultdict(int)
    sol = {}
    solutions = []

    # Crossing map
    cross = defaultdict(list)
    by_id = {s["id"]: s for s in slots}
    for x in intersections:
        cross[x["slot_a"]].append((x["slot_b"], x["pos_a"], x["pos_b"]))
        cross[x["slot_b"]].append((x["slot_a"], x["pos_b"], x["pos_a"]))

    # Equivalence classes for dedupe
    eq_classes, sid_to_class = slot_equivalence_classes(slots, intersections)
    ordered = order_slots(slots, cand, intersections)
    ids = [s["id"] for s in ordered]
    seen_signatures = set()
    last_ping = start

    def class_signature(current_sol):
        buckets = defaultdict(list)
        for sid, word in current_sol.items():
            buckets[sid_to_class[sid]].append(word)
        parts = []
        for cls_idx in sorted(buckets.keys()):
            parts.append((cls_idx, tuple(sorted(buckets[cls_idx]))))
        return tuple(parts)

    def can_place(slot_id, word):
        s = by_id[slot_id]
        # symmetry-break within equivalence class: nondecreasing lexicographic
        cls = sid_to_class[slot_id]
        class_members = [sid for sid in ids if sid_to_class[sid] == cls]
        for prev in class_members:
            if prev == slot_id: break
            if prev in sol and word < sol[prev]:
                return False
        # crossing consistency
        for other_id, pos_self, pos_other in cross[slot_id]:
            if other_id in sol and word[pos_self] != sol[other_id][pos_other]:
                return False
        # per-slot need against global budget
        need = Counter()
        for k, cell in enumerate(s["cells"]):
            ch = word[k]
            if cell in cell_letter:
                if cell_letter[cell] != ch:
                    return False
            else:
                need[ch] += 1
        for ch, cnt in need.items():
            if cnt > budget[ch]:
                return False
        return True

    def place(slot_id, word):
        s = by_id[slot_id]
        for k, cell in enumerate(s["cells"]):
            ch = word[k]
            if cell_usage[cell] == 0:
                cell_letter[cell] = ch
                budget[ch] -= 1
            cell_usage[cell] += 1
        sol[slot_id] = word

    def unplace(slot_id, word):
        s = by_id[slot_id]
        for k, cell in enumerate(s["cells"]):
            ch = word[k]
            cell_usage[cell] -= 1
            if cell_usage[cell] == 0:
                del cell_letter[cell]
                budget[ch] += 1
        del sol[slot_id]

    def maybe_ping():
        nonlocal last_ping
        now = time.time()
        if not quiet and (now - last_ping) >= HEARTBEAT_SEC:
            print(f"    … found {len(solutions)}/{max_solutions} unique so far ({now - start:.1f}s elapsed)")
            last_ping = now

    def dfs(idx=0):
        if time.time() >= deadline: return
        if len(solutions) >= max_solutions: return
        if idx == len(ids):
            # exact budget use (no leftovers)
            if all(v >= 0 for v in budget.values()) and sum(budget.values()) == 0:
                sig = class_signature(sol)
                if sig not in seen_signatures:
                    seen_signatures.add(sig)
                    solutions.append(sol.copy())
                    if not quiet:
                        print(f"    + solution #{len(solutions)} at {time.time()-start:.1f}s")
            return

        sid = ids[idx]
        for w in cand[sid]:
            if time.time() >= deadline: return
            if can_place(sid, w):
                place(sid, w)
                dfs(idx + 1)
                unplace(sid, w)
                if len(solutions) >= max_solutions or time.time() >= deadline:
                    return
                maybe_ping()

    dfs()
    return solutions

# -----------------------------
# Reporting
# -----------------------------
def write_grid_block(f, layout, slots, intersections, solutions, phrase):
    (w,h,nH,nV,hrows, vcols, mask, total_true, _slots, _inters) = layout
    gid = grid_id_from(mask,w,h,nH,nV)
    family = f"{nH}H{nV}V"
    dup_cells = len({x["cell"] for x in intersections})

    # Simple map: '#' = filled (any slot), '·' = empty
    grid = [['#' if mask[r][c]==1 else '.' for c in range(w)] for r in range(h)]
    def render_grid():
        return "\n".join("".join(row) for row in grid)

    # Across lengths by row
    h_slots = [s for s in slots if s['orient'] == "H"]
    h_slots_sorted = sorted(h_slots, key=lambda s: (s['cells'][0][0], s['cells'][0][1]))
    h_len_summary = ", ".join([f"R={s['cells'][0][0]}:LEN={s['length']}" for s in h_slots_sorted])

    # Header
    f.write(f"=== GRID W{w}×H{h}  |  FAMILY {family}  |  GRID_ID: {gid}\n")
    f.write(f"TOTAL_TRUE: {total_true}   INTERSECTIONS: {len(intersections)}   DUP_SQUARES: {dup_cells}\n")
    f.write(f"H-LENGTHS BY ROW: {h_len_summary}\n\n")

    # Slot list (H first, then V)
    hh = sorted([s for s in slots if s['orient']=="H"], key=lambda s: (s['cells'][0][0], s['cells'][0][1]))
    vv = sorted([s for s in slots if s['orient']=="V"], key=lambda s: (s['cells'][0][1], s['cells'][0][0]))
    seq = hh + vv

    f.write(f"SLOTS ({len(slots)} total):\n")
    for s in seq:
        if s['orient']=="H":
            r = s['cells'][0][0]; c1 = s['cells'][0][1]; c2 = s['cells'][-1][1]
            f.write(f"  [H] R={r}  C={c1}–{c2}  LEN={s['length']}\n")
        else:
            c = s['cells'][0][1]; r1 = s['cells'][0][0]; r2 = s['cells'][-1][0]
            f.write(f"  [V] C={c}  R={r1}–{r2}  LEN={s['length']}\n")

    f.write("\nINTERSECTIONS (slot,pos ↔ slot,pos @ r,c):\n")
    seq_id_map = {}
    for i,s in enumerate(seq, start=1):
        prefix = "H" if s['orient']=="H" else "V"
        seq_id_map[s['id']] = f"{prefix}{i}"
    for x in intersections:
        a = seq_id_map[x['slot_a']]; b = seq_id_map[x['slot_b']]; (rr,cc) = x['cell']
        f.write(f"  {a},{x['pos_a']} ↔ {b},{x['pos_b']}  @ ({rr},{cc})\n")

    # Cells & Map
    allcells = [(r,c) for r in range(h) for c in range(w) if mask[r][c]==1]
    f.write(f"\nCELLS_TRUE (count={len(allcells)}):\n  ")
    f.write(" ".join(f"({r},{c})" for (r,c) in allcells))
    f.write("\n\nASCII (monospace): '#' filled, '·' empty\n")
    f.write(render_grid()); f.write("\n")

    # Solutions
    if not solutions:
        f.write("\n-- No unique solutions found within limits --\n\n")
        return
    for idx, sol in enumerate(solutions, 1):
        # Start each solution with the label, then the new per-solution header
        f.write(f"\nSOLUTION #{idx}:\n\n")

        # Required per-solution lines
        f.write(f"PHRASE: {phrase}\n")
        f.write(f"\n")
        f.write(f"WIDTH: {w}\n")
        f.write(f"HEIGHT: {h}\n")
        f.write(f"\n")

        # WORDS section in the exact order: all H (as listed in SLOTS), then all V (as listed in SLOTS)
        f.write("WORDS:\n")

        # H first (already ordered in 'hh' per the SLOTS list)
        for s in hh:
            wid = s['id']
            word = sol.get(wid, "?")
            r = s['cells'][0][0]   # 0-based row
            c = s['cells'][0][1]   # 0-based starting col
            f.write(f"  H row={r} col={c} word={word}\n")

        # Then V (already ordered in 'vv' per the SLOTS list)
        for s in vv:
            wid = s['id']
            word = sol.get(wid, "?")
            r = s['cells'][0][0]   # 0-based starting row
            c = s['cells'][0][1]   # 0-based col
            f.write(f"  V row={r} col={c} word={word}\n")

    f.write("\n")

# -----------------------------
# Main
# -----------------------------
def main():
    ap = argparse.ArgumentParser(description="Grid-ranked solver (5 & 6 words) with purity, no-adjacent words, and unique solutions.")
    ap.add_argument("--phrase", required=False, help="Input phrase; non-letters ignored.")
    ap.add_argument("--dict", default=DEFAULT_DICT_PATH, help=f"Dictionary file (default: {DEFAULT_DICT_PATH})")
    ap.add_argument("--words_mode", choices=["5","6","both"], default="both",
                    help="Use 5-word layouts, 6-word layouts, or both (default: both).")
    ap.add_argument("--max_grids", type=int, default=DEFAULT_MAX_GRIDS, help="How many grids to attempt (ranked top-K).")
    ap.add_argument("--solutions_per_grid", type=int, default=DEFAULT_SOLUTIONS_PER_GRID, help="Upper bound on unique solutions per grid.")
    ap.add_argument("--per_grid_time", type=int, default=PER_GRID_TIME_LIMIT, help="Seconds per grid (soft).")
    ap.add_argument("--min_intersections", type=int, default=DEFAULT_MIN_INTERSECTIONS, help="Reject grids with fewer total crossings (0=off).")
    ap.add_argument("--grid_seed", type=int, default=0, help="Tie-break seed for grids with equal overlap.")
    ap.add_argument("--quiet", action="store_true", help="Suppress heartbeat progress logs.")
    ap.add_argument("--total_solutions_cap", type=int, default=0,
                help="Stop after this many total solutions across all grids (0 = no cap)")
    args = ap.parse_args()
    
    # ---- NEW FIRST PROMPT: minimum rating ----
    _min_rating = input("Minimum DICTIONARY rating to include (1–10). Enter for 1 (unrated are always included): ").strip()
    try:
        min_rating = int(_min_rating) if _min_rating else 1
    except:
        min_rating = 1
    # clamp
    if min_rating < 1: min_rating = 1
    if min_rating > 10: min_rating = 10

    phrase = args.phrase or input("Enter phrase: ")

    # Simple global cap prompt (blank = no cap)
    _cap = input("Stop after how many TOTAL solutions? (Enter for no cap): ").strip()
    try:
        global_cap = int(_cap) if _cap else 0
    except:
        global_cap = 0

    letters = clean_phrase(phrase)
    if not letters:
        print("No letters found in phrase. Exiting."); return
    L = len(letters)

    # UPDATED: pass min_rating into dictionary loader
    words_by_len = load_dictionary(args.dict, min_rating)

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_path = os.path.join(OUTPUT_DIR, f"solutions_{ts}.txt")

    # Enumerate & filter (support 5, 6, or both)
    print("Enumerating layouts...", flush=True)
    modes = [5, 6] if args.words_mode == "both" else [int(args.words_mode)]
    layouts_all = []
    for tw in modes:
        layouts_all.extend(enumerate_layouts(min_intersections=args.min_intersections, total_words=tw))

    # Filter to exact TOTAL_TRUE = phrase length
    layouts_all = [lay for lay in layouts_all if lay[7] == L]

    # Dedupe across modes by mask
    seen_masks = set(); layouts = []
    for lay in layouts_all:
        key = tuple(tuple(r) for r in lay[6])
        if key in seen_masks: continue
        seen_masks.add(key); layouts.append(lay)

    total_candidates = len(layouts)
    if total_candidates == 0:
        modes_str = "5&6" if args.words_mode == "both" else args.words_mode
        print(f"No feasible layouts for phrase length {L} with {modes_str}-word mode.")
        return

    # Rank by duplicate squares (overlap cells). Ties randomized by seed.
    ranked = []
    for lay in layouts:
        slots, intersections = lay[8], lay[9]
        dup_cells = len({x["cell"] for x in intersections})
        ranked.append((dup_cells, lay))
    rnd = random.Random(args.grid_seed)
    buckets = defaultdict(list)
    for dup, lay in ranked:
        buckets[dup].append(lay)
    for dup in buckets:
        rnd.shuffle(buckets[dup])
    sorted_dups = sorted(buckets.keys(), reverse=True)
    ranked_layouts = []
    for dup in sorted_dups:
        ranked_layouts.extend(buckets[dup])

    k = max(0, args.max_grids)
    selected = ranked_layouts[:k]

    modes_str = "5&6" if args.words_mode == "both" else args.words_mode
    print(f"Attempting {len(selected)} of {total_candidates} possible {L}-letter grids "
          f"({modes_str}-word layouts ranked by duplicate squares desc; ties randomized).")

    t0 = time.time()
    solved_count = 0
    total_solutions = 0
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(f"PHRASE: {phrase}\nCLEAN_LETTERS: {letters}  (len={L})\n")
        f.write(f"GRID RANKING: duplicate squares (desc); tie-break seed={args.grid_seed}; total words mode={modes_str}\n")
        f.write(f"Dictionary: {args.dict}\n")
        f.write("-"*64 + "\n\n")

        for idx, layout in enumerate(selected, 1):
            (w,h,nH,nV,hrows, vcols, mask, total_true, slots, intersections) = layout
            dup_cells = len({x["cell"] for x in intersections})
            family = f"{nH}H{nV}V"
            print(f"[{idx}/{len(selected)}] W{w}×H{h} • {family} • dup={dup_cells} • intersections={len(intersections)} "
                  f"• time cap={args.per_grid_time}s • up to {args.solutions_per_grid} solutions…")

            # Prefilter candidates
            budget = Counter(letters)
            cand = prefilter_candidates(words_by_len, slots, budget)
            if any(len(cand[s['id']]) == 0 for s in slots):
                print(f"    – no candidates for at least one slot; skipping.")
                write_grid_block(f, layout, slots, intersections, [], phrase)
                f.write("-"*64 + "\n\n")
                continue

            # Respect a global solutions cap by reducing this grid's max if needed
            max_solutions = args.solutions_per_grid
            if args.total_solutions_cap and args.total_solutions_cap > 0:
                remaining = args.total_solutions_cap - total_solutions
                if remaining <= 0:
                    remaining = 0
                max_solutions = min(max_solutions, remaining)

            # Respect a global solutions cap by reducing this grid's max if needed
            max_solutions = args.solutions_per_grid
            if global_cap > 0:
                remaining = global_cap - total_solutions
                if remaining <= 0:
                    remaining = 0
                max_solutions = min(max_solutions, remaining)

            sols = find_solutions_for_grid(
                slots, intersections, letters, cand,
                per_grid_time=args.per_grid_time,
                max_solutions=max_solutions,
                quiet=args.quiet
            )
            if sols:
                solved_count += 1
                total_solutions += len(sols)
                if not args.quiet:
                    print(f"    ✔ solved {len(sols)} unique")
            else:
                if not args.quiet:
                    print(f"    – no solutions (cap {args.per_grid_time}s)")

            write_grid_block(f, layout, slots, intersections, sols, phrase)
            f.write("-"*64 + "\n\n")

            # If we've hit the global cap, stop the run early
            if args.total_solutions_cap and args.total_solutions_cap > 0 and total_solutions >= args.total_solutions_cap:
                print(f"Reached global cap of {global_cap} solutions. Stopping early.")
                break

        elapsed = time.time() - t0
        print(f"Done. Attempted {len(selected)} grids; solved {solved_count}/{len(selected)}; "
              f"total unique solutions {total_solutions}; elapsed {elapsed:.1f}s")
        f.write("-"*64 + "\n")
        f.write(f"Attempted grids: {len(selected)}\n")
        f.write(f"Solved grids: {solved_count}\n")
        f.write(f"Total unique solutions: {total_solutions}\n")
        f.write(f"Elapsed: {elapsed:.2f}s\n")

    print(f"Output: {out_path}")

if __name__ == "__main__":
    main()
