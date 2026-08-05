This doc covers running external processes, their logging, and error handling.
This is a human-written doc.  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate.

# Running processes
Every subprocess goes through one of a small, named set of execution models in `src/util/non-fit/proc.ts` — there should be no raw `spawn`/`exec` anywhere else.  Each model is one function, and the `ProcessExecModel` enum documents the full set.  Three of them run a process as a logged step and so have a LogType (see below); the other three don't, because they aren't really about logging.

The models:
- `StreamToTerminal` (`run`) — LogType1.
- `HiddenUntilFailure` (`runHiddenUntilFailure`) — LogType2.
- `StreamToArtifact` (`streamToFile`) — LogType3.
- `BackgroundStreamToArtifact` (`streamToFileInBackground`) — LogType4.
- `CaptureValue` (`capture`) / `CaptureValueSync` (`captureValueSync`) — run a process to get a value we parse (a SHA, a username, a file list), not to produce log noise.  No LogType.
- `ReexecInherit` (`reexecInherit`) — hand the terminal and signals to a replacement process (the replay bootstrap).  No LogType.

## Logging
For the logged-step models above, stdout/stderr from the process can be either:
LogType1: Streamed to stdout/stderr of this process.
LogType2: Hidden as unimportant noise, and only shown on failure.  Also now included in a debug `session.debug.log` artifact version of the log.
LogType3: Sent to a separate artifact, for important but large logs.  For proof-of-life, the last line of the log is output to stdout/stderr every N seconds.
LogType4: Sent to a separate artifact in the background without blocking.  The process self-terminates when its subject (e.g. a Docker container) exits.  A `BackgroundStream.drain()` handle is returned for the caller to await after stopping the subject.  Used for performer logs so they're available even if the run is interrupted.
Generally we want those logtypes to behave the same on local or remote runs.  Agents, you will likely need to change both paths. 

### AWS SSM logging
Moving to using AWS SSM for running commands brings some odd constraints.  GetCommandInvocation will give only the first 24,000 chars of stdout and 8,000 chars of stderr.
So for some LogTypes we use what appears to be the standard workaround: direct the logs to a transient AWS CloudWatch, and poll that.
Nb AWS on the instance will only send logs to CloudWatch after 30s or when its buffer exceeds 200kb.  
Nb we intentionally avoid using AWS Session Manager, which would work better for this, as it brings in an external dependency.  SSM works from the AWS SDK.
So under AWS SSM:
LogType1: Uses the CloudWatch approach above.
LogType2: CloudWatch is used.  Read at end of process.
LogType3: File continues to be sent to separate artifact.  The 30s proof-of-life lines go to Cloudwatch.
LogType4: Similar to LogType3.


## Failures
Failing processes are defined as returning non-zero, and are classified as FatalToAll, FatalToInstance, FatalToCluster, FatalToSession or NonFatal.  The names mirror the definition-file hierarchy: an instance holds clusters, a cluster holds sessions.
FatalToAll will stop the definition run.
FatalToInstance includes things like failing to acquire or set up the instance (box).  The next instance is allowed to run.
FatalToCluster includes things like failing to set up the cluster for the instance.  The next cluster is allowed to run.
FatalToSession will fail just this session.  The next session is allowed to run.
FatalToRun will fail just this run.  The next run is allowed to, uh, run.
NonFatal allows things to continue including this session.

Deciding which of these should result in the final process returning non-zero and hence failing CI, is very tricky.
FatalToAll - obviously yes.
Everything else represents partial success.
