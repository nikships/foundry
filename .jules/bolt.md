## 2026-09-29 - Memoize MarkdownText for Chat Streaming

**Learning:** `MarkdownText` is rendered across all messages in Smith chat transcripts. Streaming updates trigger re-renders of parent containers on every token/progress event, causing all unmemoized `MarkdownText` items across previous chat turns to re-evaluate.
**Action:** Wrap `MarkdownText` and its sub-components (`Block`, `Inline`) in `React.memo` to skip DOM reconciliation for unmodified messages during streaming.
