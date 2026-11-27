---
name: Nightjar UI
description: A quiet ledger of the Queue on warm paper greys, light or dark by the machine's scheme, with hue only in small status marks.
colors:
  light:
    bg: "#ffffff"
    surface-2: "#f7f7f5"
    surface-3: "#efeeec"
    ink: "#37352f"
    muted: "#66655f"
    line: "#e9e9e7"
    accent: "#1d76cf"
    built: "#1d7f52"
    fault: "#c93a3f"
    ask: "#956a0a"
    pending: "#a3a29e"
    blue: "#337ea9"
    blue-ink: "#306e92"
    purple: "#9065b0"
    gray: "#787774"
    on-fill: "#ffffff"
    scrim: "rgba(15, 15, 15, 0.25)"
  dark:
    bg: "#191919"
    surface-2: "#202020"
    surface-3: "#2c2c2c"
    ink: "#d4d4d2"
    muted: "#a3a3a1"
    line: "#2f2f2f"
    accent: "#2a7fd8"
    built: "#4cc38a"
    fault: "#ff6369"
    ask: "#e2b93d"
    pending: "#5f5e5b"
    blue: "#5e9fd1"
    blue-ink: "#71abd7"
    purple: "#9d68d3"
    gray: "#9b9b9b"
    on-fill: "#191919"
    scrim: "rgba(0, 0, 0, 0.5)"
typography:
  title:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.4
  name:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
    fontFeature: "'tnum' 1"
  label:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', Helvetica, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
  code:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  pill: "9999px"
  round: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  view-tab:
    backgroundColor: "transparent"
    textColor: "{colors.light.muted}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  view-tab-active:
    backgroundColor: "{colors.light.surface-3}"
    textColor: "{colors.light.ink}"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.light.muted}"
    rounded: "{rounded.pill}"
    padding: "2px 12px"
  chip-on:
    backgroundColor: "{colors.light.surface-3}"
    textColor: "{colors.light.ink}"
  action-link:
    backgroundColor: "transparent"
    textColor: "{colors.light.ink}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "28px"
  card:
    backgroundColor: "{colors.light.bg}"
    rounded: "{rounded.lg}"
    padding: "12px 14px"
  detail-panel:
    backgroundColor: "{colors.light.bg}"
    rounded: "{rounded.lg}"
    padding: "14px 16px"
  meter:
    backgroundColor: "{colors.light.surface-2}"
    rounded: "{rounded.md}"
    padding: "6px 10px"
  status-mark:
    rounded: "{rounded.round}"
    size: "14px"
---

# Design System: Nightjar UI

## Overview

**Creative North Star: "The Quiet Ledger"**

The page is one design, drawn on warm paper greys and light or dark by the machine's own scheme: there is no theme to pick and no switch in the bar. It reads like a ledger: one line or one card per Feature, a hairline for every rule, the platform sans at 13px with tabular figures so clocks and tallies hold still on a live update. A person glancing at it learns what is done, what is building and what needs them from small status marks and a state's words, then reads the text to confirm.

Hue lives only in small objects: a Ticket's 14px status mark, a group's dot, a state's words. It never fills a field. Blue is kept for focus and selection. The page is calm, dense and glanceable, close to a document in a notes app and far from a dashboard: it rejects the removed night-shift HUD look, so no banner image, no glow, no corner brackets, no uppercase tracked labels and no coloured left edge.

The same stylesheet draws every page: the Board, the Table and the Overview, the Feature detail panel, the Session page and the Logbook page. A person who moves from the Board to a Logbook stays in one tool.

**Key Characteristics:**
- White ground in the light scheme and near-black (#191919) in the dark one, with warm grey surfaces, one hairline colour for every rule
- State is a small mark plus the state's words; hue never travels alone
- The platform sans at 13px with tabular figures; monospace only for code, commands and transcripts
- A 6px radius on controls, 8px on cards and panels, pills for chips and the state tag
- Flat: depth is a hairline border, with one shadow only under the modal drawer

## Colors

A warm paper-grey palette in two schemes, with five state hues kept to small objects. Every colour is a token on `:root`: the light values first, the dark values under `@media (prefers-color-scheme: dark)`. A spec rejects a literal colour outside `:root`.

### Primary
- **Focus Blue** (`accent`, light #1d76cf, dark #2a7fd8): focus rings, text selection (at 20%), checked boxes, the skip link. Never a state.

### Secondary
- **Needs-Person Amber** (`ask`, light #956a0a, dark #e2b93d): a Ticket or Feature that waits for a person: its mark, its state's words, and a 8% (12% dark) tint behind the reason and Next step under a card.

### Tertiary
- **Building Blue** (`blue`, light #337ea9, dark #5e9fd1; `blue-ink` for text, light #306e92, dark #71abd7): the building state, the live blip dot, the in-flight build in a Logbook.
- **Built Green** (`built`, light #1d7f52, dark #4cc38a): built Tickets, the Completed group's dot, a pulled Feature's words, a passed Steps-bar segment.
- **Queue Violet** (`purple`, light #9065b0, dark #9d68d3): the Queue group's dot only.
- **Shelf Grey** (`gray`, light #787774, dark #9b9b9b): the Shelf group's dot and a Logbook decision's mark.
- **Fault Red** (`fault`, light #c93a3f, dark #ff6369): failed Features, failed Steps-bar segments and faults, in words as well as colour.

### Neutral
- **Paper** (`bg`, light #ffffff, dark #191919): the page, cards, the bar and the drawer.
- **Paper Wash** (`surface-2`, light #f7f7f5, dark #202020): hover rows, meters, code blocks, the hover of a control.
- **Paper Shade** (`surface-3`, light #efeeec, dark #2c2c2c): the selected view tab and chip, the state tag, inline code.
- **Ink** (`ink`, light #37352f, dark #d4d4d2): text. **Muted** (`muted`, light #66655f, dark #a3a3a1): secondary text, labels, meta.
- **Hairline** (`line`, light #e9e9e7, dark #2f2f2f): every rule and border. **Pending** (`pending`, light #a3a29e, dark #5f5e5b): the dashed ring of a waiting Ticket and a hovered card's border.
- **On Fill** (`on-fill`, light #ffffff, dark #191919): the check and bang drawn inside a filled mark.
- **Scrim** (`scrim`, rgba(15, 15, 15, 0.25) light, rgba(0, 0, 0, 0.5) dark): the backdrop behind the drawer.

The mixes are derived, not new colours: `--ask-bg` is `color-mix()` of Needs-Person Amber, and `--accent-bg` of Focus Blue at 20%.

### Named Rules
**The Hue-Plus-Shape Rule.** State colour never travels alone. A Ticket's mark is a green disc with a check (built), a blue half-filled ring (building), an amber disc with a bang (needs a person) or a dashed ring (waiting). A Steps-bar segment is solid (passed), hatched (passed after a retry), broken by a gap (failed), half-filled with a ring (running), dashed (not reached) or a thin line (not needed). A state's words always come with its mark.

**The Small Objects Rule.** Hue lives in a mark, a dot or a state's words, never in a field or a rule. A card, a row and a panel stay on Paper and Hairline.

**The Both Schemes Rule.** Every text and state mark meets WCAG AA contrast in the light scheme and in the dark one. A new colour is added to both `:root` blocks, never to one.

## Typography

**Body Font:** ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', Helvetica, Arial, sans-serif (the platform's own face)
**Mono Font:** ui-monospace, SFMono-Regular, Menlo, Consolas, monospace

**Character:** The reader's own system face, quiet and tight, so the page feels native on every machine. Numerals are tabular everywhere (`font-feature-settings: 'tnum' 1`), so clocks, costs and counts do not jitter as the page updates live. Monospace is kept for code: Signals, commands, tool calls and logs.

### Hierarchy
- **Title** (600, 16px, 1.4): the run header and the Feature detail panel's title.
- **Name** (600, 14px, 1.4): a Feature's title on a card and a detail panel's Ticket.
- **Body** (400, 13px, 1.4): everything else; secondary lines are 12 to 13.5px in Muted.
- **Label** (500, 12px, 1.4, Muted): group names beside their dot (600, 13px), section heads, column heads (11.5px), meter captions (11.5px). Sentence case, never uppercase, never tracked.
- **Code** (400, 12px, 1.5, mono): code, commands, tool calls and the folded logs.

### Type ramp
The CSS uses only 11.5, 12, 12.5, 13, 13.5, 14 and 16px, plus `1em` headings. A spec holds the ramp.

### Named Rules
**The Mono Means Code Rule.** Monospace marks what is typed or logged: a Signal's name, a command, a tool call, a log. Names, counts, times and costs stay in the sans with tabular figures.

## Layout

The page never scrolls as a whole: the bar (the mark, Board / Table / Overview, and links to the Tracker and pull requests) and the run header with its numbers stay fixed, and only the content beneath scrolls. Below 480px height or 400px width (a landscape phone, 400% zoom) the bar and header scroll with the content, so the Features stay reachable. Content is a centred column, at most 1380px wide, with 24px side padding (12px on a phone). A visually hidden `role="status"` region announces a rise in waiting or failed Features, and a skip link jumps to the panels.

**The Board is for triage.** Each state is a group: a 28px heading with a dot of the group's hue, its name and a bare count, then its Feature cards in a grid that fits as many as the width holds, at least 280px each (420px under Waiting on you, whose cards carry a reason and a Next step). With a Feature selected the Board splits into a flexible left column and a 340px sticky detail panel (24px gap); at 1260px and below the panel moves above the groups and stops sticking. **The Table is for comparing**: one 40px line per Feature, no cell wraps, the title and outcome cut with an ellipsis (the whole text in their `title`) while an action always stays in view; the state is its word after a dot of its hue; time and cost are right-aligned; the Progress cell lays the Tickets, the Steps bar and its words on one line. It scrolls sideways below a 36rem minimum. **The Overview** is hairline-ruled sections of plain lines.

The Session page and the Logbook page share the bar (with a way back to the Board) and the scrolling region, and use the same column. Spacing steps are 4, 8, 12, 16 and 24px (a group's bottom margin is 20px). Interactive controls are at least 24px tall, and 44px under `pointer: coarse`.

## Elevation & Depth

Flat. Surfaces are told apart by a 1px Hairline and, for a hover or a selection, a step to Paper Wash or Paper Shade. The one shadow is under the Feature detail drawer, which floats over the page above a Scrim; the one other `box-shadow` is the expanding ring on the live blip dot, a pulse and not elevation.

### Named Rules
**The Flat Page Rule.** A card, a panel, a row and a fold sit on the page with a Hairline and no shadow. Only a modal drawer is lifted.

## Shapes

Soft, small radii. Controls (view tabs, action links, copy and close buttons), meters, code blocks and the Session page's `.run` blocks are 6px. Cards, the Feature detail panel and the drawer are 8px, and Steps-bar segments 2px. Chips and the run header's state tag are pills. Status marks and group dots are circles. The only borders are the 1px Hairline, the dashed ring of a waiting mark and the Pending hover of a card.

## Components

### Navigation
A 40px bar on Paper over a Hairline. The mark is 13px, 600, in Ink. View tabs are 28px high, 6px-radius, borderless text buttons in Muted; hover steps to Paper Wash and Ink; the active view is on Paper Shade in Ink at weight 500. The links to the Tracker and pull requests sit at the right as bordered action links with a small external-link mask icon. Focus is a 2px Focus Blue outline, 1px offset.

### Group and Feature Card
A group heading is a 28px line: an 8px dot in the group's hue (blue building, amber needs a person, violet queue, grey shelf, green completed), the name in 600 and a bare count in Muted. Each Feature is a card: Paper, 1px Hairline, 8px radius, 12 by 14px padding, border to Pending on hover. It reads top to bottom: its id over its title (14px, 600), with its time and cost or its action (Answer, Open) at the top right; its state in words in the state's hue; what a waiting Feature says (its reason, its Tickets handed back and its Next step) on an amber tint; then, past a Hairline, its Tickets and Steps bar.

### Status Mark
14px, circular, one per Ticket, the Hue-Plus-Shape forms above. Waiting is a dashed 1.5px Pending ring. The Feature detail panel's stepper uses a 12px mark in the same forms.

### Steps Bar
One 18 by 8px, 2px-radius segment per stage of a Feature's latest build (Tickets, Steps, Review, Review rounds, Pull checks, Feedback), 2px apart, in an `<ol>` beneath the Tickets on a card and in the Table's Progress cell. It keeps the Hue-Plus-Shape Rule. Each segment's `title` and a visually hidden text name the stage, its state, its Sessions and their cost. A legend of the forms sits once above the Board and once above the Table's chips.

### Chips and Table
Chips are 24px-tall pills on a Hairline in Muted; the pressed chip is on Paper Shade in Ink, weight 500. State chips are followed by an `Outcome` group, one pressed at a time, with `aria-pressed`, and a Muted line says `Showing n of m Features` while a filter is on. Table headers are 11.5px Muted buttons that turn Ink when sorted, with a rotated-border chevron; rows have Hairline bottom borders and step to Paper Wash on hover.

### Feature Detail Panel
Beside the Board, a 340px sticky panel on Paper with a Hairline and an 8px radius: a Building-now caption with the blip dot, the Ticket's title and id, a vertical stepper of marks, a 2-up grid of elapsed and cost meters on Paper Wash, and a scrollable session log. Under a Feature's title, the drawer (`<dialog>`, 640px, full width on a phone) opens over a Scrim, with a Close button, the spec and Tickets under Hairline-ruled sections, each Ticket's acceptance criteria folded under a `<summary>`, and the Feature's Logbook section last.

### Cost Fold
A build's cost opens into its stages and its models as a native `<details>`, folded by default, under a Completed card, under Building now's meters and in a Table row's Cost cell, whose summary is the dollars with a dotted underline. A fold stays open, and focus stays on its summary, across a live swap.

### Last seven days
The Overview opens with one wrapping row of four counts: Features completed, failed and handed to a person, and the dollars spent, each a 16px 600 number and its words. The three counts of Features link to the Table's outcome filter; a Muted line says where they come from. A zero is a zero, never an empty section.

### Session Page
`/sessions/<id>`: one hairline-bordered `.run` block per ledger line, 6px radius, holds its Feature, Ticket, kind, outcome, cost and duration as a wrapping grid of 11.5px Muted labels over values. The transcript below is a list: the Coding agent's text in the sans, each tool call a 12px mono line on Paper Wash, and each tool result a native `<details>` folded under a 12px Muted summary (44px on touch), opening a code block 24rem tall. It links back to its Feature's Logbook.

### Logbook Page
`/features/<id>` follows the build live. Under a `Logbook` heading with the Feature's id and title, one list of entries sits on Hairlines, each with a small mark whose shape tells its kind: a grey dot for a decision, a grey ring for a Session, an amber disc with a bang for a hand-over to a person, a half-filled blue ring for the build in flight (with its state word). A Session is a quiet `.run` block (when, a link to its page, kind, Ticket, outcome, cost and duration) with its summary folded; a decision is one 12.5px line with its time, a Signal's name or a command set as `code`, and what it holds (a red check's gate report, the Review's issues, the Feedback left) folded beneath it as a code block. A fold stays open, and focus stays on its link or summary, across a live swap. A Feature with no Logbook file shows a quiet note above its Sessions.

## Do's and Don'ts

### Do:
- **Do** draw state with a mark's shape plus its hue, and say the state in words (Hue-Plus-Shape).
- **Do** keep hue in small objects: a mark, a dot, a state's words.
- **Do** add every colour as a token to both `:root` blocks, and use it as `var(--token)` elsewhere.
- **Do** keep every text and state mark at WCAG AA contrast in the light scheme and the dark one.
- **Do** set sizes from the ramp (11.5, 12, 12.5, 13, 13.5, 14, 16px) and keep tabular figures.
- **Do** make every control at least 24px tall, 44px under `pointer: coarse`, and show Focus Blue's 2px ring on keyboard focus.
- **Do** honour `prefers-reduced-motion`: the live blip switches off.

### Don't:
- **Don't** add a banner, a glow, corner brackets, a grid texture or any HUD framing; that look is removed.
- **Don't** fill a card, a row or a panel with a state hue, or draw a coloured left edge.
- **Don't** use uppercase or tracked labels.
- **Don't** shadow a card or a panel; only the modal drawer is lifted.
- **Don't** rely on colour alone for state.
- **Don't** add a theme, a toggle or a stored preference: the page follows the machine's scheme and nothing else.
- **Don't** add a hue outside the set of the five states plus Focus Blue.
