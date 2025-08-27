# rate_familiarity_GPT_V3.py
# One-sentence summary:
# Rates each line’s current familiarity (1–10) for average US online word-game players using an OpenAI model you choose at runtime,
# appends "<rating>\t<original line>" to a TSV in the same folder, and shows per-batch & total token usage and cost.
#
# What this script does (tech summary):
# - Hardwired input file: C:\Alloquest_Photos\Word_Game\my-word-game\tools\latest_3.txt
# - Reads API key from:   C:\The_GPK\Entry.txt
# - Prompts for 1-indexed inclusive start/end line numbers; skips empty/whitespace-only lines
# - Processes in batches of 25 lines; appends to "latest_3_familiarity.tsv" (no header)
# - Lets you pick a model at runtime (e.g., gpt-5, gpt-5-mini, gpt-4o-mini) and computes costs with that model’s pricing
# - Retries each failed batch up to 3 times with exponential backoff; logs errors to "latest_3_familiarity_log.txt"
# - Prints per-batch token usage & cost and a final total
#
# Final output (printed at end of run):
# - Script file name
# - Brief summary of what was done
# - Output file path that was appended

import os
import time
import sys
from typing import List, Tuple

# ---- CONFIG (edit only if you want to change defaults) ----
INPUT_PATH = r"C:\Alloquest_Photos\Word_Game\my-word-game\tools\latest_3.txt"
API_KEY_PATH = r"C:\The_GPK\Entry.txt"
BATCH_SIZE = 25
MAX_RETRIES = 3
INITIAL_BACKOFF_SECONDS = 5  # 5s, then 10s, then 20s
OUTPUT_FILENAME = "latest_3_familiarity.tsv"
LOG_FILENAME = "latest_3_familiarity_log.txt"

# Per-million token pricing (USD). Update if your account differs.
# Keys must match the exact model string passed to the API.
PRICE_BY_MODEL = {
    "gpt-5":       {"input": 1.25, "output": 10.00},  # flagship
    "gpt-5-mini":  {"input": 0.25, "output": 2.00},   # lower cost
    "gpt-4o-mini": {"input": 0.15, "output": 0.60},   # also low cost
}
MODEL_DEFAULT = "gpt-5-mini"
# -----------------------------------------------------------

# --- OpenAI client (modern SDK) ---
# If needed: pip install openai
try:
    from openai import OpenAI
except ImportError:
    print("Please install the OpenAI Python package:\n  pip install openai")
    sys.exit(1)

def read_api_key(path: str) -> str:
    if not os.path.exists(path):
        raise FileNotFoundError(f"API key file not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        key = f.read().strip()
    if not key:
        raise ValueError(f"API key file is empty: {path}")
    return key

def load_lines(path: str) -> List[str]:
    if not os.path.exists(path):
        raise FileNotFoundError(f"Input file not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return f.read().splitlines()

def sanitize_for_tsv(s: str) -> str:
    # Keep original content but replace literal tabs so TSV stays exactly two columns.
    return s.replace("\t", " ")

def chunk(lst: List[str], size: int) -> List[List[str]]:
    return [lst[i:i+size] for i in range(0, len(lst), size)]

def log(line: str, log_path: str):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(f"[{ts}] {line}\n")

def choose_model(default_model: str, price_table: dict) -> str:
    print("Available models (per-million tokens pricing):")
    for m, p in price_table.items():
        print(f"  - {m}: input ${p['input']}/Mtok, output ${p['output']}/Mtok")
    chosen = input(f"Model [{default_model}]: ").strip()
    if chosen == "":
        chosen = default_model
    if chosen not in price_table:
        print(f"Unrecognized model '{chosen}'. Falling back to {default_model}.")
        chosen = default_model
    return chosen

def dollars_for_tokens(model: str, input_tokens: int, output_tokens: int) -> float:
    p = PRICE_BY_MODEL.get(model, PRICE_BY_MODEL[MODEL_DEFAULT])
    return (input_tokens / 1_000_000.0) * p["input"] + (output_tokens / 1_000_000.0) * p["output"]

def build_prompt(batch_items: List[str]) -> str:
    # Concise instructions to limit tokens/cost. We require exactly N integers 1–10, one per line, same order.
    numbered = "\n".join(f"{i+1}. {s}" for i, s in enumerate(batch_items))
    return (
        "Rate how familiar each line would be to the average U.S. online word-game player RIGHT NOW.\n"
        "• 10 = instantly recognizable by most players; 1 = very obscure/rare.\n"
        "• Consider current general recognition; age of reference doesn’t matter.\n"
        "• Lines can be words, names, brands, or phrases.\n"
        "Return exactly N lines — each a single integer from 1 to 10 — in the same order as given.\n"
        "No extra text, labels, punctuation, or explanations.\n"
        f"N = {len(batch_items)}\n\n"
        "Items:\n"
        f"{numbered}\n\n"
        "Output:\n"
    )

def parse_usage(resp) -> Tuple[int, int]:
    """
    Returns (input_tokens, output_tokens) from a Responses API result.
    Falls back gracefully if fields differ.
    """
    # Newer SDKs expose resp.usage.input_tokens / output_tokens
    try:
        u = resp.usage
        if u is not None:
            it = getattr(u, "input_tokens", None)
            ot = getattr(u, "output_tokens", None)
            if isinstance(it, int) and isinstance(ot, int):
                return it, ot
    except Exception:
        pass
    # Some SDK variants store usage inside 'usage' dict
    try:
        u = getattr(resp, "usage", None)
        if isinstance(u, dict):
            it = u.get("input_tokens")
            ot = u.get("output_tokens")
            if isinstance(it, int) and isinstance(ot, int):
                return it, ot
    except Exception:
        pass
    # Fallback if not available
    return 0, 0

def rate_batch(client: "OpenAI", items: List[str], model: str) -> Tuple[List[int], int, int]:
    prompt = build_prompt(items)
    resp = client.responses.create(
        model=model,
        input=prompt,
        # no temperature (GPT-5 ignores it anyway)
    )
    text = resp.output_text.strip()
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() != ""]
    if len(lines) != len(items):
        raise ValueError(f"Expected {len(items)} ratings, got {len(lines)}. Raw model output:\n{text}")
    try:
        ratings = [int(ln) for ln in lines]
    except ValueError as e:
        raise ValueError(f"Non-integer rating encountered. Raw model output:\n{text}") from e
    for r in ratings:
        if not (1 <= r <= 10):
            raise ValueError(f"Rating out of range 1–10: {r}")
    in_tok, out_tok = parse_usage(resp)
    return ratings, in_tok, out_tok

def main():
    # Resolve paths
    in_dir = os.path.dirname(INPUT_PATH)
    out_path = os.path.join(in_dir, OUTPUT_FILENAME)
    log_path = os.path.join(in_dir, LOG_FILENAME)

    # Read API key
    try:
        api_key = read_api_key(API_KEY_PATH)
    except Exception as e:
        print(f"ERROR: {e}")
        return

    # Init client
    client = OpenAI(api_key=api_key)

    # Load input file
    try:
        all_lines = load_lines(INPUT_PATH)
    except Exception as e:
        print(f"ERROR: {e}")
        return

    total_lines = len(all_lines)
    print(f"Loaded {total_lines} total lines from:\n  {INPUT_PATH}")

    # Choose model (affects both API call and cost math)
    model = choose_model(MODEL_DEFAULT, PRICE_BY_MODEL)
    print(f"Using model: {model}")

    # Get start/end (1-indexed, inclusive)
    try:
        start_raw = input("Enter START line number (1-indexed, inclusive): ").strip()
        end_raw = input("Enter END line number (1-indexed, inclusive): ").strip()
        start_idx = int(start_raw)
        end_idx = int(end_raw)
        if start_idx < 1 or end_idx < 1 or start_idx > end_idx:
            raise ValueError("Invalid range: start/end must be >=1 and start<=end.")
    except Exception as e:
        print(f"Invalid input for line range: {e}")
        return

    # Convert to 0-indexed and clamp
    start0 = max(0, start_idx - 1)
    end0 = min(total_lines - 1, end_idx - 1)

    # Select non-empty lines
    selected = []
    for i in range(start0, end0 + 1):
        line = all_lines[i]
        if line.strip() == "":
            continue
        selected.append(line)

    if not selected:
        print("No non-empty lines in the selected range. Nothing to do.")
        return

    batches = chunk(selected, BATCH_SIZE)
    batch_count = len(batches)
    print(f"Processing {len(selected)} non-empty lines in {batch_count} batch(es) of up to {BATCH_SIZE}...")

    processed_so_far = 0
    total_in_tokens = 0
    total_out_tokens = 0

    for b_idx, batch_items in enumerate(batches, start=1):
        attempt = 0
        backoff = INITIAL_BACKOFF_SECONDS
        while True:
            attempt += 1
            try:
                ratings, in_tok, out_tok = rate_batch(client, batch_items, model)

                # Append results immediately
                with open(out_path, "a", encoding="utf-8", newline="") as out_f:
                    for rating, original in zip(ratings, batch_items):
                        out_f.write(f"{rating}\t{sanitize_for_tsv(original)}\n")

                processed_so_far += len(batch_items)
                total_in_tokens += in_tok
                total_out_tokens += out_tok

                # Compute & print costs
                batch_cost = dollars_for_tokens(model, in_tok, out_tok)
                total_cost = dollars_for_tokens(model, total_in_tokens, total_out_tokens)
                print(
                    f"Batch {b_idx}/{batch_count} ✓  "
                    f"(items: {len(batch_items)})  "
                    f"in={in_tok} tok, out={out_tok} tok, "
                    f"batch_cost=${batch_cost:,.4f}, total_cost=${total_cost:,.4f}"
                )
                break  # go to next batch

            except Exception as e:
                log(f"Batch {b_idx} attempt {attempt} failed: {e}", log_path)
                if attempt >= MAX_RETRIES:
                    print(f"Batch {b_idx}/{batch_count} FAILED after {MAX_RETRIES} attempts. See log: {log_path}")
                    # continue to next batch rather than abort entire run
                    break
                else:
                    print(f"Batch {b_idx}/{batch_count} error: {e}\nRetrying in {backoff}s...")
                    time.sleep(backoff)
                    backoff *= 2

    # Final summary
    total_cost = dollars_for_tokens(model, total_in_tokens, total_out_tokens)
    print("\n--- Run Complete ---")
    print("Script: rate_familiarity_GPT_V3.py")
    print(f"Processed: {processed_so_far} line(s) appended")
    print(f"Total tokens: input={total_in_tokens:,}  output={total_out_tokens:,}")
    print(f"Total estimated cost: ${total_cost:,.4f}")
    print("Summary: Read input lines, rated familiarity via chosen model, appended TSV after each batch, reported per-batch & total costs.")
    print(f"Output file: {out_path}")
    print(f"Log file:    {log_path}")

if __name__ == "__main__":
    main()
