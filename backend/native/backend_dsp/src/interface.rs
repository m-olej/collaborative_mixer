//! Binary wire-frame assembly for WebSocket audio messages.
//!
//! Builds the exact byte layout required by the frontend so the React decoder
//! can use zero-copy typed array views (`Uint8Array`, `Float32Array`) without
//! any additional parsing.
//!
//! # Frame layout (Little-Endian)
//!
//! ```text
//! Offset   Size          Type          Content
//! ───────────────────────────────────────────────────────────────
//! 0        1 byte        u8            Message type ID
//! 1-3      3 bytes       [u8;3]        Zero-padding (4-byte alignment)
//! 4-515    512 bytes     [u8;512]      FFT magnitude spectrum (0-255)
//! 516+     N × 4 bytes   [f32; N] LE   PCM samples (-1.0 to 1.0)
//! ───────────────────────────────────────────────────────────────
//! ```
//!
//! # Message type IDs
//! | ID | Meaning                                          |
//! |----|--------------------------------------------------|
//! |  1 | Mixer audio frame  (existing, `audio_frame`)    |
//! |  2 | Synth audio buffer (new,      `audio_buffer`)   |
//!
//! # Memory notes
//! The `Vec<u8>` returned here is later wrapped in an `OwnedBinary` in `lib.rs`
//! and returned to the BEAM.  `OwnedBinary::new()` allocates directly on the
//! Erlang heap (via `enif_alloc_binary`), so `copy_from_slice` is the only
//! time this data is copied — there is no intermediate OS-heap allocation
//! visible to the garbage collector.

use crate::dsp::fft::FFT_SIZE;

/// Convenience type alias for the fixed-size FFT byte array.
/// Used as the return type of `dsp::fft::compute_fft_spectrum` and
/// as the `fft` parameter of `build_synth_frame`.
pub type FftBytes = [u8; FFT_SIZE];

/// Type byte for synth audio buffer frames.
pub const MSG_TYPE_SYNTH: u8 = 2;

/// Assemble a complete binary WebSocket frame ready for `push/3` in the channel.
///
/// # Arguments
/// * `fft`  – 512-byte magnitude spectrum from `dsp::fft::compute_fft_spectrum`.
/// * `pcm`  – Slice of `f32` PCM samples in the range −1.0 to 1.0.
///
/// # Returns
/// A `Vec<u8>` with the complete frame.  The caller in `lib.rs` moves this
/// into an `OwnedBinary` without a second allocation.
///
/// # JS decoder (for documentation)
/// ```js
/// channel.on("audio_buffer", (buffer) => {
///   // buffer is an ArrayBuffer from Phoenix
///   const fft = new Uint8Array(buffer, 4, 512);   // bytes  4-515
///   const pcm = new Float32Array(buffer, 516);    // bytes  516+
/// });
/// ```
pub fn build_synth_frame(fft: &FftBytes, pcm: &[f32]) -> Vec<u8> {
    // Pre-allocate the exact final size to avoid any reallocation.
    let capacity = 4 + FFT_SIZE + pcm.len() * 4;
    let mut frame = Vec::with_capacity(capacity);

    // ── Header (4 bytes) ──────────────────────────────────────────────────
    frame.push(MSG_TYPE_SYNTH); // byte 0: type ID = 2
    frame.push(0u8);            // byte 1: padding
    frame.push(0u8);            // byte 2: padding
    frame.push(0u8);            // byte 3: padding

    // ── FFT spectrum (512 bytes) ──────────────────────────────────────────
    // Bytes 4-515.  Directly usable as `new Uint8Array(buffer, 4, 512)`.
    frame.extend_from_slice(fft);

    // ── PCM samples (N × 4 bytes, little-endian f32) ─────────────────────
    // Starting at byte 516.  Directly usable as `new Float32Array(buffer, 516)`.
    for &sample in pcm {
        frame.extend_from_slice(&sample.to_le_bytes());
    }

    // Sanity: this assertion is compiled away in release mode.
    debug_assert_eq!(frame.len(), capacity, "frame size must match pre-allocated capacity");

    frame
}
