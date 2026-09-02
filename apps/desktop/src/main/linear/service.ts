import type { LinearIssueSnapshot, LinearRunSource, LinearWorkflowState } from '@shared/types.js';
import type { LinearActionResult, LinearConnectionState } from '@shared/ipc-contract.js';
import type { RunSourceLifecycle, RunSourceStage } from '../engine/source-lifecycle.js';
import type { Tracer } from '../trace/tracer.js';
import { LinearClient } from './client.js';
import type { LinearCredentials } from './credentials.js';

export type LinearClientFactory = (apiKey: string) => LinearClient;

export class LinearService {
  constructor(
    private readonly credentials: LinearCredentials,
    private readonly clientFactory: LinearClientFactory = (apiKey) => new LinearClient({ apiKey }),
  ) {}

  state(): LinearConnectionState {
    const keySet = this.credentials.has();
    return {
      keySet,
      detail: keySet
        ? 'A Linear API key is stored securely on this Mac.'
        : 'No Linear API key is stored.',
    };
  }

  async setApiKey(candidate: string): Promise<LinearActionResult> {
    const apiKey = candidate.trim();
    if (!apiKey) return { ok: false, detail: 'Enter a Linear API key.' };
    try {
      const viewer = await this.clientFactory(apiKey).test();
      // Persist only after the candidate authenticated, so a bad replacement
      // cannot destroy the last working key.
      this.credentials.set(apiKey);
      return { ok: true, detail: `Connected to Linear as ${viewer.name}.` };
    } catch (error) {
      return { ok: false, detail: errorMessage(error) };
    }
  }

  async test(): Promise<LinearActionResult> {
    try {
      const viewer = await this.client().test();
      return { ok: true, detail: `Connected to Linear as ${viewer.name}.` };
    } catch (error) {
      return { ok: false, detail: errorMessage(error) };
    }
  }

  clearApiKey(): LinearActionResult {
    this.credentials.clear();
    return { ok: true, detail: 'Linear API key removed.' };
  }

  issues(query: string): Promise<LinearIssueSnapshot[]> {
    return this.client().issues(query);
  }

  async issue(id: string): Promise<LinearIssueSnapshot> {
    const issue = await this.client().issue(id);
    if (!issue) throw new Error('Linear issue not found or not accessible with this API key');
    return issue;
  }

  workflowStates(teamId: string): Promise<LinearWorkflowState[]> {
    return this.client().workflowStates(teamId);
  }

  lifecycle(input: { source: LinearRunSource; runId: string; tracer: Tracer }): RunSourceLifecycle {
    return new LinearRunLifecycle({ ...input, client: () => this.client() });
  }

  private client(): LinearClient {
    const apiKey = this.credentials.get();
    if (!apiKey) throw new Error('Connect Linear in Settings before using a Linear issue');
    return this.clientFactory(apiKey);
  }
}

interface LifecycleDeps {
  source: LinearRunSource;
  runId: string;
  tracer: Tracer;
  client: () => LinearClient;
}

class LinearRunLifecycle implements RunSourceLifecycle {
  constructor(private readonly deps: LifecycleDeps) {}

  async advance(stage: RunSourceStage): Promise<void> {
    try {
      const stateId = this.deps.source.statusMapping[stage];
      if (!stateId) throw new Error(`No Linear status is mapped for “${stage}”`);
      const client = this.deps.client();
      const states = await client.workflowStates(this.deps.source.snapshot.team.id);
      const desired = states.find((state) => state.id === stateId);
      if (!desired) {
        throw new Error(
          `The Linear status mapped for “${stage}” is not in ${this.deps.source.snapshot.team.name}'s workflow`,
        );
      }

      const issue = await client.issue(this.deps.source.issueId);
      if (!issue) throw new Error('The source Linear issue is no longer accessible');
      if (issue.state.id === desired.id) {
        this.traceSuccess(stage, issue, desired, 'already current');
        return;
      }

      const expectedStateId = this.expectedStateId();
      if (issue.state.id !== expectedStateId) {
        throw new Error(
          `Linear status update skipped: ${issue.identifier} moved to “${issue.state.name}” outside Foundry`,
        );
      }

      const updated = await client.updateIssueState(issue.id, desired.id);
      this.traceSuccess(stage, updated, desired, 'updated');
    } catch (error) {
      const message = errorMessage(error);
      this.deps.tracer.event({
        runId: this.deps.runId,
        type: 'error',
        name: 'Linear status',
        payload: { stage, message },
      });
      this.deps.tracer.setSourceSyncError(this.deps.runId, message);
    }
  }

  private expectedStateId(): string {
    const events = this.deps.tracer.eventsAfter(this.deps.runId, 0);
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (event.name !== 'Linear status' || event.type !== 'log') continue;
      if (typeof event.payload.stateId === 'string') return event.payload.stateId;
    }
    return this.deps.source.snapshot.state.id;
  }

  private traceSuccess(
    stage: RunSourceStage,
    issue: LinearIssueSnapshot,
    desired: LinearWorkflowState,
    action: 'updated' | 'already current',
  ): void {
    this.deps.tracer.setSourceSyncError(this.deps.runId, null);
    this.deps.tracer.event({
      runId: this.deps.runId,
      type: 'log',
      name: 'Linear status',
      payload: {
        stage,
        action,
        issue: issue.identifier,
        stateId: desired.id,
        state: desired.name,
      },
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
