//! Deterministic, zero-dependency baseline JFIF encoder for diagnostic and headless camera sessions.
//! Produces 100% spec-compliant ITU-T T.81 / JFIF 1.01 grayscale JPEG streams with exact 8x8 DCT/Huffman blocks.

const ZIGZAG: [usize; 64] = [
    0, 1, 5, 6, 14, 15, 27, 28,
    2, 4, 7, 13, 16, 26, 29, 42,
    3, 8, 12, 17, 25, 30, 41, 43,
    9, 11, 18, 24, 31, 40, 44, 53,
    10, 19, 23, 32, 39, 45, 52, 54,
    20, 22, 33, 38, 46, 51, 55, 60,
    21, 34, 37, 47, 50, 56, 59, 61,
    35, 36, 48, 49, 57, 58, 62, 63,
];

// ITU-T T.81 Annex K.3 Luminance DC Huffman table (bits[1..=16] and values)
const STD_DC_LUMINANCE_NRCODES: [u8; 16] = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const STD_DC_LUMINANCE_VALUES: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

// Minimal valid AC Huffman table containing only EOB (0x00 -> 1-bit code `0`)
const MIN_AC_NRCODES: [u8; 16] = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const MIN_AC_VALUES: [u8; 1] = [0x00];

struct BitWriter {
    bytes: Vec<u8>,
    bit_buf: u32,
    bit_count: u8,
}

impl BitWriter {
    fn new(capacity: usize) -> Self {
        Self {
            bytes: Vec::with_capacity(capacity),
            bit_buf: 0,
            bit_count: 0,
        }
    }

    fn write_bits(&mut self, code: u16, length: u8) {
        self.bit_buf = (self.bit_buf << length) | (u32::from(code) & ((1u32 << length) - 1));
        self.bit_count += length;
        while self.bit_count >= 8 {
            self.bit_count -= 8;
            let byte = ((self.bit_buf >> self.bit_count) & 0xFF) as u8;
            self.bytes.push(byte);
            if byte == 0xFF {
                // ITU-T T.81 byte stuffing inside entropy-coded scan segment
                self.bytes.push(0x00);
            }
        }
    }

    fn flush(mut self) -> Vec<u8> {
        if self.bit_count > 0 {
            let pad = 8 - self.bit_count;
            self.write_bits((1u16 << pad) - 1, pad);
        }
        self.bytes
    }
}

fn build_dc_huffman_lut() -> [(u16, u8); 12] {
    let mut lut = [(0u16, 0u8); 12];
    let mut code = 0u16;
    let mut idx = 0usize;
    for (i, &count) in STD_DC_LUMINANCE_NRCODES.iter().enumerate() {
        let len = (i + 1) as u8;
        for _ in 0..count {
            let sym = STD_DC_LUMINANCE_VALUES[idx] as usize;
            lut[sym] = (code, len);
            code += 1;
            idx += 1;
        }
        code <<= 1;
    }
    lut
}

fn encode_dc_diff(writer: &mut BitWriter, diff: i16, dc_lut: &[(u16, u8); 12]) {
    if diff == 0 {
        let (code, len) = dc_lut[0];
        writer.write_bits(code, len);
        return;
    }
    let abs_val = diff.unsigned_abs();
    let category = (16 - abs_val.leading_zeros()) as u8;
    let (huff_code, huff_len) = dc_lut[category as usize];
    writer.write_bits(huff_code, huff_len);
    let amplitude = if diff > 0 {
        abs_val
    } else {
        abs_val ^ ((1u16 << category) - 1)
    };
    writer.write_bits(amplitude, category);
}

/// Generates a valid landscape 16:9 baseline JFIF image bounded by `max_dimension`.
pub fn encode_sample_jpeg(facing: &str, max_dimension: i32, seq: u64) -> (Vec<u8>, u32, u32) {
    let clamped_max = max_dimension.clamp(160, 1920) as u32;
    let width = ((clamped_max / 8) * 8).max(160);
    let raw_height = ((width * 9) / 16).max(96);
    let height = (((raw_height + 4) / 8) * 8).min(width);

    let mcu_cols = width / 8;
    let mcu_rows = height / 8;
    let facing_seed: u64 = if facing == "back" { 97 } else { 31 };

    let dc_lut = build_dc_huffman_lut();
    let mut scan = BitWriter::new((mcu_cols * mcu_rows * 2) as usize + 64);
    let mut prev_dc: i16 = 0;

    // Quantization step = 8 across all 64 DCT positions -> DC coefficient = (luma - 128)
    for row in 0..mcu_rows {
        for col in 0..mcu_cols {
            let phase = (u64::from(col) * 7 + u64::from(row) * 11 + seq * 13 + facing_seed) % 180;
            let luma = (38 + phase) as i16; // [38..217]
            let dc = luma - 128; // [-90..89], fits easily in DC category <= 7
            let diff = dc - prev_dc;
            prev_dc = dc;
            encode_dc_diff(&mut scan, diff, &dc_lut);
            // Write AC EOB (1-bit code `0`)
            scan.write_bits(0, 1);
        }
    }
    let entropy = scan.flush();

    let mut out = Vec::with_capacity(entropy.len() + 256);
    // SOI
    out.extend_from_slice(&[0xFF, 0xD8]);
    // APP0 (JFIF 1.01)
    out.extend_from_slice(&[
        0xFF, 0xE0, 0x00, 0x10,
        b'J', b'F', b'I', b'F', 0x00,
        0x01, 0x01, 0x00,
        0x00, 0x01, 0x00, 0x01,
        0x00, 0x00,
    ]);
    // DQT (Table 0, 8-bit precision, uniform quantizer = 8 in zigzag order)
    out.extend_from_slice(&[0xFF, 0xDB, 0x00, 67, 0x00]);
    for &zz in &ZIGZAG {
        let _ = zz;
        out.push(8);
    }
    // SOF0 (Baseline DCT, 8-bit, 1 grayscale component)
    out.extend_from_slice(&[
        0xFF,
        0xC0,
        0x00,
        11,
        0x08,
        ((height >> 8) & 0xFF) as u8,
        (height & 0xFF) as u8,
        ((width >> 8) & 0xFF) as u8,
        (width & 0xFF) as u8,
        0x01, // 1 component (Y)
        0x01, // component ID 1
        0x11, // sampling 1x1
        0x00, // quant table 0
    ]);
    // DHT (DC Table 0)
    let dc_seg_len = (2 + 1 + 16 + STD_DC_LUMINANCE_VALUES.len()) as u16;
    out.extend_from_slice(&[
        0xFF,
        0xC4,
        (dc_seg_len >> 8) as u8,
        (dc_seg_len & 0xFF) as u8,
        0x00,
    ]);
    out.extend_from_slice(&STD_DC_LUMINANCE_NRCODES);
    out.extend_from_slice(&STD_DC_LUMINANCE_VALUES);
    // DHT (AC Table 0)
    let ac_seg_len = (2 + 1 + 16 + MIN_AC_VALUES.len()) as u16;
    out.extend_from_slice(&[
        0xFF,
        0xC4,
        (ac_seg_len >> 8) as u8,
        (ac_seg_len & 0xFF) as u8,
        0x10,
    ]);
    out.extend_from_slice(&MIN_AC_NRCODES);
    out.extend_from_slice(&MIN_AC_VALUES);
    // SOS
    out.extend_from_slice(&[
        0xFF, 0xDA,
        0x00, 8,
        0x01, // 1 component
        0x01, // component ID 1
        0x00, // DC table 0, AC table 0
        0x00, // Ss = 0
        0x3F, // Se = 63
        0x00, // Ah/Al = 0
    ]);
    out.extend_from_slice(&entropy);
    // EOI
    out.extend_from_slice(&[0xFF, 0xD9]);

    (out, width, height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_jpeg_produces_valid_jfif_headers_dimensions_and_stuffed_entropy() {
        let (jpeg_320, w320, h320) = encode_sample_jpeg("front", 320, 1);
        assert_eq!(&jpeg_320[0..2], &[0xFF, 0xD8]);
        assert_eq!(&jpeg_320[jpeg_320.len() - 2..], &[0xFF, 0xD9]);
        assert_eq!(w320, 320);
        assert_eq!(h320, 184);

        let (jpeg_640, w640, h640) = encode_sample_jpeg("back", 640, 2);
        assert_eq!(w640, 640);
        assert_eq!(h640, 360);
        assert_ne!(jpeg_320, jpeg_640);

        // Verify SOF0 marker encodes exact width and height
        let sof0_pos = jpeg_640
            .windows(4)
            .position(|w| w == [0xFF, 0xC0, 0x00, 11])
            .expect("SOF0 marker present");
        let parsed_h = u16::from_be_bytes([jpeg_640[sof0_pos + 5], jpeg_640[sof0_pos + 6]]);
        let parsed_w = u16::from_be_bytes([jpeg_640[sof0_pos + 7], jpeg_640[sof0_pos + 8]]);
        assert_eq!(u32::from(parsed_w), w640);
        assert_eq!(u32::from(parsed_h), h640);

        // Verify no unstuffed 0xFF markers exist inside entropy scan before EOI
        let sos_pos = jpeg_640
            .windows(4)
            .position(|w| w == [0xFF, 0xDA, 0x00, 8])
            .expect("SOS marker present");
        let scan_slice = &jpeg_640[sos_pos + 10..jpeg_640.len() - 2];
        for (i, &b) in scan_slice.iter().enumerate() {
            if b == 0xFF {
                assert_eq!(scan_slice.get(i + 1), Some(&0x00), "Unstuffed 0xFF in entropy scan");
            }
        }
    }
}
