import { join } from "node:path";
import { HeatPumpDevice } from "@matter/main/devices/heat-pump";
import { Commissioning } from "./shared/commissioning.js";
import { createServerNode, STORAGE_PATH } from "./shared/node.js";
import { Settings } from "./shared/settings.js";
import { HeatPump, HeatPumpMode, HeatPumpSettings } from "./sim/heatpump.js";
import { addEndpoints, bindEndpoints } from "./matter/device.js";
import { startWebServer } from "./web/server.js";

const WEB_PORT = Number(process.env.WEB_PORT ?? 5001);
const MATTER_PORT = Number(process.env.MATTER_PORT ?? 5541);

// The first forecast assumes a 21 °C target with 8 °C outside.
const settings = new Settings<HeatPumpSettings>(join(STORAGE_PATH, "simulator.json"), {
    setpointC: 21,
    outdoorC: 8,
    mode: "heat",
    speed: 60,
    energyWh: 0,
});
const heatPump = new HeatPump(settings);

const node = await createServerNode({
    id: "heat-pump",
    name: "Simulated Heat Pump",
    productId: 0x8001,
    deviceType: HeatPumpDevice.deviceType,
    port: MATTER_PORT,
    discriminator: 3841,
    passcode: 20202021,
    serialNumber: "SIM-HP-0001",
});
const endpoints = await addEndpoints(node, heatPump);
bindEndpoints(heatPump, endpoints);

const commissioning = new Commissioning(node);
startWebServer(WEB_PORT, {
    snapshot: () => heatPump.snapshot(),
    on: (event, listener) => heatPump.on(event, listener),
    action(name, args) {
        switch (name) {
            case "setSetpoint": return heatPump.setSetpoint(Number(args.setpointC));
            case "setOutdoor": return heatPump.setOutdoor(Number(args.outdoorC));
            case "setMode": return heatPump.setMode(args.mode as HeatPumpMode);
            case "setSpeed": return heatPump.setSpeed(Number(args.speed));
            case "factoryReset": return heatPump.factoryReset();
            default: return `Unknown action ${name}`;
        }
    },
}, commissioning);

heatPump.run();
await node.start();

const { qrPairingCode, manualPairingCode } = node.state.commissioning.pairingCodes;
console.log(`Manual pairing code: ${manualPairingCode}  QR: ${qrPairingCode}`);
