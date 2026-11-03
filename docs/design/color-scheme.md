# Color scheme: Neon After Dark

> **`nightjar ui` no longer follows this palette.** The page chooses its own night-shift world (see `DESIGN.md` and `PRODUCT.md`): teal on near-black, system fonts, no magenta. This file stays the brand palette for the icon and anything else outside the page.


Nightjar's brand palette, kept here for when we improve the UI. It preserves the identity of the icon: deep midnight backgrounds, electric cyan, hot magenta, ultraviolet purple and sunset orange. It should feel like a futuristic autonomous software factory, not a generic cyberpunk dashboard.

## Palette

### Backgrounds

| Token | Name | Hex |
| --- | --- | --- |
| `--nj-void` | Void | `#070914` |
| `--nj-bg` | Base | `#0D1117` |
| `--nj-surface` | Surface | `#111827` |
| `--nj-elevated` | Elevated | `#182338` |
| `--nj-panel` | Panel | `#1C2940` |
| `--nj-border` | Border | `#30415E` |

### Neon accents

| Token | Name | Hex |
| --- | --- | --- |
| `--nj-cyan` | Electric Cyan | `#20DDF5` |
| `--nj-blue` | Laser Blue | `#278BFF` |
| `--nj-purple` | Ultraviolet | `#8B5CF6` |
| `--nj-magenta` | Hot Magenta | `#F12DD6` |
| `--nj-orange` | Sunset Orange | `#FF8A2A` |
| `--nj-gold` | Solar Gold | `#FFD166` |

### Text and status

| Token | Name | Hex |
| --- | --- | --- |
| `--nj-text` | Primary | `#EDF4FF` |
| `--nj-text-secondary` | Secondary | `#A5B4D0` |
| `--nj-text-muted` | Muted | `#71819F` |
| `--nj-success` | Success | `#27E0B3` |
| `--nj-warning` | Warning | `#FFB454` |
| `--nj-error` | Error | `#FF557A` |

Values were read off a reference image; check them against the icon before treating them as final.

## CSS variables

```css
:root {
  /* Core backgrounds */
  --nj-void: #070914;
  --nj-bg: #0d1117;
  --nj-surface: #111827;
  --nj-elevated: #182338;
  --nj-panel: #1c2940;
  --nj-border: #30415e;

  /* Neon brand colors */
  --nj-cyan: #20ddf5;
  --nj-blue: #278bff;
  --nj-purple: #8b5cf6;
  --nj-magenta: #f12dd6;
  --nj-orange: #ff8a2a;
  --nj-gold: #ffd166;

  /* Text */
  --nj-text: #edf4ff;
  --nj-text-secondary: #a5b4d0;
  --nj-text-muted: #71819f;

  /* Status */
  --nj-success: #27e0b3;
  --nj-warning: #ffb454;
  --nj-error: #ff557a;
}
```

## Terminal (true-color ANSI)

```bash
NJ_RESET='\033[0m'
NJ_BOLD='\033[1m'

NJ_CYAN='\033[38;2;32;221;245m'
NJ_BLUE='\033[38;2;39;139;255m'
NJ_PURPLE='\033[38;2;139;92;246m'
NJ_MAGENTA='\033[38;2;241;45;214m'
NJ_ORANGE='\033[38;2;255;138;42m'
NJ_GOLD='\033[38;2;255;209;102m'

NJ_WHITE='\033[38;2;237;244;255m'
NJ_MUTED='\033[38;2;113;129;159m'

NJ_SUCCESS='\033[38;2;39;224;179m'
NJ_WARNING='\033[38;2;255;180;84m'
NJ_ERROR='\033[38;2;255;85;122m'
```

## Usage

| UI element | Color |
| --- | --- |
| Main application background | `#070914` |
| Sidebar | `#0D1117` |
| Cards | `#111827` |
| Active navigation | `#20DDF5` |
| Primary buttons | Cyan → Magenta gradient |
| Secondary buttons | `#1C2940` |
| Headings | `#EDF4FF` |
| Links | `#20DDF5` |
| Build/deploy activity | `#27E0B3` |
| Warnings | `#FFB454` |
| Errors | `#FF557A` |
| Backgrounds | Restrained starfield, grid or circuit patterns |
| Premium highlights | `#FF8A2A` |

## Rules

- **Don't make everything glow.** Keep roughly 85–90% of the UI dark and neutral; use neon for meaningful interaction, active states, progress and important information.
- **Cyan is the operational color, magenta the creative/AI color, amber the execution/deployment color.** This gives a recognizable visual language instead of a pile of neon colors.

## Design principles

- **Typography:** Space Grotesk for headings, Inter for UI, JetBrains Mono for terminal output.
- **Visual language:** technical, precise, futuristic, slightly industrial.
- **Lighting:** cyan and magenta edge lighting, amber highlights.
- **Motion:** subtle pulsing status indicators, smooth transitions, animated pipeline progress.
- **Icons:** thin-line technical icons with occasional neon accents.

## Brand assets

In `docs/design/assets/`:

- `icon.webp`: app icon, nightjar over a synthwave sunset with the "N" mark.
- `wordmark.webp`: NIGHTJAR wordmark with the tagline "The software factory that works while you are sleeping".
- `banner-wide.webp`: wide banner, nightjar on a pipe above a neon city.
- `banner-16x9.webp`: 16:9 banner, nightjar on machinery before a synthwave sunset.
