# Skills

pihouse's skills, in four groups. `catalog.json` is the source of this page (`npm run skills` rewrites it); the
planner reads the same file to offer the development skills. Third-party skills keep their licenses: see
[LICENSES](LICENSES/README.md).

## Pre-build

Used by the planner to understand the work, explore the idea and write the plan.

| Skill | Author | What it does |
| --- | --- | --- |
| [`planner`](pre-build/planner/SKILL.md) | pihouse | Leads the user from an idea to a validated plan and hands it to the executor. |
| [`grilling`](pre-build/grilling/SKILL.md) | Matt Pocock | The grill-me step: interviews the user one decision at a time to stress-test the idea. |

## Build

Guide the executor and its agents while they implement the plan. The planner offers the development skills; only those the user picks reach the plan.

| Skill | Author | What it does |
| --- | --- | --- |
| [`executor`](build/executor/SKILL.md) | pihouse | Runs a validated plan end to end with agent-link agents, without asking the user. |
| [`test-driven-development`](build/test-driven-development/SKILL.md) | Addy | Write a failing test, make the smallest change that passes, verify. |
| [`spec-driven-development`](build/spec-driven-development/SKILL.md) | Addy | Define expected behavior and acceptance criteria before implementing. |
| [`source-driven-development`](build/source-driven-development/SKILL.md) | Addy | Research the code, docs and sources first and ground decisions in them. |
| [`security-and-hardening`](build/security-and-hardening/SKILL.md) | Addy | Review threats, validation, permissions and safe data handling. |
| [`performance-optimization`](build/performance-optimization/SKILL.md) | Addy | Measure and improve the performance problems that matter. |
| [`doubt-driven-development`](build/doubt-driven-development/SKILL.md) | Addy | Put assumptions and decisions to an adversarial check with evidence. |
| [`constraint-driven-development`](build/constraint-driven-development/SKILL.md) | Addy | Turn constraints into concrete, checked quality criteria. |
| [`documentation-and-adrs`](build/documentation-and-adrs/SKILL.md) | Addy | Update docs or record decisions as ADRs when it applies. |
| [`observability-and-instrumentation`](build/observability-and-instrumentation/SKILL.md) | Addy | Add the logs, metrics and traces that explain behavior and diagnose failures. |
| [`incremental-implementation`](build/incremental-implementation/SKILL.md) | Addy | Split large work into thin, verifiable increments. |
| [`git-workflow-and-versioning`](build/git-workflow-and-versioning/SKILL.md) | Addy | Follow Git and versioning practices. |
| [`ci-cd-and-automation`](build/ci-cd-and-automation/SKILL.md) | Addy | Change pipelines, checks or automation. |

## Post-build (manual)

The user invokes these after the implementation is done. They never run on their own.

| Skill | Author | What it does |
| --- | --- | --- |
| [`shipping-and-launch`](post-build/shipping-and-launch/SKILL.md) | Addy | Prepare a production launch: checklist, rollout, monitoring and rollback. |
| [`handoff`](post-build/handoff/SKILL.md) | Matt Pocock | Write a handoff document so another agent or session can continue the work. |

## Extras (manual)

Useful skills the user invokes by hand when needed. They never run on their own.

| Skill | Author | What it does |
| --- | --- | --- |
| [`api-and-interface-design`](extras/api-and-interface-design/SKILL.md) | Addy | Design clear API contracts and interfaces. |
| [`browser-testing-with-devtools`](extras/browser-testing-with-devtools/SKILL.md) | Addy | Test browser flows with developer tools. |
| [`code-review-and-quality`](extras/code-review-and-quality/SKILL.md) | Addy | Review changes for defects, risks and maintainability. |
| [`debugging-and-error-recovery`](extras/debugging-and-error-recovery/SKILL.md) | Addy | Find the root cause of failures and improve recovery. |
| [`code-simplification`](extras/code-simplification/SKILL.md) | Addy | Reduce complexity without changing behavior. |
| [`impeccable`](extras/impeccable/SKILL.md) | Paul Bakaus | Improve frontend design and visual quality: critique, polish, typography, layout, motion. |

