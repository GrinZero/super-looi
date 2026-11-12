use super::{
    SharedBle, active_shared, characteristic_key_from_uuid, encode_hex,
};
use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject, Bool},
};
use objc2_foundation::{NSObject, NSObjectProtocol, NSString};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    ptr, slice,
    sync::Arc,
};

#[link(name = "CoreBluetooth", kind = "framework")]
unsafe extern "C" {}
#[link(name = "UIKit", kind = "framework")]
unsafe extern "C" {
    static UIApplicationDidEnterBackgroundNotification: *const NSString;
}

thread_local! {
    static BLE_MANAGER: RefCell<Option<IosBleManager>> = const { RefCell::new(None) };
    static BG_OBSERVER: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

struct IosBleManager {
    central: Retained<AnyObject>,
    delegate: Retained<BleDelegate>,
    discovered: HashMap<String, Retained<AnyObject>>,
    active_peripheral: Option<Retained<AnyObject>>,
    cancelling: HashSet<usize>,
    characteristics: HashMap<String, Retained<AnyObject>>,
    generation: u64,
    want_scan: bool,
    pending_connect_id: Option<String>,
    did_report_connected: bool,
}

struct DelegateIvars {
    shared: SharedBle,
}

fn peripheral_identifier(peripheral: &AnyObject) -> String {
    unsafe {
        let uuid_obj: Retained<AnyObject> = msg_send![peripheral, identifier];
        let uuid_ns: Retained<NSString> = msg_send![&uuid_obj, UUIDString];
        uuid_ns.to_string()
    }
}

fn retrieve_or_cached_peripheral(
    central: &AnyObject,
    discovered: &mut HashMap<String, Retained<AnyObject>>,
    target_id: &str,
) -> Option<Retained<AnyObject>> {
    if let Some(cached) = discovered.get(target_id).cloned() {
        return Some(cached);
    }
    if let Some((_, cached)) = discovered
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(target_id))
    {
        return Some(cached.clone());
    }
    unsafe {
        let nsuuid_cls = AnyClass::get(c"NSUUID")?;
        let nsarray_cls = AnyClass::get(c"NSArray")?;
        let id_str = NSString::from_str(target_id);
        let alloc: Allocated<AnyObject> = msg_send![nsuuid_cls, alloc];
        let uuid_obj: Option<Retained<AnyObject>> =
            msg_send![alloc, initWithUUIDString: &*id_str];
        let uuid_obj = uuid_obj?;
        let canonical_ns: Retained<NSString> = msg_send![&uuid_obj, UUIDString];
        let canonical_id = canonical_ns.to_string();
        let identifiers: Retained<AnyObject> =
            msg_send![nsarray_cls, arrayWithObject: &*uuid_obj];
        let found: Option<Retained<AnyObject>> =
            msg_send![central, retrievePeripheralsWithIdentifiers: &*identifiers];
        let found = found?;
        let count: usize = msg_send![&found, count];
        if count == 0 {
            return None;
        }
        let peripheral: Retained<AnyObject> = msg_send![&found, objectAtIndex: 0usize];
        discovered.insert(canonical_id, peripheral.clone());
        Some(peripheral)
    }
}

fn cancel_active_peripheral(mgr: &mut IosBleManager) {
    if let Some(prev) = mgr.active_peripheral.take() {
        unsafe {
            let c_state: isize = msg_send![&mgr.central, state];
            let p_state: isize = msg_send![&prev, state];
            if c_state == 5 && (p_state == 1 || p_state == 2 || p_state == 3) {
                mgr.cancelling.insert((&*prev) as *const AnyObject as usize);
                if p_state == 1 || p_state == 2 {
                    let _: () = msg_send![&mgr.central, cancelPeripheralConnection: &*prev];
                }
            }
        }
    }
}

fn try_connect_known_peripheral(mgr: &mut IosBleManager, target_id: &str) -> bool {
    let Some(peripheral) =
        retrieve_or_cached_peripheral(&mgr.central, &mut mgr.discovered, target_id)
    else {
        return false;
    };
    let ptr_key = (&*peripheral) as *const AnyObject as usize;
    unsafe {
        if !mgr.want_scan {
            let _: () = msg_send![&mgr.central, stopScan];
        }
    }
    if mgr.cancelling.contains(&ptr_key) {
        mgr.pending_connect_id = Some(target_id.to_owned());
        return true;
    }
    mgr.pending_connect_id = None;
    mgr.active_peripheral = Some(peripheral.clone());
    unsafe {
        let _: () = msg_send![&peripheral, setDelegate: &*mgr.delegate];
        let _: () = msg_send![
            &mgr.central,
            connectPeripheral: &*peripheral,
            options: ptr::null::<AnyObject>()
        ];
    }
    true
}

fn finish_cancelled_or_promote(mgr: &mut IosBleManager, peripheral: &AnyObject) -> bool {
    let ptr_key = peripheral as *const AnyObject as usize;
    if !mgr.cancelling.remove(&ptr_key) {
        return false;
    }
    if let Some(pending_id) = mgr.pending_connect_id.clone() {
        let state: isize = unsafe { msg_send![&mgr.central, state] };
        if state == 5 && peripheral_identifier(peripheral).eq_ignore_ascii_case(&pending_id) {
            if let Some(retained) =
                unsafe { Retained::retain(peripheral as *const AnyObject as *mut AnyObject) }
            {
                mgr.pending_connect_id = None;
                mgr.active_peripheral = Some(retained.clone());
                unsafe {
                    if !mgr.want_scan {
                        let _: () = msg_send![&mgr.central, stopScan];
                    }
                    let _: () = msg_send![&retained, setDelegate: &*mgr.delegate];
                    let _: () = msg_send![
                        &mgr.central,
                        connectPeripheral: &*retained,
                        options: ptr::null::<AnyObject>()
                    ];
                }
            }
        }
    }
    true
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateIvars]
    struct BleDelegate;

    unsafe impl NSObjectProtocol for BleDelegate {}

    impl BleDelegate {
        #[unsafe(method(centralManagerDidUpdateState:))]
        fn did_update_state(&self, central: &AnyObject) {
            let state: isize = unsafe { msg_send![central, state] };
            BLE_MANAGER.with(|slot| {
                let mut borrow = slot.borrow_mut();
                let Some(mgr) = borrow.as_mut() else { return };
                if state == 5 {
                    // CBManagerStatePoweredOn == 5
                    let mut known_queued = false;
                    if let Some(target_id) = mgr.pending_connect_id.clone() {
                        known_queued = try_connect_known_peripheral(mgr, &target_id);
                    }
                    if mgr.want_scan || (mgr.pending_connect_id.is_some() && !known_queued) {
                        unsafe {
                            let _: () = msg_send![
                                &mgr.central,
                                scanForPeripheralsWithServices: ptr::null::<AnyObject>(),
                                options: ptr::null::<AnyObject>()
                            ];
                        }
                    }
                } else {
                    mgr.cancelling.clear();
                    if state == 4 {
                        // CBManagerStatePoweredOff == 4
                        let generation = mgr.generation;
                        mgr.want_scan = false;
                        if let Ok(mut shared) = self.ivars().shared.lock() {
                            shared.on_error(generation, "系统蓝牙未开启");
                        }
                    }
                }
            });
        }

        #[unsafe(method(centralManager:didDiscoverPeripheral:advertisementData:RSSI:))]
        fn did_discover_peripheral(
            &self,
            _central: &AnyObject,
            peripheral: &AnyObject,
            adv_data: &AnyObject,
            rssi: &AnyObject,
        ) {
            let (id, name, rssi_val, is_looi) = unsafe {
                let uuid_obj: Retained<AnyObject> = msg_send![peripheral, identifier];
                let uuid_ns: Retained<NSString> = msg_send![&uuid_obj, UUIDString];
                let id = uuid_ns.to_string();

                let p_name: Option<Retained<NSString>> = msg_send![peripheral, name];
                let mut name = p_name.map(|s| s.to_string()).unwrap_or_default();
                if name.is_empty() {
                    let key = NSString::from_str("kCBAdvDataLocalName");
                    let local_name: Option<Retained<NSString>> =
                        msg_send![adv_data, objectForKey: &*key];
                    if let Some(local_name) = local_name {
                        name = local_name.to_string();
                    }
                }

                let rssi_num: i32 = msg_send![rssi, intValue];
                let name_matches = name.to_ascii_lowercase().contains("looi");

                let mut service_matches = false;
                let svc_key = NSString::from_str("kCBAdvDataServiceUUIDs");
                let svc_array: Option<Retained<AnyObject>> =
                    msg_send![adv_data, objectForKey: &*svc_key];
                if let Some(arr) = svc_array {
                    let count: usize = msg_send![&arr, count];
                    for idx in 0..count {
                        let uuid: Retained<AnyObject> = msg_send![&arr, objectAtIndex: idx];
                        let s: Retained<NSString> = msg_send![&uuid, UUIDString];
                        let lower = s.to_string().to_ascii_lowercase();
                        if lower == "00ff" || lower.starts_with("000000ff-") {
                            service_matches = true;
                            break;
                        }
                    }
                }

                (id, name, rssi_num, name_matches || service_matches)
            };

            if !is_looi || id.is_empty() {
                return;
            }

            let retained_peripheral = unsafe { Retained::retain(peripheral as *const AnyObject as *mut AnyObject) };
            let Some(retained_peripheral) = retained_peripheral else { return };

            BLE_MANAGER.with(|slot| {
                if let Some(mgr) = slot.borrow_mut().as_mut() {
                    mgr.discovered.insert(id.clone(), retained_peripheral.clone());
                    if mgr
                        .pending_connect_id
                        .as_deref()
                        .is_some_and(|pending| pending.eq_ignore_ascii_case(&id))
                    {
                        let ptr_key = (&*retained_peripheral) as *const AnyObject as usize;
                        unsafe {
                            if !mgr.want_scan {
                                let _: () = msg_send![&mgr.central, stopScan];
                            }
                        }
                        if !mgr.cancelling.contains(&ptr_key) {
                            mgr.pending_connect_id = None;
                            mgr.active_peripheral = Some(retained_peripheral.clone());
                            unsafe {
                                let _: () =
                                    msg_send![&retained_peripheral, setDelegate: &*mgr.delegate];
                                let _: () = msg_send![
                                    &mgr.central,
                                    connectPeripheral: &*retained_peripheral,
                                    options: ptr::null::<AnyObject>()
                                ];
                            }
                        }
                    }
                }
            });

            if let Ok(mut shared) = self.ivars().shared.lock() {
                shared.upsert_candidate(id, name, rssi_val);
            }
        }

        #[unsafe(method(centralManager:didConnectPeripheral:))]
        fn did_connect_peripheral(&self, _central: &AnyObject, peripheral: &AnyObject) {
            let is_active = BLE_MANAGER.with(|slot| {
                slot.borrow()
                    .as_ref()
                    .and_then(|mgr| mgr.active_peripheral.as_ref())
                    .is_some_and(|active| ptr::eq(&**active, peripheral))
            });
            if !is_active {
                return;
            }
            unsafe {
                let _: () = msg_send![peripheral, setDelegate: self];
                let _: () = msg_send![peripheral, discoverServices: ptr::null::<AnyObject>()];
            }
        }

        #[unsafe(method(centralManager:didFailToConnectPeripheral:error:))]
        fn did_fail_to_connect(
            &self,
            _central: &AnyObject,
            peripheral: &AnyObject,
            _error: Option<&AnyObject>,
        ) {
            let generation = BLE_MANAGER.with(|slot| {
                let mut borrow = slot.borrow_mut();
                let Some(mgr) = borrow.as_mut() else {
                    return None;
                };
                if finish_cancelled_or_promote(mgr, peripheral) {
                    return None;
                }
                let is_active = mgr
                    .active_peripheral
                    .as_ref()
                    .is_some_and(|active| ptr::eq(&**active, peripheral));
                if !is_active {
                    return None;
                }
                mgr.characteristics.clear();
                mgr.active_peripheral = None;
                mgr.did_report_connected = false;
                Some(mgr.generation)
            });
            if let Some(generation_id) = generation {
                if let Ok(mut shared) = self.ivars().shared.lock() {
                    shared.on_disconnected(generation_id, "无法连接到 LOOI 底座");
                }
            }
        }

        #[unsafe(method(centralManager:didDisconnectPeripheral:error:))]
        fn did_disconnect_peripheral(
            &self,
            _central: &AnyObject,
            peripheral: &AnyObject,
            _error: Option<&AnyObject>,
        ) {
            let generation = BLE_MANAGER.with(|slot| {
                let mut borrow = slot.borrow_mut();
                let Some(mgr) = borrow.as_mut() else {
                    return None;
                };
                if finish_cancelled_or_promote(mgr, peripheral) {
                    return None;
                }
                let is_active = mgr
                    .active_peripheral
                    .as_ref()
                    .is_some_and(|active| ptr::eq(&**active, peripheral));
                if !is_active {
                    return None;
                }
                mgr.characteristics.clear();
                mgr.active_peripheral = None;
                mgr.did_report_connected = false;
                Some(mgr.generation)
            });
            if let Some(generation_id) = generation {
                if let Ok(mut shared) = self.ivars().shared.lock() {
                    shared.on_disconnected(generation_id, "");
                }
            }
        }

        #[unsafe(method(peripheral:didDiscoverServices:))]
        fn did_discover_services(&self, peripheral: &AnyObject, _error: Option<&AnyObject>) {
            let is_active = BLE_MANAGER.with(|slot| {
                slot.borrow()
                    .as_ref()
                    .and_then(|mgr| mgr.active_peripheral.as_ref())
                    .is_some_and(|active| ptr::eq(&**active, peripheral))
            });
            if !is_active {
                return;
            }
            unsafe {
                let services: Option<Retained<AnyObject>> = msg_send![peripheral, services];
                let Some(services) = services else { return };
                let count: usize = msg_send![&services, count];
                for idx in 0..count {
                    let service: Retained<AnyObject> = msg_send![&services, objectAtIndex: idx];
                    let _: () = msg_send![
                        peripheral,
                        discoverCharacteristics: ptr::null::<AnyObject>(),
                        forService: &*service
                    ];
                }
            }
        }

        #[unsafe(method(peripheral:didDiscoverCharacteristicsForService:error:))]
        fn did_discover_characteristics(
            &self,
            peripheral: &AnyObject,
            service: &AnyObject,
            _error: Option<&AnyObject>,
        ) {
            let mut ready_to_notify_connect = false;
            let mut generation = 0;
            let (dev_id, dev_name) = unsafe {
                let uuid_obj: Retained<AnyObject> = msg_send![peripheral, identifier];
                let uuid_ns: Retained<NSString> = msg_send![&uuid_obj, UUIDString];
                let p_name: Option<Retained<NSString>> = msg_send![peripheral, name];
                (
                    uuid_ns.to_string(),
                    p_name.map(|s| s.to_string()).unwrap_or_else(|| "LOOI 桌面底座".into()),
                )
            };

            BLE_MANAGER.with(|slot| {
                let mut borrow = slot.borrow_mut();
                let Some(mgr) = borrow.as_mut() else { return };
                let is_active = mgr
                    .active_peripheral
                    .as_ref()
                    .is_some_and(|active| ptr::eq(&**active, peripheral));
                if !is_active {
                    return;
                }
                generation = mgr.generation;
                unsafe {
                    let chars: Option<Retained<AnyObject>> = msg_send![service, characteristics];
                    let Some(chars) = chars else { return };
                    let count: usize = msg_send![&chars, count];
                    for idx in 0..count {
                        let ch: Retained<AnyObject> = msg_send![&chars, objectAtIndex: idx];
                        let uuid_obj: Retained<AnyObject> = msg_send![&ch, UUID];
                        let uuid_ns: Retained<NSString> = msg_send![&uuid_obj, UUIDString];
                        let uuid_str = uuid_ns.to_string();
                        if let Some(key) = characteristic_key_from_uuid(&uuid_str) {
                            mgr.characteristics.insert(key.to_owned(), ch);
                        }
                    }
                }
                if !mgr.did_report_connected
                    && mgr.characteristics.contains_key("handshakeControl")
                    && mgr.characteristics.contains_key("sensorNotify")
                    && mgr.characteristics.contains_key("dockNotify")
                    && mgr.characteristics.contains_key("drive")
                {
                    mgr.did_report_connected = true;
                    ready_to_notify_connect = true;
                }
            });

            if ready_to_notify_connect {
                if let Ok(mut shared) = self.ivars().shared.lock() {
                    shared.on_connected(generation, &dev_id, &dev_name);
                }
            }
        }

        #[unsafe(method(peripheral:didUpdateNotificationStateForCharacteristic:error:))]
        fn did_update_notification_state(
            &self,
            peripheral: &AnyObject,
            characteristic: &AnyObject,
            error: Option<&AnyObject>,
        ) {
            let Some(generation) = BLE_MANAGER.with(|slot| {
                let borrow = slot.borrow();
                let mgr = borrow.as_ref()?;
                mgr.active_peripheral
                    .as_ref()
                    .is_some_and(|active| ptr::eq(&**active, peripheral))
                    .then_some(mgr.generation)
            }) else { return };
            if error.is_some() {
                if let Ok(mut shared) = self.ivars().shared.lock() {
                    shared.on_error(generation, "底座通知订阅失败");
                }
                return;
            }
            let uuid_str = unsafe {
                let uuid_obj: Retained<AnyObject> = msg_send![characteristic, UUID];
                let uuid_ns: Retained<NSString> = msg_send![&uuid_obj, UUIDString];
                uuid_ns.to_string()
            };
            if let Ok(mut shared) = self.ivars().shared.lock() {
                shared.on_notify_ack(generation, &uuid_str);
            }
        }

        #[unsafe(method(peripheral:didUpdateValueForCharacteristic:error:))]
        fn did_update_value(
            &self,
            peripheral: &AnyObject,
            characteristic: &AnyObject,
            error: Option<&AnyObject>,
        ) {
            let Some(generation) = BLE_MANAGER.with(|slot| {
                let borrow = slot.borrow();
                let mgr = borrow.as_ref()?;
                mgr.active_peripheral
                    .as_ref()
                    .is_some_and(|active| ptr::eq(&**active, peripheral))
                    .then_some(mgr.generation)
            }) else {
                return;
            };
            if error.is_some() {
                return;
            }
            let (uuid_str, hex) = unsafe {
                let uuid_obj: Retained<AnyObject> = msg_send![characteristic, UUID];
                let uuid_ns: Retained<NSString> = msg_send![&uuid_obj, UUIDString];
                let value: Option<Retained<AnyObject>> = msg_send![characteristic, value];
                let Some(data) = value else { return };
                let len: usize = msg_send![&data, length];
                let ptr: *const u8 = msg_send![&data, bytes];
                let bytes = if len == 0 || ptr.is_null() {
                    &[][..]
                } else {
                    slice::from_raw_parts(ptr, len)
                };
                (uuid_ns.to_string(), encode_hex(bytes))
            };

            let need_stop = self.ivars().shared.lock().map(|mut s| {
                if characteristic_key_from_uuid(&uuid_str) == Some("power") {
                    s.on_read_result(generation, &uuid_str, &hex);
                    false
                } else {
                    s.on_notification(generation, &uuid_str, &hex)
                }
            }).unwrap_or(false);

            if need_stop {
                emergency_stop_on_main();
            }
        }

        #[unsafe(method(peripheral:didWriteValueForCharacteristic:error:))]
        fn did_write_value(
            &self,
            peripheral: &AnyObject,
            characteristic: &AnyObject,
            error: Option<&AnyObject>,
        ) {
            let Some(generation) = BLE_MANAGER.with(|slot| {
                let borrow = slot.borrow();
                let mgr = borrow.as_ref()?;
                mgr.active_peripheral
                    .as_ref()
                    .is_some_and(|active| ptr::eq(&**active, peripheral))
                    .then_some(mgr.generation)
            }) else {
                return;
            };
            if error.is_some() {
                if let Ok(mut shared) = self.ivars().shared.lock() {
                    shared.on_error(generation, "蓝牙特征值写入失败");
                }
                return;
            }
            let uuid_str = unsafe {
                let uuid_obj: Retained<AnyObject> = msg_send![characteristic, UUID];
                let uuid_ns: Retained<NSString> = msg_send![&uuid_obj, UUIDString];
                uuid_ns.to_string()
            };
            if let Ok(mut shared) = self.ivars().shared.lock() {
                shared.on_write_ack(generation, &uuid_str);
            }
        }
    }
);

impl BleDelegate {
    fn new(mtm: MainThreadMarker, shared: SharedBle) -> Retained<Self> {
        let object = Self::alloc(mtm).set_ivars(DelegateIvars { shared });
        unsafe { msg_send![super(object), init] }
    }
}

fn on_main<R: Send>(f: impl FnOnce(MainThreadMarker) -> R + Send) -> Result<R, String> {
    if let Some(mtm) = MainThreadMarker::new() {
        Ok(f(mtm))
    } else {
        let mut out: Option<R> = None;
        DispatchQueue::main().exec_sync(|| {
            if let Some(mtm) = MainThreadMarker::new() {
                out = Some(f(mtm));
            }
        });
        out.ok_or_else(|| "iOS main thread unavailable".into())
    }
}

fn emergency_stop_on_main() {
    BLE_MANAGER.with(|slot| {
        let borrow = slot.borrow();
        let Some(mgr) = borrow.as_ref() else { return };
        let (Some(peripheral), Some(drive_ch)) = (
            mgr.active_peripheral.as_ref(),
            mgr.characteristics.get("drive"),
        ) else {
            return;
        };
        unsafe {
            let Some(nsdata_cls) = AnyClass::get(c"NSData") else { return };
            let zero_bytes: [u8; 2] = [0x00, 0x00];
            let data: Retained<AnyObject> = msg_send![
                nsdata_cls,
                dataWithBytes: zero_bytes.as_ptr(),
                length: 2usize
            ];
            // 1 == CBCharacteristicWriteWithoutResponse
            let _: () = msg_send![
                &**peripheral,
                writeValue: &*data,
                forCharacteristic: &**drive_ch,
                type: 1isize
            ];
        }
    });
}

fn ensure_manager(mtm: MainThreadMarker, shared: &SharedBle) -> Result<(), String> {
    let previous = BLE_MANAGER.with(|slot| {
        slot.borrow().as_ref().and_then(|mgr| {
            let owner = &mgr.delegate.ivars().shared;
            (!Arc::ptr_eq(owner, shared)).then(|| owner.clone())
        })
    });
    if let Some(previous) = previous {
        release_on_main(&previous);
    }
    let mut created = false;
    BLE_MANAGER.with(|slot| {
        if slot.borrow().is_some() {
            created = true;
            return;
        }
        unsafe {
            let Some(central_cls) = AnyClass::get(c"CBCentralManager") else {
                return;
            };
            let delegate = BleDelegate::new(mtm, shared.clone());
            let alloc: Allocated<AnyObject> = msg_send![central_cls, alloc];
            let central: Retained<AnyObject> = msg_send![
                alloc,
                initWithDelegate: &*delegate,
                queue: ptr::null::<AnyObject>()
            ];
            *slot.borrow_mut() = Some(IosBleManager {
                central,
                delegate,
                discovered: HashMap::new(),
                active_peripheral: None,
                cancelling: HashSet::new(),
                characteristics: HashMap::new(),
                generation: 0,
                want_scan: false,
                pending_connect_id: None,
                did_report_connected: false,
            });
            created = true;
        }
    });
    if !created {
        return Err("CoreBluetooth unavailable".into());
    }

    BG_OBSERVER.with(|slot| {
        if slot.borrow().is_some() {
            return;
        }
        unsafe {
            let Some(center_cls) = AnyClass::get(c"NSNotificationCenter") else { return };
            let center: Retained<AnyObject> = msg_send![center_cls, defaultCenter];
            let block = RcBlock::new(move |_note: *mut AnyObject| {
                emergency_stop_on_main();
                if let Some(shared) = active_shared() {
                    if let Ok(mut s) = shared.lock() {
                        s.emergency_stop_count += 1;
                    }
                }
            });
            let observer: Retained<AnyObject> = msg_send![
                &center,
                addObserverForName: UIApplicationDidEnterBackgroundNotification,
                object: ptr::null::<AnyObject>(),
                queue: ptr::null::<AnyObject>(),
                usingBlock: &*block
            ];
            *slot.borrow_mut() = Some(observer);
        }
    });

    Ok(())
}

pub(super) fn permission() -> String {
    unsafe {
        let Some(cls) = AnyClass::get(c"CBManager") else {
            return "unavailable".into();
        };
        let auth: isize = msg_send![cls, authorization];
        match auth {
            3 => "granted".into(),
            1 | 2 => "denied".into(),
            0 => "undetermined".into(),
            _ => "unavailable".into(),
        }
    }
}

pub(super) fn request_permission() -> String {
    if let Some(shared) = active_shared() {
        let _ = on_main(|mtm| ensure_manager(mtm, &shared));
    }
    permission()
}

pub(super) fn start_scan(shared: &SharedBle) -> Result<(), String> {
    let shared = shared.clone();
    on_main(|mtm| {
        ensure_manager(mtm, &shared)?;
        BLE_MANAGER.with(|slot| {
            let mut borrow = slot.borrow_mut();
            let Some(mgr) = borrow.as_mut() else {
                return Err("CoreBluetooth manager not initialized".into());
            };
            mgr.want_scan = true;
            unsafe {
                let state: isize = msg_send![&mgr.central, state];
                if state == 5 {
                    let _: () = msg_send![
                        &mgr.central,
                        scanForPeripheralsWithServices: ptr::null::<AnyObject>(),
                        options: ptr::null::<AnyObject>()
                    ];
                }
            }
            Ok(())
        })
    })?
}

pub(super) fn stop_scan() {
    let _ = on_main(|_mtm| {
        BLE_MANAGER.with(|slot| {
            if let Some(mgr) = slot.borrow_mut().as_mut() {
                mgr.want_scan = false;
                unsafe {
                    let state: isize = msg_send![&mgr.central, state];
                    if state == 5 && mgr.pending_connect_id.is_none() {
                        let _: () = msg_send![&mgr.central, stopScan];
                    }
                }
            }
        });
    });
}

pub(super) fn connect(shared: &SharedBle, generation: u64, device_id: &str) -> Result<(), String> {
    let shared = shared.clone();
    let target_id = device_id.to_owned();
    on_main(|mtm| {
        ensure_manager(mtm, &shared)?;
        BLE_MANAGER.with(|slot| {
            let mut borrow = slot.borrow_mut();
            let Some(mgr) = borrow.as_mut() else {
                return Err("CoreBluetooth manager unavailable".into());
            };
            mgr.generation = generation;
            mgr.did_report_connected = false;
            mgr.characteristics.clear();

            cancel_active_peripheral(mgr);

            let state: isize = unsafe { msg_send![&mgr.central, state] };
            if state == 5 {
                if try_connect_known_peripheral(mgr, &target_id) {
                    return Ok(());
                }
                mgr.pending_connect_id = Some(target_id);
                unsafe {
                    let _: () = msg_send![
                        &mgr.central,
                        scanForPeripheralsWithServices: ptr::null::<AnyObject>(),
                        options: ptr::null::<AnyObject>()
                    ];
                }
                Ok(())
            } else {
                mgr.pending_connect_id = Some(target_id);
                Ok(())
            }
        })
    })?
}

pub(super) fn disconnect() {
    let _ = on_main(|_mtm| {
        emergency_stop_on_main();
        BLE_MANAGER.with(|slot| {
            if let Some(mgr) = slot.borrow_mut().as_mut() {
                mgr.pending_connect_id = None;
                mgr.want_scan = false;
                mgr.did_report_connected = false;
                mgr.characteristics.clear();
                unsafe {
                    let _: () = msg_send![&mgr.central, stopScan];
                }
                cancel_active_peripheral(mgr);
            }
        });
    });
}

/// Engine teardown can run while UIKit's main thread joins the JS thread.
/// Queue cleanup without waiting, and retain the owner until it runs.
pub(super) fn release(shared: &SharedBle) {
    let shared = shared.clone();
    DispatchQueue::main().exec_async(move || release_on_main(&shared));
}

fn release_on_main(shared: &SharedBle) {
    let owns_manager = BLE_MANAGER.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|mgr| Arc::ptr_eq(&mgr.delegate.ivars().shared, shared))
    });
    if !owns_manager {
        return;
    }
    disconnect();
    BLE_MANAGER.with(|slot| {
        if let Some(mgr) = slot.borrow_mut().take() {
            unsafe {
                let _: () = msg_send![&mgr.central, setDelegate: ptr::null::<AnyObject>()];
                for peripheral in mgr.discovered.values() {
                    let _: () = msg_send![&**peripheral, setDelegate: ptr::null::<AnyObject>()];
                }
            }
        }
    });
}

pub(super) fn write(
    generation: u64,
    characteristic_uuid: &str,
    bytes: &[u8],
    with_response: bool,
) -> Result<(), String> {
    let Some(key) = characteristic_key_from_uuid(characteristic_uuid) else {
        return Err("Unknown characteristic UUID".into());
    };
    let payload = bytes.to_vec();
    on_main(|_mtm| {
        BLE_MANAGER.with(|slot| {
            let borrow = slot.borrow();
            let Some(mgr) = borrow.as_ref() else {
                return Err("CoreBluetooth manager not initialized".into());
            };
            if mgr.generation != generation {
                return Err("Stale BLE generation".into());
            }
            let Some(peripheral) = mgr.active_peripheral.as_ref() else {
                return Err("No active BLE peripheral".into());
            };
            let Some(ch) = mgr.characteristics.get(key) else {
                return Err(format!("Characteristic {key} not discovered on peripheral"));
            };
            unsafe {
                let Some(nsdata_cls) = AnyClass::get(c"NSData") else {
                    return Err("NSData class unavailable".into());
                };
                let data: Retained<AnyObject> = msg_send![
                    nsdata_cls,
                    dataWithBytes: payload.as_ptr(),
                    length: payload.len()
                ];
                let write_type: isize = if with_response { 0 } else { 1 };
                let _: () = msg_send![
                    &**peripheral,
                    writeValue: &*data,
                    forCharacteristic: &**ch,
                    type: write_type
                ];
                if !with_response {
                    if let Some(shared) = active_shared() {
                        if let Ok(mut s) = shared.lock() {
                            s.on_write_ack(generation, key);
                        }
                    }
                }
            }
            Ok(())
        })
    })?
}

pub(super) fn subscribe(generation: u64, characteristic_uuid: &str) -> Result<(), String> {
    let Some(key) = characteristic_key_from_uuid(characteristic_uuid) else {
        return Err("Unknown characteristic UUID".into());
    };
    on_main(|_mtm| {
        BLE_MANAGER.with(|slot| {
            let borrow = slot.borrow();
            let Some(mgr) = borrow.as_ref() else {
                return Err("CoreBluetooth manager not initialized".into());
            };
            if mgr.generation != generation {
                return Err("Stale BLE generation".into());
            }
            let Some(peripheral) = mgr.active_peripheral.as_ref() else {
                return Err("No active BLE peripheral".into());
            };
            let Some(ch) = mgr.characteristics.get(key) else {
                return Err(format!("Characteristic {key} not discovered on peripheral"));
            };
            unsafe {
                let _: () = msg_send![
                    &**peripheral,
                    setNotifyValue: Bool::YES,
                    forCharacteristic: &**ch
                ];
            }
            Ok(())
        })
    })?
}

pub(super) fn read(generation: u64, characteristic_uuid: &str) -> Result<(), String> {
    let Some(key) = characteristic_key_from_uuid(characteristic_uuid) else {
        return Err("Unknown characteristic UUID".into());
    };
    on_main(|_mtm| {
        BLE_MANAGER.with(|slot| {
            let borrow = slot.borrow();
            let Some(mgr) = borrow.as_ref() else { return Err("CoreBluetooth manager not initialized".into()); };
            if mgr.generation != generation { return Err("Stale BLE generation".into()); }
            let Some(peripheral) = mgr.active_peripheral.as_ref() else { return Err("No active BLE peripheral".into()); };
            let Some(ch) = mgr.characteristics.get(key) else { return Err(format!("Characteristic {key} not discovered on peripheral")); };
            unsafe {
                let _: () = msg_send![&**peripheral, readValueForCharacteristic: &**ch];
            }
            Ok(())
        })
    })?
}
