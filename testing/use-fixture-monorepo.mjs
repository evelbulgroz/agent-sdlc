// Import first in a spec: pins the engine's repository root to the neutral fixture monorepo.
import { FIXTURE_MONOREPO_ROOT } from './fixture-monorepo-root.mjs';

process.env.AGENT_SDLC_REPO_ROOT = FIXTURE_MONOREPO_ROOT;
