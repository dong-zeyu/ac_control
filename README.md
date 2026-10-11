# homebridge-aeha-ac

A high-performance Homebridge dynamic platform plugin that exposes AEHA-protocol Air Conditioners via infrared using native Linux kernel LIRC character devices, with simultaneous **Matter** (`RoomAirConditioner`) and **Apple HomeKit** (`HeaterCooler`) support.

> **Tested Hardware**: This protocol engine was reverse-engineered, captured, and tested directly on the **Sanyo KMHS0772** split air conditioner system using the **RCS-KMHS0772** remote control.

---

## Features

- **Direct Linux Kernel LIRC I/O**:
  - Communicates directly with `/dev/lirc0` via native Linux kernel `ioctl` (`LIRC_SET_SEND_CARRIER`, `LIRC_SET_SEND_DUTY_CYCLE`).
  - Zero external CLI dependencies (no `ir-ctl`), zero child processes, and zero temporary files.
  - Sub-millisecond hardware pulse transmission latency (< 1ms).
- **Dual Protocol Support**:
  - **Matter 1.3+ (`RoomAirConditioner`)**: Exposes native Matter clusters when Matter is enabled in Homebridge.
  - **Apple HomeKit (`HeaterCooler`)**: Optional parallel classic HAP service for direct control via the Homebridge UI web dashboard and Apple Home.
- **Full AEHA 152-bit Protocol Engine**:
  - Full support for Cooling, Heating, Dehumidification (Dry), and Auto modes.
  - Fan speed control (Auto, Low, Medium, High).
  - Vertical Louver / Flap positioning (Positions 1–6, Auto, and Swing).
  - Auxiliary controls: Powerful / Turbo mode, Quiet mode, Night Setback (Economy), and Negative Ion generator.
  - Real-time clock synchronization in every transmitted packet.
- **Ambient Temperature, Humidity & Steadman's Apparent Temperature**:
  - Reads ambient temperature (`/dev/dht0:temp`) and relative humidity (`/dev/dht0:humid`) to compute **Apparent Temperature** using **Steadman's Formula** ($AT = T_a + 0.33 \cdot e - 4.00$, assuming wind speed $v = 0\text{ m/s}$).
  - Exposes a dedicated **Apparent Temperature** HomeKit accessory (`TemperatureSensor` + linked `HumiditySensor`) alongside the Air Conditioner.
- **Embedded Homebridge UI Remote Control Add-on (`homebridge-ui`)**:
  - Integrates a full-featured, mobile-responsive **AC Remote Control UI** directly inside **Homebridge UI (`homebridge-config-ui-x`)** under the plugin's Settings modal.
  - Automatically matches your **Homebridge Light / Dark theme** and syncs two-way in real time with Apple HomeKit and Matter.
  - Exposes **100% of Sanyo KMHS0772 hardware controls**: Power, Mode (`Cool`, `Heat`, `Dry`, `Auto`), `0.5°C` Target Temp, Live Room Temp, **Steadman Apparent Temp**, Relative Humidity, Fan Speed, all 8 Louver/Flap states (Positions `1`–`6`, `Auto`, `Swing`), Special Modes (`Powerful`, `Quiet`, `Night Setback`, `Ionizer`), independent `ON Timer` and `OFF Timer` toggles, Force Retransmit, and a live 152-bit AEHA Frame Inspector.
- **State Persistence**:
  - Remembers power, mode, setpoint, flap, and timer state across Homebridge reboots (`aeha_ac_state.json`).

---

## Hardware Requirements

- Raspberry Pi (or compatible Linux SBC) running Linux with `gpio-ir-tx` configured.
- Infrared Transmitter LED wired to a GPIO pin (e.g. GPIO 22 on `/dev/lirc0`).
- (Optional) Infrared Receiver (e.g. VS1838B on GPIO 17 `/dev/lirc1`) for decoding remotes.
- (Optional) DHT11 / DHT22 / AM2302 temperature & humidity sensor.

---

## Configuration

Add the platform to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "AehaAirConditionerPlatform",
      "name": "Living Room AC",
      "irDevice": "/dev/lirc0",
      "carrierFrequency": 38000,
      "dutyCycle": 50,
      "dhtSensor": "/dev/dht0:temp",
      "humiditySensor": "/dev/dht0:humid",
      "enableApparentTempAccessory": true,
      "defaultFlapPosition": "6",
      "enableMatter": true,
      "enableHap": false,
      "enableAuxSwitches": true
    }
  ]
}
```

### Configuration Parameters

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `name` | string | `"Room Air Conditioner"` | Accessory display name. |
| `irDevice` | string | `"/dev/lirc0"` | Path to the Linux LIRC transmitter character device. |
| `carrierFrequency` | integer | `38000` | IR carrier frequency in Hz (38 kHz). |
| `dutyCycle` | integer | `50` | Modulation duty cycle percentage (50%). |
| `dhtSensor` | string | `"/dev/dht0:temp"` | Path to read the ambient temperature sensor. |
| `humiditySensor` | string | `"/dev/dht0:humid"` | Path to read the relative humidity sensor for Apparent Temperature. |
| `enableApparentTempAccessory` | boolean | `true` | Expose a standalone Apparent Temperature & Relative Humidity accessory. |
| `defaultFlapPosition`| string | `"6"` | Default flap position when non-swing (`"6"` = top/high, `"auto"`, `"1"`–`"5"`). |
| `enableMatter` | boolean | `true` | Expose as a Matter `RoomAirConditioner` accessory. |
| `enableHap` | boolean | `false` | Also expose a classic HomeKit `HeaterCooler` accessory. |
| `enableAuxSwitches` | boolean | `true` | Expose auxiliary switches for Swing, Powerful, Quiet, Economy, and Ion. |

---

## Development & Testing

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run build

# Run protocol & state manager test suite
npm test
```

For protocol timing diagrams, header/trailer timings, and byte-by-byte bitfield mappings, see [PROTOCOL.md](PROTOCOL.md).

---

## License

Apache-2.0
