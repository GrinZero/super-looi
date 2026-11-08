package com.superlooi.nsh;

import android.Manifest;
import android.app.Activity;
import android.app.Fragment;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/** App-owned Android BLE transport bridge with immediate undock/background stop safety. */
public final class LooiBleBridge {
    static native void registerVm();
    private static native void onDeviceFound(String id, String name, int rssi);
    private static native void onConnected(long generation, String id, String name);
    private static native void onDisconnected(long generation, String reason);
    private static native void onNotification(long generation, String uuid, byte[] bytes);
    private static native void onWriteAck(long generation, String uuid);

    private static final UUID LOOI_SERVICE = UUID.fromString("000000ff-0000-1000-8000-00805f9b34fb");
    private static final UUID DRIVE_CHAR = UUID.fromString("0000fed0-0000-1000-8000-00805f9b34fb");
    private static final UUID DOCK_NOTIFY_CHAR = UUID.fromString("0000fed9-0000-1000-8000-00805f9b34fb");
    private static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private static volatile boolean permissionPending;
    private static BluetoothLeScanner activeScanner;
    private static BluetoothGatt activeGatt;
    private static long activeGeneration;
    private static final Map<String, BluetoothGattCharacteristic> characteristics = new HashMap<>();

    private static final ScanCallback SCAN_CALLBACK = new ScanCallback() {
        @Override public void onScanResult(int callbackType, ScanResult result) {
            if (result == null || result.getDevice() == null) return;
            final BluetoothDevice device = result.getDevice();
            final String id = device.getAddress();
            if (id == null || id.isEmpty()) return;
            String name = device.getName();
            final ScanRecord record = result.getScanRecord();
            if ((name == null || name.isEmpty()) && record != null) {
                name = record.getDeviceName();
            }
            if (name == null) name = "";
            boolean matches = name.toLowerCase(Locale.ROOT).contains("looi");
            if (!matches && record != null && record.getServiceUuids() != null) {
                for (ParcelUuid uuid : record.getServiceUuids()) {
                    if (uuid != null && LOOI_SERVICE.equals(uuid.getUuid())) {
                        matches = true;
                        break;
                    }
                }
            }
            if (matches) {
                onDeviceFound(id, name.isEmpty() ? "LOOI 桌面底座" : name, result.getRssi());
            }
        }
    };

    private static String[] requiredPermissions() {
        if (Build.VERSION.SDK_INT >= 31) {
            return new String[]{
                "android.permission.BLUETOOTH_SCAN",
                "android.permission.BLUETOOTH_CONNECT"
            };
        }
        return new String[]{Manifest.permission.ACCESS_FINE_LOCATION};
    }

    public static String permission() {
        final Activity owner = SuperLooiApplication.foregroundActivity();
        if (owner == null) return "unavailable";
        if (Build.VERSION.SDK_INT < 23) return "granted";
        for (String perm : requiredPermissions()) {
            if (owner.checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED) {
                return permissionPending ? "undetermined" : "denied";
            }
        }
        return "granted";
    }

    public static String requestPermission() {
        final String current = permission();
        if ("granted".equals(current)) return current;
        final Activity owner = SuperLooiApplication.foregroundActivity();
        if (owner == null || Build.VERSION.SDK_INT < 23 || permissionPending) return current;
        permissionPending = true;
        new Handler(Looper.getMainLooper()).post(() -> {
            if (owner.isFinishing()) { permissionPending = false; return; }
            try {
                owner.getFragmentManager().beginTransaction().add(new BlePermissionFragment(), "looi-ble-perm").commit();
            } catch (RuntimeException ignored) { permissionPending = false; }
        });
        return "undetermined";
    }

    public static final class BlePermissionFragment extends Fragment {
        private boolean requested;
        @Override public void onResume() {
            super.onResume();
            if (!requested) {
                requested = true;
                requestPermissions(requiredPermissions(), 7402);
            }
        }
        @Override public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
            if (code == 7402) {
                permissionPending = false;
                getFragmentManager().beginTransaction().remove(this).commitAllowingStateLoss();
            }
        }
    }

    private static BluetoothAdapter adapter() {
        final Activity owner = SuperLooiApplication.foregroundActivity();
        if (owner == null) return null;
        final BluetoothManager mgr = (BluetoothManager) owner.getSystemService(Context.BLUETOOTH_SERVICE);
        return mgr != null ? mgr.getAdapter() : null;
    }

    public static synchronized boolean startScan() {
        if (!"granted".equals(permission())) {
            requestPermission();
            return false;
        }
        final BluetoothAdapter bt = adapter();
        if (bt == null || !bt.isEnabled()) return false;
        stopScan();
        activeScanner = bt.getBluetoothLeScanner();
        if (activeScanner == null) return false;
        try {
            activeScanner.startScan(SCAN_CALLBACK);
            return true;
        } catch (RuntimeException error) {
            activeScanner = null;
            return false;
        }
    }

    public static synchronized void stopScan() {
        if (activeScanner != null) {
            try { activeScanner.stopScan(SCAN_CALLBACK); } catch (RuntimeException ignored) {}
            activeScanner = null;
        }
    }

    public static synchronized boolean connect(final long generation, final String deviceId) {
        stopScan();
        disconnect();
        final Activity owner = SuperLooiApplication.foregroundActivity();
        final BluetoothAdapter bt = adapter();
        if (owner == null || bt == null || !bt.isEnabled()) return false;
        try {
            final BluetoothDevice device = bt.getRemoteDevice(deviceId);
            activeGeneration = generation;
            activeGatt = device.connectGatt(owner, false, new BluetoothGattCallback() {
                @Override public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
                    if (newState == BluetoothProfile.STATE_CONNECTED) {
                        gatt.discoverServices();
                    } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                        synchronized (LooiBleBridge.class) {
                            if (activeGatt == gatt) {
                                characteristics.clear();
                                activeGatt = null;
                            }
                        }
                        try { gatt.close(); } catch (RuntimeException ignored) {}
                        onDisconnected(generation, "");
                    }
                }

                @Override public void onServicesDiscovered(BluetoothGatt gatt, int status) {
                    if (status != BluetoothGatt.GATT_SUCCESS) {
                        onDisconnected(generation, "蓝牙服务发现失败");
                        return;
                    }
                    synchronized (LooiBleBridge.class) {
                        characteristics.clear();
                        final List<BluetoothGattService> services = gatt.getServices();
                        for (BluetoothGattService svc : services) {
                            for (BluetoothGattCharacteristic ch : svc.getCharacteristics()) {
                                final String uuid = ch.getUuid().toString().toLowerCase(Locale.ROOT);
                                characteristics.put(uuid, ch);
                                if (DOCK_NOTIFY_CHAR.equals(ch.getUuid())) {
                                    gatt.setCharacteristicNotification(ch, true);
                                    final BluetoothGattDescriptor cccd = ch.getDescriptor(CCCD_UUID);
                                    if (cccd != null) {
                                        cccd.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                                        gatt.writeDescriptor(cccd);
                                    }
                                }
                            }
                        }
                    }
                    final String devName = gatt.getDevice() != null && gatt.getDevice().getName() != null
                        ? gatt.getDevice().getName()
                        : "LOOI 桌面底座";
                    onConnected(generation, deviceId, devName);
                }

                @Override public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
                    final byte[] val = characteristic.getValue();
                    if (val == null) return;
                    if (DOCK_NOTIFY_CHAR.equals(characteristic.getUuid()) && val.length == 1 && val[0] == 0x06) {
                        emergencyStopLocked();
                    }
                    onNotification(generation, characteristic.getUuid().toString(), val);
                }

                @Override public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
                    if (status == BluetoothGatt.GATT_SUCCESS) {
                        onWriteAck(generation, characteristic.getUuid().toString());
                    }
                }
            });
            return activeGatt != null;
        } catch (RuntimeException error) {
            return false;
        }
    }

    private static synchronized void emergencyStopLocked() {
        if (activeGatt == null) return;
        final BluetoothGattCharacteristic drive = characteristics.get(DRIVE_CHAR.toString());
        if (drive == null) return;
        try {
            drive.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            drive.setValue(new byte[]{0x00, 0x00});
            activeGatt.writeCharacteristic(drive);
        } catch (RuntimeException ignored) {}
    }

    public static synchronized void background() {
        emergencyStopLocked();
    }

    public static synchronized void disconnect() {
        emergencyStopLocked();
        characteristics.clear();
        if (activeGatt != null) {
            try { activeGatt.disconnect(); } catch (RuntimeException ignored) {}
            try { activeGatt.close(); } catch (RuntimeException ignored) {}
            activeGatt = null;
        }
    }

    public static synchronized boolean write(long generation, String uuid, byte[] payload, boolean withResponse) {
        if (activeGatt == null || generation != activeGeneration) return false;
        final BluetoothGattCharacteristic ch = characteristics.get(uuid.toLowerCase(Locale.ROOT));
        if (ch == null) return false;
        try {
            ch.setWriteType(withResponse
                ? BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                : BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
            ch.setValue(payload);
            final boolean ok = activeGatt.writeCharacteristic(ch);
            if (ok && !withResponse) {
                onWriteAck(generation, uuid);
            }
            return ok;
        } catch (RuntimeException error) {
            return false;
        }
    }
}
