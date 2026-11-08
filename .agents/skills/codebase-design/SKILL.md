---
name: codebase-design
description: Design or refactor module interfaces and boundaries using deep-module principles.
---

# Codebase Design

Aim for useful behavior behind an interface callers can understand, with related decisions and change concentrated in one place. Use the project's terminology; the vocabulary below supports reasoning without requiring renaming existing services, components, or APIs.

## Vocabulary

- **Module:** A unit with an interface and an implementation, from a function to a subsystem.
- **Interface:** What a caller must know: inputs, outputs, invariants, ordering, errors, configuration, and relevant performance characteristics.
- **Depth:** How much useful behavior the interface provides relative to the complexity callers must understand. Line counts are not a proxy.
- **Seam:** A point where behavior can be substituted or varied without changing its callers.
- **Adapter:** An implementation that satisfies a contract at a seam.
- **Leverage:** Capability callers obtain through a small, coherent interface.
- **Locality:** How closely related knowledge, changes, failures, and verification are concentrated.

## Assess a design

Start with representative callers and the actual change or testing difficulty. Keep dependencies, lifecycle, and failure behavior visible when they affect the contract.

Use the deletion test: if removing a wrapper simply removes complexity, it may be unnecessary; if callers must reproduce its logic, it may be doing useful work. A thin adapter can still earn its place through compatibility, isolation, or ownership.

Prefer cohesive interfaces over arbitrary method-count limits. Multiple justified views of a module can coexist. Introduce a substitution point when a concrete variation, testing need, lifecycle, or external boundary warrants it; the number of adapters alone does not decide its value.

Test observable behavior at an appropriate contract. Keep internal seams internal when callers do not need them. Separate computation from effects where this improves clarity, while preserving the effects the feature actually requires.

## Conditional references

- For consolidating a cluster and choosing dependency/test boundaries, read [DEEPENING.md](DEEPENING.md).
- When competing interface designs need comparison, read [DESIGN-IT-TWICE.md](DESIGN-IT-TWICE.md).

Present the proposed interface, a representative caller, trade-offs, and migration or verification implications. For an implementation request, continue through the authorized change and relevant verification; for a design request, deliver the design without expanding into implementation.

Adapted from [Matt Pocock's codebase-design](https://github.com/mattpocock/skills/blob/main/skills/engineering/codebase-design/SKILL.md) under the MIT license; see [LICENSE](LICENSE).
