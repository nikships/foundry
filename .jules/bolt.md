## 2025-05-18 - Fast-path character scanning in custom inline text parsers

**Learning:** Naive string slicing (`text.slice(1)`) combined with character-by-character regex evaluations in custom parsers creates massive O(N²) allocation overhead and regex engine churn on long prose/chat messages.
**Action:** When writing custom inline string parsers, maintain an integer index cursor (`pos`) and scan ahead for trigger characters (`'`', '*', '_', '[', 'h'`) to skip non-formatting text ranges in a single `.slice(pos, next)` operation.
