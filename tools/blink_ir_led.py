#!/usr/bin/env python3
import subprocess
import tempfile
import time

def main():
    print("💡 Blinking IR LED for 10 seconds...")
    print("👉 Look at the IR LED through your smartphone camera (it will glow purple/white if working).\n")
    
    # Generate 100ms on, 100ms off pulses
    lines = []
    for _ in range(50):
        lines.append("pulse 100000")
        lines.append("space 100000")
    raw_content = "\n".join(lines) + "\n"

    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt') as f:
        f.write(raw_content)
        f.flush()
        subprocess.run(["ir-ctl", "-d", "/dev/lirc0", "--send", f.name])
    
    print("Done.")

if __name__ == "__main__":
    main()
