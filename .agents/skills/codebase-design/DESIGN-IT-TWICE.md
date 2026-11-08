# Compare Alternative Interfaces

Use when competing interface shapes could materially affect callers, maintenance, or integration. Keep the definitions in [SKILL.md](SKILL.md); consult [DEEPENING.md](DEEPENING.md) when dependency boundaries are part of the decision.

Frame the actual use cases, constraints, dependencies, and behavior that must remain stable. Explore meaningfully different approaches where alternatives exist, such as a simple common-case interface versus a configurable interface or a boundary that isolates transport. Avoid manufacturing variants just to meet a count.

For each viable approach, show:

- The interface and a representative caller.
- What complexity it hides and what callers must still know.
- Ownership, lifecycle, errors, and dependency behavior that affect the contract.
- Migration and verification implications.

Compare against the same use cases and recommend the approach with the best fit. Explain where it trades flexibility for simplicity or moves responsibility across a seam.

Independent design passes may help a complex decision when delegation is available and authorized. Direct comparison by one agent is also valid; there is no required agent count or method-count quota. Exploration does not authorize implementation beyond the user's request.
