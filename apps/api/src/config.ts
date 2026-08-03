import { z } from 'zod';
import { ValidationError } from '@iron-ridge/types';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  throw new ValidationError(`Invalid environment: ${parsed.error.message}`);
}

export const config = parsed.data;
