import { isPayoutId } from '@stablerails/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadEnv } from '../src/env.js';
import { appRouter, createCallerFactory } from '../src/router.js';
import { buildServer } from '../src/server.js';

const env = loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' });

describe('env', () => {
  it('applies defaults and coerces PORT', () => {
    expect(loadEnv({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('fails fast on malformed values', () => {
    expect(() => loadEnv({ PORT: 'not-a-port' })).toThrow('environment validation failed');
    expect(() => loadEnv({ DATABASE_URL: 'not-a-url' })).toThrow(
      'environment validation failed',
    );
  });
});

describe('server', () => {
  const serverPromise = buildServer(env);

  beforeAll(async () => {
    await serverPromise;
  });

  afterAll(async () => {
    await (await serverPromise).close();
  });

  it('healthz responds 200 without touching dependencies', async () => {
    const app = await serverPromise;
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('serves tRPC over HTTP', async () => {
    const app = await serverPromise;
    const res = await app.inject({ method: 'GET', url: '/trpc/system.ping' });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.data).toEqual({ pong: true });
  });
});

describe('router (direct caller)', () => {
  const caller = createCallerFactory(appRouter)({ requestId: 'test' });

  it('system.info reports 6-decimal USDC and mints a valid payout id', async () => {
    const info = await caller.system.info();
    expect(info.usdcDecimals).toBe(6);
    expect(isPayoutId(info.samplePayoutId)).toBe(true);
  });
});
