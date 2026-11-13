# Content guidelines (enforced at publish)

Every artifact is something to **look at or play with**, never a wall of text.
`artifactserver publish` checks HTML before it uploads and refuses pages that
break the hard rules below, printing what to fix.

## Hard rules (publish refuses otherwise)

1. **Visual or interactive.** The page needs at least one real visual or widget:
   an `<svg>`, `<canvas>`, chart, diagram, `<input>`/`<button>`/`<details>`,
   tabs, sliders, toggles, or a component-library widget.
2. **No walls of text.** No single paragraph or list item over ~60 words, and
   prose must stay under ~60% of the visible text. Break ideas into cards,
   tables, diagrams, steps, before/after pairs.
3. **Explainers retain.** A page that explains (onboarding, how-it-works, a
   walkthrough, a tutorial, a design doc) must include **a tiny quiz after
   every 2–3 sections**, at least one quiz per page. Mark each quiz with
   `data-quiz` (the starter's `<Quiz>` does this for you).

## Quizzes

- 1 question, 2–4 options, instant feedback, one-line "why" on reveal.
- Ask about the idea just shown, not trivia. Wrong answers point back to the visual.
- Optional: a running score in the corner.

## Component libraries

Use real components, not hand-rolled divs. The starter at
`assets/starter.html` loads, from public CDNs the viewer allows:

| Library | Use for |
|---|---|
| React 19 + Radix Primitives (via esm.sh) | Tabs, Accordion, Dialog, Tooltip, Slider, Toggle, Popover |
| Tailwind (CDN) with shadcn-style tokens | Styling that matches the studio |
| Mermaid | Flow, sequence, architecture diagrams |
| Chart.js | Bar / line / scatter charts |

Start from the starter: copy it, keep its `<Quiz>`, `<Card>`, `<Tabs>`,
`<Stat>` components, and replace the content. Plain HTML + inline SVG is fine
too, as long as the hard rules pass.

## Style

Anthropic Serif for headings and body (the studio provides it), generous
whitespace, one accent colour (`#d97757`), light and dark via
`prefers-color-scheme`.
