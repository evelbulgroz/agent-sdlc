import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  argumentsFor, bytesHash, fail, isMain, main, writeJson,
} from './primitives.ts';

type Route = { id: string; provider: string; model: string; canonicalVendor: string;
  classification: string; enabled: boolean; metered: boolean; pricing?: { status?: string } };

const ROLE_PROFILES = ['agent-sdlc-default', 'critic-review'];

const machineLocalPath = () =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'model-usage', 'local-policy.json');

// Freezes what the governor resolves from bundled defaults plus the machine-local policy.
// The host adds no vendor or route configuration of its own.
export async function resolveGovernorRecord() {
  if (!process.env.MODEL_USAGE_PATH) fail('MODEL_USAGE_PATH is required');
  const root = fs.realpathSync(process.env.MODEL_USAGE_PATH);
  const { loadPolicy } = await import(pathToFileURL(path.join(root, 'dist/policy/policy.js')).href);
  const policy = loadPolicy();
  const failures: string[] = [];
  const routes = new Map<string, Route>(policy.routes.map((route: Route) => [route.id, route]));
  const profiles = Object.fromEntries(ROLE_PROFILES.map((name) => {
    const profile = policy.profiles[name];
    if (!profile) { failures.push(`missing profile: ${name}`); return [name, null]; }
    const effective = profile.routeIds.map((id: string) => routes.get(id)).filter((route: Route | undefined): route is Route => Boolean(route)).map((route: Route) => ({
      routeId: route.id, provider: route.provider, model: route.model, canonicalVendor: route.canonicalVendor,
      classification: route.classification, enabled: route.enabled, metered: route.metered,
      pricingStatus: route.pricing?.status ?? null,
    }));
    const live = effective.filter((route: { enabled: boolean; classification: string }) => route.enabled && route.classification !== 'test-only');
    if (!live.length) failures.push(`no enabled live route: ${name}`);
    for (const route of live) {
      if (route.pricingStatus !== 'known') failures.push(`unpriced route: ${name}/${route.routeId}`);
    }
    return [name, { consumer: profile.consumer, limits: profile.limits, routes: effective,
      liveRouteIds: live.map((route: { routeId: string }) => route.routeId) }];
  }));
  const local = machineLocalPath();
  return {
    schemaVersion: '1.0.0', status: failures.length ? 'blocked' : 'passed', failures,
    pricingVersion: policy.pricingVersion, instance: policy.instance,
    resolvedPolicySha256: bytesHash(Buffer.from(JSON.stringify(policy))),
    machineLocalPolicySha256: fs.existsSync(local) ? bytesHash(fs.readFileSync(local)) : null,
    profiles,
  };
}

if (isMain(import.meta.url)) await main(async () => {
  const args = argumentsFor(process.argv.slice(2), ['--output']);
  const record = await resolveGovernorRecord();
  writeJson(args['--output'], record);
  process.stdout.write(`${record.status}: ${record.failures.length} failure(s)\n${record.failures.join('\n')}\n`);
});
