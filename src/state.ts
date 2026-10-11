import fs from 'node:fs/promises';
import path from 'node:path';
import { AcMode, FanSpeed, FlapPosition, generateAcCodeLsb, transmitIr } from './protocol.js';

export interface AcDeviceState {
  power: boolean;
  mode: AcMode;
  targetTemperature: number;
  measuredTemperature: number;
  fanSpeed: FanSpeed;
  flap: FlapPosition;
  quietMode: boolean;
  highPower: boolean;
  ionMode: boolean;
  nightSetback: boolean;
}

export const DEFAULT_AC_STATE: AcDeviceState = {
  power: false,
  mode: 'cooling',
  targetTemperature: 24.0,
  measuredTemperature: 24.0,
  fanSpeed: 'auto',
  flap: 6, // High pos (top) instead of auto for non-swing
  quietMode: false,
  highPower: false,
  ionMode: false,
  nightSetback: false,
};

export class AcStateManager {
  private state: AcDeviceState = { ...DEFAULT_AC_STATE };
  private stateFilePath: string;
  private irDevice: string;
  private dhtSensor: string;
  private defaultFlap: FlapPosition;
  private carrierFrequency: number;
  private dutyCycle: number;

  constructor(
    storageDir: string,
    irDevice = '/dev/lirc0',
    dhtSensor = '/dev/dht0:temp',
    defaultFlap: FlapPosition = 6,
    carrierFrequency = 38000,
    dutyCycle = 50
  ) {
    this.stateFilePath = path.join(storageDir, 'aeha_ac_state.json');
    this.irDevice = irDevice;
    this.dhtSensor = dhtSensor;
    this.defaultFlap = defaultFlap;
    this.carrierFrequency = carrierFrequency;
    this.dutyCycle = dutyCycle;
    this.state.flap = defaultFlap;
  }

  async init(): Promise<void> {
    try {
      const data = await fs.readFile(this.stateFilePath, 'utf-8');
      const loaded = JSON.parse(data);
      this.state = { ...DEFAULT_AC_STATE, ...loaded };
      // Migrate legacy 'auto' to high position if configured
      if (this.state.flap === 'auto') {
        this.state.flap = this.defaultFlap;
      }
    } catch {
      // Use defaults if file does not exist
      this.state = { ...DEFAULT_AC_STATE, flap: this.defaultFlap };
    }

    // Try reading current ambient temperature
    const ambient = await this.readAmbientTemperature();
    if (ambient !== null) {
      this.state.measuredTemperature = ambient;
    }

    try {
      await fs.writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch {
      // Ignore initial write error
    }
  }

  getState(): Readonly<AcDeviceState> {
    return { ...this.state };
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

  async updateAndTransmit(updates: Partial<AcDeviceState>): Promise<void> {
    const wasPower = this.state.power;

    // Interlock logic: High power disables quiet mode, and quiet mode disables high power
    if (updates.highPower === true) {
      updates.quietMode = false;
    }
    if (updates.quietMode === true) {
      updates.highPower = false;
    }

    // Update in-memory state
    Object.assign(this.state, updates);

    // Refresh ambient temp
    const ambient = await this.readAmbientTemperature();
    if (ambient !== null) {
      this.state.measuredTemperature = ambient;
    }

    // Save to disk asynchronously
    try {
      await fs.writeFile(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch {
      // Ignore save error
    }

    // If the AC is OFF and this update is not turning it ON or OFF, skip IR transmission
    const isTurningOff = 'power' in updates && updates.power === false;
    const isRunning = this.state.power;

    if (!isRunning && !isTurningOff) {
      return;
    }

    const isTurningOn = 'power' in updates && updates.power === true && !wasPower;
    const powerAction = isTurningOff ? 'off' : isTurningOn ? 'on' : 'maintain';

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
    });

    // Transmit via hardware
    await transmitIr(bitstring, this.irDevice, this.carrierFrequency, this.dutyCycle);
  }
}
