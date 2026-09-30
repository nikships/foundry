import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SegmentedControl } from '../../src/renderer/components/ui/SegmentedControl.js';

describe('SegmentedControl accessibility', () => {
  it('renders tablist role and options with tab role, type="button", and aria-selected', () => {
    const handleClick = vi.fn();
    const html = renderToStaticMarkup(
      SegmentedControl({
        'aria-label': 'Mode selector',
        options: [
          { label: 'Option 1', on: true, onClick: handleClick },
          { label: 'Option 2', on: false, onClick: handleClick },
        ],
      }),
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Mode selector"');
    expect(html).toContain('type="button"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-selected="false"');
  });
});
