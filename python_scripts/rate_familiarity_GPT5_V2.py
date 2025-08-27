# rate_familiarity_GPT5_V2.py
# One-sentence summary:
# Rates each line’s current familiarity (1–10) for US word-game players using GPT-5, appending TSV output,
# and prints per-batch & total token usage + cost estimates on screen.
#
# What this script does (tech summary):
# - Hardwired input file: C:\Alloquest_Photos\Word_Game\my-word-game\tools\latest_3.txt
# - Prompts for 1-indexed inclusive start/end line numbers; skips empty/whitespace-only lines
# - Processes in batches of 25 lines; appends results to "latest_3_familiarity.tsv" (no header)
# - Uses GPT-5 with temperature=0; retries each failed batch up to 3 times (exponential backoff)
# - Logs errors/retries to "latest_3_familiarity_log.txt"
# - After each batch, prints input/output tokens and dollar cost for that batch, plus cumulative totals
#
# Final run summary (printed):
# - Script file name
# - What it did
# - Output file path

import os
import time
import sys
from typing import List, Tuple

# ---- CONFIG ----
INPUT_PATH = r"C:\Alloquest_Photos\Word_Game\my-word-game\tools\latest_3.txt"
API_KEY_PATH = r"C:\The_GPK\Entry.txt"
BATCH_SIZE = 25
MODEL = "gpt-5"     # GPT-5 flagship
# -TEMPERATURE = 0
MAX_RETRIES = 3
INITIAL_BACKOFF_SECONDS = 5
OUTPUT_FILENAME = "latest_3_familiarity.tsv"
LOG_FILENAME = "latest_3_familiarity_log.txt"

# Cost assumptions (USD per 1,000,000 tokens). Adjust if your account shows different pricing.
INPUT_COST_PER_MTOK = 1.25    # $ per 1M input tokens
OUTPUT_COST_PER_MTOK = 10.00  # $ per 1M output tokens
# ----------------

# --- Minimal OpenAI client (new SDK style) ---
# pip install openai
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
    # Keep original text but prevent extra TSV columns
    return s.replace("\t", " ")

def chunk(lst: List[str], size: int) -> List[List[str]]:
    return [lst[i:i+size] for i in range(0, len(lst), size)]

def log(line: str, log_path: str):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    with open(log_path, "a", encoding="utf-8") as f:
        f.write(f"[{ts}] {line}\n")

def build_prompt(batch_items: List[str]) -> str:
    numbered = "\n".join(f"{i+1}. {s}" for i, s in enumerate(batch_items))
    return (
        "You are rating how familiar each line would be to the average U.S. online word-game player RIGHT NOW.\n"
        "• 10 = instantly recognizable by most players; 1 = very obscure/rare.\n"
        "• Consider general recognition today; age of reference doesn’t matter.\n"
        "• Lines can be words, names, brands, or phrases.\n"
        "Task: Return exactly N lines — one per input item — where each line is just a single integer from 1 to 10.\n"
        "No extra text, no labels, no punctuation, no explanations.\n"
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
    # Fallback: unknown
    return 0, 0

def rate_batch(client: "OpenAI", items: List[str]) -> Tuple[List[int], int, int]:
    prompt = build_prompt(items)
    resp = client.responses.create(
        model=MODEL,
        input=prompt,
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

def dollars_for_tokens(input_tokens: int, output_tokens: int) -> float:
    return (input_tokens / 1_000_000.0) * INPUT_COST_PER_MTOK + (output_tokens / 1_000_000.0) * OUTPUT_COST_PER_MTOK

def main():
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

    # Load file
    try:
        all_lines = load_lines(INPUT_PATH)
    except Exception as e:
        print(f"ERROR: {e}")
        return

    total_lines = len(all_lines)
    print(f"Loaded {total_lines} total lines from:\n  {INPUT_PATH}")

    # Get range (1-indexed, inclusive)
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
                ratings, in_tok, out_tok = rate_batch(client, batch_items)

                # Append results immediately
                with open(out_path, "a", encoding="utf-8", newline="") as out_f:
                    for rating, original in zip(ratings, batch_items):
                        out_f.write(f"{rating}\t{sanitize_for_tsv(original)}\n")

                processed_so_far += len(batch_items)
                total_in_tokens += in_tok
                total_out_tokens += out_tok

                # Compute costs
                batch_cost = dollars_for_tokens(in_tok, out_tok)
                total_cost = dollars_for_tokens(total_in_tokens, total_out_tokens)

                # On-screen batch usage/cost
                print(
                    f"Batch {b_idx}/{batch_count} ✓  "
                    f"(items: {len(batch_items)})  "
                    f"in={in_tok} tok, out={out_tok} tok, "
                    f"batch_cost=${batch_cost:,.4f}, total_cost=${total_cost:,.4f}"
                )
                break  # next batch

            except Exception as e:
                log(f"Batch {b_idx} attempt {attempt} failed: {e}", log_path)
                if attempt >= MAX_RETRIES:
                    print(f"Batch {b_idx}/{batch_count} FAILED after {MAX_RETRIES} attempts. See log: {log_path}")
                    # Continue to next batch
                    break
                else:
                    print(f"Batch {b_idx}/{batch_count} error: {e}\nRetrying in {backoff}s...")
                    time.sleep(backoff)
                    backoff *= 2

    # Final totals
    total_cost = dollars_for_tokens(total_in_tokens, total_out_tokens)
    print("\n--- Run Complete ---")
    print("Script: rate_familiarity_GPT5_V2.py")
    print(f"Processed: {processed_so_far} line(s) appended")
    print(f"Total tokens: input={total_in_tokens:,}  output={total_out_tokens:,}")
    print(f"Total estimated cost: ${total_cost:,.4f}")
    print("Summary: Read input lines, rated familiarity via GPT-5, appended TSV after each batch, and reported per-batch & total costs.")
    print(f"Output file: {out_path}")
    print(f"Log file:    {log_path}")

if __name__ == "__main__":
    main()
