import { ADAPTERS } from '../platforms/index.js';
import { apiPublish, apiPublishUnavailableReason } from '../platforms/service.js';
import { registerPublishMethod } from './methods.js';

/**
 * Official-API publishing (modules/platforms) for every platform with an adapter. Preferred over the
 * manual method whenever the account has a working OAuth connection and the media fit the API
 * (unavailableReason says why not). Tokens stay inside modules/platforms.
 */
for (const adapter of ADAPTERS) {
  registerPublishMethod(adapter.id, {
    id: 'api',
    unavailableReason: (account, input) => apiPublishUnavailableReason(account, input),
    publish: (input, ctx) => apiPublish(input.account, input, { signal: ctx.signal, log: (msg, data) => ctx.log('info', msg, data) }),
  });
}
