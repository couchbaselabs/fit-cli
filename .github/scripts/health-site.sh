#!/usr/bin/env bash
# Builds the fit health Pages site from this run's per-SDK report artifacts.
# Usage: health-site.sh <reports-dir> <site-dir> [live-site-url]
#
#   <reports-dir>   holds one health-report-<sdk>/ directory per SDK that reported this run
#   <site-dir>      is created; the site is written there:
#                     index.html               redirects to health/
#                     health/index.html        each SDK's last 30 nights, one chart each (fit health overview)
#                     health/overview.json     that page's data
#                     health/sdks.json         the SDKs on the site, for the next run
#                     health/<sdk>/index.html  the SDK's report page
#                     health/<sdk>/report.json the report data: what the page draws and tools read
#   [live-site-url] the site as currently published. A Pages deploy replaces the whole site,
#                   so an SDK with no report this run (a failed job, or a dispatch for one
#                   SDK) keeps its published page instead of vanishing. The page shows its
#                   own date, so a carried-over report never passes for a new one.
set -euo pipefail

reports="$1"
site="$2"
live="${3:-}"
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

if [ -n "$live" ]; then
  if published="$(curl -fsSL "$live/health/sdks.json" 2>/dev/null)"; then
    for sdk in $(jq -r '.[]' <<<"$published"); do
      [[ "$sdk" =~ $SDK_RE ]] || continue
      [ -d "$site/health/$sdk" ] && continue
      mkdir -p "$site/health/$sdk"
      if curl -fsSL "$live/health/$sdk/" -o "$site/health/$sdk/index.html"; then
        curl -fsSL "$live/health/$sdk/report.json" -o "$site/health/$sdk/report.json" || rm -f "$site/health/$sdk/report.json"
        echo "::notice::$sdk had no report this run; keeping its published one"
        sdks+=("$sdk")
      else
        rm -rf "${site:?}/health/$sdk"
        echo "::warning::$sdk had no report this run and its published one could not be fetched; dropped"
      fi
    done
  else
    echo "No published site at $live yet (or it could not be read): publishing this run's reports only."
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

cat > "$site/index.html" <<'EOF'
<!doctype html>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=health/">
<title>FIT Health</title>
<a href="health/">FIT Health</a>
EOF

echo "Site: ${sdks[*]}"
