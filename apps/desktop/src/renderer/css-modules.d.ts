/**
 * Vite resolves a CSS import to a side-effecting module with no exports. A
 * static `import './x.css'` needs no declaration, but the brand sheets are
 * loaded with `await import(...)`, and tsc will not resolve those without one.
 */
declare module '*.css' {
  const sheet: void;
  export default sheet;
}
