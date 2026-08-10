/**
 * The SDK's typed `tool()` overload only accepts its own nested zod 3
 * (`@factory/droid-sdk` ships 3.25.76 privately). App code uses zod 4, and the
 * two are neither type- nor runtime-compatible — pass a zod-4 schema to
 * `tool()` and the SDK's parse fails or types refuse to compile.
 *
 * Isolate the nested import here so a future SDK that re-exports a compatible
 * zod (or drops the typed overload) is a one-file change. Nothing outside
 * `src/main/droid/sdk/` may import this.
 *
 * The path is relative (not a package subpath): the SDK package does not export
 * `./node_modules/zod`, so a bare `@factory/droid-sdk/node_modules/zod` import
 * fails both Vite and Node's export map.
 */

export { z } from '../../../../node_modules/@factory/droid-sdk/node_modules/zod/index.js';
