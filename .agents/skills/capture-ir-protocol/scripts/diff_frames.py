#!/usr/bin/env python3
"""
diff_frames.py - Compare two binary IR packet strings and highlight differing bits.
Usage:
    python3 diff_frames.py "<binary_string_1>" "<binary_string_2>"
    python3 diff_frames.py file1.txt file2.txt
"""

import sys
import os

def clean_binary(s):
    # Remove spaces and newlines
    return ''.join(c for c in s if c in '01')

def load_bits(arg):
    if os.path.isfile(arg):
        with open(arg, 'r') as f:
            content = f.read()
    else:
        content = arg
    return clean_binary(content)

def main():
    if len(sys.argv) < 3:
        print("Usage: diff_frames.py <frame1> <frame2>")
        sys.exit(1)

    bits1 = load_bits(sys.argv[1])
    bits2 = load_bits(sys.argv[2])

    if not bits1 or not bits2:
        print("Error: Could not extract binary bits from inputs.")
        sys.exit(1)

    len1, len2 = len(bits1), len(bits2)
    print(f"Frame 1 length: {len1} bits ({len1 // 8} bytes, {len1 % 8} rem)")
    print(f"Frame 2 length: {len2} bits ({len2 // 8} bytes, {len2 % 8} rem)\n")

    max_bytes = max(len1, len2) // 8 + (1 if max(len1, len2) % 8 else 0)

    print(f"{'Byte':<6} | {'Frame 1':<10} | {'Frame 2':<10} | {'Diff Mask':<10} | {'Notes'}")
    print("-" * 60)

    diff_count = 0
    for i in range(max_bytes):
        b1 = bits1[i*8:(i+1)*8] if i*8 < len1 else ""
        b2 = bits2[i*8:(i+1)*8] if i*8 < len2 else ""

        diff_mask = []
        for bit_idx in range(max(len(b1), len(b2))):
            c1 = b1[bit_idx] if bit_idx < len(b1) else "-"
            c2 = b2[bit_idx] if bit_idx < len(b2) else "-"
            if c1 != c2:
                diff_mask.append("^")
                diff_count += 1
            else:
                diff_mask.append(" ")

        mask_str = "".join(diff_mask)
        diff_flag = "DIFF" if "^" in mask_str else ""
        print(f"[{i+1:02d}]   | {b1:<10} | {b2:<10} | {mask_str:<10} | {diff_flag}")

    print("-" * 60)
    print(f"Total bit differences: {diff_count}\n")

if __name__ == "__main__":
    main()
