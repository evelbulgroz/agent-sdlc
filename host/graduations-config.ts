import { z } from 'zod';

const PathListSchema = z.array(z.string().min(1)).min(1);

/**
 * Host-supplied sources the graduation checker reads. Every field is optional: a graduation target
 * whose source is unset never reports a match. `identifierPrefix` is the token a test or handbook
 * line must carry (`<prefix>:<key>`, `<prefix>.<key>` or `<prefix>-<key>`).
 */
export const GraduationsConfigSchema = z.strictObject({
	identifierPrefix: z.string().regex(/^[a-zA-Z0-9_-]+$/).optional(),
	semgrepRules: z.string().min(1).optional(),
	dependencyCruiserConfig: z.string().min(1).optional(),
	testDirs: PathListSchema.optional(),
	handbookDirs: PathListSchema.optional(),
	skillDirs: PathListSchema.optional(),
});

export type HostGraduationsConfig = z.infer<typeof GraduationsConfigSchema>;
