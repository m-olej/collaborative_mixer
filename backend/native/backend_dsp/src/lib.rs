use rustler::{Atom, NifResult};

mod atoms {
    rustler::atoms! {
        ok,
        error,
    }
}

// Prosta funkcja testowa
#[rustler::nif]
fn ping() -> NifResult<String> {
    Ok("Rust DSP Engine is online!".to_string())
}

// Rejestracja funkcji dostępnych dla Elixira
rustler::init!("Elixir.Backend.DSP");
