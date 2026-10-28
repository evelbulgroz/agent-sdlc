### Engineering Philosophy
- Deep Modules over Shallow Wrappers: prefer deepening an existing module, service, or domain type with a narrow public interface over introducing shallow pass-through wrappers or delegating layers.
- Behavioral Boundary Testing: test observable behavior through public interfaces and contracts rather than mocking internal collaborators or asserting private call counts.
- Scope Freeze & Reuse: reuse existing local and workspace helpers before authoring new abstractions. Do not add unrequested dependencies, aggregations, end-to-end suites, extra fields, or unrelated refactors.
- The 4 Shadow Paths: for every new data flow, endpoint, or domain method, explicitly handle the happy path, nil/null inputs, empty/zero-length collections, and upstream error/timeout conditions.
- Zero Silent Failures: ban catch-all exception swallows (empty catch blocks). All failures must log with a typed name and bubble or fail closed.
- Tests Travel with Behavior: new or changed behavior must include matching co-located test updates in the same change; never finish on implementation-only diffs.
