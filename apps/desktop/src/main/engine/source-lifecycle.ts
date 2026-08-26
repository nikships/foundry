export type RunSourceStage = 'started' | 'completed' | 'failed';

/** External orchestration side effects injected into the ordinary executor. */
export interface RunSourceLifecycle {
  advance(stage: RunSourceStage): Promise<void>;
}
