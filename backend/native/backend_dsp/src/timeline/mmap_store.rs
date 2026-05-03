//! Memory-mapped file store for decoded audio.
//!
//! Each decoded track is written as raw f32 LE PCM to a temporary file on the
//! local SSD by `decoder::decode_to_tempfile`.  This module memory-maps those
//! files using `memmap2` so that audio data can be read with zero-copy slicing.
//!
//! # Why mmap instead of loading into RAM?
//!
//! A 3-minute stereo track at 48 kHz ≈ 34 MB of f32 PCM.  With hundreds of
//! tracks across concurrent projects, in-memory storage would exhaust RAM.
//! Memory-mapped files let the OS kernel page data on demand — only the
//! 50 ms windows being mixed at any instant occupy physical memory.

use memmap2::Mmap;
use std::collections::HashMap;
use std::fs::File;
use tempfile::NamedTempFile;

/// Entry for a single decoded track in the store.
pub struct MmapEntry {
    /// The tempfile handle — keeps the file alive on disk.
    _file: NamedTempFile,
    /// Read-only memory mapping of the tempfile.
    mmap: Mmap,
    /// Total number of mono f32 samples in this file.
    pub total_samples: usize,
}

/// Store of memory-mapped decoded audio files, keyed by `track_id`.
pub struct MmapStore {
    entries: HashMap<u64, MmapEntry>,
}

impl MmapStore {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Insert a decoded tempfile into the store.
    ///
    /// # Safety
    /// `memmap2::Mmap::map` is unsafe because the OS could modify the file
    /// externally.  We own the tempfile exclusively, so this is safe.
    pub fn insert(
        &mut self,
        track_id: u64,
        tmpfile: NamedTempFile,
        total_samples: usize,
    ) -> Result<(), std::io::Error> {
        let file: &File = tmpfile.as_file();
        // SAFETY: we own the tempfile exclusively; no other process modifies it.
        let mmap = unsafe { Mmap::map(file)? };

        self.entries.insert(
            track_id,
            MmapEntry {
                _file: tmpfile,
                mmap,
                total_samples,
            },
        );

        Ok(())
    }

    /// Remove a track from the store (tempfile will be deleted on drop).
    pub fn remove(&mut self, track_id: u64) {
        self.entries.remove(&track_id);
    }

    /// Check if a track is loaded.
    pub fn contains(&self, track_id: u64) -> bool {
        self.entries.contains_key(&track_id)
    }

    /// Read a slice of f32 samples from a memory-mapped track.
    ///
    /// # Arguments
    /// * `track_id`     – the track whose audio to read.
    /// * `sample_offset`– starting sample index (not byte offset).
    /// * `n_samples`    – number of samples to read.
    ///
    /// # Returns
    /// A slice of f32 values.  Returns an empty slice if the track is not
    /// loaded or the offset is out of bounds.
    pub fn slice(&self, track_id: u64, sample_offset: usize, n_samples: usize) -> &[f32] {
        let entry = match self.entries.get(&track_id) {
            Some(e) => e,
            None => return &[],
        };

        if sample_offset >= entry.total_samples {
            return &[];
        }

        let available = entry.total_samples - sample_offset;
        let count = n_samples.min(available);

        let byte_start = sample_offset * 4;
        let byte_end = byte_start + count * 4;

        if byte_end > entry.mmap.len() {
            return &[];
        }

        let bytes = &entry.mmap[byte_start..byte_end];
        // SAFETY: f32 is 4 bytes, alignment is guaranteed because we wrote
        // contiguous f32 LE values.  The mmap backing is immutable.
        // However, mmap alignment is page-aligned (4096), so byte_start may
        // not be f32-aligned.  We must use from_raw_parts carefully.
        // Since we wrote f32 LE sequentially from byte 0, and sample_offset
        // is always a multiple of 1 sample (4 bytes), byte_start is always
        // 4-byte aligned relative to the start of the mmap.
        let ptr = bytes.as_ptr() as *const f32;
        unsafe { std::slice::from_raw_parts(ptr, count) }
    }
}
