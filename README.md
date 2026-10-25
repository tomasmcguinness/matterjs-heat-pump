# matterjs-heat-pump

A [matter.js](https://github.com/project-chip/matter.js) air-source heat pump simulator for developing energy managers. It heats a simulated house and publishes a 24-hour **Device Energy Management** power forecast. The thermostat setpoint and the outdoor temperature can be changed from the UI, and the setpoint can also be written over Matter.

It is one of four simulators that also include [matterjs-dishwasher](https://github.com/tomasmcguinness/matterjs-dishwasher), [matterjs-washing-machine](https://github.com/tomasmcguinness/matterjs-washing-machine) and [matterjs-solar-inverter](https://github.com/tomasmcguinness/matterjs-solar-inverter). They are built to work with [matter-js-energy-manager](https://github.com/tomasmcguinness/matter-js-energy-manager).

## Running

Requires Node.js 20.19+ or 22.13+ (required by matter.js).

```bash
npm install
npm run dev
```

Open the UI at `http://localhost:5001`. Every asset (Bootstrap, socket.io and the QR code renderer) is served from `node_modules`, so the UI works with no internet connection.

| Setting | Default | Environment variable |
|---|---|---|
| Web UI port | 5001 | `WEB_PORT` |
| Matter port | 5541 | `MATTER_PORT` |
| Storage | `./.matter-storage` | `MATTER_STORAGE_PATH` |
| Log level | `info` | `MATTER_LOG_LEVEL` |

`npm run build` compiles to `dist/`, and `npm start` runs the compiled build.

## Commissioning

| | |
|---|---|
| Manual pairing code | `3497-011-2332` |
| QR payload | `MT:-24J0IRV01KA0648G00` |
| Passcode / discriminator | `20202021` / `3841` |
| Vendor / product ID | `0xFFF1` (test vendor) / `0x8001` |

The **Settings** tab shows the QR code and the fabrics the device belongs to. It has two actions:

- **Open commissioning window** opens a window so another controller can join.
- **Factory reset** erases all fabrics, Matter storage and simulator settings, then restarts the node uncommissioned.

## Conventions

- **Power sign:** Electrical Power Measurement `activePower` is positive when the device consumes power and negative when it produces it. Units are mW, mV and mA.
- **Time:** matter.js takes epoch-s values (forecast start/end and `requestedStartTime`) as **Unix seconds** and converts them to the Matter epoch on the wire. Controllers built on matter.js should send Unix seconds too.
- **Forecast size:** forecasts have at most 10 slots, the limit in the Matter specification.

## Endpoints

Endpoint 1 is the Heat Pump. The other endpoints are its children in the descriptor `partsList`.

| Endpoint | Device types | Clusters |
|---|---|---|
| 1 | Heat Pump (0x0309) | Identify |
| 2 | Device Energy Management (0x050D) + Electrical Sensor (0x0510) | Device Energy Management (PowerForecastReporting), Device Energy Management Mode, Electrical Power Measurement, Electrical Energy Measurement, Power Topology |
| 3 | Thermostat (0x0301) | Thermostat (Heating; `localTemperature` = indoor, `outdoorTemperature`, writable `occupiedHeatingSetpoint`, `systemMode` Off/Heat, `SetpointRaiseLower`), Identify |
| 4 | Temperature Sensor (0x0302) | Temperature Measurement (outdoor), Identify |

## Model

- **Heat loss:** 200 W/K, typical of a reasonably insulated 3-bed house. The thermal time constant is 2 h.
- **COP:** `COP = 2.9 + 0.06 × T_out`, clamped to 1.8–5. That gives 3.38 at 8 °C and 2.78 at −2 °C.
- **Electrical draw:** modulates between 250 W and 3 kW, which is a 6 kW unit. The compressor cycles with ±0.5 °C hysteresis when demand falls below the minimum modulation.
- **Room temperature:** the indoor temperature follows a first-order model. The simulation speed (default 60×) makes heating and cycling visible quickly.

## Forecast

The forecast covers 24 hours from the start of the current hour. Each hour's steady-state draw is `200 W/K × (T_set − T_out) / COP`, and 06:00–08:00 is raised by 40 % for morning recovery. Neighbouring hours are merged to fit the 10-slot limit. Each slot carries min/max power: 250 W up to 1.6× nominal.

At startup the defaults are **21 °C target and 8 °C outside**: 13 K × 200 W = 2.6 kW of heat at a COP of 3.38. The forecast is therefore **≈770 W**, with **≈1.08 kW** from 06:00 to 08:00, or about 19 kWh a day.

The forecast is republished with reason `InternalOptimization` whenever the setpoint, outdoor temperature or mode changes, and every hour. The heat pump offers no start-time adjustment, since it has no single run to move.

## UI

- **Main tab:**
  - an outline drawing of the house and outdoor unit: the fan spins, heat rises from the radiator and water flows in the pipes while the compressor runs;
  - the heating on/off switch, setpoint −/+ buttons and an outside temperature slider (−15 to 20 °C);
  - live COP, power and heat output;
  - the 24-hour forecast.
- **Settings tab:** commissioning, simulation speed and factory reset.

## Project layout

```
src/
  main.ts               boots the simulator, Matter node and web server
  sim/heatpump.ts       thermal model, COP, compressor control and forecast
  matter/device.ts      endpoints and the bridge from the model to Matter state
  shared/               forecast builder, energy clusters, commissioning, node setup, settings (shared with the sibling simulators)
  web/server.ts         Express and socket.io UI server
public/                 index.html (drawing and controls), app.js, common.js (Settings tab, charts), style.css
```
