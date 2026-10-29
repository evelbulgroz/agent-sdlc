# Host Workflow Configurations

The `.agents/workflows/` directory contains host-level workflow addenda (`prompts/`). Path-scoped rule files are optional and declared through `prompts.pathScopedRules` in `.agents/sdlc-host.json`; this repository declares none.

This directory is optional for new clients, as the orchestration engine provides built-in defaults.

For canonical documentation on role definitions and prompt layers:
- [`roles/README.md`](../../roles/README.md)
- [`prompts/README.md`](../../prompts/README.md)
