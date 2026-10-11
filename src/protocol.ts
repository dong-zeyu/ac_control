import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ioctl = require('ioctl');

const LIRC_SET_SEND_CARRIER = 0x40046913;
const LIRC_SET_SEND_DUTY_CYCLE = 0x40046915;

export type AcMode = 'cooling' | 'heating' | 'auto' | 'dehumidify';
export type FanSpeed = 'auto' | 'low' | 'med' | 'high';
export type FlapPosition = 'auto' | 'swing' | 'high' | 'top' | 1 | 2 | 3 | 4 | 5 | 6;

export interface AcOptions {
  powerOn?: boolean;
  powerAction?: 'on' | 'off' | 'maintain' | null;
  tempC?: number;
  measuredTempC?: number;
  mode?: AcMode;
  fanSpeed?: FanSpeed;
  flap?: FlapPosition;
  nightSetback?: boolean;
  highPower?: boolean;
  ionMode?: boolean;
  quietMode?: boolean;
  timerMode?: 'on' | 'off' | 'combo' | null;
  timerOnHours?: number;
  timerOnMinutes?: number;
  timerOffHours?: number;
  timerOffMinutes?: number;
  currentTimeHours?: number;
  currentTimeMinutes?: number;
}

function toLsb(val: number, width: number): string {
  return val.toString(2).padStart(width, '0').split('').reverse().join('');
}

/**
 * Generates the AEHA 19-byte (152-bit) LSB-first packet.
 */
export function generateAcCodeLsb(opts: AcOptions = {}): string {
  const {
    powerOn = true,
    powerAction = null,
    tempC = 24.0,
    measuredTempC = 24.0,
    mode = 'cooling',
    fanSpeed = 'auto',
    flap = 6,
    nightSetback = false,
    highPower = false,
    ionMode = false,
    quietMode = false,
    timerMode = null,
    timerOnHours = 0,
    timerOnMinutes = 0,
    timerOffHours = 0,
    timerOffMinutes = 0,
    currentTimeHours = new Date().getHours(),
    currentTimeMinutes = new Date().getMinutes()
  } = opts;

  const baseBytes = [
    '00000010', '00000000', '00101000', '00000001',
    '01110110', '10000001', '00010100', '11110111',
    '11000000', '00010010', '00010001', '01101011',
    '11000000', '10010000', '00000000', '10000000',
    '00000000', '00000000'
  ];

  const b6 = new Array(8).fill('0');
  let b9PowerBit = '0';

  if (timerMode) {
    b6[0] = '0'; b6[1] = '0';
    b9PowerBit = powerOn ? '1' : '0';
    if (timerMode === 'on') {
      b6[4] = '0'; b6[5] = '1';
    } else if (timerMode === 'off') {
      b6[4] = '1'; b6[5] = '0';
    } else if (timerMode === 'combo') {
      b6[4] = '0'; b6[5] = '1';
    }
  } else {
    if (powerAction === 'maintain') {
      b6[0] = '0'; b6[1] = '0';
      b9PowerBit = powerOn ? '1' : '0';
    } else if (powerAction === 'on' || (powerAction === null && powerOn)) {
      b6[0] = '0'; b6[1] = '1';
      b9PowerBit = '1';
    } else {
      b6[0] = '1'; b6[1] = '0';
      b9PowerBit = '0';
    }
    b6[4] = '0'; b6[5] = '0';
  }

  // Fan speed SS (bits 2..3)
  const fan = String(fanSpeed).toLowerCase();
  if (fan === 'medium' || fan === 'med') {
    b6[2] = '1'; b6[3] = '1';
  } else if (fan === 'low') {
    b6[2] = '0'; b6[3] = '1';
  } else if (fan === 'high') {
    b6[2] = '1'; b6[3] = '0';
  } else {
    b6[2] = '0'; b6[3] = '0';
  }

  // Mode MM (bits 6..7) & ModeExt m (Byte 07 bit 7)
  let modeB7 = '0';
  if (mode === 'cooling') {
    b6[6] = '0'; b6[7] = '1';
    modeB7 = '0';
  } else if (mode === 'auto') {
    b6[6] = '0'; b6[7] = '0';
    modeB7 = '1';
  } else if (mode === 'heating') {
    b6[6] = '1'; b6[7] = '0';
    modeB7 = '0';
  } else if (mode === 'dehumidify') {
    b6[6] = '1'; b6[7] = '1';
    modeB7 = '0';
  }

  baseBytes[5] = b6.join('');
  baseBytes[8] = baseBytes[8].slice(0, 5) + b9PowerBit + baseBytes[8].slice(6);

  // Target temperature formula: Raw = (T_C - 4.0) / 0.5
  const clampedTemp = Math.max(16.0, Math.min(30.0, tempC));
  const tVal = Math.round((clampedTemp - 4.0) / 0.5);
  const comboFlag = timerMode === 'combo' ? '1' : '0';
  baseBytes[6] = toLsb(tVal, 6) + comboFlag + modeB7;

  // Measured room temperature
  const cVal = Math.round((measuredTempC - 4.0) / 0.5);
  baseBytes[7] = toLsb(cVal, 6) + baseBytes[7].slice(6);

  // Timers
  if (timerMode === 'off' || timerMode === 'combo') {
    const valOff = (timerOffHours << 3) | Math.floor(timerOffMinutes / 10);
    baseBytes[9] = toLsb(valOff, 8);
  }
  if (timerMode === 'on' || timerMode === 'combo') {
    const valOn = (timerOnHours << 3) | Math.floor(timerOnMinutes / 10);
    baseBytes[10] = toLsb(valOn, 8);
  }

  // Real-Time Clock
  const rtcMBits = toLsb(currentTimeMinutes, 6);
  const rtcHBits = toLsb(currentTimeHours, 5);
  baseBytes[11] = rtcMBits + rtcHBits.slice(0, 2);
  baseBytes[12] = rtcHBits.slice(2, 5) + baseBytes[12].slice(3);

  // Quiet Mode (Byte 16 bit 0)
  const sBit = quietMode ? '1' : '0';
  baseBytes[15] = sBit + baseBytes[15].slice(1);

  // Flap / Louver (Byte 14 bits 0..2, bit 3 fixed '1')
  // 3-bit VVV: 0 = Louver/Swing, 1 = Auto, 2..7 = Position 1 (bottom) .. 6 (top)
  const flapStr = String(flap).toLowerCase();
  let vVal = 7; // Default to 7 (Pos 6 - Top / High pos)
  if (flapStr === 'swing' || flapStr === 'louver') {
    vVal = 0;
  } else if (flapStr === 'auto') {
    vVal = 1;
  } else if (flapStr === 'high' || flapStr === 'top') {
    vVal = 7;
  } else if (flapStr === 'bottom' || flapStr === 'low') {
    vVal = 2;
  } else {
    const pos = parseInt(flapStr, 10);
    if (!isNaN(pos) && pos >= 1 && pos <= 6) {
      vVal = 1 + pos;
    }
  }
  const vBits = toLsb(vVal, 3);
  baseBytes[13] = vBits + '1' + baseBytes[13].slice(4);

  // Options Register (Byte 15: N bit 0, H bit 3, I bit 4)
  const nBit = nightSetback ? '1' : '0';
  const hBit = highPower ? '1' : '0';
  const iBit = ionMode ? '1' : '0';
  baseBytes[14] = nBit + baseBytes[14].slice(1, 3) + hBit + iBit + baseBytes[14].slice(5);

  // Checksum calculation (4-bit nibble sum - 8 modulo 256)
  const actualBytes = baseBytes.map(b => parseInt(b.split('').reverse().join(''), 2));
  const nibbleSum = actualBytes.reduce((sum, b) => sum + (b >> 4) + (b & 0x0f), 0);
  const checksum = ((nibbleSum - 8) % 256 + 256) % 256;
  const checksumBin = toLsb(checksum, 8);

  return [...baseBytes, checksumBin].join(' ');
}

/**
 * Formats 152-bit binary string into PDM timing pulses for ir-ctl.
 */
export function binaryToIrCtlPulses(binaryStr: string): string {
  const HEADER_PULSE = 3300;
  const HEADER_SPACE = 1725;
  const BIT_MARK = 440;
  const BIT_SPACE_0 = 405;
  const BIT_SPACE_1 = 1290;
  const TRAILER_PULSE = 440;

  const bits = binaryStr.replace(/\s+/g, '');
  const lines: string[] = [];

  lines.push(`pulse ${HEADER_PULSE}`);
  lines.push(`space ${HEADER_SPACE}`);

  for (const bit of bits) {
    lines.push(`pulse ${BIT_MARK}`);
    if (bit === '1') {
      lines.push(`space ${BIT_SPACE_1}`);
    } else {
      lines.push(`space ${BIT_SPACE_0}`);
    }
  }

  lines.push(`pulse ${TRAILER_PULSE}`);
  lines.push('space 10000');
  return lines.join('\n') + '\n';
}

/**
 * Converts a 152-bit binary string into an array of microsecond pulse/space durations.
 */
export function binaryToDurations(binaryStr: string): number[] {
  const HEADER_PULSE = 3300;
  const HEADER_SPACE = 1725;
  const BIT_MARK = 440;
  const BIT_SPACE_0 = 405;
  const BIT_SPACE_1 = 1290;
  const TRAILER_PULSE = 440;

  const bits = binaryStr.replace(/\s+/g, '');
  const durations: number[] = [HEADER_PULSE, HEADER_SPACE];
  for (const b of bits) {
    durations.push(BIT_MARK);
    durations.push(b === '1' ? BIT_SPACE_1 : BIT_SPACE_0);
  }
  durations.push(TRAILER_PULSE);
  return durations;
}

/**
 * Transmits the infrared signal directly to the Linux kernel LIRC character device (/dev/lirc0).
 * High performance (< 1ms), pure async I/O, zero subprocesses, zero external CLI dependencies.
 * Uses native Linux ioctl to configure carrier frequency (default 38 kHz) and duty cycle (default 50%).
 */
export async function transmitIr(
  binaryStr: string,
  device = '/dev/lirc0',
  carrier = 38000,
  dutyCycle = 50
): Promise<void> {
  const durations = binaryToDurations(binaryStr);
  const buf = Buffer.alloc(durations.length * 4);
  for (let i = 0; i < durations.length; i++) {
    buf.writeUInt32LE(durations[i], i * 4);
  }

  const handle = await fs.open(device, 'r+');
  try {
    const carrierBuf = Buffer.alloc(4);
    carrierBuf.writeUInt32LE(carrier, 0);
    ioctl(handle.fd, LIRC_SET_SEND_CARRIER, carrierBuf);

    const dutyBuf = Buffer.alloc(4);
    dutyBuf.writeUInt32LE(dutyCycle, 0);
    ioctl(handle.fd, LIRC_SET_SEND_DUTY_CYCLE, dutyBuf);

    await handle.write(buf, 0, buf.length);
  } finally {
    await handle.close();
  }
}
