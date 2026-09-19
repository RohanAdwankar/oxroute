//! The palette, in one place.
//!
//! Taken from the terminal artboard in the design canvas: warm ink on a warm
//! near-black, one green for what worked, one amber for what is waiting, one
//! red for what broke. Every colour is declared as RGB rather than as an
//! ANSI slot, so the UI looks the same in a terminal whose theme has opinions
//! about what "yellow" means.

use ratatui::style::{Color, Modifier, Style};

pub const INK: Color = Color::Rgb(0xe6, 0xe0, 0xd8);
pub const DIM: Color = Color::Rgb(0x8a, 0x80, 0x78);
pub const FAINT: Color = Color::Rgb(0x5f, 0x57, 0x50);
pub const RULE: Color = Color::Rgb(0x3a, 0x34, 0x30);
pub const OK: Color = Color::Rgb(0x78, 0xc4, 0x96);
pub const WARN: Color = Color::Rgb(0xdb, 0xa0, 0x5a);
pub const BAD: Color = Color::Rgb(0xd4, 0x79, 0x6a);
pub const INFO: Color = Color::Rgb(0x7f, 0xb2, 0xcc);
pub const ACCENT: Color = Color::Rgb(0xb1, 0x92, 0xcf);
pub const SELECTED: Color = Color::Rgb(0x26, 0x22, 0x20);

pub fn text() -> Style {
    Style::default().fg(INK)
}

pub fn dim() -> Style {
    Style::default().fg(DIM)
}

pub fn faint() -> Style {
    Style::default().fg(FAINT)
}

pub fn strong() -> Style {
    Style::default().fg(INK).add_modifier(Modifier::BOLD)
}

pub fn on(color: Color) -> Style {
    Style::default().fg(color)
}

/// The row the cursor is on. A background rather than a marker character, so
/// the columns stay aligned.
pub fn cursor() -> Style {
    Style::default().bg(SELECTED).add_modifier(Modifier::BOLD)
}

pub fn status_color(status: &str) -> Color {
    match status {
        "working" => OK,
        "stalled" => WARN,
        _ => DIM,
    }
}
