import { Endpoint, ServerNode } from "@matter/main";
import { DescriptorServer } from "@matter/main/behaviors/descriptor";
import { DeviceEnergyManagementServer } from "@matter/main/behaviors/device-energy-management";
import { IdentifyServer } from "@matter/main/behaviors/identify";
import { TemperatureMeasurementServer } from "@matter/main/behaviors/temperature-measurement";
import { ThermostatServer } from "@matter/main/behaviors/thermostat";
import { DeviceEnergyManagement } from "@matter/main/clusters/device-energy-management";
import { Thermostat } from "@matter/main/clusters/thermostat";
import { HeatPumpDevice } from "@matter/main/devices/heat-pump";
import { TemperatureSensorDevice } from "@matter/main/devices/temperature-sensor";
import { ThermostatDevice } from "@matter/main/devices/thermostat";
import { DeviceEnergyManagementEndpoint } from "@matter/main/endpoints/device-energy-management";
import { ElectricalSensorEndpoint } from "@matter/main/endpoints/electrical-sensor";
import {
    DEFAULT_DEM_MODE,
    DEM_MODES,
    demModeServer,
    energyMeasurementState,
    EnergyMeasurementServer,
    NodePowerTopologyServer,
    PowerMeasurementServer,
    powerMeasurementState,
    updateMeasurements,
} from "../shared/energy.js";
import { HeatPump, MAX_ELECTRICAL_W } from "../sim/heatpump.js";

const toMatterTemp = (celsius: number) => Math.round(celsius * 100);

/** DEM reporting a 24 h power forecast. A heat pump has no single start time to move, so only PFR is offered. */
const HeatPumpDemServer = DeviceEnergyManagementServer.with("PowerForecastReporting");

/**
 * Endpoint 1 is the heat pump, composed of:
 * - endpoint 2: Device Energy Management + Electrical Sensor at the grid connection
 * - endpoint 3: Thermostat for the heated space
 * - endpoint 4: outdoor Temperature Sensor
 */
export async function addEndpoints(node: ServerNode, heatPump: HeatPump) {
    class HeatPumpThermostatServer extends ThermostatServer.with("Heating") {
        override async initialize() {
            await super.initialize();
            // Setpoint and mode can be written by controllers or changed with SetpointRaiseLower; feed them back.
            this.reactTo(this.events.occupiedHeatingSetpoint$Changed, setpoint => {
                heatPump.setSetpoint(setpoint / 100);
            });
            this.reactTo(this.events.systemMode$Changed, mode => {
                heatPump.setMode(mode === Thermostat.SystemMode.Off ? "off" : "heat");
            });
        }
    }

    const { setpointC, outdoorC, mode } = heatPump.settings.value;

    const heatPumpEndpoint = new Endpoint(HeatPumpDevice.with(IdentifyServer), { id: "heat-pump", number: 1 });
    await node.add(heatPumpEndpoint);

    const energy = new Endpoint(
        DeviceEnergyManagementEndpoint.with(
            DescriptorServer,
            HeatPumpDemServer,
            demModeServer(() => {}),
            PowerMeasurementServer,
            EnergyMeasurementServer,
            NodePowerTopologyServer,
        ),
        {
            id: "energy",
            number: 2,
            descriptor: {
                deviceTypeList: [
                    { deviceType: DeviceEnergyManagementEndpoint.deviceType, revision: DeviceEnergyManagementEndpoint.deviceRevision },
                    { deviceType: ElectricalSensorEndpoint.deviceType, revision: ElectricalSensorEndpoint.deviceRevision },
                ],
            },
            deviceEnergyManagement: {
                esaType: DeviceEnergyManagement.EsaType.SpaceHeating,
                esaCanGenerate: false,
                esaState: DeviceEnergyManagement.EsaState.Online,
                absMinPower: 0,
                absMaxPower: MAX_ELECTRICAL_W * 1000,
                forecast: heatPump.forecast,
            },
            deviceEnergyManagementMode: { supportedModes: DEM_MODES, currentMode: DEFAULT_DEM_MODE },
            electricalPowerMeasurement: powerMeasurementState(0, MAX_ELECTRICAL_W),
            electricalEnergyMeasurement: energyMeasurementState(),
            powerTopology: {},
        },
    );
    await heatPumpEndpoint.add(energy);

    const thermostat = new Endpoint(ThermostatDevice.with(HeatPumpThermostatServer, IdentifyServer), {
        id: "thermostat",
        number: 3,
        thermostat: {
            controlSequenceOfOperation: Thermostat.ControlSequenceOfOperation.HeatingOnly,
            systemMode: mode === "off" ? Thermostat.SystemMode.Off : Thermostat.SystemMode.Heat,
            externalMeasuredIndoorTemperature: toMatterTemp(heatPump.indoorC),
            outdoorTemperature: toMatterTemp(outdoorC),
            occupiedHeatingSetpoint: toMatterTemp(setpointC),
            absMinHeatSetpointLimit: 700,
            absMaxHeatSetpointLimit: 3000,
            minHeatSetpointLimit: 700,
            maxHeatSetpointLimit: 3000,
            piHeatingDemand: 0,
            thermostatRunningState: { heat: false, cool: false, fan: false, heatStage2: false, coolStage2: false, fanStage2: false, fanStage3: false },
        },
    });
    await heatPumpEndpoint.add(thermostat);

    const outdoor = new Endpoint(TemperatureSensorDevice.with(TemperatureMeasurementServer, IdentifyServer), {
        id: "outdoor-temperature",
        number: 4,
        temperatureMeasurement: { measuredValue: toMatterTemp(outdoorC), minMeasuredValue: -4000, maxMeasuredValue: 6000 },
    });
    await heatPumpEndpoint.add(outdoor);

    return { heatPump: heatPumpEndpoint, energy, thermostat, outdoor };
}

/** Mirrors simulator changes onto the Matter endpoints. Updates are serialised and coalesced. */
export function bindEndpoints(heatPump: HeatPump, endpoints: { energy: Endpoint; thermostat: Endpoint; outdoor: Endpoint }) {
    const { energy, thermostat, outdoor } = endpoints;
    let pending = false;
    let running: Promise<void> = Promise.resolve();
    let lastPowerW = -1;
    let lastEnergyPush = 0;

    const push = async () => {
        pending = false;
        const { setpointC, outdoorC, mode } = heatPump.settings.value;
        await thermostat.set({
            thermostat: {
                externalMeasuredIndoorTemperature: toMatterTemp(heatPump.indoorC),
                outdoorTemperature: toMatterTemp(outdoorC),
                occupiedHeatingSetpoint: toMatterTemp(setpointC),
                systemMode: mode === "off" ? Thermostat.SystemMode.Off : Thermostat.SystemMode.Heat,
                piHeatingDemand: Math.round((100 * heatPump.powerW) / MAX_ELECTRICAL_W),
                thermostatRunningState: { heat: heatPump.compressorOn, cool: false, fan: false, heatStage2: false, coolStage2: false, fanStage2: false, fanStage3: false },
            },
        } as never);
        await outdoor.set({ temperatureMeasurement: { measuredValue: toMatterTemp(outdoorC) } } as never);
        await energy.set({ deviceEnergyManagement: { forecast: heatPump.forecast } } as never);

        // Power is pushed when it changes noticeably; cumulative energy at most every 10 s.
        const now = Date.now();
        if (Math.abs(heatPump.powerW - lastPowerW) >= 5 || now - lastEnergyPush > 10_000) {
            lastPowerW = heatPump.powerW;
            lastEnergyPush = now;
            await updateMeasurements(energy, heatPump.powerW, heatPump.settings.value.energyWh);
        }
    };

    heatPump.on("change", () => {
        if (pending) return;
        pending = true;
        running = running.then(push).catch(error => {
            // Updates racing a factory reset are dropped; the reset publishes fresh state once the node is back.
            if (!energy.lifecycle.isReady || !thermostat.lifecycle.isReady) return;
            console.error("Failed to update Matter state", error);
        });
    });
}
