#!/usr/bin/env bash
# Builds the fit health Pages site from this run's per-SDK report artifacts.
# Usage: health-site.sh <reports-dir> <site-dir> [live-site-url]
#
#   <reports-dir>   holds one health-report-<sdk>/ directory per SDK that reported this run
#   <site-dir>      is created; the site is written there:
#                     index.html               redirects to health/
#                     health/index.html        one line per SDK, linking its report
#                     health/sdks.json         the SDKs on the site, for the next run
#                     health/<sdk>/index.html  the SDK's report page
#                     health/<sdk>/report.json the report data (the page's drawing data)
#                     health/<sdk>/triage.json the triage report (a versioned contract for tools)
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
  [ -f "$dir/triage.json" ] && cp "$dir/triage.json" "$site/health/$sdk/triage.json"
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
        curl -fsSL "$live/health/$sdk/triage.json" -o "$site/health/$sdk/triage.json" || rm -f "$site/health/$sdk/triage.json"
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

rows=""
for sdk in "${sdks[@]}"; do
  when=""
  if [ -f "$site/health/$sdk/report.json" ]; then
    when="$(jq -r '"nights to \(.end), generated \(.generatedAt[0:10])"' "$site/health/$sdk/report.json")"
  fi
  rows+="<li><a href=\"$sdk/\">$sdk</a> <span>$when</span></li>"$'\n'
done

cat > "$site/health/index.html" <<EOF
<!doctype html>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FIT Health</title>
<style>
:root { color-scheme: light dark; --bg: #f5f6f8; --ink: #161a20; --muted: #6b7380; --link: #1f5fbf; }
@media (prefers-color-scheme: dark) { :root { --bg: #111418; --ink: #e6e8eb; --muted: #9aa3ae; --link: #7fb0ff; } }
body { background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; }
a { color: var(--link); font-weight: 600; }
span { color: var(--muted); font-size: 14px; margin-left: 8px; }
li { margin: 6px 0; }
</style>
<h1>FIT Health</h1>
<p>Per-SDK FIT test health from the nightly runs, produced by <code>fit health report</code>.</p>
<ul>
$rows</ul>
EOF

cat > "$site/index.html" <<'EOF'
<!doctype html>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0; url=health/">
<title>FIT Health</title>
<a href="health/">FIT Health</a>
EOF

echo "Site: ${sdks[*]}"
