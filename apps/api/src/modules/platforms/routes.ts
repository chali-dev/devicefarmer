import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { isPlatformEnabled } from '../../lib/platforms-enabled.js';
import { enabledPlatforms } from '../social/platforms.js';
import { trendingAvailable } from '../trending/trending.js';

/**
 * Platform scope for the web (ENABLED_PLATFORMS). The official platform integrations (OAuth connect,
 * API publishing, comment sync, account analytics, account checks) were removed on 2026-11-18 by owner
 * decision; their tables (platform_connections, comment_sync_states) and the `platform.apps` setting
 * are LEGACY and only kept until the next release (expand/contract).
 */
export const platformRoutes: FastifyPluginAsyncZod = async (app) => {
  /** The web's single source for platforms: every enabled social platform and the features that depend on one. */
  app.get('/api/platforms', { preHandler: app.authenticate }, async () => ({
    enabled: enabledPlatforms().map((p) => ({ id: p.id, name: p.name })),
    features: { trending: trendingAvailable(), youtubeKey: isPlatformEnabled('youtube'), trackedCollector: isPlatformEnabled('instagram') },
  }));
};
