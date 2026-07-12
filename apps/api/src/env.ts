import { z } from 'zod';

/**
 * Fail-fast, zod-validated environment (AI-DLH pattern). Everything the
 * process reads from `process.env` goes through this schema — no naked
 * `process.env.X` anywhere else. `.env.example` documents each variable
 * for operators and must be kept in sync.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  // Consumed from the vertical slice onward; defaults match docker-compose.
  DATABASE_URL: z.url().default('postgres://stablerails:stablerails@localhost:5432/stablerails'),
  REDIS_URL: z.url().default('redis://localhost:6379'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Logger does not exist yet at this point — stderr is correct here.
    console.error('Invalid environment:\n' + z.prettifyError(parsed.error));
    throw new Error('environment validation failed');
  }
  return parsed.data;
}
