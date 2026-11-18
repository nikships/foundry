import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, '../..', rel), 'utf8');

const segmentedControlSrc = read('src/renderer/components/ui/SegmentedControl.tsx');
const updateBannerSrc = read('src/renderer/components/layout/UpdateBanner.tsx');

describe('SegmentedControl component accessibility', () => {
  it('sets role="group" and supports aria-label on the container', () => {
    expect(segmentedControlSrc).toContain('role="group"');
    expect(segmentedControlSrc).toContain('aria-label={ariaLabel}');
    expect(segmentedControlSrc).toContain("'aria-label'?: string;");
  });

  it('sets explicit type="button" and aria-pressed on segment buttons', () => {
    expect(segmentedControlSrc).toContain('type="button"');
    expect(segmentedControlSrc).toContain('aria-pressed={opt.on}');
  });
});

describe('UpdateBanner progress bar accessibility', () => {
  it('includes role="progressbar" with aria-valuenow, aria-valuemin, and aria-valuemax', () => {
    expect(updateBannerSrc).toContain('role="progressbar"');
    expect(updateBannerSrc).toContain('aria-valuenow={percent}');
    expect(updateBannerSrc).toContain('aria-valuemin={0}');
    expect(updateBannerSrc).toContain('aria-valuemax={100}');
  });
});
