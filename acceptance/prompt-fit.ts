import fs from 'node:fs';
import { argumentsFor, bytesHash, engineModule, fail, isMain, main, readJson, writeJson } from './primitives.ts';

type PhaseInput = { phase: string; documentText?: string; specSummary?: string;
  acceptanceCriteria?: string[]; testExcerpts?: string; testOutput?: string };
type PhaseFit = { promptBytes: number; estimatedPromptTokens: number; ceiling: number; fits: boolean };
type CriticRole = { roleId: string; requestedLimits: { maxPromptTokens: number } };

const QA_EXCERPT_BYTES = 8192, QA_LOG_BYTES = 2048;

// Worst-case critic prompts for the frozen spec/plan, with QA excerpts under the packing ceiling.
export async function measurePromptFit(root: string,
  { spec, tasks, criticPromptCeiling }: { spec: string; tasks: string; criticPromptCeiling: number }) {
  const { buildPhasePrompt, estimateCriticPromptTokens } = await engineModule('review/critic-prompt');
  const specText = fs.readFileSync(spec, 'utf8'), planText = fs.readFileSync(tasks, 'utf8');
  const criteria = [...specText.matchAll(/^\d+\. (AC-\d+:.*)$/gm)].map((match) => match[1]);
  if (!criteria.length) fail('no acceptance criteria in spec');
  const cases: Record<string, PhaseInput> = {
    spec: { phase: 'spec', documentText: specText },
    plan: { phase: 'plan', documentText: `${specText}\n\n${planText}` },
    qa: { phase: 'qa', specSummary: specText, acceptanceCriteria: criteria,
      testExcerpts: 'expect(page.getByRole("dialog")).toBeVisible();\n'.repeat(Math.ceil(QA_EXCERPT_BYTES / 52)).slice(0, QA_EXCERPT_BYTES),
      testOutput: 'ok 1 - case\n'.repeat(Math.ceil(QA_LOG_BYTES / 12)).slice(0, QA_LOG_BYTES) },
  };
  const phases: Record<string, PhaseFit> = {};
  for (const [name, input] of Object.entries(cases)) {
    const prompt = buildPhasePrompt({ rootDir: root, ...input });
    const tokens = estimateCriticPromptTokens(prompt);
    phases[name] = { promptBytes: Buffer.byteLength(prompt), estimatedPromptTokens: tokens,
      ceiling: criticPromptCeiling, fits: tokens <= criticPromptCeiling };
  }
  return { schemaVersion: '1.0.0', status: Object.values(phases).every((entry) => entry.fits) ? 'passed' : 'blocked',
    method: 'engine buildPhasePrompt + estimateCriticPromptTokens; QA excerpts sized under the 24 KB assembled-prompt packing ceiling',
    qaExcerptBytes: QA_EXCERPT_BYTES, specSha256: bytesHash(Buffer.from(specText)),
    tasksSha256: bytesHash(Buffer.from(planText)), phases,
    limitation: 'Author-role prompts (specifier, implementer) are not measured here' };
}

if (isMain(import.meta.url)) await main(async () => {
  const args = argumentsFor(process.argv.slice(2), ['--spec', '--tasks', '--role-definitions', '--output']);
  const roles = readJson(args['--role-definitions']);
  const critic: CriticRole | undefined = (roles as { roles: CriticRole[] }).roles.find((role) => role.roleId === 'critic-reviewer');
  if (!critic) fail('critic-reviewer role is not defined');
  const record = await measurePromptFit(fs.realpathSync(process.cwd()), { spec: args['--spec'],
    tasks: args['--tasks'], criticPromptCeiling: critic.requestedLimits.maxPromptTokens });
  writeJson(args['--output'], record);
  process.stdout.write(`${JSON.stringify(record.phases)}\n`);
});
