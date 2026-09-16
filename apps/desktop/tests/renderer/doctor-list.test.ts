/**
 * DoctorList and settings checks section tests:
 * verifies collapsible support, default collapsed state, animation classes,
 * accessibility attributes, and SettingsScreen wiring.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, '../..', rel), 'utf8');

const doctorListSrc = read('src/renderer/components/readiness/DoctorList.tsx');
const doctorListCss = read('src/renderer/components/readiness/DoctorList.module.css');
const settingsSrc = read('src/renderer/screens/SettingsScreen.tsx');

describe('DoctorList component', () => {
  it('supports collapsible prop defaulting to false', () => {
    expect(doctorListSrc).toContain('collapsible = false');
    expect(doctorListSrc).toContain('collapsible?: boolean;');
  });

  it('defaults all checks to collapsed', () => {
    expect(doctorListSrc).toContain(
      'const [expandedChecks, setExpandedChecks] = useState<Record<string, boolean>>({})',
    );
  });

  it('provides a toggle for individual checks and toggle-all in header', () => {
    expect(doctorListSrc).toContain('const toggleCheck = (id: string): void =>');
    expect(doctorListSrc).toContain('const toggleAll = (): void =>');
    expect(doctorListSrc).toContain("anyExpanded ? 'Collapse all' : 'Expand all'");
  });

  it('exposes accessible head buttons and aria attributes for collapsible checks', () => {
    expect(doctorListSrc).toContain('aria-expanded={isOpen}');
    expect(doctorListSrc).toContain('aria-controls={`doctor-check-detail-${check.id}`}');
    expect(doctorListSrc).toContain('data-testid={`doctor-check-${check.id}`}');
  });

  it('uses the standard expansion animation pattern in DoctorList.module.css', () => {
    expect(doctorListCss).toContain('.collapse {');
    expect(doctorListCss).toContain('grid-template-rows: 0fr;');
    expect(doctorListCss).toContain('grid-template-rows: 1fr;');
    expect(doctorListCss).toContain('transform: rotate(180deg);');
    expect(doctorListCss).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('SettingsScreen checks section', () => {
  it('wires DoctorList with collapsible in the Checks section', () => {
    const checksSectionIndex = settingsSrc.indexOf(
      'Section label="Checks" note="What Foundry found on this machine at launch."',
    );
    expect(checksSectionIndex).toBeGreaterThan(0);
    const checksSectionSlice = settingsSrc.slice(checksSectionIndex, checksSectionIndex + 600);
    expect(checksSectionSlice).toContain('<DoctorList');
    expect(checksSectionSlice).toContain('collapsible');
  });
});
