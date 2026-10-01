## 2026-03-30 - Fast-path scanning for custom inline parsers

**Learning:** Slicing strings character-by-character while running multiple anchors/regexes in a custom inline Markdown loop leads to $O(N^2)$ allocations and heavy regex evaluation on every single plain text character.
**Action:** Use pre-compiled trigger regexes (`/[`*_\[hH]/`) with `String.prototype.search()` to skip directly to potential trigger characters, avoiding regex testing and intermediate string slicing on plain prose.
