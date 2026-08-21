# The GCP equivalent of fit-cli-role.tf's GitHub OIDC trust policy: lets GitHub
# Actions runs in the same trusted repos (see ../shared/trusted-repos) exchange
# their GitHub-issued OIDC token for short-lived credentials as fit_cli_gcp,
# with no static key ever stored in GitHub or GCP.

module "trusted_repos" {
  source = "../shared/trusted-repos"
}

data "google_project" "current" {
  project_id = var.gcp_project_id
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.gcp_project_id
  workload_identity_pool_id = "fit-cli-github"
  display_name              = "fit-cli GitHub Actions"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.gcp_project_id
  workload_identity_pool_id         = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                      = "GitHub Actions OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  # Allow specific user forks here along with `trusted_repos`.  The matrix of SDK members * SDK repos is too much to allow all of them,
  # plus fit-cli GHAs are generally minimal and just call a shared fit-cli GHA so don't really need testing anyway.
  attribute_condition = "assertion.repository in ${jsonencode(module.trusted_repos.repos)} || (assertion.repository == \"programmatix/couchbase-jvm-clients\" && assertion.actor == \"programmatix\")"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Grants any identity from this pool (already restricted to the trusted repos
# above by attribute_condition) permission to impersonate fit_cli_gcp - the
# GCP analog of fit-cli-role.tf's sts:AssumeRoleWithWebIdentity trust.
resource "google_service_account_iam_member" "fit_cli_gcp_workload_identity" {
  service_account_id = google_service_account.fit_cli_gcp.name
  role                = "roles/iam.workloadIdentityUser"
  member              = "principalSet://iam.googleapis.com/projects/${data.google_project.current.number}/locations/global/workloadIdentityPools/${google_iam_workload_identity_pool.github.workload_identity_pool_id}/*"
}
