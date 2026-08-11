import { createContext, useContext } from 'react';

/** Increments each time the Inspector's "Collapse all" fires. Zero means never. */
export const CollapseContext = createContext(0);

export function useCollapseSignal(): number {
  return useContext(CollapseContext);
}
