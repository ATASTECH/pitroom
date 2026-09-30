---
name: pitroom-research
description: Use when you need to find, map or explain code - where something is defined or called, how a flow works end to end, which files a change would touch, what a large module does - and the answer is much smaller than what must be read. Runs a read-only Pitroom worker and returns its answer with verified file references.
---

# Research with a Pitroom worker

A read-only worker explores the codebase and returns a compact answer. It cannot edit files, run arbitrary commands or reach the web, so you can delegate freely.

## Run

```bash
pitroom run "Where are HTTP 401 responses produced? List each call site with file:line and the condition that triggers it."
pitroom run -f docs/spec.md "Which parts of the spec are not implemented in src/billing/? file:line for each."
pitroom run --web "How do we use the Stripe webhook API, and what does the current Stripe doc recommend for retries?"
```

`--web` only when the answer needs the internet. For a question that will take minutes, start it with `--bg`, keep working, and collect it with `pitroom wait <run>`.

## Write a good brief

The worker starts cold. Give it:
- **The question**, phrased so the answer is a list or a map, not an essay.
- **Where to look** (paths, symbols, keywords) when you know it.
- **What to return**: "file:line for each", "a call graph", "the three most likely causes, ranked".
- **Scope limits**: "only src/api", "ignore tests".

## Use the answer

- `── refs: 12/12 verified` means every `path:line` in the answer was checked on disk (file exists, line in range, the named symbol is nearby). Rely on verified references without re-opening the files; distrust claims tied to `bad:` ones.
- Open only the few files you actually need to act on.
- Follow up in the same worker session instead of starting over: `pitroom run --continue <run> "Now show where the token is refreshed."`
- Report the finding to the user in your own words; do not paste the whole report.

If the worker fails or times out, do the research yourself or retry once with a narrower question.
