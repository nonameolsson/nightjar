---
version: 1
slug: "src-ui-ts"
primary_target: "src/ui.ts"
related_targets: ["src/ui-command.ts"]
---

# Surface brief: nightjar ui

Scope: the `nightjar ui` page (src/ui.ts, styles in the `STYLE` const). Mode: Operate. Visitor: a developer checking their own overnight Queue in seconds. Build path: code-led; the shipped CSS is the source of truth and DESIGN.md is derived from it.

Constraints: single self-contained page, no network or CDN (CSP is default-src 'none'), live updates over server-sent events, GLOSSARY terms, WCAG AA, keyboard operable. The page palette is DESIGN.md's; the brand icon palette (`docs/design/color-scheme.md`) is reference only.

## Direction contract

THESIS: The Night Shift Mat. A cyberpunk HUD over a field-guide's habitat boards: each Feature is a mat, each Ticket an egg resting in a round nest socket, grouped on one mat per state. The screen refuses card grids and CI-dashboard defaults.
OWN-WORLD: Near-black void ground (#04070b) with a faint 32px teal grid. Signal Teal (#22e3d2) is live and active, Deep Teal (#14a89c) built, Needs-Person Amber (#ff9a1f) for a Ticket or run waiting on a human, slate violet (#8f98e0) queue, green (#3fd17f) completed, red (#ff5a5f) failed. Line #1b3a42 for hairlines; translucent near-black overlays instead of solid surfaces. Hard-edged square frames with 16px corner brackets in the mat's state hue; hexagonal tallies and stepper nodes; no drop or glow shadows.
STORY: The person sees in seconds what is done, what is building and what needs them from egg and mat colour alone, then reads the text to confirm; a running Ticket opens a sticky Building-now panel with its Steps, elapsed time, cost and Session log.
FIRST VIEWPORT: Nightjar banner (260px, fades into the void), a sticky bar with the mark and the Board / Table / Overview switcher, the run title in mono with run state, a stats line, an egg legend, then mats stacked by state (waiting, building, queue, completed), each with a vertical label tab, hexagon tally and entry rows (name, eggs in sockets, Ticket status line, clock). With a running Ticket a 340px sticky detail panel sits at the right.
FORM: Habitat mats on a HUD. State hue is set once per mat through `--h`; one egg per Ticket, eggs differ in form as well as colour (solid built, ringed pulse building, wing-flash needs a person, dashed empty waiting).
SIGNATURE: Tickets as eggs in round nest sockets; motion grammar: a slow 2.4s ring pulse on the building egg and a 2s blip on the live dot, both off under reduced motion.
FINISH: DESIGN.md and `.impeccable/design.json` are regenerated from the shipped CSS whenever it changes; known drift (off-ramp type sizes, shade alphas) is listed in DESIGN.md, not hidden.
