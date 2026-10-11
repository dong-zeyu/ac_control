#!/usr/bin/env python3
"""
AEHA Air Conditioner Infrared Protocol Decoder
Decodes 19-byte (152-bit) IR raw signals into human-readable AC state commands.
Supports live listening on /dev/lirc1, file input, and command-line binary strings.
"""

import sys
import os
import argparse
import json
import subprocess
import unicodedata

def display_width(s):
    w = 0
    for ch in str(s):
        if unicodedata.east_asian_width(ch) in ('W', 'F'):
            w += 2
        else:
            w += 1
    return w

def pad_to(s, width):
    dw = display_width(str(s))
    return str(s) + ' ' * max(0, width - dw)

def verify_checksum(bytes_list):
    if len(bytes_list) != 19:
        return False, 0, 0
    actual_bytes = [int(b[::-1], 2) for b in bytes_list[:18]]
    expected_sum = sum((b >> 4) + (b & 0x0F) for b in actual_bytes)
    expected_cs = (expected_sum - 8) % 256
    actual_cs = int(bytes_list[18][::-1], 2)
    return (expected_cs == actual_cs), expected_cs, actual_cs

def decode_ac_packet(packet_input):
    """
    Decodes a 19-byte AEHA binary packet into a structured dictionary.
    packet_input can be a list of 19 8-bit strings or a single space-separated string.
    """
    if isinstance(packet_input, str):
        bytes_list = packet_input.strip().split()
    else:
        bytes_list = list(packet_input)

    if len(bytes_list) != 19:
        raise ValueError(f"Expected 19 bytes, got {len(bytes_list)}")

    # Byte references (0-indexed)
    b1, b2, b3, b4 = bytes_list[0:4]
    b5, b6, b7, b8 = bytes_list[4:8]
    b9, b10, b11, b12 = bytes_list[8:12]
    b13, b14, b15, b16 = bytes_list[12:16]
    b17, b18, b19 = bytes_list[16:19]

    # Checksum verification
    cs_valid, expected_cs, actual_cs = verify_checksum(bytes_list)

    # 1. Power Action (Byte 06, bits 0:2)
    pp = b6[0:2]
    power_action_map = {
        '01': 'TURN ON',
        '10': 'TURN OFF',
        '00': 'MAINTAIN / SETTINGS UPDATE'
    }
    power_action = power_action_map.get(pp, f'UNKNOWN ({pp})')

    # 2. Power State (Byte 09, bit 5)
    power_state = 'ON' if b9[5] == '1' else 'OFF'

    # 3. Operating Mode (Byte 06, bits 6:8 & Byte 07 bit 7)
    mm = b6[6:8]
    mode_ext = b7[7]
    if mode_ext == '1' and mm == '00':
        mode = 'Auto'
    else:
        mode_map = {
            '00': 'Auto',
            '01': 'Cooling',
            '10': 'Heating',
            '11': 'Dehumidify / Dry'
        }
        mode = mode_map.get(mm, f'Unknown ({mm})')

    # 4. Fan Speed (Byte 06, bits 2:4)
    ss = b6[2:4]
    fan_map = {
        '00': 'Auto',
        '01': 'Low',
        '11': 'Medium',
        '10': 'High'
    }
    fan_speed = fan_map.get(ss, f'Unknown ({ss})')

    # 5. Flap / Louver / Swing (Byte 14, bits 0:3)
    v_bits = b14[0:3]
    v_val = int(v_bits[::-1], 2)
    if v_val == 0:
        flap = 'Louver (Continuous Swing)'
    elif v_val == 1:
        flap = 'Auto'
    elif 2 <= v_val <= 7:
        flap = f'Position {v_val - 1}'
    else:
        flap = f'Unknown ({v_val})'
    flap_flag = b14[3]

    # 6. Target Temperature (Byte 07, bits 0:6)
    # T_C = 4.0 + 0.5 * t_val
    t_val = int(b7[0:6][::-1], 2)
    target_c = 4.0 + 0.5 * t_val

    # 7. Measured / Room Temperature (Byte 08, bits 0:6)
    # T_C = 4.0 + 0.5 * c_val
    c_val = int(b8[0:6][::-1], 2)
    meas_c = 4.0 + 0.5 * c_val

    # 8. Special Options (Byte 15: N00HI000)
    night_setback = 'ON' if b15[0] == '1' else 'OFF'
    high_power = 'ON' if b15[3] == '1' else 'OFF'
    ion_mode = 'ON' if b15[4] == '1' else 'OFF'

    # 9. Quiet / Silent Mode (Byte 16, bit 0)
    quiet_mode = 'ON' if b16[0] == '1' else 'OFF'

    # 10. Timers (Byte 06 bits 4, 5, Byte 07 bit 6, Byte 10, Byte 11)
    f_off = b6[4] == '1'
    n_on = b6[5] == '1'
    c_combo = b7[6] == '1'

    if c_combo or (f_off and n_on):
        timer_mode = 'Combo'
    elif f_off:
        timer_mode = 'OFF Timer'
    elif n_on:
        timer_mode = 'ON Timer'
    else:
        timer_mode = 'None'

    # Timer OFF details
    off_min_tens = int(b10[0:3][::-1], 2)
    off_hours = int(b10[3:8][::-1], 2)
    timer_off_str = f"{off_hours:02d}:{off_min_tens * 10:02d}"

    # Timer ON details
    on_min_tens = int(b11[0:3][::-1], 2)
    on_hours = int(b11[3:8][::-1], 2)
    timer_on_str = f"{on_hours:02d}:{on_min_tens * 10:02d}"

    # 10. Real-Time Clock (Byte 12 & 13)
    rtc_m = int(b12[0:6][::-1], 2)
    rtc_h = int((b12[6:8] + b13[0:3])[::-1], 2)
    remote_clock = f"{rtc_h:02d}:{rtc_m:02d}"

    return {
        "raw_payload": " ".join(bytes_list),
        "checksum": {
            "valid": cs_valid,
            "expected_hex": f"0x{expected_cs:02X}",
            "actual_hex": f"0x{actual_cs:02X}"
        },
        "power_action": power_action,
        "power_state": power_state,
        "mode": mode,
        "fan_speed": fan_speed,
        "flap_louver": flap,
        "target_temperature_c": round(target_c, 1),
        "room_temperature_c": round(meas_c, 1),
        "target_temperature": {
            "celsius": round(target_c, 1),
            "raw_value": t_val
        },
        "room_temperature": {
            "celsius": round(meas_c, 1),
            "raw_value": c_val
        },
        "night_setback": night_setback,
        "high_power": high_power,
        "ion_mode": ion_mode,
        "quiet_mode": quiet_mode,
        "timer": {
            "mode": timer_mode,
            "timer_on": timer_on_str if timer_mode in ['ON Timer', 'Combo'] else None,
            "timer_off": timer_off_str if timer_mode in ['OFF Timer', 'Combo'] else None
        },
        "remote_clock": remote_clock
    }

def print_decoded_card(data):
    cs = data['checksum']
    cs_badge = "✅ VALID" if cs['valid'] else f"❌ INVALID (exp: {cs['expected_hex']}, got: {cs['actual_hex']})"
    t_c = data['target_temperature']['celsius']
    r_c = data['room_temperature']['celsius']
    WIDTH = 42

    print("┌────────────────────────────────────────────────────────────┐")
    print("│             AIR CONDITIONER COMMAND DECODER                │")
    print("├────────────────────────────────────────────────────────────┤")
    print(f"│  Power Action : {pad_to(data['power_action'], WIDTH)} │")
    print(f"│  Power State  : {pad_to(data['power_state'], WIDTH)} │")
    print(f"│  Mode         : {pad_to(data['mode'], WIDTH)} │")
    print(f"│  Fan Speed    : {pad_to(data['fan_speed'], WIDTH)} │")
    print(f"│  Flap / Louver: {pad_to(data['flap_louver'], WIDTH)} │")
    print(f"│  Target Temp  : {pad_to(f'{t_c:.1f}°C', WIDTH)} │")
    print(f"│  Room Temp    : {pad_to(f'{r_c:.1f}°C', WIDTH)} │")
    print(f"│  Night Setback: {pad_to(data['night_setback'], WIDTH)} │")
    print(f"│  High Power   : {pad_to(data['high_power'], WIDTH)} │")
    print(f"│  ION Mode     : {pad_to(data['ion_mode'], WIDTH)} │")
    print(f"│  Quiet Mode   : {pad_to(data['quiet_mode'], WIDTH)} │")
    print(f"│  Timer Mode   : {pad_to(data['timer']['mode'], WIDTH)} │")
    if data['timer']['timer_on']:
        print(f"│  Timer ON     : {pad_to(data['timer']['timer_on'], WIDTH)} │")
    if data['timer']['timer_off']:
        print(f"│  Timer OFF    : {pad_to(data['timer']['timer_off'], WIDTH)} │")
    print(f"│  Remote Clock : {pad_to(data['remote_clock'], WIDTH)} │")
    print(f"│  Checksum     : {pad_to(cs_badge, WIDTH)} │")
    print("└────────────────────────────────────────────────────────────┘")

def live_listener(device="/dev/lirc1", count=None, json_output=False):
    print(f"📡 Listening on {device}... Point remote and press buttons (Ctrl+C to quit)\n", flush=True)
    cmd = ["mode2", "-d", device]
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except FileNotFoundError:
        cmd = ["ir-ctl", "-d", device, "-r"]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    current_bits = []
    is_header = False
    packets_captured = 0

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
                    if len(current_bits) == 152:
                        bytes_str = ["".join(current_bits[i:i+8]) for i in range(0, 152, 8)]
                        current_bits = []
                        packets_captured += 1
                        
                        decoded = decode_ac_packet(bytes_str)
                        if json_output:
                            print(json.dumps(decoded, indent=2), flush=True)
                        else:
                            print(f"\n[Signal #{packets_captured}] Raw: {' '.join(bytes_str)}", flush=True)
                            print_decoded_card(decoded)
                            sys.stdout.flush()

                        if count and packets_captured >= count:
                            break
    except KeyboardInterrupt:
        print("\nListener stopped.")
    finally:
        proc.terminate()

def print_compact_line(data):
    cs = data['checksum']
    cs_badge = "✅" if cs['valid'] else "❌"
    t_c = data['target_temperature']['celsius']
    r_c = data['room_temperature']['celsius']
    clk = data['remote_clock']
    p_act = data['power_action'].split()[0]
    p_st = data['power_state']
    mode = data['mode']
    fan = data['fan_speed']
    flap = data['flap_louver']
    quiet = " (Quiet)" if data['quiet_mode'] == 'ON' else ""
    hp = " (HighPower)" if data.get('high_power') == 'ON' else ""
    ion = " (ION)" if data.get('ion_mode') == 'ON' else ""
    ns = " (NightSetback)" if data.get('night_setback') == 'ON' else ""
    
    # Timer status in compact line
    t_mode = data['timer']['mode']
    if t_mode == 'ON Timer':
        timer_str = f"ON({data['timer']['timer_on']})"
    elif t_mode == 'OFF Timer':
        timer_str = f"OFF({data['timer']['timer_off']})"
    elif t_mode == 'Combo':
        timer_str = f"Combo(ON:{data['timer']['timer_on']},OFF:{data['timer']['timer_off']})"
    else:
        timer_str = "None"
    
    print(f"[{clk}] Power:{p_st}({p_act}) | Mode:{mode} | Temp:{t_c:.1f}°C | Room:{r_c:.1f}°C | Fan:{fan}{quiet}{hp}{ion}{ns} | Flap:{flap} | Timer:{timer_str} | {cs_badge}", flush=True)

def main():
    parser = argparse.ArgumentParser(description="AEHA Air Conditioner IR Protocol Decoder")
    parser.add_argument("code", nargs="?", help="Raw 19-byte binary string to decode (optional)")
    parser.add_argument("-l", "--listen", action="store_true", help="Listen live on IR receiver device")
    parser.add_argument("-d", "--device", default="/dev/lirc1", help="LIRC device node (default: /dev/lirc1)")
    parser.add_argument("-f", "--file", help="File containing captured binary packets to decode")
    parser.add_argument("-n", "--count", type=int, help="Number of packets to capture before exiting")
    parser.add_argument("-c", "--compact", action="store_true", help="Print compact one-line output")
    parser.add_argument("--json", action="store_true", help="Output results in JSON format")

    args = parser.parse_args()

    def output_result(decoded):
        if args.json:
            print(json.dumps(decoded), flush=True)
        elif args.compact:
            print_compact_line(decoded)
        else:
            print_decoded_card(decoded)
            sys.stdout.flush()

    if args.code:
        decoded = decode_ac_packet(args.code)
        output_result(decoded)
    elif args.file:
        if not os.path.exists(args.file):
            print(f"Error: File '{args.file}' not found.")
            sys.exit(1)
        with open(args.file) as f:
            for idx, line in enumerate(f):
                line = line.strip()
                if line.startswith("00000010"):
                    decoded = decode_ac_packet(line)
                    output_result(decoded)
    elif not sys.stdin.isatty() and not args.listen:
        # Piped input from stdin!
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                if line.startswith("00000010"):
                    decoded = decode_ac_packet(line)
                    output_result(decoded)
        except KeyboardInterrupt:
            pass
    else:
        # Default behavior: live listening on device
        live_listener(device=args.device, count=args.count, json_output=args.json)

if __name__ == "__main__":
    main()
