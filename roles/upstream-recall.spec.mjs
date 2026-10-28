import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveTargetScope,
  getRoleAffinityTypes,
  formatScopeLearnings,
  resolveScopeLearnings,
} from './upstream-recall.ts';
import { addLearningBatch } from '../host/learnings.ts';

describe('Upstream Recall & Scope Mapping', () => {
  let tmpDir;
  let tmpStorePath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sdlc-recall-test-'));
    tmpStorePath = join(tmpDir, '.learnings.jsonl');
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('resolveTargetScope', () => {
    it('maps service paths to their service scope', () => {
      assert.equal(resolveTargetScope(['apps/services/conditioning/src/foo.ts']), 'conditioning');
      assert.equal(resolveTargetScope(['apps/services/authentication/src/tokens.ts']), 'authentication');
    });

    it('maps package paths to their package scope', () => {
      assert.equal(resolveTargetScope(['packages/ddd-base/src/aggregate.ts']), 'ddd-base');
      assert.equal(resolveTargetScope(['packages/service-auth-core/src/auth.ts']), 'service-auth-core');
    });

    it('maps frontend and e2e paths to their scopes', () => {
      assert.equal(
        resolveTargetScope(['apps/frontends/example-pwa-frontend/src/index.tsx']),
        'example-pwa-frontend'
      );
      assert.equal(resolveTargetScope(['apps/e2e/product/smoke.spec.ts']), 'product-e2e');
    });

    it('maps raw scope names', () => {
      assert.equal(resolveTargetScope(['conditioning']), 'conditioning');
    });

    it('returns global for empty, cross-scope, or unknown paths', () => {
      assert.equal(resolveTargetScope([]), 'global');
      assert.equal(
        resolveTargetScope([
          'apps/services/conditioning/src/foo.ts',
          'apps/services/strength/src/bar.ts',
        ]),
        'global'
      );
      assert.equal(resolveTargetScope(['random/unknown/path.txt']), 'global');
    });
  });

  describe('getRoleAffinityTypes', () => {
    it('returns correct knowledge types per role', () => {
      assert.deepEqual(getRoleAffinityTypes('architect'), ['architecture', 'preference']);
      assert.deepEqual(getRoleAffinityTypes('hardener'), ['pitfall', 'pattern']);
      assert.deepEqual(getRoleAffinityTypes('implementer'), ['pitfall', 'pattern', 'architecture']);
      assert.deepEqual(getRoleAffinityTypes('repairer'), ['pitfall', 'pattern', 'architecture']);
      assert.deepEqual(getRoleAffinityTypes('specifier'), ['architecture', 'operational']);
      assert.deepEqual(getRoleAffinityTypes('unknown-role'), ['pitfall', 'pattern']);
    });
  });

  describe('formatScopeLearnings', () => {
    it('returns empty string for empty learnings', () => {
      assert.equal(formatScopeLearnings([]), '');
      assert.equal(formatScopeLearnings(null), '');
    });

    it('formats learnings up to 3 entries and caps insight length at 300 chars', () => {
      const longInsight = 'X'.repeat(350);
      const items = [
        { type: 'pitfall', scope: 'conditioning', key: 'k1', insight: 'i1' },
        { type: 'pattern', scope: 'conditioning', key: 'k2', insight: longInsight },
        { type: 'architecture', scope: 'conditioning', key: 'k3', insight: 'i3' },
        { type: 'preference', scope: 'conditioning', key: 'k4', insight: 'i4' },
      ];

      const formatted = formatScopeLearnings(items);
      assert.ok(formatted.startsWith('## Institutional Memory & Scope Pitfalls'));
      assert.ok(formatted.includes('- [pitfall] (conditioning) k1: i1'));
      assert.ok(formatted.includes(`- [pattern] (conditioning) k2: ${'X'.repeat(300)}`));
      assert.ok(formatted.includes('- [architecture] (conditioning) k3: i3'));
      // 4th item omitted
      assert.ok(!formatted.includes('k4'));
    });
  });

  describe('resolveScopeLearnings', () => {
    it('returns empty string immediately for deterministic profile or zero maxPromptTokens', async () => {
      const resDeterministic = await resolveScopeLearnings({
        modelProfile: 'agent-sdlc-deterministic',
        storePath: tmpStorePath,
      });
      assert.equal(resDeterministic, '');

      const resZeroTokens = await resolveScopeLearnings({
        requestedLimits: { maxPromptTokens: 0 },
        storePath: tmpStorePath,
      });
      assert.equal(resZeroTokens, '');
    });

    it('returns empty string when store file does not exist', async () => {
      const res = await resolveScopeLearnings({
        modelProfile: 'agent-sdlc-llm',
        storePath: join(tmpDir, 'nonexistent.jsonl'),
      });
      assert.equal(res, '');
    });

    it('recalls and filters learnings based on role affinity and scope', async () => {
      await addLearningBatch(tmpStorePath, [
        {
          type: 'architecture',
          scope: 'conditioning',
          key: 'cond-arch-rule',
          query: 'service boundary workout plan',
          insight: 'Conditioning must not cross boundary to strength service directly.',
        },
        {
          type: 'pitfall',
          scope: 'conditioning',
          key: 'cond-pitfall-rule',
          query: 'race condition lock workout',
          insight: 'Conditioning workout increment requires optimistic lock.',
        },
        {
          type: 'operational',
          scope: 'conditioning',
          key: 'cond-ops-rule',
          query: 'deploy migrate database',
          insight: 'Deploy migrations before service start.',
        },
      ]);

      // Architect role: matches ['architecture', 'preference']
      const archRecall = await resolveScopeLearnings({
        targetPaths: ['apps/services/conditioning/src/foo.ts'],
        roleId: 'architect',
        modelProfile: 'agent-sdlc-llm',
        storePath: tmpStorePath,
      });
      assert.ok(archRecall.includes('cond-arch-rule'));
      assert.ok(!archRecall.includes('cond-pitfall-rule'));
      assert.ok(!archRecall.includes('cond-ops-rule'));

      // Hardener role: matches ['pitfall', 'pattern']
      const hardenerRecall = await resolveScopeLearnings({
        targetPaths: ['apps/services/conditioning/src/foo.ts'],
        roleId: 'hardener',
        modelProfile: 'agent-sdlc-llm',
        storePath: tmpStorePath,
      });
      assert.ok(!hardenerRecall.includes('cond-arch-rule'));
      assert.ok(hardenerRecall.includes('cond-pitfall-rule'));
    });

    it('merges candidate learnings into recall pool', async () => {
      const recall = await resolveScopeLearnings({
        targetPaths: ['apps/services/conditioning/src/foo.ts'],
        roleId: 'implementer',
        modelProfile: 'agent-sdlc-llm',
        storePath: tmpStorePath,
        candidateLearnings: [
          {
            learning_type: 'pitfall',
            scope: 'conditioning',
            learning_key: 'cond-candidate-rule',
            query: 'candidate test',
            insight: 'Candidate learning from operator insight.',
          },
        ],
      });
      assert.ok(recall.includes('cond-candidate-rule'));
      assert.ok(recall.includes('Candidate learning from operator insight.'));
    });
  });
});
