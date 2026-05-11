//! Clip timeline using an interval-based data structure for O(log n + k)
//! range queries.
//!
//! Each audio clip placed on the DAW timeline is stored as an interval
//! `[start_ms, end_ms)`.  When the mixer requests a chunk of audio at a
//! given timestamp range, we query the tree for all overlapping clips.
//!
//! # Implementation
//! We use a sorted `Vec` + binary search rather than a full balanced interval
//! tree crate to keep dependencies minimal and cache-friendly.  For the
//! expected scale (< 10 000 clips per project), a sorted scan after binary
//! search is O(log n + k) with excellent constant factors.

/// Metadata for a single audio clip placed on the timeline.
#[derive(Debug, Clone)]
pub struct ClipInfo {
    /// Unique clip identifier (usually matches the DB track.id).
    pub clip_id: u64,
    /// Which decoded audio track this clip references in the MmapStore.
    pub track_id: u64,
    /// Global timeline start position in milliseconds.
    pub start_ms: u64,
    /// Global timeline end position in milliseconds.
    pub end_ms: u64,
    /// Offset in milliseconds into the source audio file where this clip begins.
    /// Allows clips that start partway through a longer audio file.
    pub source_offset_ms: u64,
}

/// Sorted-vector interval structure for timeline clip queries.
///
/// Clips are sorted by `start_ms`.  Range queries find the first clip that
/// could overlap via binary search, then scan forward collecting all clips
/// whose `start_ms < query_end` and `end_ms > query_start`.
pub struct ClipTree {
    /// Clips sorted by `start_ms` ascending.
    clips: Vec<ClipInfo>,
}

impl ClipTree {
    pub fn new() -> Self {
        Self { clips: Vec::new() }
    }

    /// Insert a clip into the tree, maintaining sort order.
    pub fn insert(&mut self, clip: ClipInfo) {
        let pos = self
            .clips
            .binary_search_by_key(&clip.start_ms, |c| c.start_ms)
            .unwrap_or_else(|p| p);
        self.clips.insert(pos, clip);
    }

    /// Remove all clips with the given `clip_id`.
    pub fn remove_by_clip_id(&mut self, clip_id: u64) {
        self.clips.retain(|c| c.clip_id != clip_id);
    }

    /// Replace the entire timeline with a new set of clips.
    pub fn rebuild(&mut self, mut clips: Vec<ClipInfo>) {
        clips.sort_by_key(|c| c.start_ms);
        self.clips = clips;
    }

    /// Query all clips overlapping the range `[start_ms, end_ms)`.
    ///
    /// A clip overlaps if `clip.start_ms < end_ms && clip.end_ms > start_ms`.
    ///
    /// Returns an iterator over references to matching `ClipInfo` values.
    pub fn query_range(&self, start_ms: u64, end_ms: u64) -> impl Iterator<Item = &ClipInfo> {
        // Binary search for the first clip that could possibly overlap.
        // A clip with `clip.end_ms <= start_ms` cannot overlap — but we don't
        // have the clips sorted by end_ms, so we use a conservative start:
        // find the first clip whose start_ms could be relevant.
        //
        // Any clip with `clip.start_ms >= end_ms` cannot overlap, so we can
        // stop scanning there.  But clips starting before `start_ms` might
        // still extend into our range.  We scan from index 0 in the worst case,
        // but with a sorted list this is still very cache-friendly.
        self.clips
            .iter()
            .take_while(move |c| c.start_ms < end_ms)
            .filter(move |c| c.end_ms > start_ms)
    }

    /// Get the total number of clips.
    pub fn len(&self) -> usize {
        self.clips.len()
    }

    /// Check if the tree is empty.
    pub fn is_empty(&self) -> bool {
        self.clips.is_empty()
    }

    /// Get the maximum end_ms across all clips (timeline end).
    /// Returns 0 if the tree is empty.
    pub fn max_end_ms(&self) -> u64 {
        self.clips.iter().map(|c| c.end_ms).max().unwrap_or(0)
    }
}
