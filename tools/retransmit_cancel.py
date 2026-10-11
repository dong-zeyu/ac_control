#!/usr/bin/env python3
import sys
import os
import subprocess

def transmit_file(filepath, device="/dev/lirc0"):
    print(f"🚀 Sending IR file {filepath} via {device}...")
    res = subprocess.run(["ir-ctl", "-d", device, "--send", filepath], capture_output=True, text=True)
    if res.returncode == 0:
        print(f"✅ Transmitted {filepath} successfully!")
        if res.stderr:
            print("Notice:", res.stderr.strip())
    else:
        print(f"❌ Failed to transmit: {res.stderr}")

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "captured_cancel_raw.txt"
    if not os.path.exists(target):
        print(f"File {target} not found!")
        sys.exit(1)
    transmit_file(target)
