import fs from 'node:fs/promises';
import { AcStateManager } from '../dist/state.js';

let stateManager = null;
let accessoryName = 'Room Air Conditioner';

function lsbToHexBytes(lsbPacket) {
  const tokens = lsbPacket.trim().split(/\s+/);
  return tokens.map(bits => {
    const msb = bits.split('').reverse().join('');
    return parseInt(msb, 2).toString(16).toUpperCase().padStart(2, '0');
  });
}

function buildPayload() {
  const state = stateManager.getState();
  const lsb = state.lastPacketLsb || stateManager.buildPacketPreview();
  const hexBytes = lsbToHexBytes(lsb);
  return {
    ok: true,
    name: accessoryName,
    model: 'Sanyo KMHS0772 (RCS-KMHS0772)',
    state,
    packet: {
      lsb,
      hex: hexBytes.join(' '),
      bytes: hexBytes,
    },
  };
}

async function initServer() {
  const storageDir = process.env.HOMEBRIDGE_STORAGE_PATH || '/var/lib/homebridge';
  const cfgPath = process.env.HOMEBRIDGE_CONFIG_PATH || '/var/lib/homebridge/config.json';

  let irDevice = '/dev/lirc0';
  let dhtSensor = '/dev/dht0:temp';
  let humiditySensor = '/dev/dht0:humid';
  let defaultFlap = 6;
  let carrierFrequency = 38000;
  let dutyCycle = 50;

  try {
    const raw = await fs.readFile(cfgPath, 'utf-8');
    const cfg = JSON.parse(raw);
    const plat = (cfg.platforms || []).find(p => p.platform === 'AehaAirConditionerPlatform');
    if (plat) {
      if (plat.name) accessoryName = plat.name;
      if (plat.irDevice) irDevice = plat.irDevice;
      if (plat.dhtSensor) dhtSensor = plat.dhtSensor;
      if (plat.humiditySensor) humiditySensor = plat.humiditySensor;
      if (plat.defaultFlapPosition === 'auto') defaultFlap = 'auto';
      if (typeof plat.carrierFrequency === 'number') carrierFrequency = plat.carrierFrequency;
      if (typeof plat.dutyCycle === 'number') dutyCycle = plat.dutyCycle;
    }
  } catch {
    // Use defaults if config cannot be read
  }

  stateManager = new AcStateManager(storageDir, irDevice, dhtSensor, defaultFlap, carrierFrequency, dutyCycle, humiditySensor);
  await stateManager.init();
  stateManager.startFileWatch();

  stateManager.onChange(() => {
    if (process.send) {
      process.send({
        action: 'stream',
        payload: { event: 'ac-state', data: buildPayload() },
      });
    }
  });

  setInterval(() => {
    stateManager.refreshAmbientTemperature().catch(() => {});
  }, 10000);
}

process.on('message', async request => {
  if (!request || typeof request !== 'object' || !request.requestId) {
    return;
  }
  const { requestId, path: reqPath, body } = request;
  try {
    if (reqPath === '/state') {
      await stateManager.refreshAmbientTemperature();
    } else if (reqPath === '/state-update') {
      await stateManager.updateAndTransmit(body || {});
    } else if (reqPath === '/action') {
      const act = body?.action;
      if (act === 'cancel_timer') {
        await stateManager.cancelTimer();
      } else if (act === 'retransmit') {
        await stateManager.retransmit();
      } else {
        throw new Error(`Unknown action: ${act}`);
      }
    } else {
      throw new Error(`Unknown request path: ${reqPath}`);
    }

    if (process.send) {
      process.send({
        action: 'response',
        payload: {
          requestId,
          success: true,
          data: buildPayload(),
        },
      });
    }
  } catch (err) {
    if (process.send) {
      process.send({
        action: 'response',
        payload: {
          requestId,
          success: false,
          data: { message: err?.message || 'Request failed' },
        },
      });
    }
  }
});

initServer().then(() => {
  if (process.send) {
    process.send({ action: 'ready', payload: { server: true } });
    process.send({
      action: 'stream',
      payload: { event: 'ac-state', data: buildPayload() },
    });
  }
});
