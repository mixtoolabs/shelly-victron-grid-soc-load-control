// grid_plug 5.2
// grid_plug by mixtoolabs - https://github.com/mixtoolabs
// Licensed under the Apache License, Version 2.0 (see LICENSE and NOTICE).
//
// Shelly script: switches the relay of a Shelly Gen2+ device (smart plug or
// relay, firmware 1.5 or newer) by grid presence and battery state of charge
// (SOC) of a Victron Energy system. Data comes from the MQTT broker of the
// Victron GX device (Cerbo GX, Venus OS) in the same local network.
//
// Zero configuration in the code:
//   - Shelly MQTT must be enabled and point to the GX broker (<GX IP>:1883);
//   - the GX portal id and the Multi/Quattro (vebus) instance are found
//     automatically from the MQTT topics;
//   - the only setting is the virtual slider "On at SOC" (number:200,
//     50..100 %, step 5, default 95). The script creates it if missing.
//     Devices without virtual components work with a fixed threshold of 95 %.
//     The script never deletes the slider: remove it by hand
//     (web UI -> Components) when the script is no longer used.
//
// Rules:
//   grid absent (Multi inverting, no data)      -> relay OFF at once
//   SOC unknown (no value, no data for 65 s)    -> relay OFF
//   grid present, SOC >= threshold              -> relay ON
//   grid present, SOC <= threshold - 5          -> relay OFF
//   in between                                  -> keep previous (hysteresis)
//   script start, MQTT connection lost          -> relay OFF (safe state)
//   relay power-on state is forced to "off"     -> relay OFF before the
//                                                  script is running
//
// Only the first relay channel (switch:0) is controlled.

let CFG = {
  SW_KEY: "switch:0",
  SW_ID: 0,
  NUM_KEY: "number:200",
  NUM_ID: 200,
  NUM_NAME: "On at SOC",
  NUM_MIN: 50,
  NUM_MAX: 100,
  NUM_STEP: 5,
  NUM_DEFAULT: 95,
  HYST: 5,
  KEEPALIVE_MS: 30000,
  WATCH_MS: 5000,
  STALE_MS: 65000,
  LOG: "[grid_plug] "
};

let st = {
  pid: "",
  inst: "",
  grid: false,
  age: 0,
  found: false,
  discovering: false,
  gridTopic: "",
  kaTimer: null,
  otherLogged: false,
  firstLogged: false,
  soc: null,
  socAge: 0,
  socOk: false,
  socLogged: false,
  socTopic: "",
  socPending: false,
  thr: null,
  savedPid: "",
  savedInst: "",
  cmd: null
};

function log(msg) {
  print(CFG.LOG + msg);
}

// *** relay ***

function onSetDone(result, error_code, error_message) {
  st.cmd = null;
  if (error_code !== 0) {
    log("Switch.Set error " + JSON.stringify(error_code) + " " + error_message);
  }
  // the command has landed: check once more in case the decision changed
  // while it was on its way
  Timer.set(10, false, applyRelay);
}

function applyRelay() {
  syncSoc();
  let want = decide();
  let cur = Shelly.getComponentStatus(CFG.SW_KEY);
  if (cur !== null && cur.output === want) {
    return;
  }
  // this command was already sent and is not confirmed yet; sending it
  // twice makes the firmware report "cannot write register while uart is busy"
  if (st.cmd === want) {
    return;
  }
  st.cmd = want;
  let txt = "OFF";
  if (want) {
    txt = "ON";
  }
  log("relay -> " + txt);
  Shelly.call("Switch.Set", { id: CFG.SW_ID, on: want }, onSetDone);
}

function setGrid(present, reason, force) {
  if (st.grid !== present || force) {
    let txt = "absent";
    if (present) {
      txt = "present";
    }
    log("grid " + txt + " (" + reason + ")");
  }
  st.grid = present;
  applyRelay();
}

// *** decision: grid presence and SOC threshold ***

function readThreshold() {
  // slider missing (no virtual components on the device), unreadable or
  // out of range: use the default threshold
  let s = Shelly.getComponentStatus(CFG.NUM_KEY);
  if (s === null || typeof s.value !== "number") {
    return CFG.NUM_DEFAULT;
  }
  let v = s.value;
  if (v < CFG.NUM_MIN || v > CFG.NUM_MAX) {
    return CFG.NUM_DEFAULT;
  }
  return v;
}

function decide() {
  let thr = readThreshold();
  if (thr !== st.thr) {
    log("threshold " + JSON.stringify(thr));
    st.thr = thr;
  }
  if (!st.grid) {
    return false;
  }
  if (st.soc === null) {
    return false;
  }
  // hysteresis of one slider step: on at SOC >= threshold, off only at
  // SOC <= threshold - 5, the state is kept in between (no relay chatter)
  if (st.soc >= thr) {
    st.socOk = true;
  } else if (st.soc <= thr - CFG.HYST) {
    st.socOk = false;
  }
  return st.socOk;
}

// *** battery SOC ***

function onSoc(topic, message) {
  // topic: N/<pid>/system/0/Dc/Battery/Soc
  if (st.socTopic === "" || topic !== st.socTopic) {
    return;
  }
  st.socAge = 0;
  let v = parseValue(message);
  if (typeof v !== "number") {
    v = null;
  }
  if (v !== st.soc || !st.socLogged) {
    let thr = readThreshold();
    log("soc " + JSON.stringify(v) + " (threshold " + JSON.stringify(thr) + ")");
  }
  st.socLogged = true;
  st.soc = v;
  applyRelay();
}

function subscribeSoc() {
  st.socPending = false;
  if (st.pid === "" || st.socTopic !== "") {
    return;
  }
  st.socTopic = "N/" + st.pid + "/system/0/Dc/Battery/Soc";
  st.soc = null;
  st.socAge = 0;
  st.socLogged = false;
  MQTT.subscribe(st.socTopic, onSoc);
  log("soc topic " + st.socTopic);
  sendKeepalive();
}

function syncSoc() {
  // follows discovery state: subscribe when portal id is known,
  // drop subscription and value when portal id is reset (MQTT lost)
  if (st.pid === "") {
    if (st.socTopic !== "") {
      MQTT.unsubscribe(st.socTopic);
      st.socTopic = "";
    }
    st.soc = null;
    st.socOk = false;
    st.socLogged = false;
    return;
  }
  if (st.socTopic === "" && !st.socPending) {
    st.socPending = true;
    Timer.set(10, false, subscribeSoc);
  }
}

// *** "On at SOC" slider ***

function onNumSet(result, error_code, error_message) {
  if (error_code !== 0) {
    log("Number.Set error " + JSON.stringify(error_code) + " " + error_message);
    return;
  }
  applyRelay();
}

function onSliderAdded(result, error_code, error_message) {
  if (error_code !== 0) {
    log("Virtual.Add error " + JSON.stringify(error_code) + " " + error_message);
    return;
  }
  let rr = JSON.stringify(result);
  log(CFG.NUM_KEY + " created " + rr);
  Shelly.call("Number.Set", { id: CFG.NUM_ID, value: CFG.NUM_DEFAULT }, onNumSet);
}

function createSlider() {
  log("creating " + CFG.NUM_KEY + " " + CFG.NUM_NAME);
  let cfg = {
    name: CFG.NUM_NAME,
    min: CFG.NUM_MIN,
    max: CFG.NUM_MAX,
    persisted: true,
    default_value: CFG.NUM_DEFAULT,
    meta: { ui: { view: "slider", unit: "%", step: CFG.NUM_STEP } }
  };
  Shelly.call("Virtual.Add", { type: "number", id: CFG.NUM_ID, config: cfg }, onSliderAdded);
}

function ensureSlider() {
  let s = Shelly.getComponentStatus(CFG.NUM_KEY);
  if (s !== null) {
    return;
  }
  createSlider();
}

function onStatus(ev) {
  // act only on a number:200 delta that carries value
  if (typeof ev !== "object" || ev === null) {
    return;
  }
  if (ev.component !== CFG.NUM_KEY) {
    return;
  }
  if (typeof ev.delta !== "object" || ev.delta === null) {
    return;
  }
  if (typeof ev.delta.value === "undefined") {
    return;
  }
  applyRelay();
}

// *** relay power-on state: off until the script decides ***

function onCfgDone(result, error_code, error_message) {
  if (error_code !== 0) {
    log("Switch.SetConfig error " + JSON.stringify(error_code) + " " + error_message);
    return;
  }
  let rr = JSON.stringify(result);
  log("initial_state set to off " + rr);
}

function ensureInitialOff() {
  let cfg = Shelly.getComponentConfig(CFG.SW_KEY);
  if (cfg === null) {
    log("switch config not available");
    return;
  }
  if (cfg.initial_state === "off") {
    return;
  }
  let old = JSON.stringify(cfg.initial_state);
  log("initial_state " + old + " -> off");
  Shelly.call("Switch.SetConfig", { id: CFG.SW_ID, config: { initial_state: "off" } }, onCfgDone);
}

// *** grid value ***

function parseValue(msg) {
  if (msg.length === 0) {
    return null;
  }
  let o = null;
  try {
    o = JSON.parse(msg);
  } catch (e) {
    o = null;
  }
  if (o === null || typeof o !== "object") {
    return null;
  }
  if (typeof o.value === "undefined") {
    return null;
  }
  return o.value;
}

function gridName(v) {
  if (v === 0) {
    return "AC-in-1";
  }
  if (v === 1) {
    return "AC-in-2";
  }
  if (v === 240) {
    return "inverting";
  }
  return "unknown";
}

function onGrid(topic, message) {
  // topic: N/<pid>/vebus/<inst>/Ac/ActiveIn/ActiveInput
  let head = "N/" + st.pid + "/vebus/";
  let rest = topic.slice(head.length);
  let i = rest.indexOf("/");
  if (i < 1) {
    return;
  }
  let inst = rest.slice(0, i);
  if (st.inst === "") {
    st.inst = inst;
    log("vebus instance " + inst);
  }
  if (inst !== st.inst) {
    if (!st.otherLogged) {
      log("ignoring other vebus instance " + inst);
      st.otherLogged = true;
    }
    return;
  }
  st.age = 0;
  // the first value after (re)connection is always logged
  let first = !st.firstLogged;
  st.firstLogged = true;
  if (message.length === 0) {
    setGrid(false, "vebus gone", first);
    return;
  }
  let v = parseValue(message);
  let present = (v === 0 || v === 1);
  let name = gridName(v);
  let reason = "ActiveInput=" + JSON.stringify(v) + ", " + name;
  setGrid(present, reason, first);
}

// *** keepalive ***

function sendKeepalive() {
  if (st.pid === "") {
    return;
  }
  MQTT.publish("R/" + st.pid + "/keepalive", "", 0, false);
}

function stopKeepalive() {
  if (st.kaTimer !== null) {
    Timer.clear(st.kaTimer);
    st.kaTimer = null;
  }
}

// *** discovery ***

function onAny(topic, message) {
  // first N/<pid>/... message gives the portal id
  if (st.found) {
    return;
  }
  let rest = topic.slice(2);
  let i = rest.indexOf("/");
  if (topic.slice(0, 2) !== "N/" || i < 1) {
    return;
  }
  st.pid = rest.slice(0, i);
  st.found = true;
  Timer.set(10, false, afterDiscovery);
}

function afterDiscovery() {
  if (st.pid === "") {
    return;
  }
  MQTT.unsubscribe("N/#");
  st.discovering = false;
  st.firstLogged = false;
  log("portal id " + st.pid);
  st.gridTopic = "N/" + st.pid + "/vebus/+/Ac/ActiveIn/ActiveInput";
  MQTT.subscribe(st.gridTopic, onGrid);
  sendKeepalive();
  stopKeepalive();
  st.kaTimer = Timer.set(CFG.KEEPALIVE_MS, true, sendKeepalive);
}

function resume() {
  // MQTT is back: reuse the portal id and instance found before instead of
  // a new wide N/# discovery, which can overflow the Shelly MQTT queue
  if (st.pid !== "" || st.savedPid === "") {
    return;
  }
  if (!MQTT.isConnected()) {
    // lost again before this ran; the connect handler will call back
    return;
  }
  st.pid = st.savedPid;
  st.inst = st.savedInst;
  st.firstLogged = false;
  if (st.inst !== "") {
    st.gridTopic = "N/" + st.pid + "/vebus/" + st.inst + "/Ac/ActiveIn/ActiveInput";
  } else {
    st.gridTopic = "N/" + st.pid + "/vebus/+/Ac/ActiveIn/ActiveInput";
  }
  log("resume portal id " + st.pid + ", instance " + JSON.stringify(st.inst));
  MQTT.subscribe(st.gridTopic, onGrid);
  sendKeepalive();
  stopKeepalive();
  st.kaTimer = Timer.set(CFG.KEEPALIVE_MS, true, sendKeepalive);
  // soc topic is subscribed again by the relay logic (syncSoc)
  applyRelay();
}

function startDiscovery() {
  if (st.discovering || st.pid !== "") {
    return;
  }
  if (st.savedPid !== "") {
    Timer.set(10, false, resume);
    return;
  }
  st.discovering = true;
  st.found = false;
  log("discovering portal id");
  MQTT.subscribe("N/#", onAny);
}

// *** MQTT link ***

function onMqttConnect() {
  log("MQTT connected");
  startDiscovery();
}

function onMqttDisconnect() {
  log("MQTT disconnected");
  stopKeepalive();
  if (st.discovering) {
    MQTT.unsubscribe("N/#");
  }
  if (st.gridTopic !== "") {
    MQTT.unsubscribe(st.gridTopic);
  }
  // remember what discovery found; an unfinished discovery starts over
  if (st.pid !== "" && !st.discovering) {
    st.savedPid = st.pid;
    st.savedInst = st.inst;
  }
  st.pid = "";
  st.inst = "";
  st.gridTopic = "";
  st.discovering = false;
  st.found = false;
  st.otherLogged = false;
  st.firstLogged = false;
  setGrid(false, "MQTT lost", false);
}

// *** watchdog ***

function watchdog() {
  st.age = st.age + CFG.WATCH_MS;
  st.socAge = st.socAge + CFG.WATCH_MS;
  // no SOC update for 65 s: SOC is unknown and the relay goes off
  if (st.soc !== null && st.socAge >= CFG.STALE_MS) {
    log("soc unknown (no data)");
    st.soc = null;
    applyRelay();
  }
  if (st.grid && st.age >= CFG.STALE_MS) {
    setGrid(false, "no data", false);
  }
}

// *** start ***

function start() {
  log("start 5.2");
  setGrid(false, "start", false);
  ensureInitialOff();
  ensureSlider();
  Shelly.addStatusHandler(onStatus);
  MQTT.setConnectHandler(onMqttConnect);
  MQTT.setDisconnectHandler(onMqttDisconnect);
  Timer.set(CFG.WATCH_MS, true, watchdog);
  if (MQTT.isConnected()) {
    startDiscovery();
  } else {
    log("waiting for MQTT");
  }
}

Timer.set(100, false, start);
