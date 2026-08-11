# Roster Custom Accent Color Plan

## Overview
Add a custom color picker to the Agent Editor's Accent field on the Roster screen, allowing operators to choose any hex color via a color wheel affordance while preserving the existing preset swatches.

## Implementation Steps

### 1. Update CSS Modules (`apps/desktop/src/renderer/screens/RosterScreen.module.css`)
Add utility classes to encapsulate the native `<input type="color">` cleanly over a standard swatch container without disrupting its layout:

```css
.colorPickerWrapper {
  position: relative;
  cursor: pointer;
}
.colorInput {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  border: none;
  padding: 0;
}
```

### 2. Update Roster Screen (`apps/desktop/src/renderer/screens/RosterScreen.tsx`)
In the Identity section's `Accent` field, locate `<div className={styles.swatches}>`.
Following the `COLORS.map` block (which renders the preset buttons) and before the `<span className={styles.swatchHex}>`, insert the new custom color affordance:

```tsx
<label
  className={`${styles.swatch} ${styles.colorPickerWrapper} ${!COLORS.includes(draft.color) ? styles.on : ''}`}
  aria-label="Custom Accent Color"
>
  <span 
    className={styles.swatchDot} 
    style={{
      background: !COLORS.includes(draft.color) 
        ? draft.color 
        : 'conic-gradient(red, yellow, lime, aqua, blue, magenta, red)'
    }} 
  />
  <input 
    type="color" 
    value={draft.color} 
    onChange={(e) => setDraft({ ...draft, color: e.target.value.toLowerCase() })} 
    className={styles.colorInput}
  />
</label>
```

- When a custom color is active (`draft.color` is not in `COLORS`), the wheel swatch becomes `.on` and its dot previews the selected custom color.
- Otherwise, it displays a `conic-gradient` color wheel as its idle state affordance.
- The native `input[type="color"]` guarantees values matching the exact `/^#[0-9a-fA-F]{6}$/` bounds enforced by `roster.ts`.
- Changes instantly map back into `setDraft`, ensuring the adjacent hex text, tab hues (`--hue`), and debounced autosaves (via `useDebouncedSave`) fire accurately with no extra wiring.

## Verification
1. Run `npm run check` to ensure TypeScript, linting, and tests pass with no regressions.
2. Build and launch the app.
3. Edit an agent: click the color wheel, verify the OS color picker appears, select a custom value.
4. Verify the tab underline and agent title tint perfectly instantly (tied to `--hue`).
5. Ensure the custom value saves over time without validation errors.
