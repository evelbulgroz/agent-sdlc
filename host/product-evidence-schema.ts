import { z } from 'zod';
import { IDENTIFIER_PATTERN } from '../policy/contracts/primitives.ts';
import { Capability, Layer, RelPath } from '../policy/contracts/quality-primitives.ts';

const IdSchema = z.string().regex(IDENTIFIER_PATTERN);
const PLACEHOLDER = /\{[^{}]*\}/g;
const KNOWN_PLACEHOLDERS = new Set(['{reportPath}', '{baseSha}']);

// Whole-token or `key=value` only. argv[0] is the executable and takes no placeholder.
const placeholdersValid = (argv: string[]): boolean => argv.every((token, index) => {
	const found = token.match(PLACEHOLDER) ?? [];
	if (found.length === 0) return true;
	if (index === 0 || found.length > 1 || !KNOWN_PLACEHOLDERS.has(found[0] as string)) return false;
	return token === found[0] || token.endsWith(`=${found[0]}`);
});

const hasReportPath = (argv: string[]): boolean => argv.some((token, index) =>
	index > 0 && (token === '{reportPath}' || token.endsWith('={reportPath}')));

const PinSchema = z.union([
	z.strictObject({ file: RelPath }),
	z.strictObject({ script: z.strictObject({ file: RelPath, name: z.string().min(1) }) }),
]);

const ProductCommandSchema = z.strictObject({
	argv: z.array(z.string().min(1)).min(1)
		.refine(placeholdersValid, { message: 'only {reportPath} or {baseSha} may appear, as a whole token or a key=value value, never in argv[0]' })
		.refine(hasReportPath, { message: 'argv must pass {reportPath} so the report is not read from stdout' }),
	cwd: RelPath,
	layer: Layer,
	pins: z.array(PinSchema).min(1),
	capabilities: z.array(Capability).optional(),
	timeoutMs: z.number().int().positive().optional(),
	format: z.enum(['junit', 'case-report']).optional(),
	retries: z.number().int().min(0).max(5).optional(),
});

export const ProductEvidenceSchema = z.strictObject({
	packageRoot: RelPath,
	commands: z.record(IdSchema, ProductCommandSchema),
}).superRefine((block, context) => {
	const ids = Object.keys(block.commands);
	if (ids.length === 0) {
		context.addIssue({ code: 'custom', path: ['commands'], message: 'at least one command is required' });
	}
	for (const [id, command] of Object.entries(block.commands)) {
		const root = block.packageRoot;
		if (!(command.cwd === root || command.cwd.startsWith(`${root}/`))) {
			context.addIssue({ code: 'custom', path: ['commands', id, 'cwd'], message: 'command cwd must lie inside packageRoot' });
		}
		const caps = new Set(command.capabilities ?? []);
		if (new Set(command.capabilities ?? []).size !== (command.capabilities ?? []).length) {
			context.addIssue({ code: 'custom', path: ['commands', id, 'capabilities'], message: 'capabilities must be unique' });
		}
		if (caps.has('static-check') && command.layer !== 'static') {
			context.addIssue({ code: 'custom', path: ['commands', id, 'layer'], message: 'static-check requires the static layer' });
		}
		if (command.layer === 'static' && !caps.has('static-check')) {
			context.addIssue({ code: 'custom', path: ['commands', id, 'capabilities'], message: 'static commands require static-check' });
		}
		if ([...caps].some((cap) => cap === 'native-browser' || cap === 'native-file-picker' || cap === 'focus-navigation') && command.layer !== 'browser') {
			context.addIssue({ code: 'custom', path: ['commands', id, 'layer'], message: 'native browser capabilities require the browser layer' });
		}
		if ((caps.has('native-file-picker') || caps.has('focus-navigation')) && !caps.has('native-browser')) {
			context.addIssue({ code: 'custom', path: ['commands', id, 'capabilities'], message: 'native-file-picker and focus-navigation require native-browser' });
		}
	}
});

export type ProductEvidenceConfig = z.infer<typeof ProductEvidenceSchema>;
export type ProductCommandConfig = ProductEvidenceConfig['commands'][string];

/** Repository-relative paths the block names, with the field each came from. */
export function productEvidenceContainmentPaths(config: ProductEvidenceConfig | undefined): [string, string][] {
	if (!config) return [];
	const paths: [string, string][] = [[config.packageRoot, 'productEvidence.packageRoot']];
	for (const [id, command] of Object.entries(config.commands)) {
		paths.push([command.cwd, `productEvidence.commands.${id}.cwd`]);
		for (const pin of command.pins) {
			const file = 'file' in pin ? pin.file : pin.script.file;
			paths.push([`${command.cwd}/${file}`, `productEvidence.commands.${id}.pins`]);
		}
	}
	return paths;
}
