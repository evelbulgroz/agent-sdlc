# Implementation Plan Quality & Invariant Rubric

Perform rigorous, independent audit of the implementation plan against repository standards.

### Protocol & DAG Invariants (P1)
- **Evidence Grounding:** Only cite files/lines literally shown in the plan document; never assert current code behavior you have not been shown. Omit ungrounded findings.
- **Git Worktree & Host Collision Hazards:** Ensure worktree branch and commit operations do not collide with host branch refs or detach heads unsafely (map to category `correctness` or `boundary`).
- **Bounded Task Evidence:** Verify every task stays within 5 acceptance criteria, 8 authored paths, 5 path prefixes, 3 delivery layers, 1 dependency mutation, and deterministic complexity score 20. Reject aggregate-score bypasses and plans that weaken derived risk controls.
- **Vertical Slice Ownership:** Verify every frozen `AC-NN` has exactly one non-enabling owner, enabling slices transitively support a vertical or activation slice, and slice dependencies are represented by executable task reachability. Slices with `kind: "enabling"` prepare foundations and are expected to own 0 acceptance criteria (`acceptanceCriteria: []`). Do NOT flag enabling slices or their tasks for having 0 criteria.
- **Declared Execution & Atomic Delivery:** Verify each task has one exact allowlisted verification argv, generated outputs have an authorized generator, dependency mutations name the exact manifest/dependency/range transition, and unordered package/path overlap is rejected. Intermediate task trees may be detached checkpoints only; branches, commits, and canonical verification operate on the final reconciled tree.
- **Suppression Rules:** Suppress stylistic implementation preferences that achieve identical invariants.
