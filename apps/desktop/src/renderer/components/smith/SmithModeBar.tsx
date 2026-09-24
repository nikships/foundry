/**
 * The in-chat YOLO control. It sits on one row so the chat does not grow a
 * second chrome band for a one-line status.
 */

import styles from './SmithModeBar.module.css';

export default function SmithModeBar({
  trailing,
}: {
  trailing: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={styles.bar}>
      <div className={styles.trailing}>{trailing}</div>
    </div>
  );
}
