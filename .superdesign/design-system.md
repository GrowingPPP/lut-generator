# CHROMA — Design System

## Product context

**CHROMA** is a Panasonic Lumix LUT generator. It turns natural-language style
descriptions (e.g. 「日系清透」, 「电影青橙」) into real `.cube` LUT files that
photographers load into their Lumix camera bodies (Real-Time LUT) or use in
post-production.

- **Platform**: web app (React 18 + Vite frontend, FastAPI backend).
- **UI language**: Chinese (zh-CN). Product name and LUT terminology stay Latin.
- **Audience**: Panasonic Lumix photographers and creators — enthusiasts and
  working creators who shoot SOOC and want a reliable, repeatable look without
  learning a full grading suite.
- **Job to be done**: "I know the look I want in words. Give me a LUT file I can
  trust in-camera, without hand-tuning curves."

## Key pages & architecture

Single-page app with **view switching, not URL routing**:

| View | Component | What it does |
|---|---|---|
| Auth | `frontend/src/components/AuthView.jsx` | Login gate |
| Generate (default) | `frontend/src/App.jsx` | Conversational LUT generation + 22-parameter fine tuning + WebGL2 live preview |
| Library | `frontend/src/components/LibraryView.jsx` | Personal LUT CRUD, download in-camera vs. post-production builds |

Shared sub-components: `AutoRetouchBar.jsx` (trigger bar for AI auto-retouch),
`AutoRetouchReport.jsx` (diagnosis, before/after, change log, one-click undo).

> This design system describes the **product UI**. The landing page is a new
> marketing surface that must feel like the same product.

## Key features (the substance a landing page may claim)

1. **Conversational LUT generation** — describe a look in words; the model
   confirms over multiple turns, then emits a real `.cube` file.
2. **LUT management** — CRUD on personal LUTs; separate downloads for the
   in-camera build (with the Panasonic header) and the post-production build.
3. **Real-time preview** — upload a sample photo; compare via slider (before /
   after) or standalone display. GPU-composited: WebGL2 3D LUT overlay.
4. **AI auto-retouch** — upload a photo, get an automatically analysed and graded
   LUT in one step, optionally layered with a natural-language style note
   (e.g. 「日系清透一点」). Shows its diagnosis, before/after, the full change
   log, and offers one-click undo.
5. **Fine grading** — 22 parameters in collapsible groups: Base (temperature /
   tint / exposure), Tone (contrast / highlights / shadows / white / black /
   S-curve), Color (saturation / vibrance / hue), Split toning (shadow and
   highlight tinting separately), Per-channel (shadows / midtones / highlights ×
   R/G/B), base picture profile, and V-Log highlight mapping.

## Branding & styling

**This is the single source of visual truth. Do not introduce any font, color,
or visual style that is not defined here.**

### Color — dark, warm-amber accent

The product is a dark-room tool: near-black surfaces, warm amber as the single
accent. Amber is the only chromatic accent in the system — it marks the primary
action, the active state, and the LUT/look itself.

```
--ink:        #0a0a0c   /* page background, darkest surface */
--panel:      #16161a   /* primary raised surface (cards, panels) */
--panel2:     #1c1c22   /* secondary raised surface (nested, hover) */
--line:       #26262e   /* hairline border / divider */
--linestrong: #34343e   /* emphasized border, focused input */
--text:       #e9e9ec   /* primary text on dark */
--muted:      #9a9aa5   /* secondary text, labels, metadata */
--accent:     #e2a35a   /* THE accent: primary action, active state, highlights */
--warn:       #e0b64a   /* warning / attention state only */
```

Two semantic colors exist in the product as **literals, not tokens** (verified in
`App.css`) — reuse these exact values rather than inventing new hues:

```
#d98a8a      /* danger / error text — .btn-danger, .error */
#62626d      /* disabled / pending / skipped text — the --faint fallback */
```

Usage rules:

- Backgrounds are a **stepped dark ramp**: `--ink` for the page, `--panel` /
  `--panel2` for elevated content. Never place dark text on dark; never use a
  light/white page background.
- Amber `--accent` is **scarce and meaningful** — primary CTA, active tab,
  selected state, small highlights. Not for large fills or decorative washes.
- `--warn` is reserved for genuine warnings. Do not use it decoratively.
- No purple, pink, neon, or gradient-mesh palettes. No blue-grey "SaaS" purple.
  If a gradient is used at all, it stays within the amber→transparent family and
  stays subtle.

### Typography

Two families, loaded from Google Fonts in `frontend/index.html`:

- **Manrope** (400 / 500 / 700) — UI, body copy, numbers, controls.
- **Nunito** (400 / 600 / 700) — headings and the CHROMA wordmark.

Type character: geometric-humanist sans, tight and legible on dark, generous
weight contrast between heading and body. No serif display faces, no
decorative/script fonts, no condensed display faces.

### Layout & shape

- Single breakpoint in the product: `@media (max-width: 900px)`. Mobile
  behaviour is expected; the app is not desktop-only.
- Layout character: **panel-based composition** — bordered surfaces on a dark
  field, separated by hairlines (`--line`) rather than heavy shadows.
- Borders are hairlines and low-contrast; elevation is communicated by the
  surface ramp (`--ink` → `--panel` → `--panel2`), not by large drop shadows.
- Corner radius is restrained and consistent — small radii on controls, slightly
  larger on panels. Avoid pill-shaped everything and avoid fully square boxes.
- Spacing is on a consistent 4/8-based scale.

### Logo

**There is no logo file in this repository.** Render the brand as the plain
**wordmark "CHROMA"** set in Nunito (600/700), with normal letter-spacing —
optionally with the accent color applied to one letter or a small amber mark
beside it.

**Hard prohibition**: do not invent a logo, monogram, initials badge, emoji, or
generic geometric mark to fill a logo slot, and do not fabricate an SVG
logomark. A typographic wordmark is the correct and complete treatment.

### Imagery

Photography-forward. Sample images are real camera frames (a Panasonic Lumix
still), not stock-office or abstract-render imagery.

- Before/after LUT comparison is a first-class visual: the same frame shown
  graded and ungraded, ideally with a slider affordance.
- Tone: cinematic, restrained, real photographic texture. No frosted-glass
  "AI startup" hero renders, no floating 3D blobs, no fake dashboard screenshots
  with invented numbers.

### Motion

Purposeful, short, and quiet — this is a precision tool. Transitions on hover,
panel reveal, and before/after slider drag. No bouncy/playful springs, no
attention-seeking looping animation. Respect `prefers-reduced-motion`.

## Product requirements for new surfaces

- Any UI must look like it belongs to the same product as the tool UI: same
  fonts, same dark ramp, same amber accent, same hairline-border panel language.
- Claims on a marketing surface must map to a real feature listed above —
  no invented capabilities, no fabricated metrics, no fake testimonials or
  invented user counts.
- Primary conversion intent for this audience: get the reader to **generate
  their first LUT**. Secondary: see a real before/after, understand in-camera
  (Real-Time LUT) support for Lumix bodies.
- Copy language: Chinese (zh-CN) for body and headings, matching the product.
  Latin terms (LUT, `.cube`, Real-Time LUT, V-Log, Lumix) stay Latin.
