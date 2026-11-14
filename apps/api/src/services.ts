import { createAdb } from './adapters/adb.js';
import { createStf } from './adapters/stf.js';

/** Process-wide adapter singletons. Runtimes: see adapters/runtime/index.ts (per engine). */
export const adb = createAdb();
export const stf = createStf();
export { dockerHost, network, runtimeFor } from './adapters/runtime/index.js';
