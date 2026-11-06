//! Streaming, bounded mono PCM16 conversion. No audio is persisted.

pub const CAPTURE_RATE: u32 = 16_000;
pub const PLAYBACK_RATE: u32 = 24_000;
#[cfg_attr(
    not(any(target_os = "ios", target_os = "android", test)),
    allow(dead_code)
)]
pub const PACKET_SAMPLES: usize = 320;
pub const MAX_CAPTURE_PACKETS: usize = 25;
pub const MAX_PLAYBACK_SAMPLES: usize = PLAYBACK_RATE as usize * 5;

#[cfg(any(target_os = "ios", test))]
pub fn encode_sample(sample: f32) -> [u8; 2] {
    let sample = if sample.is_finite() { sample } else { 0.0 };
    let value = (sample.clamp(-1.0, 1.0) * 32768.0)
        .round()
        .clamp(-32768.0, 32767.0) as i16;
    value.to_le_bytes()
}

/// Continuous linear interpolation keeps chunk boundaries and fractional phase.
#[cfg(any(target_os = "ios", test))]
pub struct Resampler {
    previous: Option<f32>,
    position: u64,
    next_output: f64,
    step: f64,
}

#[cfg(any(target_os = "ios", test))]
impl Resampler {
    pub fn new(input_rate: u32) -> Self {
        Self {
            previous: None,
            position: 0,
            next_output: 0.0,
            step: input_rate.max(1) as f64 / CAPTURE_RATE as f64,
        }
    }

    pub fn push(&mut self, samples: &[f32], output: &mut Vec<u8>) {
        for &sample in samples {
            let current = if sample.is_finite() {
                sample.clamp(-1.0, 1.0)
            } else {
                0.0
            };
            match self.previous {
                None => {
                    output.extend_from_slice(&encode_sample(current));
                    self.next_output = self.step;
                }
                Some(previous) => {
                    while self.next_output <= self.position as f64 {
                        let fraction = (self.next_output - (self.position - 1) as f64) as f32;
                        output.extend_from_slice(&encode_sample(
                            previous + (current - previous) * fraction,
                        ));
                        self.next_output += self.step;
                    }
                }
            }
            self.previous = Some(current);
            self.position += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saturation_and_non_finite_are_safe() {
        assert_eq!(encode_sample(-2.0), i16::MIN.to_le_bytes());
        assert_eq!(encode_sample(2.0), i16::MAX.to_le_bytes());
        assert_eq!(encode_sample(f32::NAN), [0, 0]);
    }

    #[test]
    fn resampling_is_independent_of_callback_boundaries() {
        let source: Vec<f32> = (0..4_800).map(|n| (n as f32 / 70.0).sin()).collect();
        let mut all = Vec::new();
        Resampler::new(48_000).push(&source, &mut all);
        let mut chunks = Vec::new();
        let mut resampler = Resampler::new(48_000);
        for chunk in source.chunks(137) {
            resampler.push(chunk, &mut chunks);
        }
        assert_eq!(all, chunks);
        assert_eq!(all.len(), 1_600 * 2);
    }

    #[test]
    fn same_rate_preserves_signed_pcm_values() {
        let mut bytes = Vec::new();
        Resampler::new(16_000).push(&[-1.0, 0.0, 0.5, 1.0], &mut bytes);
        assert_eq!(bytes, [0, 128, 0, 0, 0, 64, 255, 127]);
    }
}
