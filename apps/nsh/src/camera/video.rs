//! Annex B access units and codec configuration, shared by live and sample input.
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub struct VideoPacket {
    pub codec: u32,
    pub timestamp_ms: u64,
    pub data: Vec<u8>,
}

pub fn nals(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        let size = if data[i..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if data[i..].starts_with(&[0, 0, 1]) {
            3
        } else {
            i += 1;
            continue;
        };
        starts.push((i, i + size));
        i += size;
    }
    starts
        .iter()
        .enumerate()
        .filter_map(|(i, &(_, start))| {
            let end = starts.get(i + 1).map_or(data.len(), |v| v.0);
            (start < end).then_some(&data[start..end])
        })
        .collect()
}

pub fn sample_packets(data: &[u8]) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    let mut current = Vec::new();
    let mut vcl = false;
    for nal in nals(data) {
        let kind = (nal[0] >> 1) & 63;
        let first_slice = kind <= 31 && nal.get(2).is_some_and(|v| v & 0x80 != 0);
        if vcl && (first_slice || matches!(kind, 32..=35)) {
            frames.push(std::mem::take(&mut current));
            vcl = false;
        }
        current.extend_from_slice(&[0, 0, 0, 1]);
        current.extend_from_slice(nal);
        vcl |= kind <= 31;
    }
    if vcl {
        frames.push(current);
    }
    frames
}

#[derive(Default, Clone)]
pub struct VideoFormat {
    pub codec: u32,
    pub width: u32,
    pub height: u32,
    parameters: BTreeMap<u8, Vec<u8>>,
    pub revision: u64,
}
impl VideoFormat {
    pub fn update(&mut self, packet: &VideoPacket) -> Result<(), String> {
        if self.codec != packet.codec {
            self.parameters.clear();
            self.codec = packet.codec;
            self.width = 0;
            self.height = 0;
        }
        for nal in nals(&packet.data) {
            let kind = if self.codec == 5 {
                (nal[0] >> 1) & 63
            } else {
                nal[0] & 31
            };
            let parameter = if self.codec == 5 {
                matches!(kind, 32..=34)
            } else {
                matches!(kind, 7 | 8)
            };
            if !parameter || self.parameters.get(&kind).is_some_and(|old| old == nal) {
                continue;
            }
            if (self.codec == 5 && kind == 33) || (self.codec == 4 && kind == 7) {
                let dimensions = if self.codec == 5 {
                    hevc_dimensions(nal)
                } else {
                    avc_dimensions(nal)
                };
                let (width, height) = dimensions.ok_or("camera_invalid_video_format")?;
                self.width = width;
                self.height = height;
            }
            self.parameters.insert(kind, nal.to_vec());
            self.revision += 1;
        }
        Ok(())
    }
    pub fn ready(&self) -> bool {
        self.width > 0
            && self.height > 0
            && if self.codec == 5 {
                [32, 33, 34].iter().all(|k| self.parameters.contains_key(k))
            } else {
                [7, 8].iter().all(|k| self.parameters.contains_key(k))
            }
    }
    pub fn csd(&self) -> Vec<u8> {
        let mut out = Vec::new();
        for bytes in self.parameters.values() {
            out.extend_from_slice(&[0, 0, 0, 1]);
            out.extend_from_slice(bytes);
        }
        out
    }
}

struct Bits {
    bytes: Vec<u8>,
    pos: usize,
}
impl Bits {
    fn new(nal: &[u8], header: usize) -> Self {
        let mut bytes = Vec::new();
        let mut zeros = 0;
        for &b in nal.iter().skip(header) {
            if zeros >= 2 && b == 3 {
                zeros = 0;
                continue;
            }
            bytes.push(b);
            zeros = if b == 0 { zeros + 1 } else { 0 };
        }
        Self { bytes, pos: 0 }
    }
    fn read(&mut self, n: usize) -> Option<u32> {
        if n > 32 || self.pos + n > self.bytes.len() * 8 {
            return None;
        }
        let mut value = 0;
        for _ in 0..n {
            value = (value << 1) | u32::from((self.bytes[self.pos / 8] >> (7 - self.pos % 8)) & 1);
            self.pos += 1;
        }
        Some(value)
    }
    fn skip(&mut self, n: usize) -> Option<()> {
        if self.pos + n > self.bytes.len() * 8 {
            return None;
        }
        self.pos += n;
        Some(())
    }
    fn ue(&mut self) -> Option<u32> {
        let mut leading = 0;
        while self.read(1)? == 0 {
            leading += 1;
            if leading > 30 {
                return None;
            }
        }
        Some((1u32 << leading) - 1 + self.read(leading)?)
    }
    fn se(&mut self) -> Option<i32> {
        let v = self.ue()?;
        Some(if v & 1 != 0 {
            ((v + 1) / 2) as i32
        } else {
            -(v as i32 / 2)
        })
    }
}
fn hevc_dimensions(nal: &[u8]) -> Option<(u32, u32)> {
    let mut b = Bits::new(nal, 2);
    b.skip(4)?;
    let layers = b.read(3)? as usize;
    b.skip(1 + 96)?;
    let mut flags = Vec::new();
    for _ in 0..layers {
        flags.push((b.read(1)?, b.read(1)?));
    }
    if layers > 0 {
        b.skip((8 - layers) * 2)?;
    }
    for (profile, level) in flags {
        if profile != 0 {
            b.skip(88)?;
        }
        if level != 0 {
            b.skip(8)?;
        }
    }
    b.ue()?;
    let chroma = b.ue()?;
    let separate = if chroma == 3 { b.read(1)? } else { 0 };
    let mut width = b.ue()?;
    let mut height = b.ue()?;
    if b.read(1)? != 0 {
        let x = b.ue()?.checked_add(b.ue()?)?;
        let y = b.ue()?.checked_add(b.ue()?)?;
        let effective = if separate != 0 { 0 } else { chroma };
        width = width.checked_sub(x * if matches!(effective, 1 | 2) { 2 } else { 1 })?;
        height = height.checked_sub(y * if effective == 1 { 2 } else { 1 })?;
    }
    (width > 0 && height > 0).then_some((width, height))
}
fn avc_dimensions(nal: &[u8]) -> Option<(u32, u32)> {
    let mut b = Bits::new(nal, 1);
    let profile = b.read(8)?;
    b.skip(16)?;
    b.ue()?;
    let mut chroma = 1;
    if [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].contains(&profile) {
        chroma = b.ue()?;
        if chroma == 3 {
            b.skip(1)?;
        }
        b.ue()?;
        b.ue()?;
        b.skip(1)?;
        if b.read(1)? != 0 {
            for i in 0..if chroma == 3 { 12 } else { 8 } {
                if b.read(1)? != 0 {
                    let mut last = 8;
                    let mut next = 8;
                    for _ in 0..if i < 6 { 16 } else { 64 } {
                        if next != 0 {
                            next = (last + b.se()? + 256) % 256;
                        }
                        if next != 0 {
                            last = next;
                        }
                    }
                }
            }
        }
    }
    b.ue()?;
    let order = b.ue()?;
    if order == 0 {
        b.ue()?;
    } else if order == 1 {
        b.skip(1)?;
        b.se()?;
        b.se()?;
        for _ in 0..b.ue()? {
            b.se()?;
        }
    }
    b.ue()?;
    b.skip(1)?;
    let width = (b.ue()? + 1) * 16;
    let map_height = b.ue()? + 1;
    let frame = b.read(1)?;
    if frame == 0 {
        b.skip(1)?;
    }
    b.skip(1)?;
    let (mut x, mut y) = (0, 0);
    if b.read(1)? != 0 {
        x = b.ue()?.checked_add(b.ue()?)?;
        y = b.ue()?.checked_add(b.ue()?)?;
    }
    let sx = if matches!(chroma, 1 | 2) { 2 } else { 1 };
    let sy = if chroma == 1 { 2 } else { 1 } * (2 - frame);
    Some((
        width.checked_sub(x * sx)?,
        (map_height * 16 * (2 - frame)).checked_sub(y * sy)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn annexb_accepts_mixed_prefixes_and_groups_hevc_frames() {
        let sample = [
            0, 0, 0, 1, 0x40, 1, 3, 0, 0, 1, 0x26, 1, 0x80, 1, 0, 0, 1, 0x02, 1, 0x80, 2,
        ];
        assert_eq!(nals(&sample).len(), 3);
        assert_eq!(sample_packets(&sample).len(), 2);
    }
}
