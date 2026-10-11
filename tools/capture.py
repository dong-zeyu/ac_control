#!/usr/bin/env python3
import subprocess
import sys

def verify_checksum(byte_list):
    if len(byte_list) != 19:
        return False
    # byte_list is list of 8-bit binary strings (LSB first)
    actual_bytes = [int(b[::-1], 2) for b in byte_list[:18]]
    expected_sum = sum((b >> 4) + (b & 0x0F) for b in actual_bytes)
    expected_cs = (expected_sum - 8) % 256
    actual_cs = int(byte_list[18][::-1], 2)
    return expected_cs == actual_cs

def parse_stream(target_count=4, device="/dev/lirc1"):
    print(f"📡 Listening on {device} for {target_count} IR packets...", flush=True)
    print("👉 Please press remote buttons one by one.\n", flush=True)
    
    cmd = ["mode2", "-d", device]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except FileNotFoundError:
        cmd = ["ir-ctl", "-d", device, "-r"]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    captured_packets = []
    current_bits = []
    is_header = False

    try:
        for line in proc.stdout:
            parts = line.strip().split()
            if len(parts) != 2:
                continue
            kind, val_str = parts[0], parts[1]
            try:
                val = int(val_str)
            except ValueError:
                continue

            if kind == "pulse":
                if val > 3000:
                    current_bits = []
                    is_header = True
            elif kind == "space":
                if is_header:
                    is_header = False
                elif val < 5000:
                    bit = "1" if val > 1000 else "0"
                    current_bits.append(bit)
                    # Check if reached 152 bits
                    if len(current_bits) == 152:
                        bytes_str = ["".join(current_bits[i:i+8]) for i in range(0, 152, 8)]
                        valid = verify_checksum(bytes_str)
                        captured_packets.append((bytes_str, valid))
                        idx = len(captured_packets)
                        cs_status = "✅ Valid Checksum" if valid else "⚠️ Checksum Mismatch"
                        print(f"[{idx}/{target_count}] Captured Packet ({cs_status}):", flush=True)
                        print("    " + " ".join(bytes_str), flush=True)
                        current_bits = []
                        if len(captured_packets) >= target_count:
                            break
    except KeyboardInterrupt:
        pass
    finally:
        proc.terminate()

    return [p[0] for p in captured_packets]

def print_diff(packets, labels=None):
    if not packets:
        return
    print("\n" + "="*80)
    print("                      CAPTURE & BIT-DIFF ANALYSIS")
    print("="*80)
    
    if not labels:
        labels = [f"Capture #{i+1}" for i in range(len(packets))]

    for idx, p in enumerate(packets):
        lbl = labels[idx] if idx < len(labels) else f"Packet #{idx+1}"
        print(f"\n{lbl}:")
        print("  " + " ".join(p))
    
    print("\n" + "-"*80)
    print("BYTE-BY-BYTE DIFFERENCES ACROSS PACKETS:")
    print("-" * 80)
    num_bytes = min(len(p) for p in packets)
    has_diff = False
    for b_idx in range(num_bytes):
        vals = [p[b_idx] for p in packets]
        if len(set(vals)) > 1:
            has_diff = True
            print(f"▶ Byte {b_idx+1:02d}:")
            for idx, v in enumerate(vals):
                lbl = labels[idx] if idx < len(labels) else f"Packet #{idx+1}"
                print(f"    {lbl:20s}: {v} (0x{int(v[::-1], 2):02X})")
    
    if not has_diff:
        print("No differences detected across packets.")
    print("="*80 + "\n")

if __name__ == "__main__":
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    if len(sys.argv) > 2:
        labels = sys.argv[2:]
        out_file = "captured_test.txt"
    elif count == 8:
        labels = [
            "1. Pos 1 (bottom)",
            "2. Pos 2",
            "3. Pos 3",
            "4. Pos 4",
            "5. Pos 5",
            "6. Pos 6 (top)",
            "7. Louver (Continuous Swing)",
            "8. Auto Flap"
        ]
        out_file = "captured_flap.txt"
    else:
        labels = ["1. High Fan", "2. Medium Fan", "3. Low Fan", "4. Auto Fan"]
        out_file = "captured_fan.txt"
        
    packets = parse_stream(target_count=count)
    if packets:
        print_diff(packets, labels[:len(packets)])
        with open(out_file, "w") as f:
            for idx, p in enumerate(packets):
                lbl = labels[idx] if idx < len(labels) else f"Packet {idx+1}"
                f.write(f"{lbl}:\n" + " ".join(p) + "\n\n")
        print(f"💾 Results saved to {out_file}", flush=True)
