# Recorded-evidence parity record

Run 2026-11-15 during reconciliation. No model calls; both analysers read the
same recorded evidence.

## Committed mini corpus

Fixture: `tests/fixtures/docs-parity` (4 trials, copied from the recorded
confirmation campaign).

Command (OTC):

```sh
node dist/cli/otc.js replay \
  --manifest tests/fixtures/docs-parity/manifest.json \
  --evidence-root tests/fixtures/docs-parity/evidence \
  --out /tmp/opencode/mini-new
```

Original command (docs @ extraction base):

```sh
node tests/fixtures/placement-harness/analysis/analyse.mts \
  --campaign tests/fixtures/analysis/manifests/mini.json \
  --evidence-root /tmp/opencode/mini-evidence \
  --out /tmp/opencode/mini-old
```

Result: `analysis.json`, `REPORT.md` and `SCREENING.json` deep-equal;
`analysis-receipt.json` equal after removing `renderedAt`. This is enforced by
`tests/contract/docs-parity.test.ts` in `npm test`.

## Recorded confirmation corpus

Evidence: `/home/mark/tmp/recording-confirm-20261110` (40 trials, 20 pairs).
Result: all three artefacts byte-identical; receipt differs only in
`renderedAt`. Decision `inconclusive`; totals 40 planned/completed; utility
20; bounds delta -13..7.

## Recorded screening corpus

Evidence: `/home/mark/tmp/docs-desc-fresh-20261110` (48 trials, six arms).
Result: all three artefacts byte-identical; decision `not-defined`; utility
24; 6 screening findings.

## Limits

- The two larger corpora are ~56 MB and are not committed; the committed mini
  corpus enforces the same pipeline offline.
- Retrieval measures require a manifest measurement declaration. The recorded
  manifests declare none, so retrieval-specific parity is covered by the
  ported measures contract tests, not by a recorded retrieval campaign.
- The frozen published `ANALYSIS-confirmation.json` predates the current
  analysis schema and is not a byte target. The comparison is original
  analyser at the extraction base versus the OTC port on the same evidence.
