# AEHA Protocol Reference & Architecture

The **AEHA** (Association of Electronic Home Appliances, Japan / 家電製品協会) standard is one of the most widely used infrared protocols for HVAC and major home appliances manufactured by Japanese brands.

---

## 1. Physical Modulation & Timing

* **Carrier Frequency**: Standard **38 kHz** (occasionally 36.7 kHz or 40 kHz).
* **Modulation**: **Pulse Distance Modulation (PDM)**.
* **Base Unit Duration ($T$)**: Typically $\approx 420\ \mu\text{s} \sim 440\ \mu\text{s}$.
* **Header / Leader**:
  * Pulse: $\approx 8T$ ($3300\ \mu\text{s} \sim 3500\ \mu\text{s}$)
  * Space: $\approx 4T$ ($1600\ \mu\text{s} \sim 1750\ \mu\text{s}$)
* **Data Bit `0`**:
  * Pulse: $\approx 1T$ ($420\ \mu\text{s} \sim 450\ \mu\text{s}$)
  * Space: $\approx 1T$ ($400\ \mu\text{s} \sim 450\ \mu\text{s}$)
* **Data Bit `1`**:
  * Pulse: $\approx 1T$ ($420\ \mu\text{s} \sim 450\ \mu\text{s}$)
  * Space: $\approx 3T$ ($1250\ \mu\text{s} \sim 1300\ \mu\text{s}$)
* **Trailer / Stop Bit**:
  * Pulse: $\approx 1T$ ($420\ \mu\text{s} \sim 450\ \mu\text{s}$)
  * Space: Gap $\ge 10000\ \mu\text{s}$ before next frame or repeat.

---

## 2. Bit Ordering & Endianness

* **LSB-First (Least Significant Bit First)**:
  * Each byte is transmitted starting from Bit 0 up to Bit 7.
  * *Example*: If the byte value is `0x14` (`00010100` binary):
    * LSB-first transmission order: `0, 0, 1, 0, 1, 0, 0, 0`.

---

## 3. Common AEHA Vendor Codes (First 2 to 5 Bytes)

The first bytes of an AEHA packet typically identify the manufacturer and device category:

| Manufacturer | Typical Header Bytes (LSB-first) | Notes |
| :--- | :--- | :--- |
| **Sanyo** | `0x02, 0x00, 0x28, 0x01, 0x76` | Sanyo KMHS0772 / RCS-KMHS0772 (19 bytes) |
| **Panasonic** | `0x02, 0x20, 0xE0, 0x04, 0x00` | Standard Panasonic HVAC frames |
| **Daikin** | `0x11, 0xDA, 0x27, 0x00` | Multi-frame sequence (2 or 3 subframes) |
| **Mitsubishi** | `0x23, 0xCB, 0x26, 0x01, 0x00` | Mitsubishi Electric 18-byte format |
| **Sharp** | `0xAA, 0x5A, 0xCF, 0x10, 0x06` | Sharp AEHA HVAC |

---

## 4. Common Checksum Patterns

1. **Simple 8-bit Summation**:
   ```python
   checksum = sum(bytes[0:N-1]) & 0xFF
   ```
2. **Offset Summation**:
   ```python
   checksum = (sum(bytes[0:N-1]) + offset) & 0xFF
   ```
3. **XOR Parity**:
   ```python
   checksum = 0
   for b in bytes[0:N-1]:
       checksum ^= b
   ```
4. **Nibble Checksum**:
   Sum all 4-bit nibbles modulo 16.
