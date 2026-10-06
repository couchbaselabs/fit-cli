This doc covers the health feature.  
This is a human-written doc.  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate

# fit health
`fit health` answers, per SDK: which FIT tests fail every night, which fail intermittently, which started or stopped failing recently, and which way things are trending. A nightly that is red every night says nothing on its own; the set of failing tests does.

A report covers its own SDK only. It makes no claim about other SDKs.

## Run records
Everything is built on run records: one per fit-cli run (a preset × test type × cluster, in one CI job), holding every test's outcome plus the run's SDK, performer, preset, cluster, run parameters and CI context. Rules like "chronic" or "intermittent" are applied when a report is built, never stored, so they can change without rewriting history.

Records come from two sources, recorded on each record as `source`:
- `run-archive-junit` - rebuilt from the JUnit reports in each run's S3 archive (`s3://fit-cli/runs/`, kept 180 days). Almost every record comes from here.
- `run-log-scrape` - read from the run's GitHub Actions log (kept 90 days), only when there is no usable archive. Logs name only failing tests, and at most 3 per Java package, so these records undercount failures.

Nothing here changes how a test run behaves: records are built afterwards, by reading each nightly's log and archive. (A third source, `fit-cli`, is reserved for records `fit run` may one day write itself at the end of a run.)

## Where records live
- On a laptop: a local store, `~/.fit-cli/health` by default.
- In CI: the shared S3 store (`s3://fit-cli/health-dev/` while proving it, then `s3://fit-cli/health/`), given explicitly with `--store s3://…` or `FIT_HEALTH_STORE`. A command pulls the SDK's part of the store into a local cache, works on it, and pushes back only what it changed. Nothing defaults to S3.
- fit-cli-role may only get and put objects in the bucket - it can't list or delete - so each SDK's keys are listed in an index object, `<sdk>/index.json`, pushed last. A store's first run needs `--create-store`.

The `FIT health` workflow (`.github/workflows/health.yaml`) runs daily for every opted-in SDK: `backfill`, then `report`. It writes the job summary, uploads the report as an artifact, posts the Slack digest where one is configured, and (from `main` only) publishes each SDK's page to the repo's GitHub Pages site at `/health/<sdk>/`. The site's top page, `/health/`, has one chart per SDK over the last 30 days: failing tests per night as bars, tests run per night as a line. Each chart has its own scales, and the SDKs are listed by name: the page shows each SDK's own trend and does not rank them.

## Opting in
An SDK opts in with an entry in `src/fit/health/registry/health-opt-ins.ts`: its repo, its nightly workflow file(s), optionally a branch, and - for a repo holding several SDKs - which paths are this SDK. Opting in includes the SDK in reports and tells `backfill` where its nightly runs are.

Steps:
1. Add the entry and commit it.
2. Run the `FIT health` workflow for the SDK once with the `create_store` input, which creates its part of the shared store. Later runs are the daily schedule.
3. Optionally, Slack: invite fitbot to the channel, then `fit health settings <sdk> --slack-channel <channel ID>` against the shared store. No PR needed.

## Commands
- `fit health backfill <sdk>` - fetches the nightly logs GitHub still holds, then rebuilds each run's records from its S3 archive. Safe to rerun: only missing runs are fetched. Ends with `check`.
- `fit health check <sdk>` - confirms the records can be trusted: every run names this SDK, how much comes from full JUnit, and JUnit agrees with the log on recent nights.
- `fit health report <sdk>` - the report: terminal summary, plus `health-report.json` and `health-report.html` as artifacts (and a job summary in GitHub Actions). It covers the last 90 days (`--days N` for another span); the store keeps every night.
- `fit health opt-ins` - lists the committed opt-ins, which the workflow runs.
- `fit health notes <sdk> [--set <file>]` - shows or sets the SDK's hand-written notes (known fixes, keyed by exact test id), kept in the store.
- `fit health settings <sdk>` - shows or sets where the SDK's output goes (its Slack channel), kept in the store.
- `fit health reparse <sdk>` - rebuilds records from stored logs after a parser change. No GitHub access needed.
- `fit health import-logs <sdk>` - imports run logs already on disk.
- `fit health overview --dir <site>/health` - writes the site's top page from each SDK's published `report.json`. The workflow runs it when it builds the site.

Backfill needs `gh` access to the SDK's repo, and AWS access to `s3://fit-cli/runs/` and the store. In CI the workflow assumes `fit-cli-role` through OIDC and uses the org GitHub token; run locally, a command uses your own `gh` login and AWS credentials.

## Triage report (`triage.json`)
A JSON contract for tools that act on the report, such as a triage agent. `report` writes it next to the page, and the workflow publishes it at `/health/<sdk>/triage.json`. Unlike `health-report.json` (the page's own drawing data, which changes with the page), its shape is versioned: `schema` is `fit-health-triage/<n>`, fields are only added within a version, and anything else bumps it.

- Header: `sdk`, `generatedAt`, `window` (`start`, `end`, `nights`, `classificationDays`, `recentDays`), `coverage` (records from JUnit vs the CI log), `blackout` nights, `unreadableRuns`.
- `series[]`: one per preset and test type: `id`, `preset`, `kind`, `where`, `label`, `params`, `clusters`, `nights`, `degraded`, `aborted`, `active`, and `latest` - the latest night counted in tests (`tests`, `passed`, `failing`, `skipped`) and in `testCases`.
- `findings[]`: one per test that isn't dormant, in an active series. `test` is the exact id (`Class.method`, or `Class` with `method: null` for a whole class that errored); `classification` (`class`, `since` - with `sinceFirstNight` when that is the series' first night with results, so the start isn't known - `streak`, `episodes`, window counts, `lastFail`, `lastPass`, `lastRan`, `notRunSince`); `history[]` of `{date, outcome}`, outcome one of `passed`, `failed`, `errored`, `not_run`, `unknown`; `evidence` - the `lastGood`, `firstFailing` (of the latest unbroken failure run) and `latestFailing` nights, each with its CI run URL, SDK commit, S3 archive and member, and cluster, plus `sdkChange` (the SDK commits of `lastGood` and `firstFailing`, and a compare URL when they differ); `notes`. `changeAnalysis` and `driverChanges` say what changed between the baseline (`lastGood`, or `previousNight` for a test that only just started running) and `firstFailing` - see below. `crossSdk` is filled in by `fit health cross` - see below. `testsSeen` lists, per test type, every test with a known result in the classification window (`complete` is false when some nights came only from the CI log, which names failures but not passes).

### What changed
`report` looks up, through GitHub, the commits between a finding's baseline night and its first failing night, on two sides:
- The SDK: `evidence.sdkChange.commits`. In a repo that holds several SDKs (couchbase-jvm-clients), the opt-in's `paths` say which part is this SDK: a commit counts only if it touches them or `sharedCorePaths` (`sharedCoreCommits`: core-io, shared by every SDK built on it); `sharedHarnessPaths` changes (shared test harness) are listed but never count.
- The FIT driver (transactions-fit-performer, which holds the tests): `driverChanges`. Each nightly clones the driver fresh; the commit isn't logged, so it is inferred as the newest commit on the driver's default branch at the clone time (`inferred: true`) - unless the preset pinned a Gerrit patchset, which is then the driver exactly. Commits touching the test's own file (`testFileCommits`) are separate from those touching other test code (`helperCommits`).

`changeAnalysis.category`, from the SDK and the test's own file only: `test-changed` (driver yes, SDK no), `sdk` (SDK yes, driver no), `both`, `neither` (environment, server or flakiness), or `unknown` (with a `reason`). `span` gives the two nights and how many days apart they are; over 2 days the `reason` says the commits cover more than one night. `--no-changes` skips the lookup.

## Across SDKs
The driver's tests are shared, so a test id means the same test on every SDK. In the workflow, `fit health cross --dir <reports>` compares every SDK's report from the run with every other's and writes the result into each `triage.json` (`crossSdk`) and page. For each finding, every other SDK is `failing`, `intermittent`, `recovered`, `stopped`, `passing` (ran it, never failed it), `not_run`, or `unknown` (its log-only nights can't say); same test id and test type only. `sameStart` marks an SDK that started failing it within a day. `category`: `only-this-sdk` (every other SDK that runs it passes), `every-sdk` (they all fail it too: likely the test, the driver, or the server or environment), `family` (this SDK's family - `jvm`, built on core-io, or `cxx`, built on the C++ SDK's core - fails it and the rest pass: likely the shared core), `mixed`, or `not-enough-data`. Failing on the same nights is not called a server issue: the server build isn't captured yet.

## Slack
Where an SDK's output goes is data in the store, not code: `fit health settings <sdk>` shows it, `--slack-channel <id>` sets it, `--no-slack` turns it off, and `--report-url` changes the digest's link (default: the SDK's page on the health Pages site). With a channel set, `fit health report` posts a digest: a headline in the channel and the detail in its thread. It posts automatically only in CI; a local run needs `--slack`, and `--slack-dry-run` prints it instead. A Slack failure is a warning, never a failed run.

## Tests, not test cases
Everything is counted in tests - the `Class.method` you'd go and fix - not test cases. One test can run as many cases (each API, every permutation; one permutation test runs 1,000), which is what fit-cli's results table counts; a test fails if any of its cases does. Pages show test cases only on hover. A test id's class is the simple class name, except where the driver uses one name in several packages (`kv.GetTest` and `transactions.states.GetTest`): those get the shortest package suffix that tells them apart (`kv/GetTest`), from fit-cli's committed list of driver test files, so every SDK names a test the same way. The CI log prints only simple names, so on a log-only night such a test can't be told apart.

## Classification
A test is classed by the shape of its last 30 days, not its failure rate: one unbroken run of failures means it broke ("Failing since"), two or more separate runs mean it flips ("Intermittent"). Also: Always fails, New · watch, Recovered, One-off, Stopped running, Dormant. Nights with no usable results, and nights a test was skipped, are shown as gaps, never as passes. A test that fails and then stops running (3+ nights) is "Stopped running": listed for 14 days, then dropped.
