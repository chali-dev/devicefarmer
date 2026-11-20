import { createAdb } from './adapters/adb.js';
import { createStf } from './adapters/stf.js';

/** Process-wide adapter singletons. */
export const adb = createAdb();
export const stf = createStf();
