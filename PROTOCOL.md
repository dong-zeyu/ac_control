# AEHA Air Conditioner Infrared Protocol Specification (Sanyo KMHS0772)

This document specifies the reverse-engineered 19-byte (152-bit) infrared control protocol captured and verified on the **Sanyo KMHS0772** air conditioner (using remote control model **RCS-KMHS0772** / AEHA format).

---

## 1. Physical Layer & Modulation

The transmission uses standard **Pulse Distance Modulation (PDM)** modulated at a 38 kHz carrier frequency.

* **Base unit timing**: $T \approx 430\text{–}440\ \mu\text{s}$
* **Bit ordering**: **LSB-first** (Least Significant Bit transmitted first for each byte)
* **Idle state**: High (carrier off)

### Timings

| Element | Pulse Duration | Space Duration | Notes |
| :--- | :--- | :--- | :--- |
| **Leader / Header** | $3300\ \mu\text{s}\ (\approx 8T)$ | $1725\ \mu\text{s}\ (\approx 4T)$ | Signals frame start to receiver AGC |
| **Data Bit `0`** | $440\ \mu\text{s}\ (1T)$ | $405\ \mu\text{s}\ (1T)$ | Total period $\approx 845\ \mu\text{s}$ |
| **Data Bit `1`** | $440\ \mu\text{s}\ (1T)$ | $1290\ \mu\text{s}\ (3T)$ | Total period $\approx 1730\ \mu\text{s}$ |
| **Trailer / Stop** | $440\ \mu\text{s}\ (1T)$ | $\ge 10000\ \mu\text{s}$ | Frame terminator |

---

## 2. Frame Structure Overview

A complete transmission packet consists of exactly **19 Bytes (152 bits)** transmitted LSB-first. Every remote button press broadcasts the **complete device state**.

The packet is organized into **5 functional groups**:

```text
===================================================================================
      AEHA AIR CONDITIONER INFRARED PROTOCOL PACKET STRUCTURE (19 Bytes)
===================================================================================

[Group 1: Bytes 01 - 05] Fixed Header & Vendor Sync Marker
+--------+--------+--------+--------+--------+
| Byte 01| Byte 02| Byte 03| Byte 04| Byte 05|
|00000010|00000000|00101000|00000001|01110110|
+--------+--------+--------+--------+--------+

[Group 2: Bytes 06 - 09] Core Climate & Power State
+--------+--------+--------+--------+
| Byte 06| Byte 07| Byte 08| Byte 09|
|PPSSFNMM|TTTTTTCm|cccccc00|11000Q00|
+--------+--------+--------+--------+
 | | |||  |     || |             |
 | | |||  |     || |             +-------> Q:      Absolute Power State (1=Unit ON, 0=Unit OFF)
 | | |||  |     || +---------------------> cccccc: Measured Room Temp (6-bit, (T_C - 4.0) / 0.5)
 | | |||  |     |+-----------------------> m:      Mode Extension Bit (1=Auto Mode, 0=Others)
 | | |||  |     +------------------------> C:      Combo Timer Active Flag (1=Both Active)
 | | |||  +------------------------------> TTTTTT: Target Temperature (6-bit, (T_C - 4.0) / 0.5)
 | | ||+---------------------------------> MM:     Operating Mode (00=Auto, 01=Cool, 10=Heat, 11=Dry)
 | | |+----------------------------------> N:      Timer ON Active Flag (1=Enabled, 0=Disabled)
 | | +-----------------------------------> F:      Timer OFF Active Flag (1=Enabled, 0=Disabled)
 | +-------------------------------------> SS:     Fan Speed (00=Auto, 01=Low, 11=Med, 10=High)
 +---------------------------------------> PP:     Power Action (00=Maintain, 01=ON, 10=OFF)

[Group 3: Bytes 10 - 13] Timers & Real-Time Clock
+--------+--------+--------+--------+
| Byte 10| Byte 11| Byte 12| Byte 13|
|oooOOOOO|iiiIIIII|MMMMMMhh|hhh00000|
+--------+--------+--------+--------+
 |  |     |  |     |     |  |
 |  |     |  |     |     |  +--------> hhh:    RTC Clock Hours [2:4] (High 3 bits of hour 0..23)
 |  |     |  |     |     +-----------> hh:     RTC Clock Hours [0:1] (Low 2 bits of hour 0..23)
 |  |     |  |     +-----------------> MMMMMM: RTC Clock Minutes (6-bit, values 0..59)
 |  |     |  +-----------------------> IIIII:  Timer ON Hours (5-bit, values 0..23)
 |  |     +--------------------------> iii:    Timer ON Minutes / 10 (3-bit, 0..5 -> 0, 10..50 min)
 |  +--------------------------------> OOOOO:  Timer OFF Hours (5-bit, values 0..23)
 +-----------------------------------> ooo:    Timer OFF Minutes / 10 (3-bit, 0..5 -> 0, 10..50 min)

[Group 4: Bytes 14 - 16] Flap & Auxiliary Options
+--------+--------+--------+
| Byte 14| Byte 15| Byte 16|
|VVV10000|N00HI000|S0000000|
+--------+--------+--------+
 |  |     |  ||    |
 |  |     |  ||    +-------> S:   Quiet / Silent Fan Mode (1=ON, 0=OFF)
 |  |     |  |+------------> I:   ION Mode / Air Purifier (1=ON, 0=OFF)
 |  |     |  +-------------> H:   High Power / Turbo Mode (1=ON, 0=OFF)
 |  |     +----------------> N:   Night Setback / Sleep Mode (1=ON, 0=OFF)
 |  +----------------------> 1:   Flap Active Flag (Fixed to 1)
 +-------------------------> VVV: Flap / Louver Direction (0=Swing, 1=Auto, 2..7=Pos 1..6)

[Group 5: Bytes 17 - 19] Frame Footer & Integrity Checksum
+--------+--------+--------+
| Byte 17| Byte 18| Byte 19|
|00000000|00000000|CCCCCCCC|
+--------+--------+--------+
                   |
                   +-------> CCCCCCCC: 8-bit Checksum (4-bit Nibble Sum minus 8)
===================================================================================
```

---

## 3. Detailed Group Specifications

### Group 1: Fixed Header & Vendor Sync (Bytes 01 – 05)

```text
+--------+--------+--------+--------+--------+
| Byte 01| Byte 02| Byte 03| Byte 04| Byte 05|
|00000010|00000000|00101000|00000001|01110110|
+--------+--------+--------+--------+--------+
```

| Byte | Transmitted (LSB) | Hex (MSB) | Description |
| :--- | :--- | :--- | :--- |
| **Byte 01** | `00000010` | `0x40` | AEHA Vendor Customer Code (Low Byte) |
| **Byte 02** | `00000000` | `0x00` | Vendor Sub-ID |
| **Byte 03** | `00101000` | `0x14` | Vendor Device Identifier |
| **Byte 04** | `00000001` | `0x80` | Model Series Identifier |
| **Byte 05** | `01110110` | `0x6E` | Protocol Synchronization Marker |

---

### Group 2: Core Climate & Power State (Bytes 06 – 09)

```text
+--------+--------+--------+--------+
| Byte 06| Byte 07| Byte 08| Byte 09|
|PPSSFNMM|TTTTTTCm|cccccc00|11000Q00|
+--------+--------+--------+--------+
```

| Byte | Bits | Field | Function & Values |
| :--- | :--- | :--- | :--- |
| **Byte 06** | `0..1` | `PP` | **Power Action Command**<br>`00` = Maintain current state / Settings update only<br>`01` = Turn ON<br>`10` = Turn OFF |
| | `2..3` | `SS` | **Fan Speed**<br>`00` = Auto<br>`01` = Low<br>`11` = Medium<br>`10` = High |
| | `4` | `F` | **Timer OFF Active Flag** (`1` = Enabled, `0` = Disabled) |
| | `5` | `N` | **Timer ON Active Flag** (`1` = Enabled, `0` = Disabled) |
| | `6..7` | `MM` | **Operating Mode**<br>`00` = Auto Mode (requires Byte 07 bit 7 `m = 1`)<br>`01` = Cooling<br>`10` = Heating<br>`11` = Dehumidify / Dry |
| **Byte 07** | `0..5` | `TTTTTT` | **Target Temperature** (6-bit integer, LSB-first)<br>Formula: $\text{Raw} = (T_C - 4.0) / 0.5$ |
| | `6` | `C` | **Combo Timer Flag** (`1` = Both ON and OFF timers active) |
| | `7` | `m` | **Mode Extension Bit** (`1` = Auto Mode, `0` = Others) |
| **Byte 08** | `0..5` | `cccccc` | **Measured Room Temperature** (6-bit integer, LSB-first)<br>Formula: $\text{Raw} = (T_C - 4.0) / 0.5$ |
| | `6..7` | `00` | Fixed zeros |
| **Byte 09** | `0..1` | `11` | Fixed prefix bits |
| | `2..4` | `000` | Fixed zeros |
| | `5` | `Q` | **Absolute Power State** (`1` = Unit is ON, `0` = Unit is OFF) |
| | `6..7` | `00` | Fixed zeros |

#### Temperature Encoding Reference
$$\text{RawValue} = \text{round}\left(\frac{T_C - 4.0^\circ\text{C}}{0.5^\circ\text{C}}\right) = \text{round}\Big(2 \times (T_C - 4.0^\circ\text{C})\Big)$$
$$T_C = 4.0^\circ\text{C} + (0.5^\circ\text{C} \times \text{RawValue})$$

| Temperature ($T_C$) | Raw Integer | 6-bit Binary (MSB) | Transmitted Bits (LSB) |
| :--- | :--- | :--- | :--- |
| **$16.0^\circ\text{C}$** | $24$ | `011000` | `000110` |
| **$18.0^\circ\text{C}$** | $28$ | `011100` | `001110` |
| **$20.0^\circ\text{C}$** | $32$ | `100000` | `000001` |
| **$22.0^\circ\text{C}$** | $36$ | `100100` | `001001` |
| **$24.0^\circ\text{C}$** | $40$ | `101000` | `000101` |
| **$25.0^\circ\text{C}$** | $42$ | `101010` | `010101` |
| **$26.0^\circ\text{C}$** | $44$ | `101100` | `001101` |
| **$28.0^\circ\text{C}$** | $48$ | `110000` | `000011` |
| **$30.0^\circ\text{C}$** | $52$ | `110100` | `001011` |

---

### Group 3: Timers & Real-Time Clock (Bytes 10 – 13)

```text
+--------+--------+--------+--------+
| Byte 10| Byte 11| Byte 12| Byte 13|
|oooOOOOO|iiiIIIII|MMMMMMhh|hhh00000|
+--------+--------+--------+--------+
```

| Byte | Bits | Field | Function & Values |
| :--- | :--- | :--- | :--- |
| **Byte 10** | `0..2` | `ooo` | **Timer OFF Minutes**: Tens of minutes ($0\text{–}5 \rightarrow 0, 10, 20, 30, 40, 50\ \text{min}$) |
| | `3..7` | `OOOOO` | **Timer OFF Hours**: $0\text{–}23$ hours (5-bit integer) |
| **Byte 11** | `0..2` | `iii` | **Timer ON Minutes**: Tens of minutes ($0\text{–}5 \rightarrow 0, 10, 20, 30, 40, 50\ \text{min}$) |
| | `3..7` | `IIIII` | **Timer ON Hours**: $0\text{–}23$ hours (5-bit integer) |
| **Byte 12** | `0..5` | `MMMMMM` | **RTC Clock Minutes**: $0\text{–}59$ minutes (6-bit integer) |
| | `6..7` | `hh` | **RTC Clock Hours [0:1]**: Low 2 bits of hour ($0\text{–}23$) |
| **Byte 13** | `0..2` | `hhh` | **RTC Clock Hours [2:4]**: High 3 bits of hour ($0\text{–}23$) |
| | `3..7` | `00000` | Fixed zeros |

> [!TIP]
> **1hr Timer Implementation:**  
> The physical remote has no separate "1hr timer" bit. When pressed, the remote computes `target_time = current_clock + 1 hour` (rounded up to the next 10-minute increment), activates the Timer OFF flag (`Byte 06, Bit 4 = 1`), and writes the target shutdown time into **Byte 10**.

---

### Group 4: Flap & Auxiliary Options (Bytes 14 – 16)

```text
+--------+--------+--------+
| Byte 14| Byte 15| Byte 16|
|VVV10000|N00HI000|S0000000|
+--------+--------+--------+
```

| Byte | Bits | Field | Function & Values |
| :--- | :--- | :--- | :--- |
| **Byte 14** | `0..2` | `VVV` | **Flap / Louver Direction** (3-bit integer, values $0\text{–}7$):<br>`0` = Louver (Continuous Swing)<br>`1` = Auto Flap<br>`2` = Position 1 (Bottom)<br>`3` = Position 2<br>`4` = Position 3<br>`5` = Position 4<br>`6` = Position 5<br>`7` = Position 6 (Top) |
| | `3` | `1` | **Flap Feature Flag**: Fixed to `1` |
| | `4..7` | `0000` | Fixed zeros |
| **Byte 15** | `0` | `N` | **Night Setback / Sleep Mode** (`1` = ON, `0` = OFF) |
| | `1..2` | `00` | Fixed zeros |
| | `3` | `H` | **High Power / Turbo Mode** (`1` = ON, `0` = OFF) |
| | `4` | `I` | **ION Mode / Air Purifier** (`1` = ON, `0` = OFF) |
| | `5..7` | `000` | Fixed zeros |
| **Byte 16** | `0` | `S` | **Quiet / Silent Fan Mode** (`1` = ON, `0` = OFF) |
| | `1..7` | `0000000` | Fixed zeros |

#### Flap Encoding Lookup Table
| Flap Mode | 3-bit Decimal (`VVV`) | 3-bit Binary (LSB) | Byte 14 (LSB String) | Hex (MSB) |
| :--- | :--- | :--- | :--- | :--- |
| **Louver (Continuous Swing)** | `0` | `000` | `00010000` | `0x08` |
| **Auto Flap** | `1` | `100` | `10010000` | `0x09` |
| **Position 1 (Bottom)** | `2` | `010` | `01010000` | `0x0A` |
| **Position 2** | `3` | `110` | `11010000` | `0x0B` |
| **Position 3** | `4` | `001` | `00110000` | `0x0C` |
| **Position 4** | `5` | `101` | `10110000` | `0x0D` |
| **Position 5** | `6` | `011` | `01110000` | `0x0E` |
| **Position 6 (Top)** | `7` | `111` | `11110000` | `0x0F` |

---

### Group 5: Frame Footer & Integrity Checksum (Bytes 17 – 19)

```text
+--------+--------+--------+
| Byte 17| Byte 18| Byte 19|
|00000000|00000000|CCCCCCCC|
+--------+--------+--------+
```

| Byte | Bits | Field | Function & Values |
| :--- | :--- | :--- | :--- |
| **Byte 17** | `0..7` | `00000000` | Frame Footer Padding: Fixed `0x00` |
| **Byte 18** | `0..7` | `00000000` | Frame Footer Padding: Fixed `0x00` |
| **Byte 19** | `0..7` | `CCCCCCCC` | **8-bit Checksum**: Nibble summation algorithm (see below) |

#### Checksum Algorithm
The checksum is calculated over the physical byte values of **Bytes 01 through 18** using a 4-bit nibble summation with an offset of `-8`:

```python
# 1. Reverse LSB bitstrings to physical byte values
actual_bytes = [int(b[::-1], 2) for b in bytes_01_to_18]

# 2. Accumulate high and low 4-bit nibbles across all 18 bytes
nibble_sum = sum((byte >> 4) + (byte & 0x0F) for byte in actual_bytes)

# 3. Subtract fixed offset 8 and mask to 8 bits
checksum = (nibble_sum - 8) % 256

# 4. Transmit LSB-first for physical infrared transmission
checksum_lsb = f"{checksum:08b}"[::-1]
```
