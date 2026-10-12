# CHROMA Design System

## Product

CHROMA is a Chinese photography tool for creating and refining LUTs. The React frontend provides a landing page, authentication, a photographic workbench, a detail viewer and a personal LUT library. The FastAPI backend stores workspaces, versions, LUTs and AI job state.

Current capabilities include conversational creation, AI photo optimization, parameter protection, reference photo matching, external `.cube` import, simultaneous master/R/G/B curve editing, before/after comparison, original resolution photo export and LUT export. Camera support must be checked against the camera’s guide; do not promise universal compatibility or a fixed processing time.

## Visual direction

Photography is the primary content. Use a clear, restrained tool interface with consistent spacing and a scarce warm amber accent. Keep landing and product surfaces in the same visual family.

The executable color source is `frontend/src/themes.css`. Supported themes are dark, neutral gray, light and system preference. The light theme uses a near-white page, white panels and soft gray secondary surfaces. Text and keyboard focus must remain readable in every theme.

### Token roles

- `--ink`: page background.
- `--panel`: primary content surface; `--panel2`: quiet supporting surface.
- `--field`: editable field background; `--hover`: hover surface.
- `--line`: low emphasis separators and panel outlines.
- `--control-line`: editable control boundaries.
- `--linestrong`: stronger non-text controls such as slider tracks.
- `--text`, `--muted`, `--faint`: readable text levels.
- `--accent`, `--accent-strong`, `--accent-soft`, `--accent-line`: primary actions and selected states.
- Danger, success, warning and information use their semantic tokens. Warning colors are reserved for genuine attention states.
- `--photo-*`: fixed neutral photographic and chart viewing surfaces, independent of the interface theme. Never apply decorative color filters to photographs.

### Typography

Use Manrope, PingFang SC, Microsoft YaHei and system sans-serif fallbacks for UI text, controls and numbers. The existing CHROMA wordmark and C mark are the product identity; do not invent additional marks. Prefer body/control sizes of 13–14px, auxiliary text of at least 12px, panel headings of 16–18px and page headings of 24–28px. Landing headings can be larger.

### Layout

- Use a 4px spacing rhythm: 8–12px between related controls, 16px inside panels and 20–24px between primary tool modules.
- Desktop tool gutters are 24px; mobile gutters are 16px.
- Landing sections use approximately 64px vertical padding on desktop and 40–48px on mobile. Title-to-content spacing is 24–32px.
- Avoid accumulating parent gaps with child margins. Avoid decorative nested panels around the same information.
- Main controls use approximately 40px height; compact tools use 34–36px. Preserve touch targets and visible keyboard focus.
- Use 8px control radii and 12px panel radii, with subtle borders and restrained shadows.
- Responsive layouts must work on small phones, tablets and wide desktop screens. Do not assume a single breakpoint.

### Components and behavior

Use the shared Radix-based SelectField, Dialog, ActionMenu, Tabs, CheckboxField, RangeField, HelpPopover and Tooltip components. Preserve focus management, Escape handling, keyboard interactions, validation and destructive action confirmation.

The workbench prioritizes photographs; manual parameters remain legible and orderly. Curve channels are shown separately. Library cards align their operation rows and keep secondary actions quiet. Landing examples must be labeled as examples and map to implemented features.

### Imagery and motion

Use real photographic examples and the actual LUT renderer for interactive comparison. No fake metrics, testimonials or capability claims. Motion should be short and purposeful; honor reduced motion preferences. Do not introduce looping decorative animation.

## Validation

The current visual quality plan and acceptance criteria are in `docs/specs/visual-quality.md`. Check actual desktop and mobile pages in light, dark and neutral gray themes. Run the existing contrast checks, frontend regression tests and production build. Color processing and export behavior are independent of visual theme changes.
