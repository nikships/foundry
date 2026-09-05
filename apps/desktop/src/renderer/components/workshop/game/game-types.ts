import type { WorkshopStation } from '../../../view-models/workshop-view.js';

export interface WorkshopGameState {
  stations: WorkshopStation[];
  activeId?: string;
  live: boolean;
  paused: boolean;
  activity: string;
  revision: number;
  failed: boolean;
}

export interface WorkshopGameHandle {
  update: (state: WorkshopGameState) => void;
  focus: (phaseId?: string) => void;
  zoom: (direction: number) => void;
  destroy: () => void;
}
