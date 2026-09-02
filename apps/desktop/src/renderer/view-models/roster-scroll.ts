export interface RosterScrollEdges {
  before: boolean;
  after: boolean;
}

/** Which edges of the agent strip still have off-canvas tabs. */
export function rosterScrollEdges({
  scrollLeft,
  scrollWidth,
  clientWidth,
}: Pick<HTMLElement, 'scrollLeft' | 'scrollWidth' | 'clientWidth'>): RosterScrollEdges {
  const maxScroll = Math.max(0, scrollWidth - clientWidth);
  return {
    before: scrollLeft > 1,
    after: scrollLeft < maxScroll - 1,
  };
}
