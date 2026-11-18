# Bolt's Journal

## 2025-03-30 - Avoid heavy full-search pipelines in UI filter predicates

**Learning:** `paneMatchesQuery` was delegating to `searchSettings`, running full scoring, map allocations, and array sorting across all panes and sections just to return a boolean for UI rail item visibility. Fast short-circuiting predicates are far superior for render-loop filter checks on every keystroke.
**Action:** When filtering UI lists on keydown/input events, write direct, non-allocating, short-circuiting predicate functions instead of re-using heavy search result rankers.
