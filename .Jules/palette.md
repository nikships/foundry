## 2025-09-30 - Segmented Control ARIA Radiogroup

**Learning:** Shared UI toggle group controls like `SegmentedControl` rendered `<button>` tags without `type="button"`, `role="radiogroup"`, `role="radio"`, or `aria-checked`.
**Action:** When building custom toggle or selector primitives, always provide semantic ARIA roles (`radiogroup`/`radio`), `aria-checked` state indicators, `type="button"`, and accept `aria-label` props.
