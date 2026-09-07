This doc covers GCP support.
This is a human-written doc.  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate.

# Static infra
Like AWS, static GCP infra is under Terraform control. 

# Running commands
GCP IAP is used as the equivalent of AWS SSM: lets us run commands on the instance securely, without having to use ephemeral SSH keys (an approach secteam were unkeen on).
Nb it is still SSH under the hood, unlike SSM: sshd does run on the instance.  The traffic is tunneled over Google's infra.
Unfortunately there is no SDK for IAP: the `gcloud` binary must be installed.

# Instances
Are created in us-west1 in project couchbase-qe.

# Credentials
The goal is the same as AWS: get to a useful pre-created 'thing' (service account in GCP world - `fit-cli-gcp` - a role in AWS) that has the required permissions, ASAP.
This allows a stable testing setup where everything works the same across CI and user laptops.
The mechanism is that a GCP instance is created with service account `fit-cli-gcp` attached.

## On user's laptop
When running on the user's laptop we use local GCP creds (user needs to run `gcloud auth application-default login` first) to get there.
Only some users are allowed to create instances with `fit-cli-gcp` attached.  Decided by google_service_account_iam_member.fit_cli_gcp_user.

## On CI
The GCP equivalent of OIDC (used by CI to safely assume the fit-cli-role AWS role) is Workload Identity Federation (WIF).  
They map very closely and the end result is similar: GitHub's OIDC token is exchanged for short-lived GCP credentials that fit-cli uses to assume service account `fit-cli-gcp`.

## On created instances
The instance's GCP metadata server will create short-lived tokens for `fit-cli-gcp` service account automatically.
Then anything running on this instance that uses GCP Application Default Credentials will pick them up transparently, effectively running as `fit-cli-gcp`.
No credential file is ever written to disk (unlike AWS).

## Admin
The author (grahamp) needs to apply for GCP admin privileges via Zendesh whenever some Terraform changes are required:
particularly when adding new repos.
Specifically roles/iam.workloadIdentityPoolAdmin on couchbase-qe is required.