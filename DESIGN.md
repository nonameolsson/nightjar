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
  socket-border: "#3f7078"
  bar-overlay: "rgba(4, 7, 11, 0.94)"
  panel-overlay: "rgba(8, 13, 19, 0.85)"
  panel-overlay-strong: "rgba(8, 13, 19, 0.92)"
  teal-wash: "rgba(34, 227, 210, 0.07)"
  shade-soft: "rgba(0, 0, 0, 0.3)"
  shade-mid: "rgba(0, 0, 0, 0.35)"
  shade-deep: "rgba(0, 0, 0, 0.45)"
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
    fontSize: "0.75rem"
    fontWeight: 600
    letterSpacing: "0.14em"
  meter-value:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.5
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
    backgroundColor: "{colors.teal-wash}"
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
    backgroundColor: "{colors.panel-overlay}"
    rounded: "{rounded.none}"
  detail-panel:
    backgroundColor: "{colors.panel-overlay-strong}"
    rounded: "{rounded.none}"
    padding: "18px"
    width: "340px"
  meter:
    backgroundColor: "{colors.shade-soft}"
    rounded: "{rounded.none}"
    padding: "6px 10px"
  nest-socket:
    backgroundColor: "{colors.shade-mid}"
    textColor: "{colors.socket-border}"
    rounded: "{rounded.round}"
    size: "1.75rem"
---

# Design System: Nightjar UI

## Themes

The page has two themes, each a whole stylesheet of its own (`src/ui-theme.ts`), and a switch at the end of the bar that keeps the person's pick in local storage (`nightjar-theme`). The theme not shown is turned off with `media="not all"`, and a head script applies a kept pick before the body draws.

- **Paper**, the default (`PAPER_STYLE` in `src/ui-theme.ts`): one line per Feature on warm paper greys, the platform sans at 13px with tabular figures, one hairline for every rule, and a 6px radius. It follows the machine's light or dark scheme. Each state's group stands under a 32px grey label with a dot of its hue (blue building, amber needs a person, violet queue, grey shelf, green completed), its name and a bare count. Tickets are 14px status icons that keep the Hue-Plus-Shape Rule: a green disc with a check (built), a blue half-filled ring (building), an amber disc with a bar (needs a person), a dashed ring (waiting). Hue lives in those small objects and a state's words, never in a field; blue also draws focus and selection. No banner, no uppercase tracked labels, no coloured left edge. Its type ramp is 11.5, 12, 12.5, 13, 13.5, 14 and 16px. Colours are tokens on `:root`, light first and dark second, under the same no-literal rule as below.
- **Nightjar**: the night-shift HUD this file describes from here on (`STYLE` in `src/ui.ts`).

## Overview

**Creative North Star: "The Night Shift Mat"**

A cyberpunk HUD runs over a field-guide's habitat boards. A nightjar banner (teal and amber line art) sits over a dark void with a faint teal grid. Below it, one mat per state holds Tickets as eggs resting in round nest sockets. A person glancing at the board reads state from egg and mat colour alone; the text is there to confirm.

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
- **Shelf Grey** (#7f979b, the muted ink): the shelf mat only. Work with no Go yet is neither live nor waiting, so it takes the quiet neutral rather than a state hue.
- **Completed Green** (#3fd17f): the completed mat and a pulled entry's label.
- **Fault Red** (#ff5a5f): failed entries only.

### Neutral
- **Void** (#04070b): page ground, text on bright fills, interior of stepper hexagons.
- **Panel** (#0b131b): declared surface base; mats and panel use translucent near-black overlays on the void instead.
- **Line** (#1b3a42): all hairlines, mat borders, dashed entry dividers, table rules.
- **Ink** (#e6f1f2): primary text. **Soft Ink** (#9db5b8): secondary text, labels. **Muted** (#7f979b): meta, empty states, column heads.
- **Socket Dash** (#2f5a63): dashed outline of a waiting (empty) egg.
- **Socket Border** (#3f7078): the 1px ring of a nest socket; the one border brighter than Line.

### Overlays
Every colour is a `:root` token (`--socket-dash`, `--socket-border`, `--bar-overlay`, `--panel-overlay`, `--panel-overlay-strong`, `--teal-wash`, `--shade-soft|mid|deep`); a spec rejects a literal outside `:root`, and translucent teal is `color-mix()` on `--teal`.

Translucent fills laid over the void and its grid; they stand in for a solid surface colour.
- **Bar Overlay** (rgba(4, 7, 11, 0.94)): the sticky bar. **Panel Overlay** (rgba(8, 13, 19, 0.85)): the mat; **Panel Overlay Strong** (rgba(8, 13, 19, 0.92)): the Building-now panel, which sits above the grid and needs the extra opacity.
- **Teal Wash** (rgba(34, 227, 210, 0.07)): active view tab fill, and the top tint of the Building-now panel.
- **Shade** (black at 0.3, 0.35, 0.45): **soft** for meters and egg inset shading (0.25 on the needs-a-person egg, 0.3 on the speckles), **mid** for the socket fill (0.35), **deep** for the session log (0.45). Egg shading and speckles use soft (0.3) and mid (0.35); the needs-a-person egg shares soft.

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
- **Data** (400, 0.85rem, mono): stats, meta, clocks, Ticket lists, session log (0.75rem, 1.7).
- **Label** (600-700, 0.75rem, mono, 0.14-0.2em tracking, uppercase): mat tabs, table column heads, meter captions, the sticky-bar mark.
- **Meter value** (700 inherited, 1rem, sans): elapsed and cost under their captions.

### Type ramp
The CSS uses only these sizes: 0.75rem (labels, column heads, meter captions, session log; the floor, nothing smaller), 0.85rem (data, tabs, chips, clocks, legend), 1rem (meter values, tally), 1.05rem (entry name), 1.2rem (panel title), 1.6rem (heading), plus the 15px body. A spec holds the ramp.

### Named Rules
**The Mono Means Measured Rule.** Monospace marks counts, ids, times, costs, and column or tab labels. Names and sentences stay in sans.

## Layout

The page never scrolls: the bar (view switcher and links to the Tracker and pull requests) and the run header with its numbers stay fixed, and only the content beneath scrolls. Below 480px height or 400px width (a landscape phone, 400% zoom) the bar and header scroll with the content, so the Features stay reachable. A 150px banner (100px on phones) opens the scrolling content and fades into the void. Content is a centred column, max 1380px, 32px side padding (12px on phones). On Board with a running Ticket the content splits into a flexible left column and a 340px sticky detail panel (20px gap, `top: 16px`). Mats stack with 16px between; each is a two-column grid, an 88px tab rail (40px on phones) and the entry lines. Entries are a 4-column grid (name, 13rem eggs, 10.5rem, 6.5rem clock) with 14px vertical padding. At 1260px and below the detail panel moves above the mats and stops sticking; at 900px the head row hides and entries collapse to one column; at 760px (phone) the mark hides and the tab rail narrows to 40px. Beside the detail panel, entries also collapse to one column between 1261px and 1400px (the head row hides). Interactive controls (sort buttons, view tabs, chips) are at least 24px tall, 44px on `pointer: coarse`. A visually hidden `role="status"` region announces a rise in waiting or failed Features; a skip link jumps to the panels. Table view scrolls horizontally with a 36rem minimum. Spacing rhythm is 4/8/16/20/32.

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
A bordered rectangle tinted from its left by 12% of its state hue. Left rail is a vertical label tab (mono uppercase, reading bottom-to-top) with a hexagon tally below it, ruled off by a 2px state-hue border. Waiting is amber, building teal, queue slate violet, shelf grey, completed green. Entries are separated by dashed Line rules.

### Egg and Nest Socket
- **Built:** solid Deep Teal egg. **Building:** Signal Teal egg with a 2px ring at 3px offset pulsing over 2.4s (`incubate`). **Needs a person:** amber egg with two small amber wings angled 20 degrees (the wing-flash). **Waiting:** dashed Socket Dash outline, no fill (hidden inside a socket, which stands for the empty nest).
- Sockets are 1.75rem circles on 35% black with a Socket Border ring.

### Building-Now Panel
Sticky, mono, translucent with a teal top wash and a Deep Teal border and teal corner brackets. Caption with a blinking blip dot, Ticket title in sans with a mono id, a vertical stepper of hexagon nodes (built Deep Teal fill, building Signal Teal fill and bold text, waiting amber outline, pending muted outline) on a 1px Line spine, a 2-up grid of elapsed and cost meters (small tracked caption over a 1rem bold value), and a scrollable session log.

### Feature Detail Panel
A modal drawer on the right, 640px wide (full width on a phone), full height and scrolling on its own over a 45% black backdrop. Same frame as the Building-now panel: translucent with a teal top wash, a Deep Teal border and teal corner brackets (top-left, bottom-right). A mono caption and a Close button, then the Feature's title in sans with a mono id. Spec and Tickets sit under Line-ruled mono section heads; the spec's own headings drop to 1rem sans. Tickets use the Building-now stepper: a closed Ticket is a filled Deep Teal hexagon in muted text, an open one an outline, and each says `open` or `closed` in words. Each Ticket's acceptance criteria fold under a teal mono `<summary>`. A Feature's title that opens the panel is a text button with a dotted underline that goes teal on hover.

### Cost Fold
A build's cost opens into its stages and its models as a native `<details>`, folded by default: under a Completed card (a full-width row beneath the entry), under Building now's meters, and in a Table row's Cost cell, whose summary is the dollars themselves with a dotted underline and a visually hidden "cost by stage and model". The summary is a 0.75rem mono Muted line (44px on `pointer: coarse`) with a 2px teal focus ring. Inside, a Muted 0.75rem mono head (`By stage`, `By model`, not uppercase) over a two-column list on dashed Line rules: the stage or model in Soft Ink, then its dollars and a `<small>` of its Sessions or its tokens. At phone width each line stacks to one column. A build whose ledger lines name no model says so in a quiet `empty` line; one with some unnamed says how many Sessions and dollars. A fold stays open, and focus stays on its summary, across a live swap. Paper draws the same at 12px on a solid Line rule.

### Steps Bar
One segment per stage of a Feature's latest build (Tickets, Steps, Review, Review rounds, Pull checks, Feedback), in an `<ol>` beneath its Eggs on its Board card and in its Table row's Progress cell; nothing for a Feature with no Session in its build. Each segment is a 1.25rem by 0.5rem flat bar 3px apart (Paper: 18 by 8px, 2px radius, 2px apart), and keeps the Hue-Plus-Shape Rule: **passed** solid Deep Teal; **passed after a retry or a round** Deep Teal hatching in a Deep Teal outline; **failed** Fault Red broken by a gap in its middle; **running** half-filled Signal Teal in a Signal Teal outline with the `incubate` ring (off under reduced motion); **not reached** a dashed Socket Dash outline; **not needed** a 2px Muted line. Paper draws the same forms in `--built`, `--fault`, `--blue` and `--pending`. Each segment's `title` and a visually hidden text name the stage, its state, its Sessions and their cost. A legend of the six forms sits once above the Board, after the Egg legend, and once above the Table's chips.

### Last seven days
The Overview opens with a section headed `Last seven days` (an overview heading, tracked mono Deep Teal) over one wrapping row of four counts: Features completed, failed and handed to a person, and the dollars spent. Each is a mono 1rem bold number and its words in Ink (Soft Ink in Nightjar, with a dotted underline on the three links); the words carry the meaning, so no colour does. The three counts of Features are links to the Table's outcome filter, named for a screen reader with what the filter shows ("show every completed Feature in the Table", "show the Features that need a person now in the Table"), at least 24px tall (44px on `pointer: coarse`); the dollars are plain text. A Muted line below says where the counts come from, and that the filter shows every Feature the Table holds with that outcome, of any day, so its number need not match the week's. A zero is a zero, never an empty section.

### Chips and Table
Filter chips are pill outlines in Deep Teal with teal text; on state they fill Signal Teal with void text. The state chips are followed by a second group of chips, labelled `Outcome` in a muted mono caption, one chip pressed at a time (Any, Completed, Failed, Needs a person); they are buttons with `aria-pressed`, and a muted mono line under them says `Showing n of m Features` while any filter is on. Table headers are tracked mono buttons that turn teal when sorted, with a rotated-border chevron for direction; rows have Line bottom borders.

### Session Log
Black 45% fill, Line border, 0.75rem mono at 1.7 line-height in Soft Ink, wrapped, capped at 14rem height and scrolling.

### Session Page
`/sessions/<id>` shares the bar (with a way back to the Board), the banner and the scrolling region. One bordered `.run` block per ledger line holds its Feature, Ticket, kind, outcome, cost and duration as a wrapping grid of mono labels over values. The transcript below is a list: the Coding agent's text in sans, each tool call in mono behind a Deep Teal rule, and each tool result a native `<details>` folded under a 0.75rem mono summary, opened with the keyboard or a tap (44px on `pointer: coarse`). The open result is the Session Log's `pre`, taller (24rem). It links back to its Feature's Logbook.

### Logbook Page
`/features/<id>` shares the Session Page's bar, banner and scrolling region, and follows the build live. Under a mono `Logbook` heading with the Feature's id and title, and a line of its Sessions and cost, the Logbook is one ordered list on a 2px Line spine. A Session is a `.run` block (when, a link to its page, the same wrapping grid of kind, Ticket, outcome, cost and duration) on a Deep Teal spine, its summary folded as a `<details>`. A decision is one 0.85rem Soft Ink line with a mono 0.75rem time; a Signal's name or a command is set as `code`, and what it holds (a red check's gate report, the Review's issues, the Feedback left) folds beneath it as the Session Log's `pre`. A hand-over to a person runs on an amber spine; the build in flight closes the list on a Signal Teal spine under a tracked `Building now` label. A folded item stays open, and focus stays on its link or summary, across a live swap. A Feature with no Logbook file shows a quiet `empty` note above its Sessions. On every Mat card and Table row a small mono `Logbook` link (0.75rem, named `Logbook of #id` for a screen reader) follows the Feature's name; the Overview ends with All Logbooks.

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
