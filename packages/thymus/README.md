# Thymus

English | [中文](README.zh.md)

A **constraint governance** layer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agents.

What it governs is **other plugins** — including the ones an agent writes and mounts at runtime. The agent's self-authoring ability is untouched; what changes is that those actions now happen underneath something that can stop them, measure them, and attribute them.

## Why

dsh deliberately does not decide at this layer. From the `cordis-host-runner` README:

> The vm sandbox isolates globals but is not a security boundary… Treat a dynamic package like bash access.

That is its stated trust stance. Thymus does not change it; it adds an **optional** governance and acceptance layer on top.

For coding-shaped work this layer is usually unnecessary — running the thing tells you whether it is right, and the tests are the oracle. It is needed where **no such oracle exists**: was that the right thing to say to a customer, should this action have been taken, may this content leave the building. The shared shape is: irreversible, rules arrive as human-readable documents, and correctness is a human judgement.

## Two halves

**Decision gate (`gate`)** — constraints stay out of the dynamic registry and adjudicate from outside the call chain. Any deny wins, independent of registration order; a constraint that throws, times out, or returns a malformed verdict counts as deny.

**Eval framework (`eval-framework`)** — replays a spec's frozen cases against candidate plugins in isolated contexts, and gradient-checks the eval set itself before it is frozen.

Governance is the pitch; evaluation is its acceptance test. Governance alone degrades into another rule-writing framework; evaluation alone has no teeth.

## Design rules

These were not designed up front. Each one came out of a run where we thought something was blocked and it was not.

1. **Constraints do not enter the dynamic registry.** Otherwise any dynamic plugin can unmount them — and even a failed version swap carries them away.
2. **A constraint must not be a peer of what it constrains.** `tools/pre-execute` short-circuits on the first verdict; `llm/stream` is a wrapper chain where the outermost wins. Opposite polarity, same conclusion: whoever acts last wins, and `prepend` is available to both sides.
3. **Aggregate verdicts; do not short-circuit.** Collect them all, then decide.
4. **Allowlist, not denylist.** Name-based deny has a demonstrated gap: register an equivalent tool under a new name and you are through.
5. **Do semantic judging in the gate, not in an `llm/stream` plugin.** Two semantic plugins mounted together recurse without bound.
6. **Route judging calls through `judgeText`**, never a bare `for await ctx.llm.stream`. On failure it does not throw — it emits an error `finish` and ends normally, so `try/catch` never fires.
7. **Separate the agent that writes constraints from the agent being constrained**, and do not give the latter dynamic-plugin tools.

## What it does not provide

**It does not tell you what is correct.** Mountable, measurable, attributable — those it gives. Whether a given version is *right* needs an outside signal: in practice, a human-written held-out set the model has not seen.

This is not a temporary gap. When the party setting the questions and the party being tested hold the same source material, the questions cannot discriminate.

## Compatibility

Developed and verified against dsh `0.1.0-rc.8`. Later versions unverified.

## License

MIT
