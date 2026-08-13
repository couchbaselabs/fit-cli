# The service account attached to every GCP box fit-cli launches.
resource "google_service_account" "fit_cli_gcp" {
  project      = var.gcp_project_id
  account_id   = "fit-cli-gcp"
  display_name = "fit-cli GCP compute"
  description  = "Attached to GCP instances fit-cli launches. Managed by Terraform in couchbaselabs/fit-cli - don't edit directly."
}

locals {
  fit_cli_gcp_instance_roles = [
    "roles/compute.networkAdmin",
    "roles/compute.viewer",
    "roles/dns.admin",
    "roles/compute.instanceAdmin.v1",
  ]
}

resource "google_project_iam_member" "fit_cli_gcp_instance_roles" {
  for_each = toset(local.fit_cli_gcp_instance_roles)
  project  = var.gcp_project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.fit_cli_gcp.email}"
}

# Lets fit-cli (human or CI) attach this service account when launching an instance.
resource "google_service_account_iam_member" "fit_cli_gcp_user" {
  for_each           = toset(var.gcp_iap_members)
  service_account_id = google_service_account.fit_cli_gcp.name
  role               = "roles/iam.serviceAccountUser"
  member             = each.value
}

# Who can open an IAP tunnel to fit-cli's instances at all.
resource "google_project_iam_member" "fit_cli_iap_tunnel_accessor" {
  for_each = toset(var.gcp_iap_members)
  project  = var.gcp_project_id
  role     = "roles/iap.tunnelResourceAccessor"
  member   = each.value
}

# OS Login for the same members — maps their IAM identity to a POSIX account
# and ephemeral key server-side, replacing key-pair management.
resource "google_project_iam_member" "fit_cli_os_login" {
  for_each = toset(var.gcp_iap_members)
  project  = var.gcp_project_id
  role     = "roles/compute.osLogin"
  member   = each.value
}

resource "google_project_iam_member" "fit_cli_instance_admin" {
  for_each = toset(var.gcp_iap_members)
  project  = var.gcp_project_id
  role     = "roles/compute.instanceAdmin.v1"
  member   = each.value
}
