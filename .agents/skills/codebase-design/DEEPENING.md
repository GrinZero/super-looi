# Deepening a Module Cluster

Use this reference when consolidating related behavior behind a more useful interface. Vocabulary: [SKILL.md](SKILL.md).

Start from actual caller complexity or scattered change, not a target number of modules. Check ownership, lifecycle, deployment, and failure boundaries before deciding that closely related code should merge.

## Dependencies and evidence

- **In-process computation or state:** Consolidation can improve locality when responsibilities belong together. Keep focused tests for independent algorithmic invariants where they remain useful.
- **Local I/O or databases:** Prefer representative disposable dependencies when their real semantics matter. A lightweight stand-in may help fast tests, but document material differences and verify the production contract separately when needed.
- **Remote services you own:** Keep the network boundary's timeout, partial failure, and versioning behavior explicit. A port or adapter can isolate transport; integration checks still need to cover the wire contract.
- **External services:** Isolate cost, nondeterminism, and consequential effects with an appropriate test double or sandbox. Match observed or documented contracts, including failure and duplicate-effect behavior relevant to the task.

Choose a seam for a concrete substitution, ownership, lifecycle, or testing need. Multiple adapters are evidence of variation, not a mandatory count. Keep internal test seams out of the caller-facing interface unless callers need them.

## Migrate verification

Trace existing tests to the behavior they protect. Add or adapt coverage at the new interface, demonstrate that it exercises the relevant outcomes, and retain unique lower-level coverage. Remove an old test only when its behavior is obsolete or genuinely covered elsewhere; consolidation alone does not justify deleting it.

Review representative callers, migration compatibility, and relevant failure paths. Verify the resulting behavior, not just that the reorganized code imports or compiles.
