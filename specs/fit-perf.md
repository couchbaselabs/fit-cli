This covers changes for FIT/PERF (SDK performance testing).
This is a human-written doc.  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate.

# Snapshot releases
https://github.com/couchbaselabs/sdk-docker-build-action/blob/main/fit-performer-docker-image-conventions.md is 
the FIT performer container spec.
Note that there is no provision for specifying the next-GA version of the main/branch snapshot releases, which ties our hands on 
the perf side.  To compensate we store the last N builds of each branch, which will be presented in the UI after the
GA releases, in build order.

Whenever FIT/PERF is included in a preset or definition file it will run regardless.  If the resulting files
are uploaded to S3 (this is optional) for ingestion, the ingestion script will a) delete any existing entries for the
snapshot if the SHA has changed or if not b) will keep up to the latest X runs for that snapshot to help smooth variance.

# Major changes
I took the decisions to:
* Move the performance testing out of transactions-fit-performer/perf-driver and into fit-cli itself.
  * Makes it much easier to iterate the performance code.

# Running
As the performance driver was added into fit-cli, we needed to run fit-cli directly on the cloud instance.
But also needed to support local development.
So if we're running under `bun`, we build the binary from local source and copy it over.
Otherwise, we install it from the install.sh script.

# Workloads a performer can't run
A transaction workload is skipped, not failed, when the performer doesn't advertise `TRANSACTIONS_WORKLOAD_1` (`TRANSACTIONS_SUPPORT_1` isn't enough: it covers the transactions RPCs, not `transactions.Workload`).
Only that run is skipped; the session's other workloads still run. Nothing is uploaded for it, and the GHA job gets a notice saying why.
jenkins-sdk likewise only scheduled write transactions for Java, Go and C++. The C++ performer runs them fine but doesn't advertise the cap, so its txn runs are skipped until it does.

# Observability
The performer sends OpenTelemetry traces, sampled at 0.01%, to the box's own otel stack, the same one functional runs use.
It sends no metrics. That matches how the jenkins-sdk history was measured, and with metrics on, the Java SDK's per-operation histograms cost a KV workload about 5%.
The stack's teardown writes the traces to the instance's `otel/` artifacts directory. `fit external-services otel replay <dir>` brings the UIs back up over them.
