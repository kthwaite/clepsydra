# Style Tokens System Design

## Aesthetic Direction

The visual language draws from brutalist and high modernist architecture: Le Corbusier's Plan Voisin, Zuazo's rationalism, Dudok's monumental horizontality. Characteristics:

- **Sharp geometry** — No rounded corners, ever
- **Stark shadows** — Hard-edged offset blocks, not diffused glows
- **Monumental weight** — Strong contrast, decisive edges
- **Rational grid** — Spacing follows Tailwind's systematic scale
- **No ornamentation** — Every element serves function

## Token Structure

### Semantic Color Pairs

Each semantic color has a paired foreground for guaranteed contrast:

| Token | Purpose |
|-------|---------|
| `background` / `foreground` | Page-level defaults |
| `card` / `card-foreground` | Card surfaces |
| `popover` / `popover-foreground` | Dropdowns, tooltips, overlays |
| `primary` / `primary-foreground` | Main actions, emphasis |
| `secondary` / `secondary-foreground` | Secondary buttons, less prominent actions |
| `muted` / `muted-foreground` | Subtle backgrounds, placeholder text |
| `accent` / `accent-foreground` | Highlights, selections |
| `destructive` / `destructive-foreground` | Delete actions, errors |

### Utility Tokens

| Token | Purpose |
|-------|---------|
| `border` | General borders |
| `input` | Input field borders |
| `ring` | Focus ring color |

## Color Values

Using OKLCH for perceptual uniformity. Neutral zinc-like foundation.

### Light Mode

```css
--color-background: oklch(1 0 0);
--color-foreground: oklch(0.145 0 0);

--color-card: oklch(1 0 0);
--color-card-foreground: oklch(0.145 0 0);

--color-popover: oklch(1 0 0);
--color-popover-foreground: oklch(0.145 0 0);

--color-primary: oklch(0.205 0 0);
--color-primary-foreground: oklch(0.985 0 0);

--color-secondary: oklch(0.96 0 0);
--color-secondary-foreground: oklch(0.205 0 0);

--color-muted: oklch(0.96 0 0);
--color-muted-foreground: oklch(0.45 0 0);

--color-accent: oklch(0.96 0 0);
--color-accent-foreground: oklch(0.205 0 0);

--color-destructive: oklch(0.55 0.2 25);
--color-destructive-foreground: oklch(0.985 0 0);

--color-border: oklch(0.90 0 0);
--color-input: oklch(0.90 0 0);
--color-ring: oklch(0.70 0 0);
```

### Dark Mode

Dark mode is not a simple inversion. Card/popover surfaces are slightly lighter than background to create depth. Muted foreground is brighter for readability.

```css
--color-background: oklch(0.145 0 0);
--color-foreground: oklch(0.985 0 0);

--color-card: oklch(0.17 0 0);
--color-card-foreground: oklch(0.985 0 0);

--color-popover: oklch(0.17 0 0);
--color-popover-foreground: oklch(0.985 0 0);

--color-primary: oklch(0.985 0 0);
--color-primary-foreground: oklch(0.205 0 0);

--color-secondary: oklch(0.22 0 0);
--color-secondary-foreground: oklch(0.985 0 0);

--color-muted: oklch(0.22 0 0);
--color-muted-foreground: oklch(0.65 0 0);

--color-accent: oklch(0.22 0 0);
--color-accent-foreground: oklch(0.985 0 0);

--color-destructive: oklch(0.55 0.2 25);
--color-destructive-foreground: oklch(0.985 0 0);

--color-border: oklch(0.25 0 0);
--color-input: oklch(0.25 0 0);
--color-ring: oklch(0.55 0 0);
```

## Shadows

Hard-edged offset shadows, bottom-right direction. No blur. Solid opacity creates the stark, cast-shadow effect of brutalist architecture.

```css
--shadow-sm: 2px 2px 0 0 oklch(0 0 0 / 0.15);
--shadow-md: 4px 4px 0 0 oklch(0 0 0 / 0.2);
--shadow-lg: 6px 6px 0 0 oklch(0 0 0 / 0.25);
--shadow-xl: 8px 8px 0 0 oklch(0 0 0 / 0.3);
```

For dark mode, shadows use a darker base since the background is already dark:

```css
--shadow-sm: 2px 2px 0 0 oklch(0 0 0 / 0.4);
--shadow-md: 4px 4px 0 0 oklch(0 0 0 / 0.5);
--shadow-lg: 6px 6px 0 0 oklch(0 0 0 / 0.6);
--shadow-xl: 8px 8px 0 0 oklch(0 0 0 / 0.7);
```

## Border Radius

Banned. Sharp edges only.

```css
--radius: 0;
```

## Non-Color Tokens

Spacing, typography, and animation use Tailwind's defaults. No custom scales needed — Tailwind v4's built-in values are well-designed and systematic.

## File Structure

All tokens live in `ui/src/main.css` using Tailwind v4's `@theme` directive. The CSS file is the source of truth.

```
ui/src/main.css       # All tokens defined here
```

## Usage

Tailwind v4 automatically generates utilities for each `--color-*` token:

```tsx
// Colors
<button className="bg-primary text-primary-foreground">
<div className="bg-muted text-muted-foreground">
<span className="text-destructive">
<div className="border border-border">

// Shadows
<div className="shadow-md">
<dialog className="shadow-xl">
```

## Implementation

Replace the current minimal `main.css` with the full token system. The existing theme toggle infrastructure (`ThemeProvider`, `ThemeToggle`) continues to work unchanged — it toggles the `.dark` class which activates the dark mode tokens.

## Future Considerations

- **Accent color**: The neutral foundation can be extended with a configurable accent hue
- **Component tokens**: As patterns emerge, add component-specific tokens (e.g., `--input-height`)
- **Motion tokens**: Add duration/easing tokens if consistent animation timing becomes important
