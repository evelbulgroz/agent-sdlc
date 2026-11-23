import '../testing/use-fixture-monorepo.mjs';
import { FIXTURE_MONOREPO_ROOT } from '../testing/fixture-monorepo-root.mjs';
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
import { addLearningBatch, loadLearningStore, searchLearningStore } from '../host/learnings.ts';

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
      assert.equal(resolveTargetScope(['services/billing/src/foo.ts']), 'billing');
      assert.equal(resolveTargetScope(['services/authentication/src/tokens.ts']), 'authentication');
    });

    it('maps package paths to their package scope', () => {
      assert.equal(resolveTargetScope(['packages/shared-base/src/aggregate.ts']), 'shared-base');
      assert.equal(resolveTargetScope(['packages/service-auth-core/src/auth.ts']), 'service-auth-core');
    });

    it('maps frontend and e2e paths to their scopes', () => {
      assert.equal(
        resolveTargetScope(['frontends/example-pwa-frontend/src/index.tsx']),
        'example-pwa-frontend'
      );
      assert.equal(resolveTargetScope(['e2e/product/smoke.spec.ts']), 'product-e2e');
    });

    it('maps raw scope names', () => {
      assert.equal(resolveTargetScope(['billing']), 'billing');
    });

    it('returns global for empty, cross-scope, or unknown paths', () => {
      assert.equal(resolveTargetScope([]), 'global');
      assert.equal(
        resolveTargetScope([
          'services/billing/src/foo.ts',
          'services/strength/src/bar.ts',
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
        { type: 'pitfall', scope: 'billing', key: 'k1', insight: 'i1' },
        { type: 'pattern', scope: 'billing', key: 'k2', insight: longInsight },
        { type: 'architecture', scope: 'billing', key: 'k3', insight: 'i3' },
        { type: 'preference', scope: 'billing', key: 'k4', insight: 'i4' },
      ];

      const formatted = formatScopeLearnings(items);
      assert.ok(formatted.startsWith('## Institutional Memory & Scope Pitfalls'));
      assert.ok(formatted.includes('- [pitfall] (billing) k1: i1'));
      assert.ok(formatted.includes(`- [pattern] (billing) k2: ${'X'.repeat(300)}`));
      assert.ok(formatted.includes('- [architecture] (billing) k3: i3'));
      // 4th item omitted
      assert.ok(!formatted.includes('k4'));
    });
  });

  describe('resolveScopeLearnings', () => {
    it('returns empty string immediately for deterministic profile or zero maxPromptTokens', async () => {
      const resDeterministic = await resolveScopeLearnings({
        modelProfile: 'agent-sdlc-deterministic',
        storePath: tmpStorePath,
        rootDir: FIXTURE_MONOREPO_ROOT,
      });
      assert.equal(resDeterministic, '');

      const resZeroTokens = await resolveScopeLearnings({
        requestedLimits: { maxPromptTokens: 0 },
        storePath: tmpStorePath,
        rootDir: FIXTURE_MONOREPO_ROOT,
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
          scope: 'billing',
          key: 'cond-arch-rule',
          query: 'service boundary workout plan',
          insight: 'Billing must not cross boundary to strength service directly.',
        },
        {
          type: 'pitfall',
          scope: 'billing',
          key: 'cond-pitfall-rule',
          query: 'race condition lock workout',
          insight: 'Billing workout increment requires optimistic lock.',
        },
        {
          type: 'operational',
          scope: 'billing',
          key: 'cond-ops-rule',
          query: 'deploy migrate database',
          insight: 'Deploy migrations before service start.',
        },
      ]);

      // Architect role: matches ['architecture', 'preference']
      const archRecall = await resolveScopeLearnings({
        targetPaths: ['services/billing/src/foo.ts'],
        roleId: 'architect',
        modelProfile: 'agent-sdlc-llm',
        storePath: tmpStorePath,
        rootDir: FIXTURE_MONOREPO_ROOT,
      });
      assert.ok(archRecall.includes('cond-arch-rule'));
      assert.ok(!archRecall.includes('cond-pitfall-rule'));
      assert.ok(!archRecall.includes('cond-ops-rule'));

      // Hardener role: matches ['pitfall', 'pattern']
      const hardenerRecall = await resolveScopeLearnings({
        targetPaths: ['services/billing/src/foo.ts'],
        roleId: 'hardener',
        modelProfile: 'agent-sdlc-llm',
        storePath: tmpStorePath,
        rootDir: FIXTURE_MONOREPO_ROOT,
      });
      assert.ok(!hardenerRecall.includes('cond-arch-rule'));
      assert.ok(hardenerRecall.includes('cond-pitfall-rule'));
    });

    it('merges candidate learnings into recall pool', async () => {
      const recall = await resolveScopeLearnings({
        targetPaths: ['services/billing/src/foo.ts'],
        roleId: 'implementer',
        modelProfile: 'agent-sdlc-llm',
        storePath: tmpStorePath,
        rootDir: FIXTURE_MONOREPO_ROOT,
        candidateLearnings: [
          {
            learning_type: 'pitfall',
            scope: 'billing',
            learning_key: 'cond-candidate-rule',
            query: 'candidate test',
            insight: 'Candidate learning from operator insight.',
          },
        ],
      });
      assert.ok(recall.includes('cond-candidate-rule'));
      assert.ok(recall.includes('Candidate learning from operator insight.'));
    });

    const unreviewed = {
      type: 'pitfall',
      scope: 'billing',
      key: 'unreviewed-pitfall',
      query: 'billing lock',
      insight: 'An unreviewed prompt stays out of role recall.',
      confidence: 9,
      source: 'user-stated',
    };
    const recallOptions = {
      targetPaths: ['services/billing/src/foo.ts'],
      roleKind: 'implementer',
      modelProfile: 'agent-sdlc-llm',
      storePath: null,
      rootDir: FIXTURE_MONOREPO_ROOT,
    };

    it('@ac AC-01 @case AC-01.1 user-stated pitfall is absent from implementer recall', async () => {
      await addLearningBatch(tmpStorePath, [unreviewed, { ...unreviewed, key: 'inferred-pitfall', source: 'inferred' }]);
      const recall = await resolveScopeLearnings({ ...recallOptions, storePath: tmpStorePath });
      assert.equal(recall.includes('unreviewed-pitfall'), false);
      assert.equal(recall.includes('inferred-pitfall'), true);
    });

    it('@ac AC-02 @case AC-02.1 search result contains the user-stated key', async () => {
      await addLearningBatch(tmpStorePath, [unreviewed]);
      const found = await searchLearningStore(await loadLearningStore(tmpStorePath), {
        query: 'billing lock',
        scope: 'billing',
        types: ['pitfall'],
        limit: 3,
      });
      assert.equal(found.some((item) => item.key === 'unreviewed-pitfall'), true);
    });

    it('@ac AC-03 @case AC-03.1 observed pitfall is present in implementer recall', async () => {
      await addLearningBatch(tmpStorePath, [unreviewed]);
      await addLearningBatch(tmpStorePath, [{ ...unreviewed, source: 'observed' }], { upsert: true });
      const recall = await resolveScopeLearnings({ ...recallOptions, storePath: tmpStorePath });
      assert.equal(recall.includes('unreviewed-pitfall'), true);
    });

    it('@ac AC-04 @case AC-04.1 default candidate key is present', async () => {
      const recall = await resolveScopeLearnings({
        ...recallOptions,
        storePath: tmpStorePath,
        candidateLearnings: [{
          learning_type: 'pitfall',
          scope: 'billing',
          learning_key: 'staged-pitfall',
          query: 'billing lock',
          insight: 'A staged proposal still injects.',
        }],
      });
      assert.equal(recall.includes('staged-pitfall'), true);
    });

    it('keeps a missing source, drops a low-confidence user-stated row, and ignores an unreviewed upsert', async () => {
      writeFileSync(tmpStorePath, `${JSON.stringify({
        type: 'pitfall', scope: 'billing', key: 'legacy-pitfall', query: 'billing lock',
        insight: 'A stored row with no source is recalled.', confidence: 9,
      })}\n`);
      const legacy = await resolveScopeLearnings({ ...recallOptions, storePath: tmpStorePath });
      assert.equal(legacy.includes('legacy-pitfall'), true);

      await addLearningBatch(tmpStorePath, [{ ...unreviewed, key: 'low-confidence-pitfall', confidence: 6 }]);
      const low = await resolveScopeLearnings({ ...recallOptions, storePath: tmpStorePath });
      assert.equal(low.includes('low-confidence-pitfall'), false);

      await addLearningBatch(tmpStorePath, [unreviewed], { upsert: true });
      const stillUnreviewed = await resolveScopeLearnings({ ...recallOptions, storePath: tmpStorePath });
      assert.equal(stillUnreviewed.includes('unreviewed-pitfall'), false);

      const emptyCandidates = await resolveScopeLearnings({
        ...recallOptions,
        storePath: join(tmpDir, 'empty-candidates.jsonl'),
        candidateLearnings: [],
      });
      assert.equal(emptyCandidates, '');
      const nilCandidates = await resolveScopeLearnings({
        ...recallOptions,
        storePath: join(tmpDir, 'nil-candidates.jsonl'),
        candidateLearnings: null,
      });
      assert.equal(nilCandidates, '');
      writeFileSync(join(tmpDir, 'broken.jsonl'), '{not-json\n');
      await assert.rejects(
        () => resolveScopeLearnings({ ...recallOptions, storePath: join(tmpDir, 'broken.jsonl') }),
        /Invalid JSON/,
      );
      const blocked = await resolveScopeLearnings({
        ...recallOptions,
        storePath: tmpStorePath,
        modelProfile: 'agent-sdlc-deterministic',
      });
      assert.equal(blocked, '');
    });
  });
});
