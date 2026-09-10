# The set of repos allowed to assume fit-cli's cloud identities via GitHub
# Actions OIDC and GCP's Workload Identity Federation.
# Bare "owner/repo" form; each cloud formats it into its own condition syntax.
locals {
  repos = [
    # FIT repos
    "couchbaselabs/fit-cli",
    "couchbaselabs/transactions-fit-performer",

    # Operational SDKs
    "couchbase/couchbase-jvm-clients",
    "couchbase/couchbase-cxx-client",
    "couchbase/couchbase-net-client",
    "couchbase/gocb",
    "couchbase/couchnode",
    "couchbase/couchbase-python-client",
    "couchbase/couchbase-ruby-client",
    "couchbase/couchbase-rs",
    "couchbase/couchbase-php-client",

    # Operation Insights SDKs
    "couchbaselabs/operational-insights-nodejs-client",
    "couchbaselabs/operational-insights-python-client",
    # These do not exist yet - looking to future
    "couchbase/operational-insights-nodejs-client",
    "couchbase/operational-insights-python-client",
    "couchbase/couchbase-insights-jvm-clients",
    "couchbase/gocbinsights",
    "couchbase/operational-insights-dotnet-client",

    # Enterprise Analytics SDKs
    "couchbase/analytics-dotnet-client",
    "couchbase/couchbase-analytics-jvm-clients",

  ]

  # GitHub issues "immutable OIDC subjects" for recently created repos: the `sub` claim
  # carries the numeric owner and repo IDs, e.g.
  # "repo:couchbase@605755/gocbinsights@1357100214:*", so a repo created later cannot
  # reuse an earlier repo's name to inherit its trust.  A repo sends one form or the
  # other, never both, and CloudTrail confirms which: everything created up to at least
  # mid-2026 still sends the bare form, everything created from Sept 2026 sends this
  # one.  Only AWS is affected - GCP matches `assertion.repository`, which is unchanged
  # either way, so `repos` above still lists every repo for GCP's benefit.
  #
  # Add an entry here for any newly created repo.  Get the IDs with:
  #   gh api /orgs/<owner> --jq .id
  #   gh api /repos/<owner>/<repo> --jq .id
  #
  # The `couchbase/...` entries for the nodejs/python clients are the same repos as the
  # `couchbaselabs/...` ones above, ready for when they move to the couchbase org: a
  # transfer keeps the repo ID and only changes the owner, so both forms can be trusted
  # up front and the move needs no terraform change.
  immutable_repos = [
    { owner = "couchbase", owner_id = 605755, name = "couchbase-insights-jvm-clients", repo_id = 1355094236 },
    { owner = "couchbase", owner_id = 605755, name = "gocbinsights", repo_id = 1357100214 },
    { owner = "couchbase", owner_id = 605755, name = "operational-insights-dotnet-client", repo_id = 1355318422 },
    { owner = "couchbaselabs", owner_id = 636956, name = "operational-insights-nodejs-client", repo_id = 1356938676 },
    { owner = "couchbaselabs", owner_id = 636956, name = "operational-insights-python-client", repo_id = 1354944681 },
    { owner = "couchbase", owner_id = 605755, name = "operational-insights-nodejs-client", repo_id = 1356938676 },
    { owner = "couchbase", owner_id = 605755, name = "operational-insights-python-client", repo_id = 1354944681 },
  ]

  immutable_repo_names = [for r in local.immutable_repos : "${r.owner}/${r.name}"]
}

output "repos" {
  value = local.repos
}

# Only the repos still on the bare subject form.  An IAM role's trust policy is capped
# at 2048 characters, and a bare entry for a repo that sends the immutable subject can
# never match, so AWS leaves those out rather than spending the budget on them.
output "legacy_repos" {
  value = [for r in local.repos : r if !contains(local.immutable_repo_names, r)]
}

# The same repos in GitHub's immutable subject form, "owner@owner_id/repo@repo_id".
output "immutable_repos" {
  value = [for r in local.immutable_repos : "${r.owner}@${r.owner_id}/${r.name}@${r.repo_id}"]
}
