## 2026-09-29 - SegmentedControl Accessibility Pattern
**Learning:** Shared UI controls built from simple `<button>` elements inside `<div>` containers (such as SegmentedControl) default to `type="submit"` when embedded inside `<form>` elements and lack selection context for screen readers unless `aria-pressed` and container `role="group"` are explicitly set.
**Action:** Always ensure segment/toggle button components supply `type="button"`, `aria-pressed={on}`, optional `aria-label`, and `role="group"` on the wrapper.
