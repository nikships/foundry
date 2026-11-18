import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from '@renderer/components/ui/SegmentedControl.js';

describe('SegmentedControl accessibility', () => {
  it('renders a radiogroup with type="button" and role="radio" options', () => {
    const onClickA = vi.fn();
    const onClickB = vi.fn();
    const options = [
      { label: 'Option A', on: true, onClick: onClickA },
      { label: 'Option B', on: false, onClick: onClickB, ariaLabel: 'Option B Custom' },
    ];

    const element = SegmentedControl({ options, 'aria-label': 'Test Control' });

    expect(element.props.role).toBe('radiogroup');
    expect(element.props['aria-label']).toBe('Test Control');

    const children = element.props.children;
    expect(children).toHaveLength(2);

    expect(children[0].props.type).toBe('button');
    expect(children[0].props.role).toBe('radio');
    expect(children[0].props['aria-checked']).toBe(true);
    expect(children[0].props.children).toBe('Option A');

    expect(children[1].props.type).toBe('button');
    expect(children[1].props.role).toBe('radio');
    expect(children[1].props['aria-checked']).toBe(false);
    expect(children[1].props['aria-label']).toBe('Option B Custom');
    expect(children[1].props.children).toBe('Option B');
  });
});
