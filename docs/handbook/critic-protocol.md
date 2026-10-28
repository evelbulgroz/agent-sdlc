# Dynamic Heterogeneous Critic Review Protocol

## 1. Core Principle: Evidence Over Merge Trust

In `agent-sdlc`, LLM critic review provides **adversarial evidence**, not merge trust. Merge trust comes exclusively from deterministic unit tests, type checking, and host preflight verification.

---

## 2. Dedicated Critic Nodes in the State Graph

Critic reviews run on dedicated, isolated graph nodes rather than inline prompt steps:

| Review Phase | Execution Point | Primary Focus |
|---|---|---|
| `spec` | Before `SPEC_APPROVED` | Ambiguous requirements, missing failure defenses, boundary omissions. |
| `plan` | Before worktree creation | Task DAG ordering, dependency cycles, missing shadow paths. |
| `qa` | After preflight verification | Test-to-behavior linkage, missed edge cases, verification gaps. |
| `code` | Standalone CLI (`agent-review`) | Read-only pre-landing diff review (never invoked from a graph node). |

---

## 3. Vendor Heterogeneity Invariant (`excludedVendors`)

To eliminate self-reinforcing blind spots and model vendor bias:
- Every critic invocation specifies `excludedVendors: [authorVendor]`.
- The Model Usage Governor strictly enforces this filter; if no alternative vendor route is available, the critic step fails closed rather than allowing a model to review its own work.

---

## 4. Standalone Critic Review CLI

Interactive review can be run at any time via the standalone binary:

```bash
agent-review --phase <spec|plan|code|qa> --author-vendor <vendor> [--scope <path>]
```
