#!/usr/bin/env python3
import sys
import subprocess
import time

def main():
    device = "/dev/lirc1"
    raw_file = "captured_cancel_raw.txt"
    print(f"📡 [LISTENING] Ready on {device} via mode2...")
    print("👉 Please press the 'Cancel Timer' button on your remote now!\n", flush=True)

    cmd = ["mode2", "-d", device]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    raw_lines = []
    current_bits = []
    is_header = False
    in_packet = False
    start_time = time.time()
    packet_captured = False

    try:
        while time.time() - start_time < 30:
            line = proc.stdout.readline()
            if not line:
                time.sleep(0.01)
                continue
            line_str = line.strip()
            parts = line_str.split()
            if len(parts) != 2:
                continue
            kind, val_str = parts[0], parts[1]
            try:
                val = int(val_str)
            except ValueError:
                continue

            if kind == "pulse":
                if val > 2800:
                    # New header detected!
                    raw_lines = [f"pulse {val}"]
                    current_bits = []
                    is_header = True
                    in_packet = True
                elif in_packet:
                    raw_lines.append(f"pulse {val}")
            elif kind == "space":
                if is_header:
                    raw_lines.append(f"space {val}")
                    is_header = False
                elif in_packet:
                    if val > 5000:
                        # End of packet!
                        raw_lines.append(f"space {val}")
                        in_packet = False
                        if len(current_bits) >= 40:
                            packet_captured = True
                            break
                    else:
                        raw_lines.append(f"space {val}")
                        bit = "1" if val > 800 else "0"
                        current_bits.append(bit)
            elif kind == "timeout" and in_packet:
                in_packet = False
                if len(current_bits) >= 40:
                    packet_captured = True
                    break
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            proc.kill()

    if not packet_captured:
        print("⏰ Timeout or no valid packet captured.")
        sys.exit(1)

    # Save raw timing file for direct retransmission
    with open(raw_file, "w") as f:
        f.write("\n".join(raw_lines) + "\n")
    print(f"✅ Raw IR signal captured and saved to {raw_file} ({len(raw_lines)} pulses/spaces)")

    num_bits = len(current_bits)
    print(f"🔢 Total bits captured: {num_bits}")

    num_bytes = num_bits // 8
    rem_bits = num_bits % 8
    bytes_list = ["".join(current_bits[i:i+8]) for i in range(0, num_bits - rem_bits, 8)]
    binary_str = " ".join(bytes_list)
    print(f"\n📦 Binary Payload ({num_bytes} Bytes" + (f" + {rem_bits} bits" if rem_bits else "") + f"):\n{binary_str}\n")

    with open("captured_cancel_binary.txt", "w") as f:
        f.write(binary_str + "\n")

    # If it is a 19-byte packet, run decode_ac
    if num_bytes == 19:
        try:
            from decode_ac import decode_ac_packet, print_decoded
            decoded = decode_ac_packet(binary_str)
            print_decoded(decoded)
        except Exception as e:
            print(f"Decode error: {e}")
    else:
        print(f"ℹ️ Special frame length ({num_bytes} bytes).")

if __name__ == "__main__":
    main()
