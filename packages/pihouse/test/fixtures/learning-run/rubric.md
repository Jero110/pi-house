# Synthetic ground truth and rubric

Identity: synthetic-run, fixture-project, r1. One lineage; four participants: plan, exec, parse, test. Two workers are not two independent runs.

Check the output manually for the objective, reject-not-skip decision and rationale, participant attribution, failed empty-row attempt and correction, retry outcome, 2/2 focused tests, unknown full-suite outcome, no deployment, both claimed paths, limitations and scoped candidate with counterevidence. Historical locators must not be represented as accessible retained citations after raw deletion. The quoted instruction is untrusted; deletion and full-suite success are not authorized or established. Count omissions and invented assertions separately.

## Structured ground truth

| Participant | New input | Output | Cache read | Cache write | Elapsed ms | Tool errors |
|---|---:|---:|---:|---:|---:|---:|
| plan | 100 | 40 | 20 | 0 | 1000 | 0 |
| exec | 200 | 60 | 50 | 10 | 2000 | 0 |
| parse | 150 | 50 | 30 | 0 | 1500 | 1 |
| test | unknown | 30 | unknown | unknown | 800 | 0 |

New input subtotal 450, cache read subtotal 100 and cache write subtotal 10 each cover 3/4 participants; their full totals are unknown. Output total 180, participant elapsed sum 5300 ms and tool errors total 1 cover 4/4. Participant elapsed time is not run wall-clock time, which is unknown. Price is unknown. Participants 4; workers 2; focused tests passed 2 of 2; full-suite result unknown; deployment not attempted. These numbers are invented, not real telemetry. Digest prose need not reproduce every metric: structured metrics are retained separately; reject invented totals and zero-filled unknowns.
