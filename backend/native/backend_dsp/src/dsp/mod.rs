//! DSP sub-module hub.
//!
//! | Module        | Contents                                                  |
//! |---------------|-----------------------------------------------------------|
//! | `oscillators` | `build_unison_oscillator` — unison voice stacking         |
//! | `filters`     | `build_filter`, `FilterType` — SVF and Moog LPF factory   |
//! | `effects`     | Drive, distortion, chorus, reverb, volume nodes           |
//! | `lfo`         | `Lfo`, `LfoTarget` — sub-audio parameter modulation       |
//! | `envelope`    | `Adsr` — ADSR envelope for amplitude and filter mod       |
//! | `fft`         | `compute_fft_spectrum`, `FFT_SIZE` — spectrum for canvas  |

pub mod effects;
pub mod envelope;
pub mod fft;
pub mod filters;
pub mod lfo;
pub mod oscillators;
