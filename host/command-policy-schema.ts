import { z } from 'zod';

const ArgvSchema = z.array(z.string().min(1)).min(1);

const pnpmRunScript = (label: string) =>
	ArgvSchema.refine((argv) => argv[0] === 'pnpm' && argv[1] === 'run' && argv.length >= 3, {
		message: `${label} must start with 'pnpm', 'run'`,
	});

export const CommandPolicySchema = z.strictObject({
	allowedVerbs: z.array(z.string().min(1)).min(1).optional(),
	repositoryScripts: z.array(pnpmRunScript('repository scripts')).optional(),
	contractGateScripts: z.array(pnpmRunScript('contract gate scripts')).optional(),
});
