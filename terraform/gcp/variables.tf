variable "gcp_project_id" {
  description = "The GCP project fit-cli's compute/network/service-account resources are created in. Must already exist with billing enabled - this configuration does not create the project itself."
  type        = string
  # Nb for now fit-cli lives under this project per discussion with SDK management.  It may want to move to its own project at some point.
  default     = "couchbase-qe"
}

# IAM members (e.g. "user:name@couchbase.com", "group:sdk-qe@couchbase.com") allowed
# to open an IAP tunnel to fit-cli's GCP instances and to use OS Login on them.
variable "gcp_iap_members" {
  description = "IAM members granted roles/iap.tunnelResourceAccessor, roles/compute.osLogin, and roles/compute.instanceAdmin.v1, i.e. who can launch fit-cli's GCP instances and reach them over the IAP transport."
  type        = list(string)
  default     = [
      # Internal discussion here https://couchbase.slack.com/archives/G9682CWN7/p1786356769355469?thread_ts=1785939833.137899&cid=G9682CWN7 on which to use
      "group:sdk_core@couchbase.com"
  ]
}
