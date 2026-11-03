---
name: Nightjar UI
description: A cyberpunk night-shift habitat board where every Ticket is an egg in a round nest socket, grouped on HUD-framed mats by state.
colors:
  void: "#04070b"
  panel: "#0b131b"
  line: "#1b3a42"
  teal: "#22e3d2"
  teal-deep: "#14a89c"
  amber: "#ff9a1f"
  slate-violet: "#8f98e0"
  ok-green: "#3fd17f"
  ink: "#e6f1f2"
  ink-soft: "#9db5b8"
  muted: "#7f979b"
  err: "#ff5a5f"
  socket-dash: "#2f5a63"
typography:
  heading-mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "1.6rem"
    fontWeight: 700
    lineHeight: 1.5
  panel-title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.2rem"
    fontWeight: 700
    lineHeight: 1.5
  entry-name:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.05rem"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.85rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.72rem"
    fontWeight: 600
    letterSpacing: "0.14em"
rounded:
  none: "0"
  pill: "999px"
  round: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "20px"
  xl: "32px"
components:
  nav-tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.none}"
    padding: "5px 16px"
  nav-tab-active:
    backgroundColor: "rgba(34, 227, 210, 0.07)"
    textColor: "{colors.teal}"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.teal}"
    rounded: "{rounded.pill}"
    padding: "3px 14px"
  chip-on:
    backgroundColor: "{colors.teal}"
    textColor: "{colors.void}"
  mat:
    backgroundColor: "rgba(8, 13, 19, 0.85)"
    rounded: "{rounded.none}"
  detail-panel:
    backgroundColor: "rgba(8, 13, 19, 0.92)"
    rounded: "{rounded.none}"
    padding: "18px"
    width: "340px"
  meter:
    backgroundColor: "rgba(0, 0, 0, 0.3)"
    rounded: "{rounded.none}"
    padding: "6px 10px"
  nest-socket:
    backgroundColor: "rgba(0, 0, 0, 0.35)"
    rounded: "{rounded.round}"
    size: "1.75rem"
---

# Design System: Nightjar UI

## Overview

**Creative North Star: "The Night Shift Mat"**

Wingspan's habitat boards run through a cyberpunk HUD. A nightjar banner (teal and amber line art) sits over a dark void with a faint teal grid. Below it, one mat per state holds Tickets as eggs resting in round nest sockets. A person glancing at the board reads state from egg and mat colour alone; the text is there to confirm.

The page is dense and instrument-like: system sans for names and prose, `ui-monospace` for labels, counts, clocks and anything that is data. Colour is semantic (teal builds, amber needs a person, slate violet queues, green completes, red fails) and always paired with a shape change, so state never rests on hue alone. Frames are hard-edged and square, finished with corner brackets rather than rounded cards.

**Key Characteristics:**
- Dark void ground (#04070b) with a 32px teal grid at 3.5% alpha
- One accent colour per state, carried by the mat's tab, tally, brackets and tint
- Eggs are the unit of state; sockets are round, everything else is square or hexagonal
- Mono for data and labels, sans for names and prose
- No shadows for depth; borders and corner brackets build structure

## Colors

A teal-and-amber HUD palette on near-black, with two supporting state hues.

### Primary
- **Signal Teal** (#22e3d2): the live colour. Building eggs, the active view tab, links, the Building-now panel frame and caption, selected chips, focus rings, selection background.
- **Deep Teal** (#14a89c): built eggs, built stepper hexagons, resting borders on the detail panel and chips, overview section headings, scrollbar.

### Secondary
- **Needs-Person Amber** (#ff9a1f): a Ticket or run waiting on a human (egg with wing-flash) and the waiting mat. Reserved for "someone must act".

### Tertiary
- **Queue Slate Violet** (#8f98e0): the queue mat only.
- **Completed Green** (#3fd17f): the completed mat and a pulled entry's label.
- **Fault Red** (#ff5a5f): failed entries only.

### Neutral
- **Void** (#04070b): page ground, text on bright fills, interior of stepper hexagons.
- **Panel** (#0b131b): declared surface base; mats and panel use translucent near-black overlays on the void instead.
- **Line** (#1b3a42): all hairlines, mat borders, dashed entry dividers, table rules.
- **Ink** (#e6f1f2): primary text. **Soft Ink** (#9db5b8): secondary text, labels. **Muted** (#7f979b): meta, empty states, column heads.
- **Socket Dash** (#2f5a63): dashed outline of a waiting (empty) egg.

### Named Rules
**The Hue-Plus-Shape Rule.** State colour never travels alone: built, building, needs-a-person and waiting each differ in egg form (solid, ringed pulse, wing-flash, dashed empty) as well as colour.

**The One Hue Per Mat Rule.** A mat sets a single `--h` and derives its tab, tally, brackets and tint from it. Do not mix state hues inside one mat.

## Typography

**Display Font:** none shipped (known gap); the mono heading at 1.6rem stands in.
**Body Font:** system-ui, -apple-system, 'Segoe UI', sans-serif
**Label/Mono Font:** ui-monospace, SFMono-Regular, Menlo, monospace

**Character:** An operator's console: neutral system sans for what things are called, monospace for what they measure. All numerals are tabular so clocks and tallies do not jitter on live update.

### Hierarchy
- **Heading** (700, 1.6rem, 1.5, mono): the run title in the page header.
- **Panel title** (700, 1.2rem, 1.5, sans): Building-now Ticket name.
- **Entry name** (600, 1.05rem, 1.5, sans): Ticket and run names on mats.
- **Body** (400, 15px, 1.5, sans): prose and descriptions; secondary text 0.85rem in Soft Ink.
- **Data** (400, 0.76-0.9rem, mono): stats, meta, clocks, Ticket lists, session log (12px, 1.7).
- **Label** (600-700, 0.72-0.78rem, mono, 0.14-0.2em tracking, uppercase): mat tabs, table column heads, meter captions, the sticky-bar mark.

### Named Rules
**The Mono Means Measured Rule.** Monospace marks counts, ids, times, costs, and column or tab labels. Names and sentences stay in sans.

## Layout

A sticky bar (view switcher, 4px gaps, 10px/32px padding) sits under a 260px banner (180px on phones) that fades into the void. Content is a centred column, max 1380px, 32px side padding (12px on phones). On Board with a running Ticket the content splits into a flexible left column and a 340px sticky detail panel (20px gap, `top: 60px`). Mats stack with 16px between; each is a two-column grid, an 88px tab rail (40px on phones) and the entry lines. Entries are a 4-column grid (name, 13rem eggs, 10.5rem, 6.5rem clock) with 14px vertical padding, collapsing to one column at 760px. Under 1000px the detail panel drops below and stops sticking. Table view scrolls horizontally with a 36rem minimum. Spacing rhythm is 4/8/16/20/32.

## Elevation & Depth

Flat. Depth comes from translucent near-black panels over the grid, 1px Line borders, a gradient tint at each mat's tab edge, and corner brackets. No drop or glow shadows exist. The only `box-shadow` uses are inset 3px shading inside an egg and the expanding 9px ring on the live blip dot, both of which describe object form or a pulse, not elevation.

### Named Rules
**The Flat Frame Rule.** Surfaces are separated by border and tint, never by shadow. A new surface gets a Line border and, if it is a primary frame, corner brackets.

## Shapes

Square frames, round sockets, hexagonal counters. Mats, the detail panel, meters and the log are 0-radius rectangles with 1px borders. Two 16px, 2px corner brackets in the state hue mark each mat (top-right and bottom-right) and the detail panel (top-left and bottom-right). Counts and stepper nodes are flat-top hexagons (`clip-path` 25%/75% polygon: 2.3rem tally, 13px stepper node). Eggs are an ovoid (50% / 62% 62% 38% 38%) with two speckle dots; sockets are 1.75rem circles. Chips are the only pill (999px).

## Components

### Navigation
A sticky bar at 94% void with a Line bottom border. The mark is mono, bold, 0.2em tracked, in Signal Teal. View tabs are square, borderless buttons in Soft Ink; hover goes Ink; active is Signal Teal text on a 7% teal wash with a Deep Teal border. Focus shows a 2px teal outline, 2px offset.

### Habitat Mat
A bordered rectangle tinted from its left by 12% of its state hue. Left rail is a vertical label tab (mono uppercase, reading bottom-to-top) with a hexagon tally below it, ruled off by a 2px state-hue border. Waiting is amber, building teal, queue slate violet, completed green. Entries are separated by dashed Line rules.

### Egg and Nest Socket
- **Built:** solid Deep Teal egg. **Building:** Signal Teal egg with a 2px ring at 3px offset pulsing over 2.4s (`incubate`). **Needs a person:** amber egg with two small amber wings angled 20 degrees (the wing-flash). **Waiting:** dashed Socket Dash outline, no fill (hidden inside a socket, which stands for the empty nest).
- Sockets are 1.75rem circles on 35% black with a Line border.

### Building-Now Panel
Sticky, mono, translucent with a teal top wash and a Deep Teal border and teal corner brackets. Caption with a blinking blip dot, Ticket title in sans with a mono id, a vertical stepper of hexagon nodes (built Deep Teal fill, building Signal Teal fill and bold text, waiting amber outline, pending muted outline) on a 1px Line spine, a 2-up grid of elapsed and cost meters (small tracked caption over a 1rem bold value), and a scrollable session log.

### Chips and Table
Filter chips are pill outlines in Deep Teal with teal text; on state they fill Signal Teal with void text. Table headers are tracked mono buttons that turn teal when sorted, with a rotated-border chevron for direction; rows have Line bottom borders.

### Session Log
Black 45% fill, Line border, 12px mono at 1.7 line-height in Soft Ink, wrapped, capped at 14rem height and scrolling.

## Do's and Don'ts

### Do:
- **Do** draw state with an egg form plus the state hue (Hue-Plus-Shape).
- **Do** put the state hue on a mat through `--h` only and derive tab, tally, brackets and tint from it.
- **Do** use Signal Teal for live or active, amber only for "needs a person".
- **Do** set counts, ids, times and costs in mono with tabular numerals.
- **Do** end primary frames with corner brackets in their hue.
- **Do** honour `prefers-reduced-motion`: pulse and blip animations switch off.

### Don't:
- **Don't** use drop or glow shadows for elevation; build depth with borders and tints.
- **Don't** round frames, mats or buttons; only sockets (50%), eggs and chips (999px) are round.
- **Don't** use amber, violet or green for decoration; each is a state.
- **Don't** rely on colour alone for state.
- **Don't** add a new accent hue outside the state set.

### Not canonized (build carries these)
- No display face is shipped; the mono heading stands in. Treat as a gap, not a rule.
- Small tracked uppercase captions (the Building-now caption, overview section headings) read as eyebrow labels; they are not a pattern for new surfaces. Tab, column and meter labels are functional and stay.
