---
version: 1
slug: "src-ui-ts"
primary_target: "src/ui.ts"
related_targets: ["src/ui-command.ts"]
---

# Surface brief: nightjar ui

Scope: the `nightjar ui` page (src/ui.ts; the one stylesheet is the `STYLE` const in src/ui-style.ts, which the Board, the Session page and the Logbook page all inline). Mode: Operate. Visitor: a developer checking their own overnight Queue in seconds. Build path: code-led; the shipped CSS is the source of truth and DESIGN.md is derived from it.

Constraints: single self-contained page, no network or CDN (CSP is default-src 'none'), live updates over server-sent events, GLOSSARY terms, WCAG AA, keyboard operable. The page palette is DESIGN.md's; the brand icon palette (`docs/design/color-scheme.md`) is reference only.

## Direction contract

THESIS: A quiet ledger. One line per Feature on warm paper greys; hue lives only in small objects (a Ticket's status mark, a group's dot, a state's words), never in a field.
OWN-WORLD: The platform sans at 13px with tabular figures, one hairline for every rule, a 6px radius, light or dark by the machine's scheme; blue for focus and selection.
STORY: The person sees in seconds what is done, what is building and what needs them from the status marks and the state's words, then reads the text to confirm; a running Ticket opens a sticky Building-now panel with its Steps, elapsed time, cost and Session log.
FIRST VIEWPORT: The bar (mark, Board / Table / Overview, links to the Tracker and pull requests), the run header and its numbers, then each Mat under a grey label with its dot, name and count. No banner.
FORM: State hue is set once per Mat through `--h`; one 14px mark per Ticket, marks differ in form as well as colour (solid built, half-filled building, a bang for needs a person, dashed for waiting).
SIGNATURE: 14px status marks that keep the Hue-Plus-Shape Rule; the one motion is a 2s blip on the live dot, off under reduced motion.
FINISH: DESIGN.md and `.impeccable/design.json` are regenerated from the shipped CSS (`src/ui-style.ts`) whenever it changes; known drift is listed in DESIGN.md, not hidden.
