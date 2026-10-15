#!/usr/bin/env bash
# Runs one fit health command so that none of what it says reaches this public repo's Actions:
# its output goes to <log> instead of the job log, and it gets no job summary to write to.
# Usage: health-quiet.sh <log> <command> [args...]
#
# The reports name commits from the private driver repo and tests from the private run
# archives, so they're published only to the internal couchbaselabs/fit-health repo, along
# with these logs. The job log says only how the command ended. Doing this here, rather than
# in each command, means nothing a command prints - now or after a later change - can leak.
set -uo pipefail

log="$1"
shift
mkdir -p "$(dirname "$log")"
# GITHUB_ACTIONS stays set: the commands still upload their run folders to the private S3 bucket.
env -u GITHUB_STEP_SUMMARY "$@" >"$log" 2>&1
status=$?
echo "$(basename "$log"): exit $status (output in the internal fit-health repo, not here)"
exit "$status"
