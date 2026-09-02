/**
 * Design — the single authoring home for pipelines, agents, and envelopes.
 *
 * These three are one workflow with hard cross-references: a phase names an
 * agent, and an agent names an envelope. Tabs turn what used to be a trip into
 * Settings into an in-place switch with the target already selected, so a
 * cross-link never loses the editor you came from.
 *
 * Each tab keeps its own editor state while mounted. Switching tabs unmounts
 * the other two on purpose: their debounced saves flush on unmount, so leaving
 * a tab commits the pending edit rather than stranding it.
 */

import { useCallback, useEffect, useState } from 'react';
import { DESIGN_TABS, type DesignTab } from '../utils/navigation.js';
import { DESIGN_TAB_EMBLEMS } from '../components/layout/SidebarEmblems.js';
import { useTablistNav } from '../hooks/useTablistNav.js';
import { useApp } from '../stores/app.js';
import DesignScopeControl from '../components/project/DesignScopeControl.js';
import EnvelopesEditor from '../components/pipeline/EnvelopesEditor.js';
import PipelinesScreen from './PipelinesScreen.js';
import RosterScreen from './RosterScreen.js';
import styles from './DesignScreen.module.css';

export default function DesignScreen({
  tab,
  onTabChange,
  openTarget,
  openNonce = 0,
}: {
  tab: DesignTab;
  onTabChange: (tab: DesignTab) => void;
  /** Deep link (a Smith approve, or a cross-link): select this entity on `tab`. */
  openTarget?: string;
  /** Bumped per deep-link so re-selecting the same entity re-fires the effect. */
  openNonce?: number;
}): React.JSX.Element {
  const onTablistKey = useTablistNav();
  const { project, refreshScoped } = useApp();
  // A cross-link carries its own target; a plain tab click must not re-apply
  // the previous one, so the deep link is consumed by the tab it was aimed at.
  const [consumedNonce, setConsumedNonce] = useState(0);

  useEffect(() => {
    if (openNonce) setConsumedNonce(0);
  }, [openNonce]);

  const selectTab = useCallback(
    (next: DesignTab): void => {
      setConsumedNonce(openNonce);
      onTabChange(next);
    },
    [onTabChange, openNonce],
  );

  const liveNonce = openNonce && openNonce !== consumedNonce ? openNonce : 0;
  const deepLink = liveNonce ? openTarget : undefined;
  const active = DESIGN_TABS.find((t) => t.id === tab) ?? DESIGN_TABS[0];

  return (
    <div className={styles.designScreen}>
      <header className={styles.designHeader}>
        <p className="eyebrow">
          <span className="index">03</span>Design
        </p>
        <p className={styles.designLead}>{active.blurb}</p>
        <DesignScopeControl tab={tab} project={project} onChanged={refreshScoped} />
      </header>

      <div
        className={styles.designTabs}
        role="tablist"
        aria-label="Design surfaces"
        onKeyDown={onTablistKey}
      >
        {DESIGN_TABS.map((t) => {
          const on = t.id === tab;
          const Emblem = DESIGN_TAB_EMBLEMS[t.id];
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              className={`${styles.designTab} ${on ? styles.on : ''}`}
              onClick={() => selectTab(t.id)}
              title={`${t.label} (⌘⇧${t.key})`}
              aria-keyshortcuts={`Meta+Shift+${t.key} Control+Shift+${t.key}`}
              data-testid={`tab-${t.id}`}
            >
              <Emblem size={15} className={styles.designTabEmblem} />
              <span className={styles.designTabLabel}>{t.label}</span>
              <kbd className={styles.designTabKey}>⌘⇧{t.key}</kbd>
            </button>
          );
        })}
      </div>

      <div className={styles.designPanel} role="tabpanel" aria-label={active.label}>
        {tab === 'pipelines' && (
          <PipelinesScreen
            onOpenDesignTab={selectTab}
            openPipeline={deepLink}
            openNonce={liveNonce}
          />
        )}
        {tab === 'agents' && (
          <RosterScreen onOpenDesignTab={selectTab} openAgent={deepLink} openNonce={liveNonce} />
        )}
        {tab === 'envelopes' && <EnvelopesEditor openEnvelope={deepLink} openNonce={liveNonce} />}
      </div>
    </div>
  );
}
