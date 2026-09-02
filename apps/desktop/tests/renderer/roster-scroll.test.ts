import { describe, expect, it } from 'vitest';
import { rosterScrollEdges } from '@renderer/view-models/roster-scroll.js';

describe('rosterScrollEdges', () => {
  it('reveals a forward affordance when later agents are off-canvas', () => {
    expect(rosterScrollEdges({ scrollLeft: 0, clientWidth: 900, scrollWidth: 1700 })).toEqual({
      before: false,
      after: true,
    });
  });

  it('offers both directions in the middle of the roster', () => {
    expect(rosterScrollEdges({ scrollLeft: 400, clientWidth: 900, scrollWidth: 1700 })).toEqual({
      before: true,
      after: true,
    });
  });

  it('hides the affordances when their edge is reached or the roster fits', () => {
    expect(rosterScrollEdges({ scrollLeft: 800, clientWidth: 900, scrollWidth: 1700 })).toEqual({
      before: true,
      after: false,
    });
    expect(rosterScrollEdges({ scrollLeft: 0, clientWidth: 900, scrollWidth: 900 })).toEqual({
      before: false,
      after: false,
    });
  });
});
