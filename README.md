# grid_plug — Shelly relay control script by grid presence and battery SOC (Victron GX)

**grid_plug by [mixtoolabs](https://github.com/mixtoolabs)** · License: [Apache 2.0](LICENSE) · [Українською](README.uk.md)

A Shelly script that switches the relay of a Shelly Gen2+ device (smart plug or relay)
by **grid presence** and **battery state of charge (SOC)** of a Victron Energy system.
All data comes from the MQTT broker of the Victron GX device in your local network —
no cloud, no configuration in the code.

Typical use: power a load from the grid only while the grid is present and the battery is
already charged enough, and switch it off at once when the grid is lost.

---

## How it works

| Condition | Relay |
|---|---|
| Grid absent (Multi/Quattro is inverting, or no data) | **OFF at once** |
| Battery SOC unknown (no value, no data for 65 s) | **OFF** |
| Grid present and SOC ≥ threshold | **ON** |
| Grid present and SOC ≤ threshold − 2 % | **OFF** |
| SOC between the two limits | keeps the previous state (hysteresis, no relay chatter) |
| Script start, MQTT connection lost | **OFF** (safe state) |

- **Zero configuration.** The script finds the GX portal ID and the Multi/Quattro (VE.Bus)
  instance by itself from the MQTT topics. You only need to enter the IP address of the GX
  MQTT broker in the Shelly settings.
- **One setting — the "On at SOC" slider** (50…100 %, step 5 %, default 95 %). The script
  creates it on the first start and the value survives reboots.
- **Grid presence** — `vebus/<instance>/Ac/ActiveIn/ActiveInput`: AC-in-1 or AC-in-2 active
  means "grid present", "inverting" means "grid absent".
- **Battery SOC** — `system/0/Dc/Battery/Soc` (the main battery of the system).
- **Safe power-on.** The script sets the relay power-on state to "off", so after a power
  cut the relay stays off until the script has decided.
- **Keep-alive.** The script sends an MQTT keep-alive to the GX every 30 s, so the GX keeps
  publishing values.
- **Reconnect.** After an MQTT reconnect the script reuses the portal ID and instance it
  already found and does not search again.

---

## Requirements

- **Shelly Gen2 or newer with a relay** (smart plug or relay), firmware **1.5 or newer**.
- **Victron Energy system** with a GX device (Cerbo GX, Venus OS) and a **Multi/Quattro
  (VE.Bus)** inverter/charger, in the **same local network** as the Shelly.
- **MQTT access enabled on the GX.** In the current Venus OS interface:
  **Settings → Integrations → MQTT Access** (section "Server applications").
  The GX notes: *"A Security Profile must be configured before the network services can be
  enabled, see Settings - General"*.

### Compatibility

| Device | Status |
|---|---|
| Shelly Plug M Gen3, firmware 2.1.0 | **tested by the author** |
| Ogemray 25A by Shelly (SW40 PbS) firmware 1.5.0-ogemray25prod1-g5ae3a20 | **tested by the author** |
| Other Shelly Gen2+ devices with a relay | should work (not tested by the author) |

Notes:

- The **"On at SOC" slider is a virtual component**. According to the Shelly documentation
  virtual components exist on **Gen3 and Gen2 Pro** devices; they are also reported to work
  on Gen4. On devices **without virtual components** the script still works, with a
  **fixed threshold of 95 %**.
- Only the **first relay channel** (`switch:0`) is controlled.
- Not supported: Multi RS, standalone chargers without an AC input reading.

---

## Installation

### 1. Enable MQTT on the Victron GX

On the GX: **Settings → Integrations → MQTT Access** → on.
Note the IP address of the GX in your local network.

### 2. Connect Shelly to the GX MQTT broker

In the Shelly web interface (open the IP of the Shelly in a browser):
**Settings → MQTT**.

| Field | Value |
|---|---|
| **Enable** | **on** (required) |
| Connection type | No TLS |
| **Server** | **`<IP of your GX>:1883`** (required) |
| Username / Password | empty |
| Enable 'MQTT Control', Enable RPC over MQTT, RPC status notifications over MQTT, Generic status update over MQTT | **not used by the script** — optional; you may switch them off to reduce traffic on the GX broker |

Press **Save**. If Shelly asks for a reboot, reboot it.

### 3. Install the script

1. In the Shelly web interface open **Scripts** → **Create script**.
2. Give it a name, e.g. `grid_plug`.
3. Paste the whole content of [`grid_plug.js`](grid_plug.js) and press **Save**.
4. Enable **Run on startup** for the script.
5. Press **Start**.

### 4. Check that it runs

Open the script **console**. Within about a minute you should see lines like these
(the order of some lines may differ):

```
[grid_plug] start 5.2
[grid_plug] threshold 95
[grid_plug] creating number:200 On at SOC
[grid_plug] discovering portal id
[grid_plug] number:200 created {"id":200}
[grid_plug] portal id <your portal id>
[grid_plug] vebus instance <instance>
[grid_plug] grid present (ActiveInput=0, AC-in-1)
[grid_plug] soc topic N/<your portal id>/system/0/Dc/Battery/Soc
[grid_plug] soc 96 (threshold 95)
[grid_plug] relay -> ON
```

---

## Setting the threshold

In the Shelly Cloud app open **Components** → **On at SOC** and move the slider
(50…100 %). The slider is available only in the Shelly Cloud app; the device web interface
does not show it. The change applies at once:

- the relay switches **on** when SOC reaches the threshold;
- the relay switches **off** when SOC drops to **threshold − 2 %** (for 95 %: off at 93 %).

---

## Console messages

| Message | Meaning |
|---|---|
| `start 5.2` | script started (version) |
| `waiting for MQTT` | Shelly is not connected to the GX broker yet |
| `discovering portal id` / `portal id …` | searching for / found the GX |
| `vebus instance …` | Multi/Quattro found |
| `grid present (ActiveInput=0, AC-in-1)` | grid present on input 1 |
| `grid absent (ActiveInput=240, inverting)` | grid lost, Multi is inverting |
| `soc 95.5 (threshold 95)` | battery SOC and current threshold |
| `threshold 75` | slider moved |
| `relay -> ON` / `relay -> OFF` | relay command |
| `soc unknown (no data)` / `grid absent (no data)` | no data from the GX for 65 s |
| `MQTT disconnected` / `MQTT connected` / `resume portal id …` | connection lost and restored |
| `initial_state "on" -> off` | relay power-on state was changed to "off" |

---

## What stays on the device after removing the script

- The virtual component **"On at SOC"** (`number:200`) — remove it by hand in
  **Components**.
- The relay **power-on state** stays **"Turn OFF"** (output settings → "Action on power on")
  — change it back if needed.

---

## License

Copyright 2026 [mixtoolabs](https://github.com/mixtoolabs).

Licensed under the [Apache License, Version 2.0](LICENSE). Commercial and non-commercial
use, modification and distribution are allowed. When you distribute the script or a work
based on it, you must keep the license and the attribution from the [NOTICE](NOTICE) file:

> grid_plug by mixtoolabs - https://github.com/mixtoolabs

The script is provided "as is", without warranties of any kind (see the license).
