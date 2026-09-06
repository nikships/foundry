/**
 * Application palettes. One catalog feeds the settings picker, the store
 * schema, native window chrome, and the renderer `data-theme` attribute.
 *
 * Components consume semantic tokens and never branch on a theme id; a new
 * palette is a catalog row plus a matching `:root[data-theme='…']` block.
 * `background` must stay in sync with that block's `--bg-base`.
 */

export const APP_THEMES = [
  {
    id: 'dark',
    label: 'Dark',
    group: 'Dark',
    appearance: 'dark',
    background: '#020202',
    preview: { base: '#020202', panel: '#0a0a0a', accent: '#ee6018', text: '#eeeeee' },
  },
  {
    id: 'midnight',
    label: 'Midnight',
    group: 'Dark',
    appearance: 'dark',
    background: '#070b14',
    preview: { base: '#070b14', panel: '#10182a', accent: '#7aa2ff', text: '#e8eefc' },
  },
  {
    id: 'forest',
    label: 'Forest',
    group: 'Dark',
    appearance: 'dark',
    background: '#0b100c',
    preview: { base: '#0b100c', panel: '#141c16', accent: '#6fbf73', text: '#e4eee6' },
  },
  {
    id: 'ember',
    label: 'Ember',
    group: 'Dark',
    appearance: 'dark',
    background: '#140c08',
    preview: { base: '#140c08', panel: '#1e1410', accent: '#e07a3d', text: '#f3e6d8' },
  },
  {
    id: 'contrast',
    label: 'High Contrast',
    group: 'Dark',
    appearance: 'dark',
    background: '#000000',
    preview: { base: '#000000', panel: '#0a0a0a', accent: '#ffb020', text: '#ffffff' },
  },
  {
    id: 'light',
    label: 'Light',
    group: 'Light',
    appearance: 'light',
    background: '#f7f7f5',
    preview: { base: '#f7f7f5', panel: '#ffffff', accent: '#b9470e', text: '#1b1b19' },
  },
  {
    id: 'sand',
    label: 'Sand',
    group: 'Light',
    appearance: 'light',
    background: '#f4efe4',
    preview: { base: '#f4efe4', panel: '#fffaf0', accent: '#9a4b16', text: '#2a2118' },
  },
  {
    id: 'mist',
    label: 'Mist',
    group: 'Light',
    appearance: 'light',
    background: '#eef1f6',
    preview: { base: '#eef1f6', panel: '#ffffff', accent: '#2b5f9e', text: '#1a2230' },
  },
] as const;

export type AppTheme = (typeof APP_THEMES)[number]['id'];
export type ThemeAppearance = (typeof APP_THEMES)[number]['appearance'];
export type AppThemeDef = (typeof APP_THEMES)[number];

export const APP_THEME_IDS = APP_THEMES.map((theme) => theme.id) as unknown as readonly [
  AppTheme,
  ...AppTheme[],
];

const THEMES_BY_ID = new Map<string, AppThemeDef>(APP_THEMES.map((theme) => [theme.id, theme]));

export function isAppTheme(value: unknown): value is AppTheme {
  return typeof value === 'string' && THEMES_BY_ID.has(value);
}

export function themeDef(theme: AppTheme): AppThemeDef {
  const def = THEMES_BY_ID.get(theme);
  if (!def) throw new Error(`Unknown theme: ${theme}`);
  return def;
}

/** Native form-control / scrollbar scheme. Always `dark` or `light`. */
export function themeAppearance(theme: AppTheme): ThemeAppearance {
  return themeDef(theme).appearance;
}

/** Native window paint shown before (and behind) the renderer. Keep in sync with `--bg-base`. */
export function themeBackgroundColor(theme: AppTheme): string {
  return themeDef(theme).background;
}

export function themeLabel(theme: AppTheme): string {
  return themeDef(theme).label;
}
