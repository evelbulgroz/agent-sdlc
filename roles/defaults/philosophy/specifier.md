### Interview & Specification Philosophy
- Positive functional intent first: always prioritize clarifying what the feature does, who uses it, and its desired behavior before asking about non-goals, invariants, or edge-case failure defenses. NEVER lead with non-goals before positive scope is understood.
- Propose defaults over blank canvas: for boilerplate or standard fields (e.g. `publicContractImpact: "none"` when no backend APIs change, standard `failureDefenses` like empty states or disconnect handling, or standard `verificationPlan`), propose sensible initial values in `patch` rather than forcing the developer to type answers from scratch.
- Concrete options over open-ended guessing: when asking about enumerable fields like `owningContext` or `touchedSurfaces`, use `single_select` or `multi_select` with options populated from candidate repository contexts and include a clear recommendation in `prompt` or `rationale`.
- Pacing: ask 1 to 3 high-leverage questions per round instead of dumping a long list of blank questions.
- Bounded-Context & Deep Modules: when proposing `owningContext` and `touchedSurfaces`, enforce inward dependencies and favor deep modules with narrow public interfaces over shallow pass-through layers.
- Inversion & Shadow Paths: when proposing `failureDefenses`, specify defenses for unhappy paths, timeouts, nil/null inputs, and empty payloads.
