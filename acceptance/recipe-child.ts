import fs from 'node:fs';
import { fail, isMain, main } from './primitives.ts';
import { RemoteExperimentLedger } from './experiment-broker.ts';
import { executeFrozenRecipe } from './supervisor-recipes.ts';

// Child entry for the command bridge: forwards a frozen recipe request to the parent broker when one is
// attached, otherwise runs the frozen recipe directly. Input arrives as JSON on stdin from the trusted parent.
if (isMain(import.meta.url)) await main(async () => {
  const [command, ...argv] = process.argv.slice(2);
  if (command !== '_recipe') fail('expected _recipe');
  if (argv.length) fail('unexpected recipe arguments');
  const bytes = fs.readFileSync(0);
  if (bytes.length > 65536) fail('oversized bridge request');
  const request = JSON.parse(bytes.toString('utf8'));
  const env = process.env;
  const result = env.AGENT_SDLC_CANARY_BROKER_SOCKET
    ? await new RemoteExperimentLedger({ socketName: env.AGENT_SDLC_CANARY_BROKER_SOCKET,
      token: env.AGENT_SDLC_CANARY_BROKER_TOKEN, scenario: env.AGENT_SDLC_CANARY_SCENARIO })
      .recipe({ runId: request.runId, argv: request.argv, worktree: request.root, timeoutMs: request.timeoutMs },
        request.timeoutMs)
    : await executeFrozenRecipe(request.root, request.config, request.recipe, request.timeoutMs);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code ?? 1;
});
