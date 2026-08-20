/**
 * CSS Modules: `import styles from './x.module.css'` yields a class-name map.
 * Static side-effect imports (`import './x.css'`) need a module declaration
 * under TypeScript 6.
 */
declare module '*.css' {
  const classes: Record<string, string>;
  export default classes;
}
