# Specification Quality & Invariant Rubric

Perform rigorous, independent audit of the specification against repository standards.

### Protocol & Formatting Invariants (P1)
- **Evidence Grounding:** `file` must be copied verbatim from the spec's `## Touched surfaces` list; `evidence` must quote/paraphrase text literally in the document. Omit ungrounded findings.
- **Measurable Acceptance Criteria:** Every acceptance criterion MUST use `AC-NN: <observable outcome>. Given <precondition or input>. Then <observable result>.` with unique ids. Flag missing identifiers, missing Given/Then examples, ambiguous tokens (`TBD`, `unknown`, `unsure`, `??`), or duplicate `AC-NN` ids as P1. Vague intent without a worked example is a P1.
- **Section Separation (No Redundant AC Expansion):** `## Acceptance criteria` defines the primary numbered `AC-NN` outcomes, while `## Invariants and constraints` and `## Failure defenses` define domain invariants, boundary conditions, and error/edge-case defenses. Do NOT flag a P1 or demand new `AC-NN` entries merely because invariants, edge cases (such as `NaN`, `Infinity`, `null`, `-0`, or non-number inputs), or failure defenses are specified in `## Invariants and constraints` or `## Failure defenses` rather than duplicated as separate `AC-NN` lines.
- **Suppression Rules:** Suppress cosmetic, aesthetic, and stylistic wording opinions. Focus exclusively on technical soundness, invariant preservation, and defect prevention.
