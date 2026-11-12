//! App-owned BLE transport bridge for the LOOI magnetic desktop dock.
//! Enforces generation-isolated event queues and native-level `<100ms` emergency stop on undock/background.
use nsh_core::prelude::*;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, OnceLock, Weak},
};

#[cfg(target_os = "android")]
#[path = "ble/android.rs"]
mod android;
#[cfg(target_os = "ios")]
#[path = "ble/ios.rs"]
mod ios;

#[cfg(target_os = "android")]
use android as platform;
#[cfg(target_os = "ios")]
use ios as platform;

#[cfg_attr(not(any(target_os = "ios", target_os = "android")), allow(dead_code))]
pub(super) const LOOI_SERVICE_UUID: &str = "000000ff-0000-1000-8000-00805f9b34fb";
pub(super) const MAX_BLE_EVENTS: usize = 128;

pub(super) type SharedBle = Arc<Mutex<BleState>>;
static ACTIVE_BLE: OnceLock<Mutex<Weak<Mutex<BleState>>>> = OnceLock::new();

/// One nearby BLE device candidate discovered during scanning.
#[derive(Clone, Debug, PartialEq, Eq, JsObject)]
pub struct ScannedBleDevice {
    /// Platform BLE peripheral identifier.
    pub id: String,
    /// Friendly advertised peripheral name.
    pub name: String,
    /// Signal strength in dBm.
    pub rssi: i32,
}

/// One pollable BLE lifecycle or GATT notification event.
#[derive(Clone, Debug, PartialEq, Eq, JsObject)]
pub struct BleNativeEvent {
    /// "connected" | "disconnected" | "notification" | "write_ack" | "error"
    pub kind: String,
    /// Characteristic key ("dockNotify", "handshakeControl", etc.) or empty
    pub characteristic: String,
    /// Lowercase hex payload or error message
    pub payload: String,
}

/// Snapshot of native BLE connection and permission state.
#[derive(Clone, Debug, PartialEq, Eq, JsObject)]
pub struct BleNativeStatus {
    /// "disconnected" | "scanning" | "connecting" | "connected" | "error"
    pub state: String,
    /// "granted" | "denied" | "undetermined" | "unavailable"
    pub permission: String,
    /// Connected or pending peripheral identifier.
    pub device_id: String,
    /// Connected or pending peripheral display name.
    pub device_name: String,
    /// Last sanitized error string, or empty.
    pub error: String,
}

pub(super) struct BleState {
    pub generation: u64,
    pub state: &'static str,
    pub device_id: String,
    pub device_name: String,
    pub error: String,
    pub candidates: Vec<ScannedBleDevice>,
    pub events: VecDeque<BleNativeEvent>,
    pub emergency_stop_count: u64,
}

impl Default for BleState {
    fn default() -> Self {
        Self {
            generation: 0,
            state: "disconnected",
            device_id: String::new(),
            device_name: String::new(),
            error: String::new(),
            candidates: Vec::new(),
            events: VecDeque::with_capacity(MAX_BLE_EVENTS),
            emergency_stop_count: 0,
        }
    }
}

#[cfg_attr(not(any(target_os = "ios", target_os = "android")), allow(dead_code))]
impl BleState {
    pub fn push_event(&mut self, kind: &str, characteristic: &str, payload: &str) {
        if self.events.len() >= MAX_BLE_EVENTS {
            self.events.pop_front();
        }
        self.events.push_back(BleNativeEvent {
            kind: kind.to_owned(),
            characteristic: characteristic.to_owned(),
            payload: payload.to_owned(),
        });
    }

    pub fn upsert_candidate(&mut self, id: String, name: String, rssi: i32) {
        if id.trim().is_empty() {
            return;
        }
        let display_name = if name.trim().is_empty() {
            "LOOI 桌面底座".to_owned()
        } else {
            name.trim().to_owned()
        };
        if let Some(existing) = self.candidates.iter_mut().find(|item| item.id == id) {
            existing.name = display_name;
            existing.rssi = rssi;
        } else {
            self.candidates.push(ScannedBleDevice {
                id,
                name: display_name,
                rssi,
            });
        }
    }

    pub fn on_connected(&mut self, generation: u64, device_id: &str, device_name: &str) -> bool {
        if generation != self.generation {
            return false;
        }
        self.state = "connected";
        self.error.clear();
        if !device_id.is_empty() {
            self.device_id = device_id.to_owned();
        }
        if !device_name.is_empty() {
            self.device_name = device_name.to_owned();
        }
        self.push_event("connected", "", &self.device_id.clone());
        true
    }

    pub fn on_disconnected(&mut self, generation: u64, reason: &str) -> bool {
        if generation != self.generation {
            return false;
        }
        self.state = "disconnected";
        if !reason.is_empty() {
            self.error = reason.to_owned();
        }
        self.push_event("disconnected", "", reason);
        true
    }

    /// Returns `true` if a hardware-level immediate `0000` stop write to `drive` (`fed0`) is required.
    pub fn on_notification(&mut self, generation: u64, uuid_or_key: &str, hex: &str) -> bool {
        if generation != self.generation
            || (self.state != "connected" && self.state != "connecting")
        {
            return false;
        }
        let Some(char_key) = characteristic_key_from_uuid(uuid_or_key) else {
            return false;
        };
        let clean = hex.trim().to_ascii_lowercase();
        let requires_emergency_stop = char_key == "dockNotify" && clean == "06";
        if requires_emergency_stop {
            self.emergency_stop_count += 1;
        }
        self.push_event("notification", char_key, &clean);
        requires_emergency_stop
    }

    pub fn on_write_ack(&mut self, generation: u64, uuid_or_key: &str) {
        if generation != self.generation || self.state != "connected" {
            return;
        }
        if let Some(char_key) = characteristic_key_from_uuid(uuid_or_key) {
            self.push_event("write_ack", char_key, "");
        }
    }

    pub fn on_notify_ack(&mut self, generation: u64, uuid_or_key: &str) {
        if generation != self.generation || self.state != "connected" {
            return;
        }
        if let Some(char_key) = characteristic_key_from_uuid(uuid_or_key) {
            self.push_event("notify_ack", char_key, "");
        }
    }

    pub fn on_read_result(&mut self, generation: u64, uuid_or_key: &str, hex: &str) {
        if generation != self.generation || self.state != "connected" {
            return;
        }
        if let Some(char_key) = characteristic_key_from_uuid(uuid_or_key) {
            self.push_event("read_result", char_key, hex);
        }
    }

    pub fn on_error(&mut self, generation: u64, message: &str) {
        if generation != self.generation {
            return;
        }
        self.error = message.to_owned();
        self.push_event("error", "", message);
    }
}

#[cfg_attr(not(any(target_os = "ios", target_os = "android")), allow(dead_code))]
pub(super) fn active_shared() -> Option<SharedBle> {
    ACTIVE_BLE.get()?.lock().ok()?.upgrade()
}

pub(super) fn characteristic_uuid(key: &str) -> Option<&'static str> {
    match key {
        "drive" => Some("0000fed0-0000-1000-8000-00805f9b34fb"),
        "head" => Some("0000fed1-0000-1000-8000-00805f9b34fb"),
        "light" => Some("0000fed2-0000-1000-8000-00805f9b34fb"),
        "sensorNotify" => Some("0000fed5-0000-1000-8000-00805f9b34fb"),
        "power" => Some("0000fed8-0000-1000-8000-00805f9b34fb"),
        "dockNotify" => Some("0000fed9-0000-1000-8000-00805f9b34fb"),
        "handshakeControl" => Some("0000feda-0000-1000-8000-00805f9b34fb"),
        "handshakeData" => Some("0000fef0-0000-1000-8000-00805f9b34fb"),
        "rawFe00" => Some("0000fe00-0000-1000-8000-00805f9b34fb"),
        _ => None,
    }
}

#[cfg_attr(
    not(any(target_os = "ios", target_os = "android", test)),
    allow(dead_code)
)]
pub(super) fn characteristic_key_from_uuid(uuid_or_key: &str) -> Option<&'static str> {
    let lower = uuid_or_key.trim().to_ascii_lowercase();
    match lower.as_str() {
        "drive" | "fed0" | "0000fed0-0000-1000-8000-00805f9b34fb" => Some("drive"),
        "head" | "fed1" | "0000fed1-0000-1000-8000-00805f9b34fb" => Some("head"),
        "light" | "fed2" | "0000fed2-0000-1000-8000-00805f9b34fb" => Some("light"),
        "sensornotify" | "fed5" | "0000fed5-0000-1000-8000-00805f9b34fb" => Some("sensorNotify"),
        "power" | "fed8" | "0000fed8-0000-1000-8000-00805f9b34fb" => Some("power"),
        "docknotify" | "fed9" | "0000fed9-0000-1000-8000-00805f9b34fb" => Some("dockNotify"),
        "handshakecontrol" | "feda" | "0000feda-0000-1000-8000-00805f9b34fb" => {
            Some("handshakeControl")
        }
        "handshakedata" | "fef0" | "0000fef0-0000-1000-8000-00805f9b34fb" => Some("handshakeData"),
        "rawfe00" | "fe00" | "0000fe00-0000-1000-8000-00805f9b34fb" => Some("rawFe00"),
        _ => None,
    }
}

pub(super) fn decode_hex(raw: &str) -> Result<Vec<u8>, String> {
    let clean: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
    if clean.is_empty() || clean.len() % 2 != 0 {
        return Err("Invalid BLE hex payload length".into());
    }
    let mut bytes = Vec::with_capacity(clean.len() / 2);
    for idx in (0..clean.len()).step_by(2) {
        let byte = u8::from_str_radix(&clean[idx..idx + 2], 16)
            .map_err(|_| "Invalid BLE hex payload characters".to_owned())?;
        bytes.push(byte);
    }
    Ok(bytes)
}

#[cfg_attr(
    not(any(target_os = "ios", target_os = "android", test)),
    allow(dead_code)
)]
pub(super) fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

/// Pollable native BLE bridge for LOOI hardware dock.
#[class]
pub struct LooiBle {
    shared: SharedBle,
}

#[class]
impl LooiBle {
    /// Create an idle BLE bridge without starting a scan or prompting for permissions.
    pub fn new() -> Self {
        let shared = Arc::new(Mutex::new(BleState::default()));
        if let Ok(mut slot) = ACTIVE_BLE.get_or_init(|| Mutex::new(Weak::new())).lock() {
            *slot = Arc::downgrade(&shared);
        }
        Self { shared }
    }

    /// Query current Bluetooth authorization status.
    pub fn permission(&self) -> String {
        platform::permission()
    }

    /// Request Bluetooth permission from the operating system.
    pub fn request_permission(&self) -> String {
        platform::request_permission()
    }

    /// Begin scanning for nearby LOOI hardware docks.
    pub fn start_scan(&mut self) -> Result<(), String> {
        {
            let mut state = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            state.error.clear();
            state.candidates.clear();
            if state.state == "disconnected" || state.state == "error" {
                state.state = "scanning";
            }
        }
        platform::start_scan(&self.shared)
    }

    /// Stop an active BLE scan.
    pub fn stop_scan(&mut self) {
        platform::stop_scan();
        if let Ok(mut state) = self.shared.lock() {
            if state.state == "scanning" {
                state.state = "disconnected";
            }
        }
    }

    /// Read the list of discovered nearby BLE dock candidates.
    pub fn scanned_devices(&self) -> Vec<ScannedBleDevice> {
        self.shared
            .lock()
            .map(|state| state.candidates.clone())
            .unwrap_or_default()
    }

    /// Connect to a specific BLE dock peripheral by identifier.
    pub fn connect(&mut self, device_id: String) -> Result<(), String> {
        let target_id = device_id.trim().to_owned();
        if target_id.is_empty() {
            return Err("BLE device_id is required".into());
        }
        let generation = {
            let mut state = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            state.generation = state.generation.wrapping_add(1);
            state.state = "connecting";
            state.error.clear();
            state.events.clear();
            state.device_id = target_id.clone();
            if let Some(found) = state.candidates.iter().find(|c| c.id == target_id) {
                state.device_name = found.name.clone();
            } else if state.device_name.is_empty() {
                state.device_name = "LOOI 桌面底座".into();
            }
            state.generation
        };
        if let Err(err) = platform::connect(&self.shared, generation, &target_id) {
            if let Ok(mut state) = self.shared.lock() {
                if state.generation == generation {
                    state.state = "error";
                    state.error = err.clone();
                }
            }
            return Err(err);
        }
        Ok(())
    }

    /// Disconnect from the active BLE dock and invalidate its generation.
    pub fn disconnect(&mut self) {
        {
            let mut state = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            state.generation = state.generation.wrapping_add(1);
            state.state = "disconnected";
            state.events.clear();
        }
        platform::disconnect();
    }

    /// Enable notifications and wait for the platform's subscription acknowledgement.
    pub fn subscribe(&mut self, characteristic: String) -> Result<(), String> {
        let uuid = characteristic_uuid(&characteristic)
            .ok_or_else(|| format!("Unsupported LOOI characteristic: {characteristic}"))?;
        let generation = {
            let state = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            if state.state != "connected" {
                return Err("BLE transport is not connected".into());
            }
            state.generation
        };
        platform::subscribe(generation, uuid)
    }

    /// Write a hex-encoded payload to a named LOOI GATT characteristic.
    pub fn write(
        &mut self,
        characteristic: String,
        hex_payload: String,
        with_response: bool,
    ) -> Result<(), String> {
        let uuid = characteristic_uuid(&characteristic)
            .ok_or_else(|| format!("Unsupported LOOI characteristic: {characteristic}"))?;
        let bytes = decode_hex(&hex_payload)?;
        let generation = {
            let state = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            if state.state != "connected" {
                return Err("BLE transport is not connected".into());
            }
            state.generation
        };
        platform::write(generation, uuid, &bytes, with_response)
    }

    /// Request one GATT characteristic read; the value arrives as a `read_result` event.
    pub fn read(&mut self, characteristic: String) -> Result<(), String> {
        let uuid = characteristic_uuid(&characteristic)
            .ok_or_else(|| format!("Unsupported LOOI characteristic: {characteristic}"))?;
        let generation = {
            let state = self.shared.lock().unwrap_or_else(|e| e.into_inner());
            if state.state != "connected" {
                return Err("BLE transport is not connected".into());
            }
            state.generation
        };
        platform::read(generation, uuid)
    }

    /// Drain queued BLE events in chronological order.
    pub fn drain_events(&mut self) -> Vec<BleNativeEvent> {
        self.shared
            .lock()
            .map(|mut state| state.events.drain(..).collect())
            .unwrap_or_default()
    }

    /// Poll current native BLE status.
    pub fn status(&self) -> BleNativeStatus {
        let state = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        BleNativeStatus {
            state: state.state.to_owned(),
            permission: platform::permission(),
            device_id: state.device_id.clone(),
            device_name: state.device_name.clone(),
            error: state.error.clone(),
        }
    }
}

impl Drop for LooiBle {
    fn drop(&mut self) {
        #[cfg(target_os = "ios")]
        ios::release(&self.shared);
        #[cfg(not(target_os = "ios"))]
        self.disconnect();
    }
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod platform {
    use super::SharedBle;
    pub fn permission() -> String {
        "unavailable".into()
    }
    pub fn request_permission() -> String {
        "unavailable".into()
    }
    pub fn start_scan(_shared: &SharedBle) -> Result<(), String> {
        Err("Native BLE requires iOS or Android".into())
    }
    pub fn read(_generation: u64, _characteristic_uuid: &str) -> Result<(), String> {
        Err("Native BLE requires iOS or Android".into())
    }
    pub fn stop_scan() {}
    pub fn connect(_shared: &SharedBle, _generation: u64, _device_id: &str) -> Result<(), String> {
        Err("Native BLE requires iOS or Android".into())
    }
    pub fn disconnect() {}
    pub fn subscribe(_generation: u64, _characteristic_uuid: &str) -> Result<(), String> {
        Err("Native BLE requires iOS or Android".into())
    }
    pub fn write(
        _generation: u64,
        _characteristic_uuid: &str,
        _bytes: &[u8],
        _with_response: bool,
    ) -> Result<(), String> {
        Err("Native BLE requires iOS or Android".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_codec_and_characteristic_mapping_roundtrip() {
        let bytes = decode_hex("41 32 30 32 36").unwrap();
        assert_eq!(bytes, b"A2026");
        assert_eq!(encode_hex(&bytes), "4132303236");
        assert!(decode_hex("0").is_err());
        assert!(decode_hex("zz").is_err());

        assert_eq!(characteristic_key_from_uuid("FED9"), Some("dockNotify"));
        assert_eq!(characteristic_key_from_uuid("FED8"), Some("power"));
        assert_eq!(characteristic_uuid("power"), Some("0000fed8-0000-1000-8000-00805f9b34fb"));
        assert_eq!(
            characteristic_key_from_uuid("0000fed0-0000-1000-8000-00805f9b34fb"),
            Some("drive")
        );
        assert_eq!(
            characteristic_uuid("handshakeControl"),
            Some("0000feda-0000-1000-8000-00805f9b34fb")
        );
    }

    #[test]
    fn generation_isolation_and_undock_emergency_stop_invariant() {
        let mut state = BleState::default();
        state.generation = 1;
        state.state = "connecting";

        // Stale generation callbacks are ignored
        assert!(!state.on_connected(0, "old-id", "Old LOOI"));
        assert_eq!(state.state, "connecting");

        // The first dock notification can arrive before CCCD subscription reports connected.
        assert!(!state.on_notification(1, "FED9", "05"));

        // Current generation connects
        assert!(state.on_connected(1, "looi-01", "LOOI 桌面底座"));
        assert_eq!(state.state, "connected");

        state.on_read_result(0, "FED8", "4c01");
        assert!(!state.events.iter().any(|event| event.kind == "read_result"));
        state.on_read_result(1, "FED8", "4c01");
        assert!(state.events.iter().any(|event| event.kind == "read_result" && event.characteristic == "power" && event.payload == "4c01"));

        // Docked notification ('05') does not trigger emergency stop
        assert!(!state.on_notification(1, "FED9", "05"));
        assert_eq!(state.emergency_stop_count, 0);

        // Undocked notification ('06') immediately signals hardware emergency stop
        assert!(state.on_notification(1, "0000fed9-0000-1000-8000-00805f9b34fb", "06"));
        assert_eq!(state.emergency_stop_count, 1);

        let drained: Vec<_> = state.events.drain(..).collect();
        assert_eq!(drained.len(), 5);
        assert_eq!(drained[0].characteristic, "dockNotify");
        assert_eq!(drained[0].payload, "05");
        assert_eq!(drained[1].kind, "connected");
        assert_eq!(drained[2].characteristic, "power");
        assert_eq!(drained[2].payload, "4c01");
        assert_eq!(drained[3].characteristic, "dockNotify");
        assert_eq!(drained[3].payload, "05");
        assert_eq!(drained[4].characteristic, "dockNotify");
        assert_eq!(drained[4].payload, "06");
    }
}
