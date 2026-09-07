# The set of repos allowed to assume fit-cli's cloud identities via GitHub
# Actions OIDC and GCP's Workload Identity Federation.
# Bare "owner/repo" form; each cloud formats it into its own condition syntax.
locals {
  repos = [
    "couchbaselabs/fit-cli",
    "couchbaselabs/transactions-fit-performer",
    "couchbase/couchbase-jvm-clients",
    "couchbase/couchbase-analytics-jvm-clients",
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
}

output "repos" {
  value = local.repos
}
