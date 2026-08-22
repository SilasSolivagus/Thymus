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

## Writing constraints

Constraints are **data**, not code. After installing the plugin, what you edit is a declaration:

```ts
const specs: ConstraintSpec[] = [
  {
    name: 'no-internal-jargon',
    type: 'forbidden-phrases',
    phrases: ['portal', 'BAS', 'BOSS'],
    evals: {
      deny:    ['please sign in to the portal'],   // must be blocked
      allow:   ['your billing period is August'],  // must pass through untouched
      heldout: ['please sign in to the admin console'],  // human-written, unseen
    },
  },
  {
    name: 'service-tone',
    type: 'semantic-policy',
    policy: 'No dismissive, interrogating, or blame-shifting phrasing.',
    provider: 'deepseek-official', model: 'deepseek-chat',
    evals: { deny: ['that is impossible'], allow: ['your billing period is August'], heldout: ["that is not my problem"] },
  },
]

const constraints = compileConstraints(ctx, specs)

// Judge one sentence (evaluation, tests):
const { verdict } = await gateSay(ctx, textTheAgentWantsToSay, constraints)

// Or mount both gates on a live agent, before any untrusted code loads:
installToolGate(ctx, constraints)
installSayGate(ctx, constraints, 'Sorry — let me hand this to a human colleague.')
```

`installSayGate` wraps `ctx.llm.prepareCall`, buffers the whole stream, assembles it, and
judges the assembled text — text and reasoning on separate channels, judged separately.
A denied text block is replaced with the sentence you pass; a denied reasoning block is
dropped. **The turn is not stopped**: tool calls in the same message still run.
`ctx.llm.stream` is not a usable mount point — the agent loop calls `preparedCall.stream()`
and never touches it.

**Acceptance cases live next to the constraint.** That is deliberate. Without a held-out set there is no discrimination, and only a human can write one; split across two files, evaluation becomes "we'll add it later" and never arrives.

`checkSpecEvals()` runs each constraint against its own cases only, so attribution falls out for free — no separate ablation needed:

```
✓ no-internal-jargon (forbidden-phrases)  block 2/2 · pass 1/1 · held-out 0/1
    · held-out missed 1 — a literal phrase list always misses here; switch to semantic-policy to cover it
✓ service-tone (semantic-policy)  block 1/1 · pass 1/1 · held-out 1/1
```

Held-out results **do not count toward pass/fail** — a literal phrase list missing them is the type's capability boundary, not a mistake in the declaration. But the number is right there, and it is the evidence for whether you need semantic judging.

## Design rules

These were not designed up front. Each one came out of a run where we thought something was blocked and it was not.

1. **Constraints do not enter the dynamic registry.** Otherwise any dynamic plugin can unmount them — and even a failed version swap carries them away.
2. **A constraint must not be a peer of what it constrains.** `tools/pre-execute` short-circuits on the first verdict; `llm/stream` is a wrapper chain where the outermost wins. Opposite polarity, same conclusion: whoever acts last wins, and `prepend` is available to both sides.
3. **Aggregate verdicts; do not short-circuit.** Collect them all, then decide.
4. **Allowlist, not denylist.** Name-based deny has a demonstrated gap: register an equivalent tool under a new name and you are through.
5. **Do semantic judging in the gate, not in an `llm/stream` plugin.** Two semantic plugins mounted together recurse without bound.
6. **Route judging calls through `judgeText`**, never a bare `for await ctx.llm.stream`. On failure it does not throw — it emits an error `finish` and ends normally, so `try/catch` never fires.
7. **Separate the agent that writes constraints from the agent being constrained**, and do not give the latter dynamic-plugin tools. On the speech side this is load-bearing, not hygiene: `prepareCall` is reachable from the sandbox, and whoever wraps it last is on the outside.
8. **Mount the tool gate on the scheduler**, not on `ctx.tools.execute` — the agent loop never calls `execute`. Wrap `execute` too, for external callers.
9. **Judge reasoning separately from text.** Judging the two concatenated hands the judge two different kinds of writing glued together; judging text alone lets a banned phrase through in the thinking block.

## What it does not provide

**It does not tell you what is correct.** Mountable, measurable, attributable — those it gives. Whether a given version is *right* needs an outside signal: in practice, a human-written held-out set the model has not seen.

This is not a temporary gap. When the party setting the questions and the party being tested hold the same source material, the questions cannot discriminate.

## Compatibility

Developed and verified against dsh `0.1.0-rc.8`. Later versions unverified.

## License

MIT
