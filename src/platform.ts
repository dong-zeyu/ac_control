import { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, CharacteristicValue } from 'homebridge';
import type { MatterAccessory } from 'homebridge';
import { AcStateManager, AcDeviceState } from './state.js';
import { FanSpeed, FlapPosition } from './protocol.js';

export const PLUGIN_NAME = 'homebridge-aeha-ac';
export const PLATFORM_NAME = 'AehaAirConditionerPlatform';

export class AehaAirConditionerPlatform implements DynamicPlatformPlugin {
  public readonly Service;
  public readonly Characteristic;
  private readonly stateManager: AcStateManager;
  private matterAccessoryUUID?: string;
  private hapAccessory?: PlatformAccessory;

  constructor(
    public readonly log: Logging,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    const irDevice = (this.config.irDevice as string) || '/dev/lirc0';
    const dhtSensor = (this.config.dhtSensor as string) || '/dev/dht0:temp';
    const storageDir = this.api.user.storagePath();
    const defaultFlapCfg = this.config.defaultFlapPosition as string;
    const defaultFlap: FlapPosition = defaultFlapCfg === 'auto' ? 'auto' : 6;
    const carrierFrequency = typeof this.config.carrierFrequency === 'number' ? this.config.carrierFrequency : 38000;
    const dutyCycle = typeof this.config.dutyCycle === 'number' ? this.config.dutyCycle : 50;
    this.stateManager = new AcStateManager(storageDir, irDevice, dhtSensor, defaultFlap, carrierFrequency, dutyCycle);

    this.api.on('didFinishLaunching', async () => {
      await this.stateManager.init();
      await this.setupAccessories();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.hapAccessory = accessory;
  }

  private async setupAccessories(): Promise<void> {
    const name = (this.config.name as string) || 'Room Air Conditioner';
    const enableMatter = this.config.enableMatter === true;
    const enableHap = this.config.enableHap !== false;

    // Check if Matter is requested and supported by this Homebridge instance
    if (enableMatter && this.api.matter) {
      this.log.info('Initializing Matter RoomAirConditioner accessory...');
      await this.setupMatterAccessory(name);
      if (enableHap) {
        this.log.info('Initializing parallel classic HomeKit HAP HeaterCooler accessory for UI dashboard...');
        this.setupHapAccessory(name);
      }
    } else {
      if (enableMatter && !this.api.matter) {
        this.log.warn('Matter is requested in plugin config but not active on this bridge.');
        this.log.warn('To enable Matter in Homebridge, add `"matter": { "enabled": true }` to your bridge config.');
      }
      this.log.info('Initializing classic HomeKit HAP HeaterCooler accessory...');
      this.setupHapAccessory(name);
    }
  }

  // =========================================================================
  // MATTER IMPLEMENTATION (RoomAirConditioner)
  // =========================================================================
  private async setupMatterAccessory(name: string): Promise<void> {
    if (!this.api.matter) return;

    const state = this.stateManager.getState();
    const uuid = this.api.hap.uuid.generate(`matter-${name}`);
    this.matterAccessoryUUID = uuid;

    // Ensure Homebridge's internal cluster behavior mappings have the required features
    // for FanControl (MultiSpeed, Auto) and Thermostat (Heating, Cooling, AutoMode)
    try {
      const { createRequire } = await import('node:module');
      const path = await import('node:path');
      const { pathToFileURL } = await import('node:url');

      const req = createRequire(import.meta.url);
      const hbEntry = req.resolve('homebridge');
      const hbDir = path.resolve(path.dirname(hbEntry), '..');

      const bMapUrl = pathToFileURL(path.join(hbDir, 'dist/matter/server/BehaviorMap.js')).href;
      const bIndexUrl = pathToFileURL(path.join(hbDir, 'dist/matter/behaviors/index.js')).href;

      const { CORE_CLUSTER_BEHAVIOR_MAP, FULL_CLUSTER_BEHAVIOR_MAP } = await import(bMapUrl);
      const { HomebridgeFanControlServer, HomebridgeThermostatServer } = await import(bIndexUrl);

      if (CORE_CLUSTER_BEHAVIOR_MAP) {
        CORE_CLUSTER_BEHAVIOR_MAP.fanControl = HomebridgeFanControlServer.with('MultiSpeed', 'Auto');
        CORE_CLUSTER_BEHAVIOR_MAP.thermostat = HomebridgeThermostatServer.with('Heating', 'Cooling', 'AutoMode');
      }
      if (FULL_CLUSTER_BEHAVIOR_MAP) {
        FULL_CLUSTER_BEHAVIOR_MAP.fanControl = CORE_CLUSTER_BEHAVIOR_MAP.fanControl;
        FULL_CLUSTER_BEHAVIOR_MAP.thermostat = CORE_CLUSTER_BEHAVIOR_MAP.thermostat;
      }
      this.log.info('[Matter] Successfully aligned internal cluster behaviors (FanControl + Thermostat)');
    } catch (e: any) {
      this.log.warn('[Matter] Note on behavior map setup:', e?.message || e);
    }

    // Compose Matter RoomAirConditioner with FanControl and TemperatureMeasurement
    const RAC = this.api.matter.deviceTypes.RoomAirConditioner as any;
    const composedDeviceType = RAC.with(
      RAC.requirements.ThermostatServer.with('Heating', 'Cooling', 'AutoMode'),
      RAC.requirements.FanControlServer.with('MultiSpeed', 'Auto'),
      RAC.requirements.TemperatureMeasurementServer
    );

    // Initial system mode: 0=Off, 1=Auto, 3=Cool, 4=Heat
    const currentSystemMode = state.power
      ? (state.mode === 'cooling' ? 3 : state.mode === 'heating' ? 4 : 1)
      : 0;

    // Fan mode: 0=Off, 1=Low, 2=Medium, 3=High, 5=Auto
    const currentFanMode = state.fanSpeed === 'low' ? 1
      : state.fanSpeed === 'med' ? 2
      : state.fanSpeed === 'high' ? 3
      : 5;

    const fanPercent = state.fanSpeed === 'low' ? 33
      : state.fanSpeed === 'med' ? 66
      : state.fanSpeed === 'high' ? 100
      : 0;

    const matterAccessory: MatterAccessory = {
      UUID: uuid,
      displayName: name,
      deviceType: composedDeviceType,
      manufacturer: 'Fujitsu / Custom',
      model: 'AR-RCE1E',
      serialNumber: 'AEHA-AC-001',
      context: {},
      clusters: {
        onOff: {
          onOff: state.power,
        },
        thermostat: {
          systemMode: currentSystemMode,
          occupiedCoolingSetpoint: Math.round(state.targetTemperature * 100),
          occupiedHeatingSetpoint: Math.round(state.targetTemperature * 100),
          localTemperature: Math.round(state.measuredTemperature * 100),
          controlSequenceOfOperation: 4, // Cooling and Heating
          minCoolSetpointLimit: 1600,
          maxCoolSetpointLimit: 3000,
          minHeatSetpointLimit: 1600,
          maxHeatSetpointLimit: 3000,
        },
        fanControl: {
          fanMode: currentFanMode,
          fanModeSequence: 2, // Off/Low/Med/High/Auto
          percentSetting: fanPercent,
          percentCurrent: fanPercent,
          speedMax: 3,
          speedSetting: state.fanSpeed === 'low' ? 1 : state.fanSpeed === 'med' ? 2 : state.fanSpeed === 'high' ? 3 : 0,
          speedCurrent: state.fanSpeed === 'low' ? 1 : state.fanSpeed === 'med' ? 2 : state.fanSpeed === 'high' ? 3 : 0,
        },
        temperatureMeasurement: {
          measuredValue: Math.round(state.measuredTemperature * 100),
          minMeasuredValue: -5000,
          maxMeasuredValue: 10000,
        },
      },
      handlers: {
        onOff: {
          on: async () => {
            this.log.info('[Matter] Power ON command received');
            await this.stateManager.updateAndTransmit({ power: true });
            await this.syncMatterState();
          },
          off: async () => {
            this.log.info('[Matter] Power OFF command received');
            await this.stateManager.updateAndTransmit({ power: false });
            await this.syncMatterState();
          },
        },
        thermostat: {
          systemModeChange: async ({ systemMode }) => {
            this.log.info(`[Matter] System Mode changed to ${systemMode}`);
            if (systemMode === 0) {
              await this.stateManager.updateAndTransmit({ power: false });
            } else if (systemMode === 3) {
              await this.stateManager.updateAndTransmit({ power: true, mode: 'cooling' });
            } else if (systemMode === 4) {
              await this.stateManager.updateAndTransmit({ power: true, mode: 'heating' });
            } else if (systemMode === 1) {
              await this.stateManager.updateAndTransmit({ power: true, mode: 'auto' });
            }
            await this.syncMatterState();
          },
          occupiedCoolingSetpointChange: async ({ occupiedCoolingSetpoint }) => {
            const tempC = Math.round((occupiedCoolingSetpoint / 100) * 2) / 2;
            this.log.info(`[Matter] Cooling target temperature changed to ${tempC}°C`);
            await this.stateManager.updateAndTransmit({ targetTemperature: tempC });
            await this.syncMatterState();
          },
          occupiedHeatingSetpointChange: async ({ occupiedHeatingSetpoint }) => {
            const tempC = Math.round((occupiedHeatingSetpoint / 100) * 2) / 2;
            this.log.info(`[Matter] Heating target temperature changed to ${tempC}°C`);
            await this.stateManager.updateAndTransmit({ targetTemperature: tempC });
            await this.syncMatterState();
          },
          setpointRaiseLower: async (request: any) => {
            const delta = (request.amount || 0) / 10;
            const current = this.stateManager.getState().targetTemperature;
            const newTemp = Math.max(16.0, Math.min(30.0, current + delta));
            this.log.info(`[Matter] Setpoint raise/lower: delta=${delta}°C, target=${newTemp}°C`);
            await this.stateManager.updateAndTransmit({ targetTemperature: newTemp });
            await this.syncMatterState();
          },
        },
        fanControl: {
          fanModeChange: async ({ fanMode }) => {
            this.log.info(`[Matter] Fan mode changed to ${fanMode}`);
            let speed: FanSpeed = 'auto';
            if (fanMode === 1) speed = 'low';
            else if (fanMode === 2) speed = 'med';
            else if (fanMode === 3) speed = 'high';
            else speed = 'auto';
            await this.stateManager.updateAndTransmit({ fanSpeed: speed });
            await this.syncMatterState();
          },
          percentSettingChange: async ({ percentSetting }) => {
            this.log.info(`[Matter] Fan percentage changed to ${percentSetting}%`);
            let speed: FanSpeed = 'auto';
            if (percentSetting === null || percentSetting === 0) speed = 'auto';
            else if (percentSetting <= 33) speed = 'low';
            else if (percentSetting <= 66) speed = 'med';
            else speed = 'high';
            await this.stateManager.updateAndTransmit({ fanSpeed: speed });
            await this.syncMatterState();
          },
        },
      },
    };

    try {
      await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [matterAccessory]);
      this.log.success(`[Matter] Successfully registered RoomAirConditioner: "${name}" (${uuid})`);
    } catch (err) {
      this.log.error('[Matter] Failed to register RoomAirConditioner accessory:', err);
    }
  }

  private async syncMatterState(): Promise<void> {
    const state = this.stateManager.getState();

    // 1. Sync classic HAP HeaterCooler accessory
    if (this.hapAccessory) {
      const service = this.hapAccessory.getService(this.Service.HeaterCooler);
      if (service) {
        service.updateCharacteristic(
          this.Characteristic.Active,
          state.power ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE
        );
        service.updateCharacteristic(
          this.Characteristic.CurrentHeaterCoolerState,
          !state.power ? this.Characteristic.CurrentHeaterCoolerState.INACTIVE
            : state.mode === 'cooling' ? this.Characteristic.CurrentHeaterCoolerState.COOLING
            : state.mode === 'heating' ? this.Characteristic.CurrentHeaterCoolerState.HEATING
            : this.Characteristic.CurrentHeaterCoolerState.IDLE
        );
        service.updateCharacteristic(
          this.Characteristic.TargetHeaterCoolerState,
          state.mode === 'cooling' ? this.Characteristic.TargetHeaterCoolerState.COOL
            : state.mode === 'heating' ? this.Characteristic.TargetHeaterCoolerState.HEAT
            : this.Characteristic.TargetHeaterCoolerState.AUTO
        );
        service.updateCharacteristic(
          this.Characteristic.CurrentTemperature,
          state.measuredTemperature
        );
        service.updateCharacteristic(
          this.Characteristic.CoolingThresholdTemperature,
          state.targetTemperature
        );
        service.updateCharacteristic(
          this.Characteristic.HeatingThresholdTemperature,
          state.targetTemperature
        );
        const p = state.fanSpeed === 'low' ? 33 : state.fanSpeed === 'med' ? 66 : state.fanSpeed === 'high' ? 100 : 0;
        service.updateCharacteristic(this.Characteristic.RotationSpeed, p);
        service.updateCharacteristic(
          this.Characteristic.SwingMode,
          state.flap === 'swing' ? this.Characteristic.SwingMode.SWING_ENABLED : this.Characteristic.SwingMode.SWING_DISABLED
        );
      }

      const fanService = this.hapAccessory.getServiceById(this.Service.Fanv2, 'ac-fan') ||
        this.hapAccessory.getService(this.Service.Fanv2);
      if (fanService) {
        const p = state.fanSpeed === 'low' ? 33 : state.fanSpeed === 'med' ? 66 : state.fanSpeed === 'high' ? 100 : 0;
        fanService.updateCharacteristic(
          this.Characteristic.Active,
          state.power ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE
        );
        fanService.updateCharacteristic(
          this.Characteristic.CurrentFanState,
          !state.power ? this.Characteristic.CurrentFanState.INACTIVE : this.Characteristic.CurrentFanState.BLOWING_AIR
        );
        fanService.updateCharacteristic(
          this.Characteristic.TargetFanState,
          state.fanSpeed === 'auto' ? this.Characteristic.TargetFanState.AUTO : this.Characteristic.TargetFanState.MANUAL
        );
        fanService.updateCharacteristic(this.Characteristic.RotationSpeed, p);
      }

      const swingSwitch = this.hapAccessory.getServiceById(this.Service.Switch, 'ac-swing');
      if (swingSwitch) {
        swingSwitch.updateCharacteristic(this.Characteristic.On, state.flap === 'swing');
      }
      const powerfulSwitch = this.hapAccessory.getServiceById(this.Service.Switch, 'ac-powerful');
      if (powerfulSwitch) {
        powerfulSwitch.updateCharacteristic(this.Characteristic.On, state.highPower);
      }
      const quietSwitch = this.hapAccessory.getServiceById(this.Service.Switch, 'ac-quiet');
      if (quietSwitch) {
        quietSwitch.updateCharacteristic(this.Characteristic.On, state.quietMode);
      }
      const economySwitch = this.hapAccessory.getServiceById(this.Service.Switch, 'ac-economy');
      if (economySwitch) {
        economySwitch.updateCharacteristic(this.Characteristic.On, state.nightSetback);
      }
      const ionizerSwitch = this.hapAccessory.getServiceById(this.Service.Switch, 'ac-ionizer');
      if (ionizerSwitch) {
        ionizerSwitch.updateCharacteristic(this.Characteristic.On, state.ionMode);
      }
    }

    // 2. Sync Matter accessory if active
    if (!this.api.matter || !this.matterAccessoryUUID) return;
    const systemMode = state.power
      ? (state.mode === 'cooling' ? 3 : state.mode === 'heating' ? 4 : 1)
      : 0;

    const fanMode = state.fanSpeed === 'low' ? 1
      : state.fanSpeed === 'med' ? 2
      : state.fanSpeed === 'high' ? 3
      : 5;

    const fanPercent = state.fanSpeed === 'low' ? 33
      : state.fanSpeed === 'med' ? 66
      : state.fanSpeed === 'high' ? 100
      : 0;

    try {
      await this.api.matter.updateAccessoryState(this.matterAccessoryUUID, 'onOff', { onOff: state.power });
      await this.api.matter.updateAccessoryState(this.matterAccessoryUUID, 'thermostat', {
        systemMode,
        occupiedCoolingSetpoint: Math.round(state.targetTemperature * 100),
        occupiedHeatingSetpoint: Math.round(state.targetTemperature * 100),
        localTemperature: Math.round(state.measuredTemperature * 100),
      });
      await this.api.matter.updateAccessoryState(this.matterAccessoryUUID, 'fanControl', {
        fanMode,
        percentSetting: fanPercent,
        percentCurrent: fanPercent,
        speedSetting: state.fanSpeed === 'low' ? 1 : state.fanSpeed === 'med' ? 2 : state.fanSpeed === 'high' ? 3 : 0,
        speedCurrent: state.fanSpeed === 'low' ? 1 : state.fanSpeed === 'med' ? 2 : state.fanSpeed === 'high' ? 3 : 0,
      });
      await this.api.matter.updateAccessoryState(this.matterAccessoryUUID, 'temperatureMeasurement', {
        measuredValue: Math.round(state.measuredTemperature * 100),
      });
    } catch (err) {
      this.log.debug('[Matter] Error syncing state cache:', err);
    }
  }

  // =========================================================================
  // CLASSIC HAP IMPLEMENTATION (HeaterCooler fallback / dual mode)
  // =========================================================================
  private setupHapAccessory(name: string): void {
    const uuid = this.api.hap.uuid.generate(`hap-${name}`);
    let accessory = this.hapAccessory;

    if (!accessory) {
      accessory = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.hapAccessory = accessory;
    }

    accessory.getService(this.Service.AccessoryInformation)!
      .setCharacteristic(this.Characteristic.Manufacturer, 'Fujitsu / Custom')
      .setCharacteristic(this.Characteristic.Model, 'AR-RCE1E')
      .setCharacteristic(this.Characteristic.SerialNumber, 'AEHA-AC-001');

    const service = accessory.getService(this.Service.HeaterCooler) ||
      accessory.addService(this.Service.HeaterCooler, name);
    service.setPrimaryService(true);
    service.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
    service.setCharacteristic(this.Characteristic.ConfiguredName, name);

    const fanService = accessory.getServiceById(this.Service.Fanv2, 'ac-fan') ||
      accessory.getService(this.Service.Fanv2) ||
      accessory.addService(this.Service.Fanv2, `${name} Fan Speed`, 'ac-fan');
    service.addLinkedService(fanService);
    fanService.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
    fanService.setCharacteristic(this.Characteristic.Name, 'Fan Speed');
    fanService.setCharacteristic(this.Characteristic.ConfiguredName, 'Fan Speed');

    // Fan Active: Strictly synced with AC power, completely decoupled from fan speed.
    fanService.getCharacteristic(this.Characteristic.Active)
      .onGet(() => this.stateManager.getState().power ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE)
      .onSet(async (val: CharacteristicValue) => {
        const isAcOn = this.stateManager.getState().power;
        const targetActive = val === this.Characteristic.Active.ACTIVE;
        this.log.info(`[HAP Fan] Set Active: ${targetActive} (AC was: ${isAcOn})`);
        if (targetActive) {
          if (!isAcOn) {
            await this.stateManager.updateAndTransmit({ power: true });
          }
        } else {
          // Setting the fan slider to 0% in Apple Home sends Active = 0.
          // Because Active is strictly synced with AC power and decoupled from fan speed,
          // if AC is running, active status stays true, and speed is set to auto.
          if (isAcOn) {
            this.log.info('[HAP Fan] Fan set to 0/inactive while AC running -> set fanSpeed to auto, keeping Active = true');
            await this.stateManager.updateAndTransmit({ fanSpeed: 'auto' });
          }
        }
        await this.syncMatterState();
        // Guarantee Active status remains strictly synchronized with AC power
        if (this.stateManager.getState().power) {
          setTimeout(() => {
            fanService.updateCharacteristic(this.Characteristic.Active, this.Characteristic.Active.ACTIVE);
          }, 80);
        }
      });

    // Fan CurrentFanState
    fanService.getCharacteristic(this.Characteristic.CurrentFanState)
      .onGet(() => {
        const st = this.stateManager.getState();
        return st.power ? this.Characteristic.CurrentFanState.BLOWING_AIR : this.Characteristic.CurrentFanState.INACTIVE;
      });

    // Fan TargetFanState (AUTO vs MANUAL)
    fanService.getCharacteristic(this.Characteristic.TargetFanState)
      .onGet(() => {
        const st = this.stateManager.getState();
        return st.fanSpeed === 'auto'
          ? this.Characteristic.TargetFanState.AUTO
          : this.Characteristic.TargetFanState.MANUAL;
      })
      .onSet(async (val: CharacteristicValue) => {
        const isAuto = val === this.Characteristic.TargetFanState.AUTO;
        this.log.info(`[HAP Fan] Set TargetFanState: ${isAuto ? 'AUTO' : 'MANUAL'}`);
        if (isAuto) {
          await this.stateManager.updateAndTransmit({ fanSpeed: 'auto' });
        } else {
          const current = this.stateManager.getState().fanSpeed;
          const newSpeed: FanSpeed = current === 'auto' ? 'med' : current;
          await this.stateManager.updateAndTransmit({ fanSpeed: newSpeed });
        }
        await this.syncMatterState();
      });

    // Fan RotationSpeed (3-step snapping slide bar: Low=33%, Med=66%, High=100%, Auto=0%)
    fanService.getCharacteristic(this.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 33 })
      .onGet(() => {
        const sp = this.stateManager.getState().fanSpeed;
        if (sp === 'low') return 33;
        if (sp === 'med') return 66;
        if (sp === 'high') return 100;
        return 0; // Auto is 0%
      })
      .onSet(async (val: CharacteristicValue) => {
        const p = Number(val);
        let speed: FanSpeed = 'auto';
        if (p === 0) {
          speed = 'auto';
        } else if (p <= 33) {
          speed = 'low';
        } else if (p <= 66) {
          speed = 'med';
        } else {
          speed = 'high';
        }
        this.log.info(`[HAP Fan] Set RotationSpeed: ${p}% -> ${speed} (Active status decoupled, AC power untouched)`);
        const isAcOn = this.stateManager.getState().power;
        if (!isAcOn && speed !== 'auto') {
          await this.stateManager.updateAndTransmit({ power: true, fanSpeed: speed });
        } else {
          await this.stateManager.updateAndTransmit({ fanSpeed: speed });
        }
        await this.syncMatterState();
        // Guarantee Active status remains strictly synchronized with AC power
        if (this.stateManager.getState().power) {
          setTimeout(() => {
            fanService.updateCharacteristic(this.Characteristic.Active, this.Characteristic.Active.ACTIVE);
          }, 80);
        }
      });

    // Active
    service.getCharacteristic(this.Characteristic.Active)
      .onGet(() => this.stateManager.getState().power ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE)
      .onSet(async (val: CharacteristicValue) => {
        const on = val === this.Characteristic.Active.ACTIVE;
        this.log.info(`[HAP] Set Active: ${on}`);
        await this.stateManager.updateAndTransmit({ power: on });
        await this.syncMatterState();
      });

    // Current State
    service.getCharacteristic(this.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => {
        const st = this.stateManager.getState();
        if (!st.power) return this.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        if (st.mode === 'cooling') return this.Characteristic.CurrentHeaterCoolerState.COOLING;
        if (st.mode === 'heating') return this.Characteristic.CurrentHeaterCoolerState.HEATING;
        return this.Characteristic.CurrentHeaterCoolerState.IDLE;
      });

    // Target State
    service.getCharacteristic(this.Characteristic.TargetHeaterCoolerState)
      .onGet(() => {
        const st = this.stateManager.getState();
        if (st.mode === 'cooling') return this.Characteristic.TargetHeaterCoolerState.COOL;
        if (st.mode === 'heating') return this.Characteristic.TargetHeaterCoolerState.HEAT;
        return this.Characteristic.TargetHeaterCoolerState.AUTO;
      })
      .onSet(async (val: CharacteristicValue) => {
        let m: AcDeviceState['mode'] = 'cooling';
        if (val === this.Characteristic.TargetHeaterCoolerState.HEAT) m = 'heating';
        else if (val === this.Characteristic.TargetHeaterCoolerState.AUTO) m = 'auto';
        this.log.info(`[HAP] Set TargetHeaterCoolerState: ${m}`);
        await this.stateManager.updateAndTransmit({ power: true, mode: m });
        await this.syncMatterState();
      });

    // Current Temperature
    service.getCharacteristic(this.Characteristic.CurrentTemperature)
      .onGet(() => this.stateManager.getState().measuredTemperature);

    // Target Cooling Temperature
    service.getCharacteristic(this.Characteristic.CoolingThresholdTemperature)
      .setProps({ minValue: 16, maxValue: 30, minStep: 0.5 })
      .onGet(() => this.stateManager.getState().targetTemperature)
      .onSet(async (val: CharacteristicValue) => {
        const temp = Number(val);
        this.log.info(`[HAP] Set CoolingThresholdTemperature: ${temp}°C`);
        await this.stateManager.updateAndTransmit({ targetTemperature: temp });
        await this.syncMatterState();
      });

    // Target Heating Temperature
    service.getCharacteristic(this.Characteristic.HeatingThresholdTemperature)
      .setProps({ minValue: 16, maxValue: 30, minStep: 0.5 })
      .onGet(() => this.stateManager.getState().targetTemperature)
      .onSet(async (val: CharacteristicValue) => {
        const temp = Number(val);
        this.log.info(`[HAP] Set HeatingThresholdTemperature: ${temp}°C`);
        await this.stateManager.updateAndTransmit({ targetTemperature: temp });
        await this.syncMatterState();
      });

    // Fan Speed Slider on HeaterCooler (RotationSpeed 0..100%, minStep: 33)
    service.getCharacteristic(this.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 33 })
      .onGet(() => {
        const sp = this.stateManager.getState().fanSpeed;
        if (sp === 'low') return 33;
        if (sp === 'med') return 66;
        if (sp === 'high') return 100;
        return 0; // Auto
      })
      .onSet(async (val: CharacteristicValue) => {
        const p = Number(val);
        let speed: FanSpeed = 'auto';
        if (p === 0) {
          speed = 'auto';
        } else if (p <= 33) {
          speed = 'low';
        } else if (p <= 66) {
          speed = 'med';
        } else {
          speed = 'high';
        }
        this.log.info(`[HAP] Set RotationSpeed: ${p}% -> ${speed}`);
        await this.stateManager.updateAndTransmit({ fanSpeed: speed });
        await this.syncMatterState();
      });

    // Swing Mode on HeaterCooler
    service.getCharacteristic(this.Characteristic.SwingMode)
      .onGet(() => this.stateManager.getState().flap === 'swing' ? this.Characteristic.SwingMode.SWING_ENABLED : this.Characteristic.SwingMode.SWING_DISABLED)
      .onSet(async (val: CharacteristicValue) => {
        const swing = val === this.Characteristic.SwingMode.SWING_ENABLED;
        const defaultFlapCfg = this.config.defaultFlapPosition as string;
        const nonSwingFlap: FlapPosition = defaultFlapCfg === 'auto' ? 'auto' : 6;
        this.log.info(`[HAP] Set SwingMode: ${swing} (non-swing flap: ${nonSwingFlap})`);
        await this.stateManager.updateAndTransmit({ flap: swing ? 'swing' : nonSwingFlap });
        await this.syncMatterState();
      });

    // Auxiliary Control Switches (Swing, Powerful, Quiet, Economy, Ionizer)
    const enableAux = this.config.enableAuxSwitches !== false;

    const setupSwitch = (
      subtype: string,
      displayName: string,
      shortName: string,
      getFn: () => boolean,
      setFn: (val: boolean) => Promise<void>
    ) => {
      let sw = accessory.getServiceById(this.Service.Switch, subtype);
      if (!enableAux) {
        if (sw) {
          accessory.removeService(sw);
        }
        return;
      }
      if (!sw) {
        sw = accessory.addService(this.Service.Switch, displayName, subtype);
      }
      sw.addOptionalCharacteristic(this.Characteristic.ConfiguredName);
      sw.setCharacteristic(this.Characteristic.Name, shortName);
      sw.setCharacteristic(this.Characteristic.ConfiguredName, shortName);
      sw.getCharacteristic(this.Characteristic.ConfiguredName)
        .onSet((val: CharacteristicValue) => {
          this.log.info(`[HAP Switch] ${shortName} ConfiguredName renamed by user: ${val}`);
        });

      service.addLinkedService(sw);
      sw.getCharacteristic(this.Characteristic.On)
        .onGet(getFn)
        .onSet(async (val: CharacteristicValue) => {
          await setFn(Boolean(val));
          await this.syncMatterState();
        });
    };

    // Clean up any previously created Fan Speed switches
    for (const subtype of ['ac-fan-auto', 'ac-fan-low', 'ac-fan-med', 'ac-fan-high']) {
      const sw = accessory.getServiceById(this.Service.Switch, subtype);
      if (sw) {
        accessory.removeService(sw);
      }
    }

    // 1. AC Swing Switch
    setupSwitch(
      'ac-swing',
      `${name} Swing`,
      'Swing',
      () => this.stateManager.getState().flap === 'swing',
      async (val) => {
        const defaultFlapCfg = this.config.defaultFlapPosition as string;
        const nonSwingFlap: FlapPosition = defaultFlapCfg === 'auto' ? 'auto' : 6;
        this.log.info(`[HAP Switch] Set Swing: ${val}`);
        await this.stateManager.updateAndTransmit({ flap: val ? 'swing' : nonSwingFlap });
      }
    );

    // 2. AC Powerful Switch (High Power) - does not force power on if AC is currently OFF
    setupSwitch(
      'ac-powerful',
      `${name} Powerful`,
      'Powerful',
      () => this.stateManager.getState().highPower,
      async (val) => {
        this.log.info(`[HAP Switch] Set Powerful: ${val}`);
        await this.stateManager.updateAndTransmit({ highPower: val });
      }
    );

    // 3. AC Quiet Switch (Silent Fan / Indoor Unit Quiet) - does not force power on if AC is currently OFF
    setupSwitch(
      'ac-quiet',
      `${name} Quiet`,
      'Quiet',
      () => this.stateManager.getState().quietMode,
      async (val) => {
        this.log.info(`[HAP Switch] Set Quiet: ${val}`);
        await this.stateManager.updateAndTransmit({ quietMode: val });
      }
    );

    // 4. AC Economy Switch (Night Setback)
    setupSwitch(
      'ac-economy',
      `${name} Economy`,
      'Economy',
      () => this.stateManager.getState().nightSetback,
      async (val) => {
        this.log.info(`[HAP Switch] Set Economy: ${val}`);
        await this.stateManager.updateAndTransmit({ nightSetback: val });
      }
    );

    // 5. AC Ionizer Switch (Air Clean)
    setupSwitch(
      'ac-ionizer',
      `${name} Ionizer`,
      'Ionizer',
      () => this.stateManager.getState().ionMode,
      async (val) => {
        this.log.info(`[HAP Switch] Set Ionizer: ${val}`);
        await this.stateManager.updateAndTransmit({ ionMode: val });
      }
    );

    this.log.success(`[HAP] Successfully configured HeaterCooler accessory: "${name}"`);
  }
}
