#!/usr/bin/env bash
# Builds the fit health Pages site from this run's per-SDK report artifacts.
# Usage: health-site.sh <reports-dir> <site-dir> [previous-site-dir]
#
#   <reports-dir>   holds one health-report-<sdk>/ directory per SDK that reported this run
#   <site-dir>      is created; the site is written there:
#                     index.html               redirects to health/
#                     .nojekyll                Pages serves the files as they are
#                     health/index.html        each SDK's last 30 nights, one chart each (fit health overview)
#                     health/sdks.json         the SDKs on the site, for the next run
#                     health/<sdk>/index.html  the SDK's report page
#                     health/<sdk>/report.json the report data: what the page draws and tools read
#   [previous-site-dir] the site as currently published (a checkout of fit-health's site
#                   branch). Each publish replaces the whole site, so an SDK with no report
#                   this run (a failed job, or a dispatch for one SDK) keeps its published page
#                   instead of vanishing. The page shows its own date, so a carried-over report
#                   never passes for a new one.
set -euo pipefail

reports="$1"
site="$2"
previous="${3:-}"
SDK_RE='^[a-z0-9][a-z0-9-]{0,40}$'

mkdir -p "$site/health"
sdks=()

for dir in "$reports"/health-report-*/; do
  [ -d "$dir" ] || continue
  sdk="$(basename "$dir")"
  sdk="${sdk#health-report-}"
  if ! [[ "$sdk" =~ $SDK_RE ]] || [ ! -f "$dir/health-report.html" ]; then
    echo "::warning::skipping $dir: not an SDK report"
    continue
  fi
  mkdir -p "$site/health/$sdk"
  cp "$dir/health-report.html" "$site/health/$sdk/index.html"
  [ -f "$dir/health-report.json" ] && cp "$dir/health-report.json" "$site/health/$sdk/report.json"
  sdks+=("$sdk")
done

if [ -n "$previous" ]; then
  if [ -f "$previous/health/sdks.json" ]; then
    for sdk in $(jq -r '.[]' "$previous/health/sdks.json"); do
      [[ "$sdk" =~ $SDK_RE ]] || continue
      [ -d "$site/health/$sdk" ] && continue
      if [ -f "$previous/health/$sdk/index.html" ]; then
        mkdir -p "$site/health/$sdk"
        cp "$previous/health/$sdk/index.html" "$site/health/$sdk/index.html"
        [ -f "$previous/health/$sdk/report.json" ] && cp "$previous/health/$sdk/report.json" "$site/health/$sdk/report.json"
        echo "$sdk had no report this run; keeping its published one"
        sdks+=("$sdk")
      else
        echo "$sdk had no report this run and has no published page; dropped"
      fi
    done
  else
    echo "No published site in $previous yet: publishing this run's reports only."
  fi
fi

# Kept to bash 3.2, so it can be tried on a Mac: no mapfile, and "${sdks[@]}" only once
# the array is known to be non-empty.
if [ "${#sdks[@]}" -eq 0 ]; then
  echo "::error::no SDK reports to publish"
  exit 1
fi

# SDK names match SDK_RE, so splitting on whitespace is safe.
# shellcheck disable=SC2207
sdks=($(printf '%s\n' "${sdks[@]}" | sort -u))
printf '%s\n' "${sdks[@]}" | jq -R . | jq -cs . > "$site/health/sdks.json"

bun src/fit/main/main.ts health overview --dir "$site/health"

touch "$site/.nojekyll"
cat > "$site/index.html" <<'EOF'
<!doctype html>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=health/">
<title>FIT Health</title>
<a href="health/">FIT Health</a>
EOF

echo "Site: ${sdks[*]}"
