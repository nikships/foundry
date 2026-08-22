/**
 * Renders chat Markdown as real React elements from the tree produced by
 * `utils/markdown.ts` — no HTML strings cross into the DOM, so there is
 * nothing to sanitize. Links open in the system browser through the app
 * seam rather than navigating the window.
 */

import { useMemo } from 'react';
import { api } from '../../api.js';
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from '../../utils/markdown.js';
import styles from './MarkdownText.module.css';

function Inline({ nodes }: { nodes: MarkdownInline[] }): React.JSX.Element {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.type) {
          case 'code':
            return (
              <code key={i} className={styles.inlineCode}>
                {node.text}
              </code>
            );
          case 'strong':
            return (
              <strong key={i}>
                <Inline nodes={node.children} />
              </strong>
            );
          case 'em':
            return (
              <em key={i}>
                <Inline nodes={node.children} />
              </em>
            );
          case 'link':
            return (
              <a
                key={i}
                className={styles.link}
                href={node.href}
                onClick={(e) => {
                  e.preventDefault();
                  void api.app.openExternal(node.href);
                }}
              >
                <Inline nodes={node.children} />
              </a>
            );
          default:
            return <span key={i}>{node.text}</span>;
        }
      })}
    </>
  );
}

function Block({ block }: { block: MarkdownBlock }): React.JSX.Element {
  switch (block.type) {
    case 'heading': {
      // Chat headings are section labels, not document structure: clamp the
      // visual weight and keep the DOM flat so screen readers see one region.
      const cls = `${styles.heading} ${styles[`h${Math.min(block.level, 4)}`] ?? ''}`;
      return (
        <p role="heading" aria-level={block.level} className={cls}>
          <Inline nodes={block.children} />
        </p>
      );
    }
    case 'code':
      return (
        <pre className={styles.codeBlock} data-language={block.language || undefined}>
          <code>{block.text}</code>
        </pre>
      );
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i}>
          <Inline nodes={item} />
        </li>
      ));
      return block.ordered ? (
        <ol className={styles.list}>{items}</ol>
      ) : (
        <ul className={styles.list}>{items}</ul>
      );
    }
    case 'quote':
      return (
        <blockquote className={styles.quote}>
          <Inline nodes={block.children} />
        </blockquote>
      );
    case 'rule':
      return <hr className={styles.rule} />;
    default:
      return (
        <p className={styles.paragraph}>
          <Inline nodes={block.children} />
        </p>
      );
  }
}

export default function MarkdownText({ text }: { text: string }): React.JSX.Element {
  // The transcript re-renders on every progress push; parse only when the
  // message itself changes.
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={styles.markdown}>
      {blocks.map((block, i) => (
        <Block key={i} block={block} />
      ))}
    </div>
  );
}
