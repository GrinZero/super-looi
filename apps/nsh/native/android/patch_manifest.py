"""Patch Android binary manifest for app plugin Application, permissions, orientation, and schedule components.

No decompile/re-link: resource IDs, icons, existing components and unknown
chunks remain intact. All string/attribute indices retain their meaning.
"""
import struct

NO_INDEX = 0xFFFFFFFF
ANDROID = "http://schemas.android.com/apk/res/android"
NAME_ID = 0x01010003
EXPORTED_ID = 0x01010010
SCREEN_ORIENTATION_ID = 0x0101001E
BACKUP_ID = 0x01010280
EXTRACT_NATIVE_LIBS_ID = 0x010104EA
USES_CLEARTEXT_TRAFFIC_ID = 0x010104EC
FOREGROUND_SERVICE_TYPE_ID = 0x01010599
DATA_SYNC_SERVICE_TYPE = 0x00000001

KEEPALIVE_SERVICE = "com.superlooi.nsh.ScheduleKeepAliveService"
ALARM_RECEIVER = "com.superlooi.nsh.ScheduleAlarmReceiver"

SUPPORTED_PERMISSIONS = (
    "android.permission.CAMERA",
    "android.permission.RECORD_AUDIO",
    "android.permission.MODIFY_AUDIO_SETTINGS",
    "android.permission.BLUETOOTH",
    "android.permission.BLUETOOTH_ADMIN",
    "android.permission.BLUETOOTH_SCAN",
    "android.permission.BLUETOOTH_CONNECT",
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
    "android.permission.WAKE_LOCK",
    "android.permission.SCHEDULE_EXACT_ALARM",
)


def u16(data, offset):
    return struct.unpack_from("<H", data, offset)[0]


def u32(data, offset):
    return struct.unpack_from("<I", data, offset)[0]


def length(data, offset, utf8):
    if utf8:
        first = data[offset]
        return (((first & 0x7F) << 8) | data[offset + 1], offset + 2) if first & 0x80 else (first, offset + 1)
    first = u16(data, offset)
    return (((first & 0x7FFF) << 16) | u16(data, offset + 2), offset + 4) if first & 0x8000 else (first, offset + 2)


def parse_strings(pool):
    header, count, flags, start = u16(pool, 2), u32(pool, 8), u32(pool, 16), u32(pool, 20)
    utf8 = bool(flags & 0x100)
    strings = []
    for index in range(count):
        offset = start + u32(pool, header + index * 4)
        size, offset = length(pool, offset, utf8)
        if utf8:
            size, offset = length(pool, offset, True)
        strings.append(pool[offset:offset + size * (1 if utf8 else 2)].decode("utf-8" if utf8 else "utf-16-le"))
    return strings


def extend_pool(pool, strings, values):
    additions = [value for value in values if value not in strings]
    if not additions:
        return pool
    header, count, styles = u16(pool, 2), u32(pool, 8), u32(pool, 12)
    start, style_start = u32(pool, 20), u32(pool, 24)
    utf8 = bool(u32(pool, 16) & 0x100)
    string_data = bytearray(pool[start:style_start or len(pool)])
    offsets = []
    for value in additions:
        offsets.append(len(string_data))
        encoded = value.encode("utf-8" if utf8 else "utf-16-le")
        units = len(value.encode("utf-16-le")) // 2
        if units >= 128 or (utf8 and len(encoded) >= 128):
            raise ValueError("Plugin string too long")
        string_data.extend(bytes([units, len(encoded)]) + encoded + b"\0" if utf8 else struct.pack("<H", units) + encoded + b"\0\0")
        strings.append(value)
    string_data.extend(b"\0" * (-len(string_data) % 4))
    prefix = bytearray(pool[:header])
    struct.pack_into("<I", prefix, 8, len(strings))
    new_start = start + 4 * len(additions)
    struct.pack_into("<I", prefix, 20, new_start)
    struct.pack_into("<I", prefix, 24, new_start + len(string_data) if style_start else 0)
    old_offsets = pool[header:header + count * 4]
    style_offsets_and_gap = pool[header + count * 4:start]
    result = prefix + old_offsets + struct.pack("<" + "I" * len(offsets), *offsets) + style_offsets_and_gap + string_data + (pool[style_start:] if style_start else b"")
    struct.pack_into("<I", result, 4, len(result))
    return bytes(result)


def pack_attr(ns_index, name_index, raw_index, data_type, data_value):
    return struct.pack("<IIIHBBI", ns_index, name_index, raw_index, 8, 0, data_type, data_value)


def attr_sort_key(attr, resources):
    name_index = u32(attr, 4)
    return resources[name_index] if name_index < len(resources) and resources[name_index] else NO_INDEX


def element_attrs(chunk):
    start, count = 16 + u16(chunk, 24), u16(chunk, 28)
    return start, count, [chunk[start + i * 20:start + (i + 1) * 20] for i in range(count)]


def element_android_name(chunk, strings, android_ns_index, name_index):
    _, _, attrs = element_attrs(chunk)
    for attr in attrs:
        if u32(attr, 0) == android_ns_index and u32(attr, 4) == name_index and attr[15] == 3:
            return strings[u32(attr, 16)]
    return None


def build_element_chunks(element_index, attrs):
    start_chunk = (
        struct.pack("<HHIII", 0x102, 16, 36 + len(attrs) * 20, 0, NO_INDEX)
        + struct.pack("<IIHHHHHH", NO_INDEX, element_index, 20, 20, len(attrs), 0, 0, 0)
        + b"".join(attrs)
    )
    end_chunk = struct.pack("<HHIII", 0x103, 16, 24, 0, NO_INDEX) + struct.pack("<II", NO_INDEX, element_index)
    return start_chunk, end_chunk


def upsert_component(chunks, strings, resources, indices, element_tag, class_name, desired_attrs):
    android_ns = indices[ANDROID]
    name_idx = indices["name"]
    element_idx = indices[element_tag]
    desired_names = {u32(attr, 4): attr for attr in desired_attrs}

    for index, chunk in enumerate(chunks):
        if u16(chunk, 0) != 0x102 or strings[u32(chunk, 20)] != element_tag:
            continue
        if element_android_name(chunk, strings, android_ns, name_idx) != class_name:
            continue
        if u16(chunk, 2) != 16 or u16(chunk, 26) != 20:
            raise ValueError(f"Unsupported {element_tag} element")
        start, count, attrs = element_attrs(chunk)
        specials = [attrs[u16(chunk, pos) - 1][:8] if u16(chunk, pos) else None for pos in (30, 32, 34)]
        retained = [
            attr for attr in attrs
            if not (u32(attr, 0) == android_ns and u32(attr, 4) in desired_names)
        ]
        merged = retained + list(desired_names.values())
        merged.sort(key=lambda attr: attr_sort_key(attr, resources))
        prefix = bytearray(chunk[:start])
        struct.pack_into("<H", prefix, 28, len(merged))
        for pos, special in zip((30, 32, 34), specials):
            struct.pack_into("<H", prefix, pos, next((i + 1 for i, attr in enumerate(merged) if attr[:8] == special), 0))
        updated = prefix + b"".join(merged) + chunk[start + count * 20:]
        struct.pack_into("<I", updated, 4, len(updated))
        chunks[index] = bytes(updated)
        return

    sorted_attrs = sorted(desired_attrs, key=lambda attr: attr_sort_key(attr, resources))
    start_chunk, end_chunk = build_element_chunks(element_idx, sorted_attrs)
    app_end_index = next(
        i for i, chunk in enumerate(chunks)
        if u16(chunk, 0) == 0x103 and strings[u32(chunk, 20)] == "application"
    )
    chunks[app_end_index:app_end_index] = [start_chunk, end_chunk]


def patch(data, application, allow_backup=False, orientation="landscape", permissions=()):
    if len(data) < 8 or u16(data, 0) != 3 or u16(data, 2) != 8 or u32(data, 4) != len(data):
        raise ValueError("Invalid Android binary manifest")
    chunks = []
    offset = 8
    while offset < len(data):
        size = u32(data, offset + 4)
        if size < 8 or offset + size > len(data):
            raise ValueError("Invalid Android XML chunk")
        chunks.append(data[offset:offset + size])
        offset += size
    pool_index = next(i for i, chunk in enumerate(chunks) if u16(chunk, 0) == 1)
    strings = parse_strings(chunks[pool_index])
    permissions = tuple(dict.fromkeys(permissions))
    if any(value not in SUPPORTED_PERMISSIONS for value in permissions):
        raise ValueError("Unsupported app plugin permission")
    if orientation != "landscape":
        raise ValueError("Unsupported app orientation")
    required_strings = [
        ANDROID,
        "name",
        "exported",
        "allowBackup",
        "usesCleartextTraffic",
        "extractNativeLibs",
        "screenOrientation",
        "foregroundServiceType",
        application,
        "service",
        "receiver",
        KEEPALIVE_SERVICE,
        ALARM_RECEIVER,
    ]
    if permissions:
        required_strings.extend(["uses-permission", *permissions])
    chunks[pool_index] = extend_pool(chunks[pool_index], strings, required_strings)
    indices = {value: strings.index(value) for value in required_strings}
    resource_index = next(i for i, chunk in enumerate(chunks) if u16(chunk, 0) == 0x180)
    resources = list(struct.unpack("<" + "I" * ((len(chunks[resource_index]) - 8) // 4), chunks[resource_index][8:]))
    attr_resource_map = [
        ("name", NAME_ID),
        ("exported", EXPORTED_ID),
        ("allowBackup", BACKUP_ID),
        ("usesCleartextTraffic", USES_CLEARTEXT_TRAFFIC_ID),
        ("extractNativeLibs", EXTRACT_NATIVE_LIBS_ID),
        ("screenOrientation", SCREEN_ORIENTATION_ID),
        ("foregroundServiceType", FOREGROUND_SERVICE_TYPE_ID),
    ]
    max_attr_index = max(indices[name] for name, _ in attr_resource_map)
    if max_attr_index + 1 > len(resources):
        resources.extend([0] * (max_attr_index + 1 - len(resources)))
    for name, resource in attr_resource_map:
        index = indices[name]
        if resources[index] not in (0, resource):
            raise ValueError("Conflicting manifest resource ID")
        resources[index] = resource
    chunks[resource_index] = struct.pack("<HHI", 0x180, 8, 8 + len(resources) * 4) + struct.pack("<" + "I" * len(resources), *resources)

    found = False
    for index, chunk in enumerate(chunks):
        if u16(chunk, 0) != 0x102 or strings[u32(chunk, 20)] != "application":
            continue
        if found or u16(chunk, 2) != 16 or u16(chunk, 26) != 20:
            raise ValueError("Unsupported application element")
        found = True
        start, count, attrs = element_attrs(chunk)
        specials = [attrs[u16(chunk, position) - 1][:8] if u16(chunk, position) else None for position in (30, 32, 34)]
        replacement = {
            indices["name"]: pack_attr(indices[ANDROID], indices["name"], indices[application], 3, indices[application]),
            indices["allowBackup"]: pack_attr(indices[ANDROID], indices["allowBackup"], NO_INDEX, 0x12, int(allow_backup)),
            indices["usesCleartextTraffic"]: pack_attr(indices[ANDROID], indices["usesCleartextTraffic"], NO_INDEX, 0x12, 0),
            indices["extractNativeLibs"]: pack_attr(indices[ANDROID], indices["extractNativeLibs"], NO_INDEX, 0x12, 1),
        }
        retained = []
        for attr in attrs:
            name = u32(attr, 4)
            if u32(attr, 0) == indices[ANDROID] and name in replacement:
                if name == indices["name"] and strings[u32(attr, 16)] != application:
                    raise ValueError("An existing custom Application cannot be replaced")
                continue
            retained.append(attr)
        attrs = retained + list(replacement.values())
        attrs.sort(key=lambda attr: attr_sort_key(attr, resources))
        prefix = bytearray(chunk[:start])
        struct.pack_into("<H", prefix, 28, len(attrs))
        for position, special in zip((30, 32, 34), specials):
            struct.pack_into("<H", prefix, position, next((i + 1 for i, attr in enumerate(attrs) if attr[:8] == special), 0))
        updated = prefix + b"".join(attrs) + chunk[start + count * 20:]
        struct.pack_into("<I", updated, 4, len(updated))
        chunks[index] = bytes(updated)
    if not found:
        raise ValueError("Manifest has no application")

    for index, chunk in enumerate(chunks):
        if u16(chunk, 0) != 0x102 or strings[u32(chunk, 20)] != "activity":
            continue
        start, count, attrs = element_attrs(chunk)
        attrs = [attr for attr in attrs if not (u32(attr, 0) == indices[ANDROID] and u32(attr, 4) == indices["screenOrientation"])]
        attrs.append(pack_attr(indices[ANDROID], indices["screenOrientation"], NO_INDEX, 0x10, 0))
        attrs.sort(key=lambda attr: attr_sort_key(attr, resources))
        updated = bytearray(chunk[:start])
        struct.pack_into("<H", updated, 28, len(attrs))
        updated.extend(b"".join(attrs) + chunk[start + count * 20:])
        struct.pack_into("<I", updated, 4, len(updated))
        chunks[index] = bytes(updated)

    existing_permissions = set()
    for chunk in chunks:
        if u16(chunk, 0) != 0x102 or strings[u32(chunk, 20)] != "uses-permission":
            continue
        name_value = element_android_name(chunk, strings, indices[ANDROID], indices["name"])
        if name_value:
            existing_permissions.add(name_value)
    additions = []
    for permission in permissions:
        if permission in existing_permissions:
            continue
        element, value = indices["uses-permission"], indices[permission]
        attr = pack_attr(indices[ANDROID], indices["name"], value, 3, value)
        start_chunk, end_chunk = build_element_chunks(element, [attr])
        additions.extend([start_chunk, end_chunk])
    if additions:
        application_index = next(i for i, chunk in enumerate(chunks) if u16(chunk, 0) == 0x102 and strings[u32(chunk, 20)] == "application")
        chunks[application_index:application_index] = additions

    service_attrs = [
        pack_attr(indices[ANDROID], indices["name"], indices[KEEPALIVE_SERVICE], 3, indices[KEEPALIVE_SERVICE]),
        pack_attr(indices[ANDROID], indices["exported"], NO_INDEX, 0x12, 0),
        pack_attr(indices[ANDROID], indices["foregroundServiceType"], NO_INDEX, 0x11, DATA_SYNC_SERVICE_TYPE),
    ]
    upsert_component(chunks, strings, resources, indices, "service", KEEPALIVE_SERVICE, service_attrs)

    receiver_attrs = [
        pack_attr(indices[ANDROID], indices["name"], indices[ALARM_RECEIVER], 3, indices[ALARM_RECEIVER]),
        pack_attr(indices[ANDROID], indices["exported"], NO_INDEX, 0x12, 0),
    ]
    upsert_component(chunks, strings, resources, indices, "receiver", ALARM_RECEIVER, receiver_attrs)

    result = bytearray(data[:8] + b"".join(chunks))
    struct.pack_into("<I", result, 4, len(result))
    return bytes(result)
