//! Audio file decoding: raw bytes → f32 PCM @ target sample rate → tempfile.
//!
//! Uses `symphonia` for format detection + decoding and `rubato` for sample
//! rate conversion.  The decoded PCM is written to a temporary file on the
//! local SSD so it can be memory-mapped by `MmapStore` without consuming RAM.
//!
//! # Pipeline
//! ```text
//! Elixir binary (MP3/WAV/FLAC bytes from S3)
//!     → symphonia: detect codec, decode to interleaved f32
//!     → rubato:    resample to target_sample_rate (if different)
//!     → mono mix:  average all channels to mono f32
//!     → tempfile:  write f32 LE bytes to NamedTempFile on SSD
//! ```

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};
use std::io::Write;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::DecoderOptions;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use tempfile::NamedTempFile;

/// Errors from the decode pipeline.
#[derive(Debug)]
pub enum DecodeError {
    NoTrack,
    NoDecoder(String),
    Decode(String),
    Resample(String),
    Io(std::io::Error),
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoTrack => write!(f, "no audio track found in file"),
            Self::NoDecoder(e) => write!(f, "codec not supported: {e}"),
            Self::Decode(e) => write!(f, "decode error: {e}"),
            Self::Resample(e) => write!(f, "resample error: {e}"),
            Self::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

impl From<std::io::Error> for DecodeError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

/// Decode raw audio bytes into a mono f32 PCM tempfile at `target_sample_rate`.
///
/// Returns the tempfile handle (which keeps the file alive on disk) and the
/// total number of mono f32 samples written.
pub fn decode_to_tempfile(
    audio_bytes: &[u8],
    target_sample_rate: u32,
) -> Result<(NamedTempFile, usize), DecodeError> {
    // ── 1. Probe format ────────────────────────────────────────────────────
    let owned = audio_bytes.to_vec();
    let cursor = std::io::Cursor::new(owned);
    let mss = MediaSourceStream::new(Box::new(cursor), Default::default());

    let probed = symphonia::default::get_probe()
        .format(
            &Hint::new(),
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| DecodeError::Decode(e.to_string()))?;

    let mut format_reader = probed.format;

    // ── 2. Find the first audio track ──────────────────────────────────────
    let track = format_reader
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or(DecodeError::NoTrack)?;

    let codec_params = track.codec_params.clone();
    let source_rate = codec_params.sample_rate.unwrap_or(44_100);
    let channels = codec_params.channels.map(|c| c.count()).unwrap_or(1);
    let track_id = track.id;

    let mut decoder = symphonia::default::get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| DecodeError::NoDecoder(e.to_string()))?;

    // ── 3. Decode all packets to interleaved f32 ───────────────────────────
    let mut all_samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format_reader.next_packet() {
            Ok(p) => p,
            Err(symphonia::core::errors::Error::IoError(ref e))
                if e.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(_) => break,
        };

        if packet.track_id() != track_id {
            continue;
        }

        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(_) => continue,
        };

        let spec = *decoded.spec();
        let n_frames = decoded.capacity();
        let mut sample_buf = SampleBuffer::<f32>::new(n_frames as u64, spec);
        sample_buf.copy_interleaved_ref(decoded);
        all_samples.extend_from_slice(sample_buf.samples());
    }

    // ── 4. Down-mix to mono ────────────────────────────────────────────────
    let mono: Vec<f32> = if channels > 1 {
        all_samples
            .chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect()
    } else {
        all_samples
    };

    // ── 5. Resample to target rate (if needed) ─────────────────────────────
    let resampled = if source_rate != target_sample_rate {
        resample_mono(&mono, source_rate, target_sample_rate)?
    } else {
        mono
    };

    // ── 6. Write to tempfile as f32 LE bytes ───────────────────────────────
    let mut tmpfile = NamedTempFile::new()?;
    for &sample in &resampled {
        tmpfile.write_all(&sample.to_le_bytes())?;
    }
    tmpfile.flush()?;

    let total_samples = resampled.len();
    Ok((tmpfile, total_samples))
}

/// Resample mono f32 PCM from `source_rate` to `target_rate` using rubato.
fn resample_mono(
    input: &[f32],
    source_rate: u32,
    target_rate: u32,
) -> Result<Vec<f32>, DecodeError> {
    let chunk_size = 1024;
    let mut resampler = Fft::<f32>::new(
        source_rate as usize,
        target_rate as usize,
        chunk_size,
        2, // sub-chunks
        1, // mono
        FixedSync::Input,
    )
    .map_err(|e| DecodeError::Resample(e.to_string()))?;

    let mut output = Vec::with_capacity(
        (input.len() as f64 * target_rate as f64 / source_rate as f64) as usize + chunk_size,
    );

    let mut pos = 0;
    while pos + chunk_size <= input.len() {
        let input_buf = InterleavedSlice::new(&input[pos..pos + chunk_size], 1, chunk_size)
            .map_err(|e| DecodeError::Resample(format!("{e:?}")))?;
        let out = resampler
            .process(&input_buf, 0, None)
            .map_err(|e| DecodeError::Resample(e.to_string()))?;
        output.extend_from_slice(&out.take_data());
        pos += chunk_size;
    }

    // Handle remaining samples by zero-padding to chunk_size.
    if pos < input.len() {
        let remaining = input.len() - pos;
        let mut last_chunk = vec![0.0_f32; chunk_size];
        last_chunk[..remaining].copy_from_slice(&input[pos..]);
        let input_buf = InterleavedSlice::new(&last_chunk, 1, chunk_size)
            .map_err(|e| DecodeError::Resample(format!("{e:?}")))?;
        let out = resampler
            .process(&input_buf, 0, None)
            .map_err(|e| DecodeError::Resample(e.to_string()))?;
        let out_data = out.take_data();
        let expected = (remaining as f64 * target_rate as f64 / source_rate as f64) as usize;
        let take = expected.min(out_data.len());
        output.extend_from_slice(&out_data[..take]);
    }

    Ok(output)
}
