# API Traffic Report

A CLI that reads a JSONL HTTP request log and writes a single JSON report to
stdout: request counts per endpoint and per client, a count of malformed lines,
and the rate-limit violations it found.

## Running

Requires **Node.js >= 20.11** (developed on Node 22). `tsx` runs the TypeScript
sources directly, so there is no build step.

```bash
npm install
npm run analyze ./sample_input/requests.jsonl
```

That is the whole contract: `npm run analyze <path-to-jsonl>`, one JSON object on
stdout. Errors go to stderr with a non-zero exit code.

The supplied sample contains **no violations** under the shipped policy — six
requests in nine seconds is ~40/min, well inside the 100/min for `/v1/widgets`.
An empty `rate_limit_violations` there is the right answer, not a missing
feature. To see the same file flagged, tighten the policy:

```bash
npm run analyze ./sample_input/requests.jsonl -- --config ./config/strict-example.json
```

A larger sample is bundled for the integration test, with violations, malformed
lines and every status class in one report:

```bash
npm run analyze ./test/integration.jsonl > results.json
```

Development commands: `npm run verify` (lint, typecheck, tests), `npm test`
(169 tests), `npm run test:coverage` (100% of statements, branches, functions and
lines in `src/`, excluding the entry point).

> The repo has an `.npmrc` with `loglevel=silent`, because `npm run` otherwise
> prints its own `> pkg@1.0.0 analyze` banner to **stdout** and corrupts the
> report when it is piped.

## Design

### What it does, end to end

1. **Stream.** `readline` over a read stream yields one line at a time; nothing
   accumulates, so a 64 MB log is no different from a small one (500k records in
   ~1.5s). A leading byte-order mark is stripped and `CRLF` is handled.
2. **Parse and validate** each line on its own: the five required fields with
   their types, `status_code` an integer in 100–599, and `timestamp` a real
   instant. `Date.parse` alone accepts `"2024"` and `"Jan 15 2024"`, so the
   timestamp is matched against an RFC 3339 pattern first — a zone designator is
   mandatory — then range-checked. Unknown fields are ignored.
3. **Discard and count** anything invalid as `malformed_inputs` and move to the
   next line. Validation returns a reason rather than throwing, so one bad line
   never ends the run.
4. **Aggregate traffic** for the run as a whole, per endpoint and per client.
5. **Evaluate rate limits** for the same request against its account limiter and,
   if the endpoint has one configured, its endpoint limiter — then discard the
   record. Only the aggregates and the live windows stay in memory.
6. **Emit** one JSON report.

```
src/index.ts    entry point            src/policy.ts           config loading, validation, resolution
src/cli.ts      args, exit codes       src/rateLimiter.ts      rolling-window counter
src/analyze.ts  the streaming loop     src/violationTracker.ts applies policy, emits events
src/parser.ts   validation             src/report.ts           aggregation, report assembly
src/timestamps.ts RFC 3339 + UTC       src/types.ts            shared types
```

### The rate-limit rule, and why

**A rolling window per limiter.** For a limit of `N` requests over `W` seconds, a
client is violating whenever more than `N` of its requests fall inside
`(t - W, t]`. On each request the limiter evicts timestamps at or before `t - W`,
appends `t`, and compares the count with `N`.

- **Rolling, not fixed buckets.** Fixed per-minute counters let a client send `N`
  requests at 10:00:59 and `N` more at 10:01:00 — a `2N` burst no counter sees.
- **Two independent scopes.** One number cannot express both "no client may
  overwhelm the API" and "this endpoint is expensive". An account limit applies to
  every client; an endpoint limit applies only where configured. They are
  evaluated separately, so a request can breach either, both or neither. An
  endpoint with no configured limit is governed by the account limit alone.
- **Per-account overrides**, because real APIs sell higher quotas, and a policy
  that cannot say "this customer gets 10x" gets replaced by hard-coded exceptions.
- **A violation is an event, not a flag.** Crossing from `<= limit` to `> limit`
  opens one event; later requests while still over extend it and raise its peak;
  a request that finds the window back at or below the limit closes it, and
  crossing again opens a new one. A client 500 requests over for three minutes is
  one incident to investigate, not 500 rows.
- **429 and 5xx do not count** toward a limit. A 429 is the server's own
  rejection, so counting it would make a client look worse the harder the server
  pushed back; a 5xx is a failure the client should not be charged for. Both are
  still counted as traffic. (The brief lists 5xx as counting — this is a
  deliberate departure, and it is one predicate in `src/violationTracker.ts`.)
- **The window is exclusive at `t - W`**, so a request exactly `W` old has left.

The numbers are policy, not code. `config/rate-limits.json` ships:

```json
{
  "defaults": {
    "account": { "requests": 1000, "windowSeconds": 60 },
    "endpoints": {
      "/v1/widgets":  { "requests": 100, "windowSeconds": 60 },
      "/v1/payments": { "requests": 20,  "windowSeconds": 60 },
      "/v1/reports":  { "requests": 10,  "windowSeconds": 60 }
    }
  },
  "accounts": {
    "acct_enterprise": {
      "account": { "requests": 10000, "windowSeconds": 60 },
      "endpoints": { "/v1/payments": { "requests": 100, "windowSeconds": 60 } }
    }
  }
}
```

An `accounts` entry overrides the defaults key by key, so an account that
overrides one endpoint still gets the default account limit. These values are
illustrative — the kind of numbers a product owner sets. Any file can be supplied
with `--config <path>`; it is validated at startup, and a bad policy is a startup
error. `rateLimiter.ts` only ever sees a count and a window length.

### Output specification

One JSON object with four sections. Keys are sorted and violations are ordered by
start time, so two runs over the same input differ only in `meta.generated_at`.

**`meta`** — about the run and the input as a whole:

| Field | Meaning |
| --- | --- |
| `input_file` / `generated_at` | the path as given, and when the run happened (UTC) |
| `total_requests` / `valid_requests` / `malformed_inputs` | non-blank lines seen, of which parsed, of which discarded |
| `distinct_clients` / `distinct_endpoints` | cardinality among valid requests |
| `first_request_at` / `last_request_at` | time range covered, UTC; `null` if nothing was valid |

**`endpoints.<path>`** and **`clients.<id>`** — two breakdowns of the same valid requests:

| Field | Meaning |
| --- | --- |
| `request_count` | valid requests for that endpoint or client |
| `status_code_counts` | requests per class; all five of `1xx`–`5xx` always present, zeros included, so a consumer never distinguishes "none" from "key absent" |
| `rate_limited_count` | endpoints only: 429s it served, i.e. how often it turned a caller away — separate from `4xx` so it can be alerted on |
| `rate_limit_violation_count` | clients only: violation events for that client, both scopes |
| `clients["*"]` | reserved entry with the totals across all clients; sorts first |

**`rate_limit_violations[]`** — one entry per event:

| Field | Meaning |
| --- | --- |
| `client_id` / `scope` / `endpoint` | who, `account` or `endpoint`, and which path (endpoint scope only) |
| `started_at` / `ended_at` | when the limit was crossed, and when the window was next seen back under it; `null` if still over at end of input |
| `peak_request_count` | highest count reached in the window during the event |
| `limit` / `window_seconds` | the policy that was breached |

A client's error total is its `4xx` plus `5xx`; reporting a derived total
alongside its parts only invites the two to disagree. The count when a violation
*starts* is not reported either: each counted request adds exactly one, so it is
always `limit + 1`.

Output of the second command above — the supplied sample under the demo policy:

```json
{
  "meta": {
    "input_file": "./sample_input/requests.jsonl",
    "generated_at": "2026-01-15T09:31:00Z",
    "total_requests": 8,
    "valid_requests": 8,
    "malformed_inputs": 0,
    "distinct_clients": 2,
    "distinct_endpoints": 2,
    "first_request_at": "2024-01-15T10:00:00Z",
    "last_request_at": "2024-01-15T10:05:05Z"
  },
  "endpoints": {
    "/v1/reports": {
      "request_count": 2,
      "status_code_counts": {
        "1xx": 0,
        "2xx": 2,
        "3xx": 0,
        "4xx": 0,
        "5xx": 0
      },
      "rate_limited_count": 0
    },
    "/v1/widgets": {
      "request_count": 6,
      "status_code_counts": {
        "1xx": 0,
        "2xx": 6,
        "3xx": 0,
        "4xx": 0,
        "5xx": 0
      },
      "rate_limited_count": 0
    }
  },
  "clients": {
    "*": {
      "request_count": 8,
      "status_code_counts": {
        "1xx": 0,
        "2xx": 8,
        "3xx": 0,
        "4xx": 0,
        "5xx": 0
      },
      "rate_limit_violation_count": 1
    },
    "acct_1": {
      "request_count": 6,
      "status_code_counts": {
        "1xx": 0,
        "2xx": 6,
        "3xx": 0,
        "4xx": 0,
        "5xx": 0
      },
      "rate_limit_violation_count": 1
    },
    "acct_2": {
      "request_count": 2,
      "status_code_counts": {
        "1xx": 0,
        "2xx": 2,
        "3xx": 0,
        "4xx": 0,
        "5xx": 0
      },
      "rate_limit_violation_count": 0
    }
  },
  "rate_limit_violations": [
    {
      "client_id": "acct_1",
      "scope": "endpoint",
      "endpoint": "/v1/widgets",
      "started_at": "2024-01-15T10:00:08Z",
      "ended_at": null,
      "peak_request_count": 6,
      "limit": 5,
      "window_seconds": 60
    }
  ]
}
```

### Implementation decisions

- **Policy is configuration, not constants.** The limiter takes a count and a
  window; nothing in it knows about accounts, endpoints or the shipped numbers.
- **Amortized O(1) per request.** Each limiter holds its timestamps in a FIFO
  queue (an array plus a head index), so every timestamp is appended once and
  skipped once, with no scanning or re-filtering. The array is compacted when the
  consumed prefix dominates it, and limiters whose windows have fully drained are
  swept out periodically — never one with a violation in progress. Memory tracks
  live windows plus one entry per client and endpoint, not input size.
- **All five status classes everywhere.** A bare request total says little: 500
  requests to `/v1/payments` reads very differently if 200 were 5xx.
- **`generated_at` is injected**, not read from the clock inside the aggregator,
  so a report is reproducible and the tests can assert `meta` exactly.
- **Timestamps normalize to UTC on the way in**, so `+HH:MM` offsets and `Z`
  compare correctly and every output timestamp is UTC.
- **Tested at 100% of `src/`** (169 tests): units per module, the rolling window
  driven directly, the CLI both in-process and spawned, and an integration run
  over a ~1 MB log whose expected values were derived independently rather than
  snapshotted, plus invariants — endpoints and clients each sum back to
  `valid_requests` and to the totals, class by class.
- **Biome, jscpd and a coverage floor** run in `npm run verify`: formatting,
  nine lint rules plus a GritQL plugin (file and function length, cognitive
  complexity, arrow functions only, no unused code), 0% duplication, and a 95%
  coverage floor.

## Assumptions and product gaps

1. **Input is assumed to be approximately chronological.** The rolling windows
   are advanced by each record's timestamp, and the file is never sorted. Each
   window only evicts from its head, so a much older timestamp appended at the
   tail evicts nothing: the count then spans more than the window and can report a
   violation that never happened, stamped with the old timestamp. Traffic
   statistics are unaffected, since they do not depend on order.
   `test/analyze.test.ts` pins this behaviour rather than leaving it undefined. A
   production pipeline receiving genuinely out-of-order events would need a
   different approach (a bounded reordering buffer with watermarks, or windows
   computed per fixed time bucket).
2. **The input schema has no HTTP method.** This is a meaningful product gap:
   `GET /v1/widgets` and `POST /v1/widgets` are very different in cost and risk
   and usually deserve different limits. A production event schema should include
   the method, and rate-limit policy should be keyed on method + endpoint. The
   schema given for this exercise has no method field, so none was invented.
3. **Endpoints are matched as exact strings.** A real API would have
   parameterized paths (`/v1/widgets/{id}`); the log would need to carry a route
   template, or the analyzer would need a route-matching layer, before policy
   could be attached to path patterns.
4. **Rate-limit values are configuration**, normally owned by product/business
   policy. The values in `config/rate-limits.json` are illustrative.
5. **This tool analyzes observed traffic; it does not enforce anything.** It
   reports where limits *were* exceeded after the fact and rejects no requests.
   In particular, 429s in the input are treated as evidence that some other
   system was enforcing limits.
6. **Upstream producers are not trusted.** The logs come from third-party
   services owned by other teams, so every line is validated independently and a
   bad one is counted and skipped rather than aborting the run: one team shipping a
   malformed field must not cost the platform its whole report. That is also why
   `malformed_inputs` is reported rather than logged — a rising count is the signal
   that an upstream has drifted.
7. **`request_id` is assumed unique but is not checked.** Duplicate ids are not
   treated as malformed, since the exercise defines uniqueness as a property of
   the input rather than something to validate.

## What I would change with more time

- **Method-aware policy**: include the HTTP method in the event schema and key
  limits on method + endpoint (and route templates rather than exact paths).
- **Out-of-order tolerance**: a small reordering buffer with a watermark, and
  reporting on how much input arrived late.
- **Dynamic configuration**: load policy from the service that owns it rather
  than a file on disk, with schema versioning and hot reload.
- **Richer observability**: percentiles and per-window peak traffic, time-bucketed
  output for charting, error-rate breakdowns per endpoint, and structured logs on
  stderr behind a `--verbose` flag.
- **Continuous operation**: run the same aggregation over a live stream instead of
  a file, emitting violation events as they open and close.
- **Distributed state**: if traffic were sharded across workers, limiter state
  would have to be partitioned by client (consistent hashing) or shared, since
  per-worker windows undercount.
- **Stronger schema validation**: a declared schema with a version field, so
  unknown fields and schema drift are reported rather than silently ignored.

None of these are needed for this exercise; they are what would come next if it
became a real component.

## AI usage

> Anything in this repo other than this section of README (code, tests, configs etc and above sections) are written by AI and reviewed by me. I (Mehmet) only manually typed in this section of README.

I used Claude Code (Opus 5 / high). I first started having a chat what I want to build based on the specs you ave given. It created a plan which I rejected a few times and asked for changes. One example is that, it suggested having a generic rate limit that applies to any endpoint for an account. I asked for;
- Default rate limits per endpoint. These should be per account as well as global rate limits to prevent DDoS.
- Account specific overrides as it is a quite common scenario in real world.

Then I had it write the first version with unit tests and an integration test that consumes a real 1MB file. I've reviewed unit tests as well as the implementation.

Then I manually tested (`npm run analyze ./test/integration.jsonl > out.json`) and asked for changes in the output schema. Some examples are;
- The meta section. Some of the meta data was in main JSON body and some were missing.
- Showing stats per status code. It was showing how many requests per endpoint. But with status breakdown it is genuienly useless data.
- Asked it to add `rate_limited_count` separately for endpoint stats. Because we'll probably want to know how many times an endpoint throttles clients so that we can adjust our rate limits.

Finally I introduced `biome`, `jscpd` and `jest` (initially it used `node:test`) form long term maintainability. I find having some static analyzer rules in place to be much more effective than prompt engineering for making AI generate maintainable code. Some of my favourite rules are;
- Max lines per file/function.
- Max cognitive complexity.
- Enforcing arrow functions instead of `function` declerations.
- Detecting copy pasted code that can be refactored (that's where `jscpd`)
- Added minimum test coverage rules to make sure everything is tested properly.

Then I worked with Claude through the assumptions we made and what I would do differently sections.

Before wrapping up, I asked it to review the code one more time find any discrepancies between code, comments, tests and docs.

And, again, finally I wrote this section by myself manually.