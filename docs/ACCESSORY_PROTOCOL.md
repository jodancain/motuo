# Motuo accessory protocol v1

SteedPilot-compatible HUD transport is based on MIT-licensed Dean Edis / SteedPilot (see adjacent license, upstream https://github.com/deanthecoder/SteedPilot). No firmware or GSX250R ECU compatibility is asserted.

- BLE service c6372234-79d6-4a5e-8a57-08a3b7a8a7d1, write-with-response f6c8d747-fc2c-4ef4-906a-7c8cbf552814, optional notify fa62492e-5c6f-4a8d-9853-1a996b0c7c5d.
- Wi-Fi Bonjour `_motuo-hud._tcp`, local TCP. User explicitly selects the advertised device; no passwords, NAS credentials or manuals sent to accessories. HUD payloads only.
- UTF8 JSON + LF framing. At most 8192 bytes per outgoing object. BLE fragmentation <=128 bytes and negotiated maximum, one in flight with 3s ACK timeout. Most recent pending snapshot wins; old queued states are not replayed after reconnect.
- State packet: `{ "v":1, "type":"state", "mode":"rideInfo", "source":"measured", "speed":{"current":42}, "units":{"speed":"kmh"} }`. Missing measured speed must be omitted; simulated frames carry source simulated.
- Heartbeat `{ "v":1, "type":"heartbeat" }` every ~3s when idle. A receiver must invalidate its displayed measured state after 10s without fresh state/update; a heartbeat alone must not resurrect a stale speed or turn instruction. This stricter Motuo freshness rule should be added to original SteedPilot firmware before road use.
- Future device capability advertisement `{ "v":1,"type":"capabilities","capabilities":["hud","tyrePressure","rpm","gear"] }`.
- Measurement `{ "v":1,"type":"measurement","sequence":1,"timestamp":1789372800.0,"metric":"tyrePressure","value":245,"unit":"kPa" }`. UTC epoch seconds, receive age <=5s, sequence strictly increasing per connection; unknown units/capabilities or out-of-range values are rejected. Physical driver must additionally establish wheel identity and calibration before tyre-pressure UI integration.
- Initial accepted values: tyrePressure 0...600 kPa; rpm 0...20000 rpm; gear integral 0...6 (0 neutral). IMU capability reserved until a specific sensor's units/orientation are mapped.

Run `swift scripts/HUDSimulator.swift` on a Mac on the same network to advertise the TCP fixture receiver. This validates discovery/framing and stale timeout, not actual accessory behavior. Pair actual BLE hardware for real BLE acceptance.
