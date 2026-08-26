/**
 * Native notifications and the dock badge. Called from one place in the run
 * lifecycle so what the user is told cannot disagree with what the trace says.
 */

import { app, Notification } from 'electron';
import type { AppSettings, RunRow } from '@shared/types.js';

const OUTCOME_TITLES: Record<string, string> = {
  accepted: 'Run accepted',
  rejected: 'Run not accepted',
  failed: 'Run failed',
  killed: 'Run killed',
};

function outcomeEnabled(status: RunRow['status'], settings: AppSettings): boolean {
  const { notifications } = settings;
  if (status === 'accepted') return notifications.accepted;
  if (status === 'rejected') return notifications.rejected;
  if (status === 'failed' || status === 'killed') return notifications.failed;
  return false;
}

export function notifyOutcome(run: RunRow, settings: AppSettings): void {
  if (!outcomeEnabled(run.status, settings) || !Notification.isSupported()) return;
  new Notification({
    title: OUTCOME_TITLES[run.status] ?? 'Run finished',
    body: `${run.pipelineName}: ${run.request.slice(0, 120)}`,
    subtitle: run.branch ?? undefined,
    silent: false,
  }).show();
}

export function setDockBadge(runningCount: number, settings: AppSettings): void {
  if (process.platform !== 'darwin') return;
  app.dock?.setBadge(settings.dockBadge && runningCount > 0 ? String(runningCount) : '');
}
