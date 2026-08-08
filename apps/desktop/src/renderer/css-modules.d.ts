/**
 * CSS Modules: `import styles from './x.module.css'` yields a class-name map.
 * Static side-effect imports (`import './x.css'`) need no declaration.
 */
declare module '*.module.css' {
  const classes: Record<string, string>;
  export default classes;
}
