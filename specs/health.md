This doc covers the health feature.  
This is a human-written doc.  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate

# fit health
`fit health` answers, per SDK: which FIT tests fail every night, which fail intermittently, which started or stopped failing recently, and which way things are trending. A nightly that is red every night says nothing on its own; the set of failing tests does.

A report is built from its own SDK's runs only; the workflow then adds how other SDKs fare on the same tests (`fit health site`).

## Run records
Everything is built on run records: one per fit-cli run (a preset × test type × cluster, in one CI job), holding every test's outcome plus the run's SDK, performer, preset, cluster, run parameters and CI context. Rules like "chronic" or "intermittent" are applied when a report is built, never stored, so they can change without rewriting history.

Records come from two sources, recorded on each record as `source`:
- `run-archive-junit` - rebuilt from the JUnit reports in each run's S3 archive (`s3://fit-cli/runs/`, kept 180 days). Almost every record comes from here.
- `run-log-scrape` - read from the run's GitHub Actions log (kept 90 days), only when there is no usable archive. Logs name only failing tests, and at most 3 per Java package, so these records undercount failures.

A situational record also reads the scenario scores in the run's `results.tar`, and a test whose score fails it is recorded as failed, in `scoreFailures`.

Nothing here changes how a test run behaves: records are built afterwards, by reading each nightly's log and archive. (A third source, `fit-cli`, is reserved for records `fit run` may one day write itself at the end of a run.)

## Where records live
- On a laptop: a local store, `~/.fit-cli/health` by default.
- In CI: the shared S3 store (`s3://fit-cli/health-dev/` while proving it, then `s3://fit-cli/health/`), given explicitly with `--store s3://…` or `FIT_HEALTH_STORE`. A command pulls the SDK's part of the store into a local cache, works on it, and pushes back only what it changed. Nothing defaults to S3.
- A command finds the SDK's keys by listing its prefix, `<sdk>/`, so a new SDK's part of the store is simply empty until its first run. A push writes records and raw logs first, then the manifests that vouch for them, then deletes what was removed.

The `FIT health` workflow (`.github/workflows/health.yaml`) runs daily for every opted-in SDK: `backfill`, then `report`. It posts the Slack digest where one is configured and (from `main` only) publishes each SDK's page at `/health/<sdk>/` on a private Pages site, served by the internal `couchbaselabs/fit-health` repo to anyone who can read it. The reports are private: they name commits from the private driver repo and tests from fit-cli's private run archives. This repo is public, so the workflow keeps them out of its Actions entirely: no job summary, no artifacts, and each command's output goes to a log published with the site (`/health/logs/<sdk>/`) rather than to the job log. The health jobs hand their reports to the site job through the private S3 bucket, and the site job force-pushes the whole site as one commit to `fit-health`'s `site` branch, keeping the published page of any SDK with no report this run. The site's top page, `/health/`, has one chart per SDK over the last 30 days: failing tests per night as bars, tests run per night as a line. Each chart has its own scales, and nothing is ranked: the page shows each SDK's own trend. The charts are in a row per language (in effect, per team): its Couchbase SDK, then its Operational Insights and Columnar SDKs. The languages whose Couchbase SDKs share a core are in a section for it (`FAMILY_SECTIONS`: the C++ core, the JVM), first; the other languages follow on their own. Sections and rows are in name order. A report kept from the published site (no report this run) is marked as from an earlier run; a report whose nightly runs later in the day, and so ends a night before the others, is not. Each SDK's page links back to it. A night on either page's chart opens that SDK's page at the night (`#night-YYYY-MM-DD`): the SDK commit tested and, per preset, the tests run, the failing tests and a link to the night's GitHub Actions run. A night whose nightly ran but gave no results (every run aborted, or its log could not be read) is shaded on the top page, not shown as a night with no run; its panel gives fit-cli's reason for the abort and still links to the run.

## Opting in
An SDK opts in with an entry in `src/fit/health/registry/health-opt-ins.ts`: its repo, its nightly workflow file(s), optionally a branch, and - for a repo holding several SDKs - which paths are this SDK. An SDK that is not a language's Couchbase SDK (an Operational Insights or Columnar SDK) gives `language`, the Couchbase SDK of its language (e.g. `java`), to put it in that SDK's row on the top page. `family` is different: give it only to an SDK built on that core, as it decides the cross-SDK `family` verdict. The Operational Insights SDKs have a `language` and no `family`: none is built on another SDK's core. Opting in includes the SDK in reports and tells `backfill` where its nightly runs are.

Steps:
1. Add the entry and commit it.
2. Optionally, Slack: invite fitbot to the channel, then `fit health settings <sdk> --slack-channel <channel ID>` against the shared store. No PR needed.

## Commands
- `fit health backfill <sdk>` - fetches the nightly logs GitHub still holds, then rebuilds each run's records from its S3 archive. Safe to rerun: only missing runs are fetched. Ends with `check`.
- `fit health check <sdk>` - confirms the records can be trusted: every run names this SDK, how much comes from full JUnit, and JUnit agrees with the log on recent nights.
- `fit health report <sdk>` - the report: terminal summary, plus `health-report.json` and `health-report.html` as artifacts. It covers the last 90 days (`--days N` for another span); the store keeps every night.
- `fit health opt-ins` - lists the committed opt-ins, which the workflow runs.
- `fit health notes <sdk> [--set <file>]` - shows or sets the SDK's hand-written notes (known fixes, keyed by exact test id), kept in the store.
- `fit health settings <sdk>` - shows or sets where the SDK's output goes (its Slack channel), kept in the store.
- `fit health reparse <sdk>` - rebuilds records from stored logs after a parser change. No GitHub access needed.
- `fit health import-logs <sdk>` - imports run logs already on disk.
- `fit health weekly --out <site> [--week YYYY-Www] [--weeks N]` - adds the weekly wrap-up (see "Weekly wrap-up") to a site `site` built: rebuilds every SDK's reports at the week ends from the store, and writes the week, `latest/` and the index. A week already in the site is left alone (`--rebuild` to redo it); `--weeks N` also builds the weeks before. `--slack-channel <id>` posts a week built this run; `--slack-dry-run` prints it.
- `fit health site --reports <dir> --out <site> [--previous <dir>]` - builds the Pages site from one run's reports: compares the SDKs (see "Across SDKs"), writes each SDK's page and `report.json`, and the top page from them. An SDK the published site (`--previous`, a checkout of `fit-health`'s `site` branch) has and this run didn't report keeps its published page, and the published weekly wrap-ups are kept as they are. The workflow runs it after the reports.

Backfill needs `gh` access to the SDK's repo, and AWS access to `s3://fit-cli/runs/` and the store. In CI the workflow assumes `fit-cli-role` through OIDC and uses the org GitHub token; run locally, a command uses your own `gh` login and AWS credentials.

## The report (`report.json`)
The report is one JSON document per SDK. The page draws it (all of it except `testsSeen`), and tools (such as a triage agent) read it. `report` writes it, as compact JSON, to `health-report.json`, and the workflow publishes it at `/health/<sdk>/report.json`. It has no version: when the report changes, its shape can change too.

- Header: `sdk`, `repo` (the SDK repo the nightly runs are in), `generatedAt`, `start` and `end` (the report covers 90 days to `end`), `dates` (every calendar day in that span), `blackout` (nights with no usable functional results), `classes` (the classes in order, their labels and descriptions, `windowDays` - the classification window, 30 days - and `recentDays` - how far back "started" and "stopped failing" look, 14 days), `sdkNames` (the display name of each SDK), and `source` (how many records came from JUnit and how many from the CI log, and the runs that could not be read).
- `series[]`: one per preset and test type. It has `id`, `preset`, `kind`, `label`, `short` (where it runs), `params`, `clusters`, `ran` (the nights it ran, oldest first), `degraded`, `aborted` (each with fit-cli's `level` and `reason`, and its run's `runId`, `attempt`, `job` and, when it differs from the report's, `repo`) and `active` (false when it last ran before the window). It also has:
  - `nights`: for each night in `ran`, the CI run (`runId`, `attempt`, `job`, and `repo` only when it is not the report's; the run's page is `https://github.com/<repo>/actions/runs/<runId>/attempts/<attempt>`), the SDK commit under test (`sdkCommit`, with `sdkCommitFrom`: `performer-image` when the log shows the image revision, else `workflow`, and then `workflowCommit` if that is different), the S3 `archive` and the surefire tarball in it, `source` (`run-archive-junit`, where every outcome is known, or `run-log-scrape`, where only failures are named), and `driver`: how the night's job got the FIT driver, when its log shows it (`clonedAt`, and a `branch` or pinned `gerritRef` if it had one).
  - `perNight`, `testCounts` and `latest`: per night, how many tests failed and how many ran.
  - `tests[]`: every test that failed in the 90 days (a test that stopped running more than `recentDays` ago is left out). See below.
- `testsSeen`: for each test type, every test with a known result in the classification window. `complete` is false when some nights came only from the CI log, which names failures but not passes.
- `comparisons`: pairs of presets that are different in only one parameter (for example, Capella with and without a private endpoint).
- `digest`: what every view leads with, built once from the active functional series (situational presets stay out). It has `failedLastNight` (the tests that failed or errored on `end`, from the series whose latest night is `end` and usable, with their part per series, the split into `persistent`, `new` and `intermittent`, `atLeast` when a series' night came only from the CI log, and the tests themselves), the counts `persistent` (always failing, or failing 3+ nights in a row), `started`, `stopped` and `intermittent` (each a `total` and its part per series), `startedGroups` (the started tests grouped by class, night and series, newest first), `stoppedTests`, `stoppedRunning`, `always` (failed every night they ran in the window), `lastNight` (tests run, from the series whose latest night is `end` and usable), and `gaps` and `unreadableRuns` (only those in the classification window). The page, the Slack digest and the terminal only format it.

Each entry in `tests[]` is one test:
- `test` is the exact test id: `Class.method`, or `Class` for a whole class that errored.
- `seq` is the history: one letter for each night in the series' `ran`. `p` is passed, `f` is failed, `e` is errored, `n` is not run, and `u` is unknown (the night cannot tell).
- `cls` is the class (see "Classification"), with `since` (when the current failure run started; `sinceFirstNight` is set when that is the series' first night, so the real start is not known), `streak`, `episodes`, `windowFails` and `windowRuns`, `lastFail`, `lastPass`, `lastRan`, and, for a test that stopped running, `lastResult` and `notRunSince`.
- `lastEpisode` (`from`, `to`, `nights`) is the most recent unbroken run of failures. `lastGood` is the last night it passed before that run. If it never passed before, `previousNight` is the night before the run. Use these dates to look up `series[].nights`.
- `fix` is a known fix, from the SDK's notes.
- `scores`, for a situational test: each night its score failed it, with the `score` and `reasons`.
- `sdkChange`, `driverChanges` and `changeAnalysis` tell what changed between the baseline night (`lastGood`, else `previousNight`) and `lastEpisode.from` (see below). `crossSdk` tells how the other SDKs do with the same test (see "Across SDKs"). These fields are only on tests that are not dormant, in series that are active.

### What changed
`report` looks up, through GitHub, the commits between a test's baseline night and the first night of its last failure run, on two sides:
- The SDK: `sdkChange` (`from` and `to`, the two commits; `changed`; `compareUrl`; and the `commits`). In a repo that holds several SDKs (couchbase-jvm-clients), the opt-in's `paths` say which part is this SDK: a commit counts only if it touches them or `sharedCorePaths` (`sharedCoreCommits`: core-io, shared by every SDK built on it); `sharedHarnessPaths` changes (shared test harness) are listed but never count.
- The FIT driver (transactions-fit-performer, which holds the tests): `driverChanges`. Each nightly clones the driver fresh (each night's `driver`); the commit isn't logged, so it is inferred as the newest commit on the driver's default branch at the clone time (`inferred: true`) - unless the preset pinned a Gerrit patchset, which is then the driver exactly. Commits touching the test's own file (`testFileCommits`) are separate from those touching other test code (`helperCommits`).

`changeAnalysis.category`, from the SDK and the test's own file only: `test-changed` (driver yes, SDK no), `sdk` (SDK yes, driver no), `both`, `neither` (environment, server or flakiness), or `unknown` (with a `reason`). `span` gives the two nights and how many days apart they are; over 2 days the `reason` says the commits cover more than one night. `--no-changes` skips the lookup.

## Across SDKs
The driver's tests are shared, so a test id means the same test on every SDK that runs that driver. The Analytics SDKs (Operational Insights, Columnar) run their own driver, columnar-test-driver, so they are compared only with each other, and the Couchbase SDKs only with each other. In the workflow, `fit health site` compares every SDK's report from the run with every other's and writes the result into each report (`crossSdk` on each test) and page. For each test, every other SDK is `failing`, `intermittent`, `recovered`, `stopped`, `passing` (ran it, never failed it), `not_run`, or `unknown` (its log-only nights can't say); same test id and test type only. `sameStart` marks an SDK that started failing it within a day. `category`: `only-this-sdk` (every other SDK that runs it passes), `every-sdk` (they all fail it too: likely the test, the driver, or the server or environment), `family` (this SDK's family - `jvm`, built on core-io, or `cxx`, built on the C++ SDK's core - fails it and the rest pass: likely the shared core), `mixed`, or `not-enough-data`. Failing on the same nights is not called a server issue: the server build isn't captured yet.

## Slack
Where an SDK's output goes is data in the store, not code: `fit health settings <sdk>` shows it, `--slack-channel <id>` sets it, `--no-slack` turns it off, and `--report-url` changes the digest's link (default: the SDK's page on the health site, whose address `report` asks GitHub for each time: private Pages gets a random hostname, which changes if Pages is turned off and on again). With a channel set, `fit health report` posts a digest: a headline in the channel and the detail in its thread. It posts only when asked: the scheduled workflow passes `--slack` (a manual run of it posts only with its `slack` input ticked), `--slack-channel <id>` posts to that channel instead, and `--slack-dry-run` prints the digest. A Slack failure is a warning, never a failed run.

## Weekly wrap-up
Once a week, a page shows each SDK's FIT condition for SDK teams and managers, and how it changed since the week before. A week is an ISO week of Monday-to-Sunday nights (`2026-W43`). The workflow builds it on Mondays, after the site, so Monday's night goes in the next week; its `weekly` input builds it on any day. Each SDK's two reports, one at the end of each week, are rebuilt with `--end`, so nothing new is stored.

A card is the overall picture for one SDK at the week's end:
- failing: the tests in a current failure run (classes always, failing and new), with the change since last week's end as one arrow (▲ up, ▼ down, or no change)
- flaky: the intermittent tests that failed during the week; they are not in the failing count, so a card with both says so ("18 failing · 3 more flaky")
- the nights with results (`6/7`, the other nights shaded as on the top page)

A dot beside the SDK's name says where it stands: red with tests failing, amber with only flaky tests, green with neither, grey with no results all week. The arrow is red going up and green going down. The SDK's name links to its page.

The tests behind the numbers are collapsed under one toggle per card (`#sdk-<sdk>` opens that card's): newly failing (joined the failing set; marked if it never passed), no longer failing (left it; with why when it doesn't pass: stopped running, now flaky, or not reported), and flaky this week. A test leaves the failing set after three clean nights, so one that stops failing late in a week is listed the week after.

The page lays out the SDKs in the top page's sections and rows, in the same order, without the sections' descriptions.

Each week is frozen at `/health/weekly/<YYYY-Www>/` and never rebuilt. The site keeps every published week. `/health/weekly/latest/` is a copy of the newest week, and `/health/weekly/` lists them all. A frozen page reads `weekly/index.json` when viewed, to link to the previous, next and latest weeks. A test name opens its SDK's page, which shows the state as of today, and the page says so. The first build also builds the past weeks the store covers.

The scheduled Monday run (or a run with its `weekly_slack` input ticked; `slack` is only the daily digests') posts one message to the weekly channel (the `FIT_HEALTH_WEEKLY_SLACK_CHANNEL` repository variable; none set, no post), linking to the frozen week. The message is grouped as the page's summary is. Its first line, what a notification shows, counts the SDKs failing, flaky only, clean and with no results. Each failing SDK has a line: its failing count of the tests run, its flaky tests as more ("3 more flaky": they are not in the failing count), the change since last week in words, and its nights if any had no results. The other SDKs are named on a line per state, a flaky-only SDK with its flaky count. Each state has an emoji that differs in shape as well as color. The test names are on the page only. Health posts, daily and weekly, never unfurl their links.

## Tests, not test cases
Everything is counted in tests - the `Class.method` you'd go and fix - not test cases. One test can run as many cases (each API, every permutation; one permutation test runs 1,000), which is what fit-cli's results table counts; a test fails if any of its cases does. A parameterised test's variants (`durability(Durability)[2]`) are cases of one test, `durability`; a record keeps the variants that failed (`v`), and the page shows those of a test's last failing night on hover. Pages show test cases only on hover. A test id's class is the simple class name, except where the driver uses one name in several packages (`kv.GetTest` and `transactions.states.GetTest`): those get the shortest package suffix that tells them apart (`kv/GetTest`), from fit-cli's committed list of driver test files, so every SDK names a test the same way. The CI log prints only simple names. On a log-only night a failure under such a name goes to the one test of that name the JUnit nights have seen; only when they have seen it in several of the classes can the night not tell them apart, and each is unknown that night.

## Classification
A test is classed by the shape of its last 30 days, not its failure rate: one unbroken run of failures means it broke ("Failing since"), two or more separate runs mean it flips ("Intermittent"). Also: Always fails, New · watch, Recovered, One-off, Stopped running, Dormant. Nights with no usable results, and nights a test was skipped, are shown as gaps, never as passes. A test that fails and then stops running (3+ nights) is "Stopped running": listed for 14 days, then dropped.
