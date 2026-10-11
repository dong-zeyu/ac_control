import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { AcMode, FanSpeed, FlapPosition, generateAcCodeLsb, transmitIr } from './protocol.js';

export type TimerMode = 'on' | 'off' | 'combo' | null;

/**
 * Calculate Apparent Temperature (°C) using Steadman's formula (indoor / shade):
 *   AT = Ta + 0.33 * e - 0.70 * v - 4.00
 * where water vapor pressure e (hPa) is:
 *   e = (RH / 100) * 6.105 * exp((17.27 * Ta) / (237.7 + Ta))
 */
export function calculateApparentTemperature(
  tempC: number,
  relativeHumidity: number,
  windSpeedMs = 0
): number {
  const rh = Math.max(0, Math.min(100, relativeHumidity));
  const vaporPressureHpa = (rh / 100) * 6.105 * Math.exp((17.27 * tempC) / (237.7 + tempC));
  const at = tempC + 0.33 * vaporPressureHpa - 0.70 * windSpeedMs - 4.0;
  return Math.round(at * 10) / 10;
}

export interface AcDeviceState {
  power: boolean;
  mode: AcMode;
  targetTemperature: number;
  measuredTemperature: number;
  measuredHumidity: number;
  apparentTemperature: number;
  fanSpeed: FanSpeed;
  flap: FlapPosition;
  quietMode: boolean;
  highPower: boolean;
  ionMode: boolean;
  nightSetback: boolean;
  timerOnEnabled: boolean;
  timerOffEnabled: boolean;
  timerMode: TimerMode;
  timerOnHours: number;
  timerOnMinutes: number;
  timerOffHours: number;
  timerOffMinutes: number;
  lastUpdated?: string;
  lastPacketLsb?: string;
}

export interface UpdateTransmitOptions {
  forceTransmit?: boolean;
  skipTransmit?: boolean;
  powerActionOverride?: 'on' | 'off' | 'maintain' | 'cancel_timer';
}

export const DEFAULT_AC_STATE: AcDeviceState = {
  power: false,
  mode: 'cooling',
  targetTemperature: 24.0,
  measuredTemperature: 24.0,
  measuredHumidity: 50.0,
  apparentTemperature: calculateApparentTemperature(24.0, 50.0, 0),
  fanSpeed: 'auto',
  flap: 6, // High pos (top) instead of auto for non-swing
  quietMode: false,
  highPower: false,
  ionMode: false,
  nightSetback: false,
  timerOnEnabled: false,
  timerOffEnabled: false,
  timerMode: null,
  timerOnHours: 7,
  timerOnMinutes: 0,
  timerOffHours: 23,
  timerOffMinutes: 0,
};

export class AcStateManager {
  private state: AcDeviceState = { ...DEFAULT_AC_STATE };
  private stateFilePath: string;
  private irDevice: string;
  private dhtSensor: string;
  private humiditySensor: string;
  private defaultFlap: FlapPosition;
  private carrierFrequency: number;
  private dutyCycle: number;
  private listeners: Set<(state: Readonly<AcDeviceState>) => void> = new Set();
  private watchingFile = false;

  constructor(
    storageDir: string,
    irDevice = '/dev/lirc0',
    dhtSensor = '/dev/dht0:temp',
    defaultFlap: FlapPosition = 6,
    carrierFrequency = 38000,
    dutyCycle = 50,
    humiditySensor = '/dev/dht0:humid'
  ) {
    this.stateFilePath = path.join(storageDir, 'aeha_ac_state.json');
    this.irDevice = irDevice;
    this.dhtSensor = dhtSensor;
    this.humiditySensor = humiditySensor;
    this.defaultFlap = defaultFlap;
    this.carrierFrequency = carrierFrequency;
    this.dutyCycle = dutyCycle;
    this.state.flap = defaultFlap;
  }

  onChange(listener: (state: Readonly<AcDeviceState>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const snapshot = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Ignore listener errors
      }
    }
  }

  startFileWatch(): void {
    if (this.watchingFile) return;
    this.watchingFile = true;
    fsSync.watchFile(this.stateFilePath, { interval: 500 }, async (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return;
      try {
        const data = await fs.readFile(this.stateFilePath, 'utf-8');
        const loaded = JSON.parse(data) as AcDeviceState;
        if (loaded.lastUpdated && loaded.lastUpdated !== this.state.lastUpdated) {
          this.state = { ...DEFAULT_AC_STATE, ...loaded };
          this.state.apparentTemperature = calculateApparentTemperature(
            this.state.measuredTemperature,
            this.state.measuredHumidity,
            0
          );
          this.notifyListeners();
        }
      } catch {
        // Ignore transient read/parse errors
      }
    });
  }

  stopFileWatch(): void {
    if (!this.watchingFile) return;
    this.watchingFile = false;
    fsSync.unwatchFile(this.stateFilePath);
  }

  async init(): Promise<void> {
    try {
      const data = await fs.readFile(this.stateFilePath, 'utf-8');
      const loaded = JSON.parse(data);
      this.state = { ...DEFAULT_AC_STATE, ...loaded };
      // Migrate legacy 'auto' to high position if configured
      if (this.state.flap === 'auto' && this.defaultFlap !== 'auto') {
        this.state.flap = this.defaultFlap;
      }
      // Ensure timerOnEnabled / timerOffEnabled match timerMode if migrated
      if (typeof loaded.timerOnEnabled !== 'boolean') {
        this.state.timerOnEnabled = this.state.timerMode === 'on' || this.state.timerMode === 'combo';
      }
      if (typeof loaded.timerOffEnabled !== 'boolean') {
        this.state.timerOffEnabled = this.state.timerMode === 'off' || this.state.timerMode === 'combo';
      }
    } catch {
      // Use defaults if file does not exist
      this.state = { ...DEFAULT_AC_STATE, flap: this.defaultFlap };
    }

    // Try reading current ambient temperature and humidity
    const ambient = await this.readAmbientTemperature();
    if (ambient !== null) {
      this.state.measuredTemperature = ambient;
    }
    const humidity = await this.readAmbientHumidity();
    if (humidity !== null) {
      this.state.measuredHumidity = humidity;
    }
    this.state.apparentTemperature = calculateApparentTemperature(
      this.state.measuredTemperature,
      this.state.measuredHumidity,
      0
    );

    this.state.lastPacketLsb = this.buildPacketPreview();

    try {
      await fs.writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch {
      // Ignore initial write error
    }
  }

  getState(): Readonly<AcDeviceState> {
    return { ...this.state };
  }

  getDefaultFlap(): FlapPosition {
    return this.defaultFlap;
  }

  buildPacketPreview(powerActionOverride?: 'on' | 'off' | 'maintain' | 'cancel_timer' | null): string {
    return generateAcCodeLsb({
      powerOn: this.state.power,
      powerAction: powerActionOverride ?? (this.state.power ? 'maintain' : 'off'),
      tempC: this.state.targetTemperature,
      measuredTempC: this.state.measuredTemperature,
      mode: this.state.mode,
      fanSpeed: this.state.fanSpeed,
      flap: this.state.flap,
      nightSetback: this.state.nightSetback,
      highPower: this.state.highPower,
      ionMode: this.state.ionMode,
      quietMode: this.state.quietMode,
      timerMode: this.state.timerMode,
      timerOnHours: this.state.timerOnHours,
      timerOnMinutes: this.state.timerOnMinutes,
      timerOffHours: this.state.timerOffHours,
      timerOffMinutes: this.state.timerOffMinutes,
    });
  }

  async readAmbientTemperature(): Promise<number | null> {
    try {
      const raw = await fs.readFile(this.dhtSensor, 'utf-8');
      const val = parseFloat(raw.trim());
      if (!isNaN(val)) {
        return Math.round((val / 1000) * 10) / 10;
      }
    } catch {
      // Fallback if sensor is unavailable
    }
    return null;
  }

  async readAmbientHumidity(): Promise<number | null> {
    try {
      const raw = await fs.readFile(this.humiditySensor, 'utf-8');
      const val = parseFloat(raw.trim());
      if (!isNaN(val)) {
        const pct = val > 100 ? val / 1000 : val;
        return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
      }
    } catch {
      // Fallback if humidity sensor is unavailable
    }
    return null;
  }

  async refreshAmbientTemperature(): Promise<number | null> {
    const ambient = await this.readAmbientTemperature();
    const humidity = await this.readAmbientHumidity();
    let changed = false;

    if (ambient !== null && ambient !== this.state.measuredTemperature) {
      this.state.measuredTemperature = ambient;
      changed = true;
    }
    if (humidity !== null && humidity !== this.state.measuredHumidity) {
      this.state.measuredHumidity = humidity;
      changed = true;
    }

    const newApparent = calculateApparentTemperature(
      this.state.measuredTemperature,
      this.state.measuredHumidity,
      0
    );
    if (newApparent !== this.state.apparentTemperature) {
      this.state.apparentTemperature = newApparent;
      changed = true;
    }

    if (changed) {
      this.state.lastPacketLsb = this.buildPacketPreview();
      try {
        await fs.writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
      } catch {
        // Ignore save error
      }
      this.notifyListeners();
    }
    return ambient;
  }

  async cancelTimer(): Promise<void> {
    await this.updateAndTransmit(
      { timerOnEnabled: false, timerOffEnabled: false, timerMode: null },
      { forceTransmit: true, powerActionOverride: 'cancel_timer' }
    );
  }

  async retransmit(): Promise<void> {
    await this.updateAndTransmit({}, { forceTransmit: true });
  }

  async updateAndTransmit(
    updates: Partial<AcDeviceState>,
    options: UpdateTransmitOptions = {}
  ): Promise<void> {
    const wasPower = this.state.power;
    const wasTimerActive = this.state.timerMode !== null || this.state.timerOnEnabled || this.state.timerOffEnabled;

    // Interlock logic: High power disables quiet mode, and quiet mode disables high power
    if (updates.highPower === true) {
      updates.quietMode = false;
    }
    if (updates.quietMode === true) {
      updates.highPower = false;
    }

    // Clamp targetTemperature if provided
    if (typeof updates.targetTemperature === 'number' && !isNaN(updates.targetTemperature)) {
      updates.targetTemperature = Math.max(16.0, Math.min(30.0, Math.round(updates.targetTemperature * 2) / 2));
    }

    // Synchronize independent timerOnEnabled / timerOffEnabled with timerMode
    if ('timerOnEnabled' in updates || 'timerOffEnabled' in updates) {
      const nextOn = updates.timerOnEnabled ?? this.state.timerOnEnabled;
      const nextOff = updates.timerOffEnabled ?? this.state.timerOffEnabled;
      updates.timerOnEnabled = nextOn;
      updates.timerOffEnabled = nextOff;
      updates.timerMode = nextOn && nextOff ? 'combo' : nextOn ? 'on' : nextOff ? 'off' : null;
    } else if ('timerMode' in updates) {
      updates.timerOnEnabled = updates.timerMode === 'on' || updates.timerMode === 'combo';
      updates.timerOffEnabled = updates.timerMode === 'off' || updates.timerMode === 'combo';
    }

    const touchedTimerFields =
      'timerOnEnabled' in updates ||
      'timerOffEnabled' in updates ||
      'timerMode' in updates ||
      ('timerOnHours' in updates && (updates.timerOnEnabled ?? this.state.timerOnEnabled)) ||
      ('timerOnMinutes' in updates && (updates.timerOnEnabled ?? this.state.timerOnEnabled)) ||
      ('timerOffHours' in updates && (updates.timerOffEnabled ?? this.state.timerOffEnabled)) ||
      ('timerOffMinutes' in updates && (updates.timerOffEnabled ?? this.state.timerOffEnabled));

    // Update in-memory state
    Object.assign(this.state, updates);
    this.state.lastUpdated = new Date().toISOString();

    // Refresh ambient temp & humidity
    const ambient = await this.readAmbientTemperature();
    if (ambient !== null) {
      this.state.measuredTemperature = ambient;
    }
    const humidity = await this.readAmbientHumidity();
    if (humidity !== null) {
      this.state.measuredHumidity = humidity;
    }
    this.state.apparentTemperature = calculateApparentTemperature(
      this.state.measuredTemperature,
      this.state.measuredHumidity,
      0
    );

    const isTurningOff = 'power' in updates && updates.power === false;
    const isTurningOn = 'power' in updates && updates.power === true && !wasPower;
    const isRunning = this.state.power;
    const isCancellingTimer = wasTimerActive && this.state.timerMode === null && ('timerOnEnabled' in updates || 'timerOffEnabled' in updates || 'timerMode' in updates);
    const hasTimerUpdate = (touchedTimerFields && this.state.timerMode !== null) || isCancellingTimer;

    const powerAction =
      options.powerActionOverride ??
      (isCancellingTimer ? 'cancel_timer' : isTurningOff ? 'off' : isTurningOn ? 'on' : 'maintain');

    // Generate IR packet
    const bitstring = generateAcCodeLsb({
      powerOn: this.state.power,
      powerAction,
      tempC: this.state.targetTemperature,
      measuredTempC: this.state.measuredTemperature,
      mode: this.state.mode,
      fanSpeed: this.state.fanSpeed,
      flap: this.state.flap,
      nightSetback: this.state.nightSetback,
      highPower: this.state.highPower,
      ionMode: this.state.ionMode,
      quietMode: this.state.quietMode,
      timerMode: powerAction === 'cancel_timer' ? null : this.state.timerMode,
      timerOnHours: this.state.timerOnHours,
      timerOnMinutes: this.state.timerOnMinutes,
      timerOffHours: this.state.timerOffHours,
      timerOffMinutes: this.state.timerOffMinutes,
    });

    this.state.lastPacketLsb = bitstring;

    // Save to disk asynchronously
    try {
      await fs.writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch {
      // Ignore save error
    }

    // Notify listeners (HomeKit, Matter, Embedded UI)
    this.notifyListeners();

    if (options.skipTransmit) {
      return;
    }

    // If the AC is OFF and this update is not turning it ON/OFF, setting/cancelling a timer, or forced, skip IR transmission
    if (!isRunning && !isTurningOff && !hasTimerUpdate && !options.forceTransmit) {
      return;
    }

    // Transmit via hardware
    await transmitIr(bitstring, this.irDevice, this.carrierFrequency, this.dutyCycle);
  }
}
