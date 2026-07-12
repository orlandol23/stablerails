import { fastifyTRPCPlugin, type FastifyTRPCPluginOptions } from '@trpc/server/adapters/fastify';
import Fastify, { type FastifyInstance } from 'fastify';

import type { Env } from './env.js';
import { appRouter, type AppRouter, type Context } from './router.js';

export async function buildServer(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Never log secrets, even by accident (threat model T-hygiene).
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  // Liveness: process is up. Always 200, no dependencies consulted.
  app.get('/healthz', async () => ({ status: 'ok' }));

  // Readiness: will check Postgres/Redis once they are wired in
  // (vertical slice); for the scaffold it mirrors liveness.
  app.get('/readyz', async () => ({ status: 'ok' }));

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: async ({ req }): Promise<Context> => ({ requestId: req.id }),
      onError: ({ path, error }) => {
        app.log.error({ path, err: error }, 'tRPC error');
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>['trpcOptions'],
  });

  return app;
}
