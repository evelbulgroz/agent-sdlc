import { z } from 'zod';

export const EngineConfigSchema = z.strictObject({ selfRoot: z.string().min(1).optional() });
