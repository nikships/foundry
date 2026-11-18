import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SegmentedControl } from '../../src/renderer/components/ui/SegmentedControl.js';

describe('SegmentedControl accessibility', () => {
  it('renders a container with role="group" and optional aria-label', () => {
    const html = renderToString(
      SegmentedControl({
        ariaLabel: 'View switcher',
        options: [
          { label: 'List', on: true, onClick: () => {} },
          { label: 'Grid', on: false, onClick: () => {} },
        ],
      }),
    );

    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="View switcher"');
  });

  it('sets explicit type="button" and aria-pressed on each option', () => {
    const html = renderToString(
      SegmentedControl({
        options: [
          { label: 'Tab A', on: true, onClick: () => {} },
          { label: 'Tab B', on: false, onClick: () => {} },
        ],
      }),
    );

    expect(html).toContain('type="button"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
  });

  it('supports aria-label and disabled attributes on options', () => {
    const html = renderToString(
      SegmentedControl({
        options: [
          { label: 'Active', on: true, onClick: () => {} },
          {
            label: 'Disabled',
            on: false,
            onClick: () => {},
            ariaLabel: 'Disabled mode',
            disabled: true,
          },
        ],
      }),
    );

    expect(html).toContain('aria-label="Disabled mode"');
    expect(html).toContain('disabled=""');
  });
});
