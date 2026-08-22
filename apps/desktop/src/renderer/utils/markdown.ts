/**
 * A deliberately small Markdown parser for chat transcripts. Smith's replies
 * arrive as Markdown text; this turns them into a tiny block/inline tree that
 * a component can render as real React elements — no HTML strings, no
 * `dangerouslySetInnerHTML`, no dependency. Pure and DOM-free so the grammar
 * is pinned by plain Vitest tests.
 *
 * Covered: paragraphs, ATX headings, fenced code blocks, unordered/ordered
 * lists, blockquotes, horizontal rules, bold, italic, inline code, and
 * http(s) links (explicit or bare). Anything else renders as literal text,
 * which is the right failure mode for a chat surface.
 */

export type MarkdownInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: MarkdownInline[] }
  | { type: 'em'; children: MarkdownInline[] }
  | { type: 'link'; href: string; children: MarkdownInline[] };

export type MarkdownBlock =
  | { type: 'paragraph'; children: MarkdownInline[] }
  | { type: 'heading'; level: number; children: MarkdownInline[] }
  | { type: 'code'; language: string; text: string }
  | { type: 'list'; ordered: boolean; items: MarkdownInline[][] }
  | { type: 'quote'; children: MarkdownInline[] }
  | { type: 'rule' };

const FENCE = /^```(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BULLET_ITEM = /^\s*[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE_LINE = /^>\s?(.*)$/;

function isStructural(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line.trim()) ||
    BULLET_ITEM.test(line) ||
    ORDERED_ITEM.test(line) ||
    QUOTE_LINE.test(line)
  );
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // past the closing fence, or EOF for an unterminated block
      blocks.push({ type: 'code', language: fence[1] ?? '', text: body.join('\n') });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1]!.length,
        children: parseInline(heading[2]!),
      });
      i += 1;
      continue;
    }

    if (RULE.test(line.trim())) {
      blocks.push({ type: 'rule' });
      i += 1;
      continue;
    }

    const listMatch = line.match(BULLET_ITEM) ?? line.match(ORDERED_ITEM);
    if (listMatch) {
      const ordered = ORDERED_ITEM.test(line);
      const itemPattern = ordered ? ORDERED_ITEM : BULLET_ITEM;
      const items: MarkdownInline[][] = [];
      while (i < lines.length) {
        const item = lines[i]!.match(itemPattern);
        if (!item) break;
        items.push(parseInline(item[1]!));
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    if (QUOTE_LINE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const quoted = lines[i]!.match(QUOTE_LINE);
        if (!quoted) break;
        body.push(quoted[1]!);
        i += 1;
      }
      blocks.push({ type: 'quote', children: parseInline(body.join('\n')) });
      continue;
    }

    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !isStructural(lines[i]!)) {
      body.push(lines[i]!);
      i += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(body.join('\n')) });
  }

  return blocks;
}

const INLINE_CODE = /^`([^`]+)`/;
const STRONG = /^\*\*((?:[^*]|\*(?!\*))+)\*\*/;
const EM_STAR = /^\*([^*\s](?:[^*]*[^*\s])?)\*/;
const EM_UNDERSCORE = /^_([^_\s](?:[^_]*[^_\s])?)_/;
const LINK = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/;
const BARE_URL = /^https?:\/\/[^\s<>)]+/;

export function parseInline(text: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let plain = '';
  const flush = (): void => {
    if (plain) {
      out.push({ type: 'text', text: plain });
      plain = '';
    }
  };

  let rest = text;
  while (rest.length > 0) {
    const code = rest.match(INLINE_CODE);
    if (code) {
      flush();
      out.push({ type: 'code', text: code[1]! });
      rest = rest.slice(code[0].length);
      continue;
    }
    const strong = rest.match(STRONG);
    if (strong) {
      flush();
      out.push({ type: 'strong', children: parseInline(strong[1]!) });
      rest = rest.slice(strong[0].length);
      continue;
    }
    // Underscore emphasis never applies intraword, so snake_case identifiers
    // in chat stay literal.
    const afterWord = /\w$/.test(plain);
    const em = rest.match(EM_STAR) ?? (afterWord ? null : rest.match(EM_UNDERSCORE));
    if (em) {
      flush();
      out.push({ type: 'em', children: parseInline(em[1]!) });
      rest = rest.slice(em[0].length);
      continue;
    }
    const link = rest.match(LINK);
    if (link) {
      flush();
      out.push({ type: 'link', href: link[2]!, children: parseInline(link[1]!) });
      rest = rest.slice(link[0].length);
      continue;
    }
    const bare = rest.match(BARE_URL);
    if (bare) {
      flush();
      out.push({ type: 'link', href: bare[0], children: [{ type: 'text', text: bare[0] }] });
      rest = rest.slice(bare[0].length);
      continue;
    }
    plain += rest[0]!;
    rest = rest.slice(1);
  }
  flush();
  return out;
}
