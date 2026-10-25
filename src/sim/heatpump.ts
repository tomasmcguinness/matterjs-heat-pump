import { EventEmitter } from "node:events";
import { DeviceEnergyManagement } from "@matter/main/clusters/device-energy-management";
import { buildForecast, ForecastStep } from "../shared/forecast.js";
import { Settings } from "../shared/settings.js";
import { nowUnixS } from "../shared/time.js";

const { ForecastUpdateReason } = DeviceEnergyManagement;

/** Building heat loss coefficient (W/K): a typical, reasonably insulated 3-bed house. */
export const UA_W_PER_K = 200;
/** Thermal time constant of the building. */
const TAU_S = 2 * 3600;
const THERMAL_MASS_J_PER_K = UA_W_PER_K * TAU_S;
/** Electrical limits of a 6 kW air-source heat pump. */
export const MIN_ELECTRICAL_W = 250;
export const MAX_ELECTRICAL_W = 3000;
const STANDBY_W = 10;
/** Proportional boost (W of heat per K below setpoint) used to recover the room temperature. */
const RECOVERY_W_PER_K = 1500;
/** Compressor hysteresis when demand is below the minimum modulation. */
const HYSTERESIS_K = 0.5;
/** Forecast horizon and slot size. */
const FORECAST_SLOTS = 24;
const SLOT_S = 3600;
/** Morning comfort recovery: 06:00–08:00 draws more as the house warms after the overnight dip. */
const MORNING_BOOST = { fromHour: 6, toHour: 8, factor: 1.4 };

export type HeatPumpMode = "heat" | "off";

export interface HeatPumpSettings {
    setpointC: number;
    outdoorC: number;
    mode: HeatPumpMode;
    speed: number;
    energyWh: number;
}

/** Coefficient of performance for an air-source heat pump at the given outdoor temperature. */
export function cop(outdoorC: number) {
    return Math.min(5, Math.max(1.8, 2.9 + 0.06 * outdoorC));
}

/** Steady-state electrical draw needed to hold the setpoint. */
export function steadyStateWatts(setpointC: number, outdoorC: number) {
    const heatW = Math.max(0, UA_W_PER_K * (setpointC - outdoorC));
    if (heatW === 0) return 0;
    return Math.min(MAX_ELECTRICAL_W, Math.max(MIN_ELECTRICAL_W, heatW / cop(outdoorC)));
}

/**
 * Air-source heat pump heating a house. The indoor temperature follows a first-order thermal model; the compressor
 * modulates between its minimum and maximum electrical power and cycles when demand drops below the minimum.
 */
export class HeatPump extends EventEmitter {
    indoorC: number;
    compressorOn = false;
    powerW = 0;
    heatW = 0;
    forecastId = 0;
    lastMessage = "";
    #forecast: DeviceEnergyManagement.Forecast | null = null;
    #forecastHour = -1;
    #timer?: NodeJS.Timeout;

    constructor(readonly settings: Settings<HeatPumpSettings>) {
        super();
        this.indoorC = settings.value.setpointC - 0.2;
    }

    get forecast() {
        return this.#forecast;
    }

    get cop() {
        return cop(this.settings.value.outdoorC);
    }

    run() {
        this.#publishForecast();
        this.#timer = setInterval(() => this.tick(), 1000);
    }

    close() {
        clearInterval(this.#timer);
    }

    // ---- User and Matter actions. Each returns an error message on failure. ----

    setSetpoint(setpointC: number) {
        if (!Number.isFinite(setpointC) || setpointC < 7 || setpointC > 30) return "Setpoint must be between 7 and 30 °C";
        setpointC = Math.round(setpointC * 10) / 10;
        if (setpointC === this.settings.value.setpointC) return;
        this.settings.update({ setpointC });
        this.lastMessage = `Setpoint changed to ${setpointC.toFixed(1)} °C`;
        this.#publishForecast();
        this.emit("change");
    }

    setOutdoor(outdoorC: number) {
        if (!Number.isFinite(outdoorC) || outdoorC < -25 || outdoorC > 35) return "Outdoor temperature out of range";
        outdoorC = Math.round(outdoorC * 10) / 10;
        if (outdoorC === this.settings.value.outdoorC) return;
        this.settings.update({ outdoorC });
        this.lastMessage = `Outdoor temperature changed to ${outdoorC.toFixed(1)} °C`;
        this.#publishForecast();
        this.emit("change");
    }

    setMode(mode: HeatPumpMode) {
        if (mode !== "heat" && mode !== "off") return "Unknown mode";
        if (mode === this.settings.value.mode) return;
        this.settings.update({ mode });
        this.lastMessage = mode === "heat" ? "Heating on" : "Heating off";
        this.#publishForecast();
        this.tick(0);
    }

    setSpeed(speed: number) {
        this.settings.update({ speed: Math.max(1, Math.min(600, speed)) });
        this.emit("change");
    }

    factoryReset() {
        this.settings.reset();
        this.indoorC = this.settings.value.setpointC - 0.2;
        this.forecastId = 0;
        this.lastMessage = "Factory reset";
        this.#publishForecast();
        this.emit("change");
    }

    // ---- Simulation ----

    /** Advances the thermal model by one tick (simulation speed × 1 s, or the given number of seconds). */
    tick(dtS = this.settings.value.speed) {
        const { setpointC, outdoorC, mode } = this.settings.value;
        const lossW = UA_W_PER_K * (this.indoorC - outdoorC);

        if (mode === "off") {
            this.compressorOn = false;
        } else {
            const demandW = UA_W_PER_K * (setpointC - outdoorC) + RECOVERY_W_PER_K * (setpointC - this.indoorC);
            const minHeatW = MIN_ELECTRICAL_W * this.cop;
            if (this.indoorC > setpointC + HYSTERESIS_K || demandW <= 0) {
                this.compressorOn = false;
            } else if (this.indoorC < setpointC - HYSTERESIS_K || demandW >= minHeatW) {
                this.compressorOn = true;
            }
        }

        if (this.compressorOn) {
            const demandW = UA_W_PER_K * (setpointC - outdoorC) + RECOVERY_W_PER_K * (setpointC - this.indoorC);
            this.powerW = Math.min(MAX_ELECTRICAL_W, Math.max(MIN_ELECTRICAL_W, demandW / this.cop));
            this.heatW = this.powerW * this.cop;
        } else {
            this.powerW = STANDBY_W;
            this.heatW = 0;
        }

        this.indoorC += ((this.heatW - lossW) * dtS) / THERMAL_MASS_J_PER_K;
        this.settings.update({ energyWh: this.settings.value.energyWh + (this.powerW * dtS) / 3600 }, false);

        // Roll the forecast forward each hour so it always covers the next 24 h.
        if (new Date().getHours() !== this.#forecastHour) {
            this.#publishForecast();
        }
        this.emit("change");
    }

    /** Hour-by-hour expected electrical power for the next 24 h at the current setpoint and outdoor temperature. */
    forecastSteps(): ForecastStep[] {
        const { setpointC, outdoorC, mode } = this.settings.value;
        const baseW = mode === "off" ? STANDBY_W : steadyStateWatts(setpointC, outdoorC);
        const startHour = new Date().getHours();
        return Array.from({ length: FORECAST_SLOTS }, (_, i) => {
            const hour = (startHour + i) % 24;
            const boost = mode === "heat" && hour >= MORNING_BOOST.fromHour && hour < MORNING_BOOST.toHour ? MORNING_BOOST.factor : 1;
            const watts = Math.round(Math.min(MAX_ELECTRICAL_W, baseW * boost));
            return {
                durationS: SLOT_S,
                watts,
                minWatts: mode === "off" ? STANDBY_W : Math.min(watts, MIN_ELECTRICAL_W),
                maxWatts: mode === "off" ? STANDBY_W : Math.min(MAX_ELECTRICAL_W, Math.round(watts * 1.6)),
            };
        });
    }

    #publishForecast() {
        const hourStart = new Date();
        hourStart.setMinutes(0, 0, 0);
        this.#forecastHour = hourStart.getHours();
        this.forecastId++;
        const startUnixS = Math.floor(hourStart.getTime() / 1000);
        this.#forecast = buildForecast({
            forecastId: this.forecastId,
            steps: this.forecastSteps(),
            startUnixS,
            elapsedS: nowUnixS() - startUnixS,
            reason: ForecastUpdateReason.InternalOptimization,
        });
    }

    snapshot() {
        const forecast = this.#forecast;
        const { setpointC, outdoorC, mode, speed, energyWh } = this.settings.value;
        return {
            kind: "heat-pump",
            running: this.compressorOn,
            mode,
            setpointC,
            outdoorC,
            indoorC: Math.round(this.indoorC * 100) / 100,
            powerW: Math.round(this.powerW),
            heatW: Math.round(this.heatW),
            cop: Math.round(this.cop * 100) / 100,
            steadyStateW: Math.round(steadyStateWatts(setpointC, outdoorC)),
            energyKWh: energyWh / 1000,
            speed,
            message: this.lastMessage,
            forecast: forecast && {
                forecastId: forecast.forecastId,
                reason: ForecastUpdateReason[forecast.forecastUpdateReason],
                startUnixS: forecast.startTime,
                endUnixS: forecast.endTime,
                activeSlotNumber: forecast.activeSlotNumber,
                slots: forecast.slots.map(s => ({ durationS: s.defaultDuration, watts: Number(s.nominalPower ?? 0) / 1000 })),
            },
        };
    }
}
