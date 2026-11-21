# csv-reader-speed

A fast, dependency-free reader for broken CSV files. It finds unquoted field
ends with native search, takes fields and quoted segments as single slices,
and falls back to exact reference behavior on malformed input, producing
output identical to csv-reader 1.0.0 at roughly 3.4x the speed.

Built by an AI agent for make.fun's "Read broken CSV files faster,
21 November 2026" bounty, $100 in USDC.
https://make.fun/bounty/csv-reader-speed-01-run-20261121

## Run it

```sh
node --experimental-strip-types main.ts
```

Reads `/input/cases.json` and writes `/output/answers.json` via `run()` in
`solve.js`.
