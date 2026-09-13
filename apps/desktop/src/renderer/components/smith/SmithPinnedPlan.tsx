import { useState } from 'react';
import { useSmithChatUI } from '../../stores/smith-chat-ui.js';
import { Button } from '../ui/Button.js';
import { ModalShell } from '../ui/ModalShell.js';
import SmithRunPlanCard from './SmithRunPlanCard.js';
import styles from './SmithPinnedPlan.module.css';

/** Session-only context, separate from the durable conversation and artifact snapshots. */
export default function SmithPinnedPlan(): React.JSX.Element | null {
  const { pinnedPlan, pinnedPlanAvailable, unpinPlan } = useSmithChatUI();
  const [open, setOpen] = useState(false);
  if (!pinnedPlan) return null;
  return (
    <aside className={styles.strip} data-testid="smith-pinned-plan">
      <div className={styles.description}>
        <strong>{pinnedPlan.title}</strong>
        <span className={styles.meta}>
          {pinnedPlan.planId} · {pinnedPlanAvailable ? pinnedPlan.status : 'unavailable · snapshot'}{' '}
          · revision {pinnedPlan.revision}
        </span>
      </div>
      <Button size="sm" onClick={() => setOpen(true)}>
        Open card
      </Button>
      <Button size="sm" variant="ghost" onClick={unpinPlan}>
        Unpin
      </Button>
      {open && (
        <ModalShell
          onClose={() => setOpen(false)}
          className={styles.modal}
          data-testid="smith-pinned-card"
        >
          <Button size="sm" onClick={() => setOpen(false)}>
            Close card
          </Button>
          <SmithRunPlanCard artifact={pinnedPlan} />
        </ModalShell>
      )}
    </aside>
  );
}
