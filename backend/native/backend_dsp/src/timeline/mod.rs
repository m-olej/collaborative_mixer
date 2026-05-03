//! Timeline playback sub-module for mixer audio streaming.
//!
//! This is a completely independent pipeline from the synthesizer (`engine.rs`).
//! The synth pipeline renders audio on-demand from fundsp oscillators.
//! The timeline pipeline reads pre-decoded audio from memory-mapped files on disk,
//! queries an interval tree for active clips, and mixes them in real time.
//!
//! # Module layout
//!
//! | Module          | Responsibility                                          |
//! |-----------------|---------------------------------------------------------|
//! | `decoder`       | symphonia + rubato → decode audio to f32 PCM tempfile   |
//! | `mmap_store`    | Memory-mapped file store keyed by track_id              |
//! | `interval_tree` | Clip timeline using O(log n + k) interval queries       |
//! | `chunk_mixer`   | Query tree, read mmap slices, mix, FFT, pack frame      |
//!
//! # ProjectEngine
//!
//! The central stateful object shared across NIF calls via Rustler `ResourceArc`.
//! One `ProjectEngine` per active project, protected by a `Mutex` for thread safety.

pub mod chunk_mixer;
pub mod decoder;
pub mod interval_tree;
pub mod mmap_store;

use std::collections::HashMap;
use std::sync::Mutex;

use interval_tree::ClipTree;
use mmap_store::MmapStore;
use rustler::ResourceArc;

/// Per-track mixing parameters passed from Elixir slider state.
#[derive(Debug, Clone)]
pub struct TrackParams {
    pub volume: f32,
    pub muted: bool,
    pub pan: f32,
}

impl Default for TrackParams {
    fn default() -> Self {
        Self {
            volume: 1.0,
            muted: false,
            pan: 0.0,
        }
    }
}

/// The central stateful object for timeline playback of a single project.
///
/// Held as a `ResourceArc<Mutex<ProjectEngine>>` across NIF calls so that
/// multiple Elixir processes can share one engine safely.
///
/// # Lifetime
/// Created when a project session starts (`init_engine`), dropped when the
/// Elixir `ResourceArc` term is garbage collected (after the ProjectSession
/// GenServer terminates).
pub struct ProjectEngine {
    /// Decoded audio files on SSD, memory-mapped into the process address space.
    pub store: MmapStore,
    /// Interval tree representing all clips on the timeline.
    pub timeline: ClipTree,
    /// Per-track mixing parameters (volumes, mutes, pans).
    pub params: HashMap<u64, TrackParams>,
    /// Project-wide sample rate (all decoded audio is resampled to this).
    pub sample_rate: u32,
}

impl ProjectEngine {
    /// Create a new empty engine for a project.
    pub fn new(sample_rate: u32) -> Self {
        Self {
            store: MmapStore::new(),
            timeline: ClipTree::new(),
            params: HashMap::new(),
            sample_rate,
        }
    }
}

/// Wrapper type for Rustler ResourceArc registration.
pub struct ProjectEngineResource(pub Mutex<ProjectEngine>);
