import test from 'node:test';
import assert from 'node:assert';
import { generateAcCodeLsb, binaryToIrCtlPulses, binaryToDurations } from '../dist/protocol.js';
import { execSync } from 'node:child_process';

test('Protocol: generateAcCodeLsb matches test_run.py across key modes and options', () => {
  const testCases = [
    { powerOn: true, tempC: 24.0, mode: 'cooling', fanSpeed: 'auto', flap: 'auto' },
    { powerOn: false, tempC: 24.0, mode: 'cooling', fanSpeed: 'auto', flap: 'auto' },
    { powerOn: true, tempC: 18.5, mode: 'heating', fanSpeed: 'low', flap: 'swing' },
    { powerOn: true, tempC: 26.0, mode: 'auto', fanSpeed: 'high', flap: 1, ionMode: true },
    { powerOn: true, tempC: 22.0, mode: 'dehumidify', fanSpeed: 'med', flap: 6, quietMode: true },
    { powerOn: true, tempC: 25.0, mode: 'cooling', fanSpeed: 'auto', flap: 'auto', highPower: true },
    { powerOn: true, tempC: 27.5, mode: 'cooling', fanSpeed: 'low', flap: 'auto', nightSetback: true },
    { powerOn: true, tempC: 24.0, mode: 'cooling', fanSpeed: 'auto', flap: 6 },
  ];

  for (const tc of testCases) {
    const jsResult = generateAcCodeLsb({
      ...tc,
      currentTimeHours: 12,
      currentTimeMinutes: 0
    });

    const pyCmd = `python3 -c "import sys; sys.path.insert(0, 'tools'); import test_run; print(test_run.generate_ac_code_lsb(` +
      `power_on=${tc.powerOn ? 'True' : 'False'}, ` +
      `temp_c=${tc.tempC}, ` +
      `mode='${tc.mode}', ` +
      `fan_speed='${tc.fanSpeed}', ` +
      `flap=${typeof tc.flap === 'number' ? tc.flap : `'${tc.flap}'`}, ` +
      `night_setback=${tc.nightSetback ? 'True' : 'False'}, ` +
      `high_power=${tc.highPower ? 'True' : 'False'}, ` +
      `ion_mode=${tc.ionMode ? 'True' : 'False'}, ` +
      `quiet_mode=${tc.quietMode ? 'True' : 'False'}, ` +
      `current_time_hours=12, current_time_minutes=0))"`;

    const pyResult = execSync(pyCmd, { cwd: '/home/dzy/homebridge-ac' }).toString().trim();
    assert.strictEqual(jsResult, pyResult, `Mismatch for test case: ${JSON.stringify(tc)}`);
  }

  // Verify default flap is position 6 (high / top, Byte 14 = 11110000)
  const defaultCode = generateAcCodeLsb({ currentTimeHours: 12, currentTimeMinutes: 0 });
  const bytes = defaultCode.split(' ');
  assert.strictEqual(bytes[13], '11110000', 'Default flap byte (Byte 14) must be position 6 (11110000)');

  // Verify 'high' and 'top' aliases match position 6
  const highCode = generateAcCodeLsb({ flap: 'high', currentTimeHours: 12, currentTimeMinutes: 0 });
  assert.strictEqual(highCode, defaultCode);
  const topCode = generateAcCodeLsb({ flap: 'top', currentTimeHours: 12, currentTimeMinutes: 0 });
  assert.strictEqual(topCode, defaultCode);
});

test('Protocol: binaryToIrCtlPulses generates valid pulse/space format', () => {
  const binary = '00000010 00000000 00101000 00000001 01110110 01000001 00010100 00010111 11000100 00010010 00010001 00000000 11000000 10010000 00000000 00000000 00000000 00000000 00101110';
  const pulses = binaryToIrCtlPulses(binary);
  const lines = pulses.trim().split('\n');

  // Header pulse & space
  assert.strictEqual(lines[0], 'pulse 3300');
  assert.strictEqual(lines[1], 'space 1725');

  // 152 data bits * 2 + 2 header + 2 trailer = 308 lines
  assert.strictEqual(lines.length, 152 * 2 + 4);

  // Stop pulse & space
  assert.strictEqual(lines[lines.length - 2], 'pulse 440');
  assert.strictEqual(lines[lines.length - 1], 'space 10000');
});

test('Protocol: binaryToDurations generates exact raw timings for Linux kernel LIRC character device', () => {
  const binary = '00000010 00000000 00101000 00000001 01110110 01000001 00010100 00010111 11000100 00010010 00010001 00000000 11000000 10010000 00000000 00000000 00000000 00000000 00101110';
  const durations = binaryToDurations(binary);

  // 152 data bits * 2 + 2 header + 1 trailer = 307 entries
  assert.strictEqual(durations.length, 307);
  assert.strictEqual(durations[0], 3300); // Header pulse
  assert.strictEqual(durations[1], 1725); // Header space
  assert.strictEqual(durations[durations.length - 1], 440); // Trailer pulse

  // 307 uint32 = 1228 bytes
  const buf = Buffer.alloc(durations.length * 4);
  for (let i = 0; i < durations.length; i++) {
    buf.writeUInt32LE(durations[i], i * 4);
  }
  assert.strictEqual(buf.length, 1228);
});

test('Protocol: cancel_timer action matches test_run.py', () => {
  const jsCancel = generateAcCodeLsb({
    powerOn: false,
    powerAction: 'cancel_timer',
    tempC: 24.0,
    measuredTempC: 27.0,
    mode: 'cooling',
    fanSpeed: 'auto',
    quietMode: true,
    currentTimeHours: 12,
    currentTimeMinutes: 0,
  });

  const pyCmd =
    `python3 -c "import sys; sys.path.insert(0, 'tools'); import test_run; ` +
    `print(test_run.generate_ac_code_lsb(power_on=False, power_action='cancel_timer', temp_c=24.0, measured_temp_c=27.0, mode='cooling', fan_speed='auto', quiet_mode=True, current_time_hours=12, current_time_minutes=0))"`;
  const pyCancel = execSync(pyCmd, { cwd: '/home/dzy/homebridge-ac' }).toString().trim();
  assert.strictEqual(jsCancel, pyCancel);
});

test('State: AcStateManager handles independent ON/OFF timers and interlocks safely (skipTransmit)', async () => {
  const { AcStateManager } = await import('../dist/state.js');

  const sm = new AcStateManager('/home/dzy/homebridge-ac/dist', '/dev/null', '/dev/null', 6, 38000, 50);
  await sm.init();

  // 1. Test mode, flap, and highPower/quietMode interlock
  await sm.updateAndTransmit(
    {
      mode: 'dehumidify',
      targetTemperature: 22.5,
      fanSpeed: 'low',
      flap: 3,
      ionMode: true,
      highPower: true,
      quietMode: false,
    },
    { skipTransmit: true }
  );
  let st = sm.getState();
  assert.strictEqual(st.mode, 'dehumidify');
  assert.strictEqual(st.targetTemperature, 22.5);
  assert.strictEqual(st.fanSpeed, 'low');
  assert.strictEqual(st.flap, 3);
  assert.strictEqual(st.ionMode, true);
  assert.strictEqual(st.highPower, true);
  assert.strictEqual(st.quietMode, false);

  // Enabling quietMode automatically disables highPower
  await sm.updateAndTransmit({ quietMode: true }, { skipTransmit: true });
  st = sm.getState();
  assert.strictEqual(st.quietMode, true);
  assert.strictEqual(st.highPower, false);

  // 2. Enable ON Timer independently -> timerMode === 'on'
  await sm.updateAndTransmit(
    { timerOnEnabled: true, timerOnHours: 7, timerOnMinutes: 30 },
    { skipTransmit: true }
  );
  st = sm.getState();
  assert.strictEqual(st.timerOnEnabled, true);
  assert.strictEqual(st.timerOffEnabled, false);
  assert.strictEqual(st.timerMode, 'on');

  // 3. Also enable OFF Timer -> timerMode === 'combo'
  await sm.updateAndTransmit(
    { timerOffEnabled: true, timerOffHours: 23, timerOffMinutes: 10 },
    { skipTransmit: true }
  );
  st = sm.getState();
  assert.strictEqual(st.timerOnEnabled, true);
  assert.strictEqual(st.timerOffEnabled, true);
  assert.strictEqual(st.timerMode, 'combo');

  // 4. Disable ON Timer while OFF Timer stays enabled -> timerMode === 'off'
  await sm.updateAndTransmit({ timerOnEnabled: false }, { skipTransmit: true });
  st = sm.getState();
  assert.strictEqual(st.timerOnEnabled, false);
  assert.strictEqual(st.timerOffEnabled, true);
  assert.strictEqual(st.timerMode, 'off');

  // 5. Disable OFF Timer -> both disabled -> timerMode === null and packet uses cancel_timer signature
  await sm.updateAndTransmit({ timerOffEnabled: false }, { skipTransmit: true });
  st = sm.getState();
  assert.strictEqual(st.timerOnEnabled, false);
  assert.strictEqual(st.timerOffEnabled, false);
  assert.strictEqual(st.timerMode, null);
  const packetBytes = st.lastPacketLsb.split(' ');
  assert.strictEqual(packetBytes[9], '10010010');
  assert.strictEqual(packetBytes[10], '00001010');
  assert.strictEqual(packetBytes[13], '11100000');
});

test('State: calculateApparentTemperature computes Steadman formula (windSpeed = 0)', async () => {
  const { calculateApparentTemperature } = await import('../dist/state.js');
  // At 23.0°C and 51% RH, e = 0.51 * 6.105 * exp((17.27 * 23) / (237.7 + 23)) = 14.288 hPa
  // AT = 23.0 + 0.33 * 14.288 - 4.00 = 23.7°C
  assert.strictEqual(calculateApparentTemperature(23.0, 51.0, 0), 23.7);
  // At 30.0°C and 70% RH, e = 0.70 * 6.105 * exp((17.27 * 30) / (237.7 + 30)) = 29.669 hPa
  // AT = 30.0 + 0.33 * 29.669 - 4.00 = 35.8°C
  assert.strictEqual(calculateApparentTemperature(30.0, 70.0, 0), 35.8);
});
