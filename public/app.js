import { $, act, formatPower, initSettings, renderForecast, renderForecastMeta, setIfIdle, socket, syncSpeed } from "./common.js";

initSettings({ speedHelp: "Speeds up the room temperature model so heating and cycling are visible quickly." });

let state;

$("heatOn").addEventListener("change", e => act("setMode", { mode: e.target.checked ? "heat" : "off" }));
$("setpointDown").addEventListener("click", () => act("setSetpoint", { setpointC: state.setpointC - 0.5 }));
$("setpointUp").addEventListener("click", () => act("setSetpoint", { setpointC: state.setpointC + 0.5 }));
$("outdoor").addEventListener("input", e => ($("outdoorValue").textContent = `${Number(e.target.value).toFixed(1)} °C`));
$("outdoor").addEventListener("change", e => act("setOutdoor", { outdoorC: Number(e.target.value) }));

socket.on("state", s => {
    state = s;
    document.body.className = [s.running ? "running" : "", s.mode === "off" ? "mode-off" : ""].join(" ");

    $("heatOn").checked = s.mode === "heat";
    $("setpoint").textContent = `${s.setpointC.toFixed(1)}°C`;
    setIfIdle($("outdoor"), String(s.outdoorC));
    if (document.activeElement !== $("outdoor")) $("outdoorValue").textContent = `${s.outdoorC.toFixed(1)} °C`;

    $("stateBadge").textContent = s.mode === "off" ? "Off" : s.running ? "Heating" : "Idle";
    $("stateBadge").classList.toggle("on", s.running);
    $("compressor").textContent = s.running ? "Running" : "Off";
    $("indoor").textContent = `${s.indoorC.toFixed(2)} °C`;
    $("cop").textContent = s.cop.toFixed(2);
    $("power").textContent = formatPower(s.powerW);
    $("heat").textContent = formatPower(s.heatW);
    $("steady").textContent = formatPower(s.steadyStateW);
    $("energy").textContent = `${s.energyKWh.toFixed(3)} kWh`;
    $("message").textContent = s.message || "–";
    $("indoorLabel").textContent = `${s.indoorC.toFixed(1)}°`;
    $("outdoorLabel").textContent = `${s.outdoorC.toFixed(1)}°`;
    syncSpeed(s.speed);

    renderForecast($("forecastChart"), s.forecast);
    renderForecastMeta($("forecastMeta"), s.forecast, {
        "Basis": `${s.setpointC.toFixed(1)} °C target, ${s.outdoorC.toFixed(1)} °C outside`,
        "Energy (24 h)": s.forecast ? `${(s.forecast.slots.reduce((sum, slot) => sum + slot.watts * slot.durationS, 0) / 3.6e6).toFixed(1)} kWh` : "–",
    });
});
