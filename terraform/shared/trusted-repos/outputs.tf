# The set of repos allowed to assume fit-cli's cloud identities via GitHub
# Actions OIDC and GCP's Workload Identity Federation.
# Bare "owner/repo" form; each cloud formats it into its own condition syntax.
locals {
  repos = [
    "couchbaselabs/fit-cli",
    "couchbaselabs/transactions-fit-performer",
    "couchbaselabs/operational-insights-nodejs-client",
    "couchbaselabs/operational-insights-python-client",
    "couchbase/couchbase-jvm-clients",
    "couchbase/couchbase-analytics-jvm-clients",
    "couchbase/couchbase-insights-jvm-clients",
    "couchbase/couchbase-cxx-client",
    "couchbase/couchbase-net-client",
    "couchbase/gocb",
    "couchbase/gocbinsights",
    "couchbase/couchnode",
    "couchbase/couchbase-python-client",
    "couchbase/couchbase-ruby-client",
    "couchbase/couchbase-rs",
    "couchbase/couchbase-php-client",
    "couchbase/analytics-dotnet-client",
  ]

  # GitHub has started issuing "immutable OIDC subjects" for recently created repos:
  # the `sub` claim carries the numeric owner and repo IDs, e.g.
  # "repo:couchbase@605755/gocbinsights@1357100214:*", so a repo created later cannot
  # reuse an earlier repo's name to inherit its trust.  Older repos still send the bare
  # "repo:owner/repo:*" form, and a given repo sends one form or the other, so AWS
  # trusts both - listing a repo in both places is harmless.  Only AWS is affected:
  # GCP matches on `assertion.repository`, which is unchanged either way.
  #
  # Add an entry here for any newly created repo (and if GitHub later flips the older
  # repos over, they go here too).  Get the IDs with:
  #   gh api /orgs/<owner> --jq .id
  #   gh api /repos/<owner>/<repo> --jq .id
  immutable_repos = [
    { owner = "couchbase", owner_id = 605755, name = "couchbase-insights-jvm-clients", repo_id = 1355094236 },
    { owner = "couchbase", owner_id = 605755, name = "gocbinsights", repo_id = 1357100214 },
    { owner = "couchbaselabs", owner_id = 636956, name = "operational-insights-nodejs-client", repo_id = 1356938676 },
    { owner = "couchbaselabs", owner_id = 636956, name = "operational-insights-python-client", repo_id = 1354944681 },
  ]
}

output "repos" {
  value = local.repos
}

# The same repos in GitHub's immutable subject form, "owner@owner_id/repo@repo_id".
output "immutable_repos" {
  value = [for r in local.immutable_repos : "${r.owner}@${r.owner_id}/${r.name}@${r.repo_id}"]
}
