import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, projectDbPath, projectRunsDir } from '../../src/main/trace/db.js';
import { Tracer } from '../../src/main/trace/tracer.js';
import { smithRunPlanArtifact } from '../../src/shared/smith-run-plan.js';
import { runPlanFixture } from '../helpers/run-plan.js';
import { seedOnboardedFixture, type SeededFixture } from './seed.js';

/** Real durable proposal + inert chat snapshot, with no model or run start. */
export function seedRunPlanFixture(userDataDir?: string, snapshotOnly = false): SeededFixture {
  const fixture = seedOnboardedFixture(userDataDir, 'none');
  const row = runPlanFixture(fixture.projectId);
  row.messages = [
    { id: 'old-operator', role: 'operator', text: 'Keep the shortcuts.', at: 1 },
    {
      id: 'old-smith',
      role: 'orchestrator',
      text: 'The shortcuts are preserved.',
      at: 2,
      revisedPlan: true,
    },
  ];
  const db = openDb(projectDbPath(fixture.supportDir, fixture.projectPath));
  try {
    const tracer = new Tracer(db, projectRunsDir(fixture.supportDir, fixture.projectPath));
    if (!snapshotOnly) {
      tracer.createProposal(row);
      tracer.updateProposal(row.planId, {
        status: 'ready',
        planJson: JSON.stringify(row.plan),
        revision: row.revision,
        updatedAt: row.updatedAt,
        messagesJson: JSON.stringify(row.messages),
      });
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  const artifact = smithRunPlanArtifact(row);
  writeFileSync(
    join(fixture.supportDir, 'pi', 'smith', fixture.projectId, 'chat-state.json'),
    JSON.stringify({
      sessionId: null,
      modelOverride: null,
      transcript: [
        { id: artifact.id, kind: 'artifact', source: 'smith', artifact, at: artifact.createdAt },
      ],
    }),
  );
  return fixture;
}
