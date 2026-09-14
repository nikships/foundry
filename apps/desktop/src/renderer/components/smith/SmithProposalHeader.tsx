import type { ReactNode } from 'react';
import { cx } from '../ui/cx.js';
import styles from './SmithProposalHeader.module.css';

/**
 * Kind / mode / title row shared by the three Smith proposal card variants.
 */
export function SmithProposalHeader({
  kind,
  mode,
  modeClassName,
  title,
  titleId,
}: {
  kind: ReactNode;
  mode?: ReactNode;
  modeClassName?: string;
  title: ReactNode;
  titleId?: string;
}): React.JSX.Element {
  return (
    <header className={styles.header}>
      <span className={styles.kind}>{kind}</span>
      {mode != null && mode !== '' && (
        <span className={cx(styles.mode, modeClassName)}>{mode}</span>
      )}
      <h2 className={styles.title} id={titleId}>
        {title}
      </h2>
    </header>
  );
}
