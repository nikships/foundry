import type { ReactNode } from 'react';
import styles from './GutterSection.module.css';

/**
 * Numbered gutter section used by Settings and Design editors: mono
 * micro-label in a left column, fields on the right, hairlines between.
 * Put `gutterPageClass` on the scrolling page so CSS counters number
 * sections that are direct children.
 */
export const gutterPageClass = styles.page;

export function GutterSection({
  label,
  note,
  children,
  dataSec,
}: {
  label: string;
  note?: ReactNode;
  children: ReactNode;
  /** Settings search/scroll target (`data-sec`). */
  dataSec?: string;
}): React.JSX.Element {
  return (
    <section className={styles.section} data-sec={dataSec}>
      <div className={styles.label}>
        <p className="eyebrow">
          <span className="index" aria-hidden />
          {label}
        </p>
        {note != null && note !== '' && <p>{note}</p>}
      </div>
      <div className={styles.body}>{children}</div>
    </section>
  );
}
