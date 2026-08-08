/**
 * Vite resolves a CSS import to a side-effecting module with no exports. A
 * static `import './x.css'` needs no declaration, but a dynamic
 * `await import(...)` does, so this stays as a fallback for any future use.
 */
declare module '*.css' {
  const sheet: void;
  export default sheet;
}
