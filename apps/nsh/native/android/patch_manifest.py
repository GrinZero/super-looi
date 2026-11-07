"""Change two application attributes in Android binary XML, preserving the rest.

No decompile/re-link: resource IDs, icons, permissions, components and unknown
chunks remain intact. All string/attribute indices retain their meaning.
"""
import struct

NO_INDEX = 0xFFFFFFFF
ANDROID = "http://schemas.android.com/apk/res/android"
NAME_ID = 0x01010003
BACKUP_ID = 0x01010280


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


def patch(data, application, allow_backup=False, permissions=()):
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
    if any(value not in ("android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS") for value in permissions):
        raise ValueError("Unsupported app plugin permission")
    chunks[pool_index] = extend_pool(chunks[pool_index], strings, [ANDROID, "name", "allowBackup", "usesCleartextTraffic", application] + (["uses-permission", *permissions] if permissions else []))
    indices = {value: strings.index(value) for value in [ANDROID, "name", "allowBackup", "usesCleartextTraffic", application]}
    resource_index = next(i for i, chunk in enumerate(chunks) if u16(chunk, 0) == 0x180)
    resources = list(struct.unpack("<" + "I" * ((len(chunks[resource_index]) - 8) // 4), chunks[resource_index][8:]))
    resources.extend([0] * (max(indices["name"], indices["allowBackup"], indices["usesCleartextTraffic"]) + 1 - len(resources)))
    for name, resource in [("name", NAME_ID), ("allowBackup", BACKUP_ID), ("usesCleartextTraffic", 0x010104ec)]:
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
        start, count = 16 + u16(chunk, 24), u16(chunk, 28)
        attrs = [chunk[start + i * 20:start + (i + 1) * 20] for i in range(count)]
        specials = [attrs[u16(chunk, position) - 1][:8] if u16(chunk, position) else None for position in (30, 32, 34)]
        replacement = {
            indices["name"]: struct.pack("<IIIHBBI", indices[ANDROID], indices["name"], indices[application], 8, 0, 3, indices[application]),
            indices["allowBackup"]: struct.pack("<IIIHBBI", indices[ANDROID], indices["allowBackup"], NO_INDEX, 8, 0, 0x12, int(allow_backup)),
        }
        replacement[indices["usesCleartextTraffic"]] = struct.pack("<IIIHBBI", indices[ANDROID], indices["usesCleartextTraffic"], NO_INDEX, 8, 0, 0x12, 0)
        retained = []
        for attr in attrs:
            name = u32(attr, 4)
            if u32(attr, 0) == indices[ANDROID] and name in replacement:
                if name == indices["name"] and strings[u32(attr, 16)] != application:
                    raise ValueError("An existing custom Application cannot be replaced")
                continue
            retained.append(attr)
        attrs = retained + list(replacement.values())
        attrs.sort(key=lambda attr: resources[u32(attr, 4)] if u32(attr, 4) < len(resources) and resources[u32(attr, 4)] else NO_INDEX)
        prefix = bytearray(chunk[:start])
        struct.pack_into("<H", prefix, 28, len(attrs))
        for position, special in zip((30, 32, 34), specials):
            struct.pack_into("<H", prefix, position, next((i + 1 for i, attr in enumerate(attrs) if attr[:8] == special), 0))
        updated = prefix + b"".join(attrs) + chunk[start + count * 20:]
        struct.pack_into("<I", updated, 4, len(updated))
        chunks[index] = bytes(updated)
    if not found:
        raise ValueError("Manifest has no application")
    existing_permissions = set()
    for chunk in chunks:
        if u16(chunk, 0) != 0x102 or strings[u32(chunk, 20)] != "uses-permission":
            continue
        start = 16 + u16(chunk, 24)
        for attr_index in range(u16(chunk, 28)):
            attr = chunk[start + attr_index * 20:start + (attr_index + 1) * 20]
            if u32(attr, 0) == indices[ANDROID] and u32(attr, 4) == indices["name"] and attr[15] == 3:
                existing_permissions.add(strings[u32(attr, 16)])
    additions = []
    for permission in permissions:
        if permission in existing_permissions:
            continue
        element, value = strings.index("uses-permission"), strings.index(permission)
        attr = struct.pack("<IIIHBBI", indices[ANDROID], indices["name"], value, 8, 0, 3, value)
        additions.append(struct.pack("<HHIII", 0x102, 16, 56, 0, NO_INDEX) + struct.pack("<IIHHHHHH", NO_INDEX, element, 20, 20, 1, 0, 0, 0) + attr)
        additions.append(struct.pack("<HHIII", 0x103, 16, 24, 0, NO_INDEX) + struct.pack("<II", NO_INDEX, element))
    if additions:
        application_index = next(i for i, chunk in enumerate(chunks) if u16(chunk, 0) == 0x102 and strings[u32(chunk, 20)] == "application")
        chunks[application_index:application_index] = additions
    result = bytearray(data[:8] + b"".join(chunks))
    struct.pack_into("<I", result, 4, len(result))
    return bytes(result)
