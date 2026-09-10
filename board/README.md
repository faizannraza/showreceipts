# The showreceipts board

A static page that lists false-done rates: how often a model, in a given
harness and version, ended a turn claiming done while its own tool log said
otherwise. Every number is aggregates only, submitted by the person who ran it,
and reviewed by a human before it publishes.

The board is not a survey and not a ranking of models in the abstract. It is a
convenience sample of self-selected submissions, grouped by model, harness and
harness version together, because the same model contradicts itself at
different rates under different harnesses and releases.

## What the page shows

`index.html` is a single self-contained file (inline CSS and JS, no build step,
no external requests). GitHub Pages serves it from `/board`. At runtime it
fetches `data/rows.json` and renders one table row per model x harness x version
x rules version, with:

- the false-done line: "N of M done claims contradicted by the session's own
  tool log (X%)". The percentage is hidden below 10 done turns.
- unverified turns, session count, and submitter count.

Above the table sit the author's own August numbers (one person's data, not a
published row) and the five printed caveats from the docs.

## The publication threshold

A row publishes only when it has **at least 50 done-claims total from 5 or more
submitters**. Below that, the row still renders, but greyed and labelled
"below publication threshold - shown as format example". A small denominator
makes a misleading rate, so the board refuses to present one as real.

The threshold is a **render** concern: a below-threshold submission still
ingests and accumulates toward the 50/5 minimum. It is simply shown greyed
until it clears the bar. The seed rows in `data/rows.json` are the author's own
data shown as format examples; each is deliberately under the threshold.

## How to submit

1. Run `bench --publish`. It writes an aggregates-only JSON file locally and
   never sends anything (see `../docs/privacy.md`, "The bench --publish
   payload", for every field).
2. Open a board-submission issue. `bench --publish` prints a URL-prefilled link
   to the issue form; the form has one field for the pasted JSON, a checkbox
   confirming the numbers are aggregates-only and yours to share, and an
   optional handle for credit.
3. A workflow validates the payload and, on success, opens a pull request.
4. A maintainer reviews the diff and merges. Only then does the row change.

## How ingestion and validation work

`scripts/ingest.mjs` is pure Node with zero dependencies (so it is testable in
isolation). It:

- extracts the JSON from the issue body with `JSON.parse` only, never by
  executing the submitted text;
- caps the issue body and the pasted JSON at fixed byte sizes;
- validates against the published-fields whitelist, mirroring
  `../src/bench/validate.ts` and the schema in `../docs/privacy.md`: no key
  outside the schema; the publishable string charset; harness, model, claim
  kind and reason enums; month-format dates; a day-precision scan that rejects
  anything finer than a month (filesystem paths trip the slash rule, e-mails
  trip the e-mail scan); and a recomputed `contentHash`;
- merges the accepted rows into `data/rows.json`, collapsing the harness
  version to its display form (`2.1.214` becomes `2.1.x`) and de-duplicating
  submitters so re-running the same issue never double-counts.

`.github/workflows/board-submission.yml` runs `ingest.mjs` on issues labelled
`board-submission` (and on manual dispatch). On success it opens a pull
request; on rejection it comments the reasons back on the issue and commits
nothing.

### Every submission is reviewed by a human

Submission issue bodies are untrusted input. The workflow **never auto-merges**.
It opens a pull request so a maintainer reads the diff before any row lands on
the board. The ingest script never executes submitted content, whitelists
every key, and caps sizes; the human review is the final gate.

## Running the tests

```sh
node board/scripts/ingest.test.mjs
```

The tests cover a valid payload merging, a payload with a filesystem path being
rejected, a payload with a day-precision date being rejected, and a
below-threshold row still ingesting.

## Data shape

`data/rows.json`:

```json
{
  "schema": "showreceipts.board/1",
  "thresholds": { "minDoneTurns": 50, "minSubmitters": 5 },
  "rows": [
    {
      "harness": "claude-code",
      "harnessVersion": "2.1.x",
      "model": "claude-opus-5",
      "rulesVersion": "claims/2",
      "sessions": 12,
      "turns": 74,
      "doneTurns": 31,
      "contradictedTurns": 2,
      "unverifiedTurns": 8,
      "cleanTurns": 21,
      "submitters": [{ "id": "issue-42", "handle": "someone" }],
      "exemplar": false
    }
  ]
}
```

A row may carry an optional `modelLabel` for display when `model` is `other`
(an open model that is not a built-in price-table key).
