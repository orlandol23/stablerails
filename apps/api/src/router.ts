import { USDC_DECIMALS, newPayoutId } from '@stablerails/core';
import { initTRPC } from '@trpc/server';

export interface Context {
  requestId: string;
}

const t = initTRPC.context<Context>().create();

export const publicProcedure = t.procedure;

/**
 * Scaffold surface. `system.info` exercises the workspace dependency on
 * @stablerails/core (and pins the 6-decimals fact where every reviewer
 * will see it first); real routers land with the vertical slice.
 */
export const appRouter = t.router({
  system: t.router({
    ping: publicProcedure.query(() => ({ pong: true as const })),
    info: publicProcedure.query(() => ({
      name: 'stablerails-api',
      usdcDecimals: USDC_DECIMALS,
      samplePayoutId: newPayoutId(),
    })),
  }),
});

export type AppRouter = typeof appRouter;

export const createCallerFactory = t.createCallerFactory;
