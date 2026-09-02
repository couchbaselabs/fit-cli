This doc covers how credentials and AWS secrets are used.
This is a human-written doc.  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate.

# Credentials
The basic goal with clean EC2 testing is that as long as the user has some level of AWS access, we bootstrap into (assume) a `fit-cli-role` that has permissions to do everything.

We use:
* Github PAT for accessing private repos (transactions-fit-performer) and for container images.
* Gerrit creds only if accessing Gerrit patchsets.
* AWS credentials for creating EC2 instances etc.
* Capella creds for Capella testing.

## Secrets
[SECRETS1] We store all credentials for clean cloud testing in AWS secrets.
A core goal is to have the same environment easily spunup from both localhost and CI, and so we want to avoid encoding the secrets into e.g. GHA. 
This is read by fit-cli on the user's machine rather than on the EC2 instance, and written in a hidden way.  The goal is to easily support Azure and GCP in future while maintaining the secrets in one place.
Note that the secrets are easily read with anyone with AWS permissions, and the intention is to hide secrets from those outside Couchbase.
So nothing __too__ secret should be stored - we are talking GHA PATs, Gerrit creds, database passwords, etc.

### Capella
We use the known sdkqe@couchbase.com accounts, which are setup in all Capella envs, for all Capella testing by default.
These are stored in environments.json5 and AWS Secrets [SECRETS1].
[CAPELLA1] The user can provide a different acount in their fit-cli.  This is used both for localhost testing and clean cloud instance testing, an exception to the [CONFIG1] rule.  
[CAPELLA2] cbdinocluster's cloud deployer authenticates with a v4 organization API key and secret.  These live per environment in the same AWS secret (apiKey/apiSecret keys) and can be overridden personally, like the password [CAPELLA1].  The v2 username/password are kept alongside: custom or unreleased image deploys, server version changes, and columnar operations still need them.
[CAPELLA3] A run creates its own ephemeral pool of v4 API keys.  When `defaults.capellaKeyPool.enabled` is set, `cbdinocluster init` on the box creates the pool, and cbdinocluster round robins over its keys.  Capella rate limits per API key, so the pool raises the request budget for the run.  The pool is named after the run's unique stamp, so two runs never share a pool and never rotate each other's keys.  The pool lives in the cbdinocluster config on the box only, never in an env var.  Teardown removes the pool best effort.  The keys also carry an expiry, which is the backstop for a run that dies before its teardown.

## AWS
[SECRETS2] After encountering various problems when using user's localhost credentials in the clean EC2 testing, have decided to settle on EC2 testing exclusively using info from AWS secrets (Github PAT, Gerrit creds, etc).
Those problems included the user's local Github PAT token not being recently SSO-authorised to access couchbaselabs repos (very common).
[AWS1] The exception to this is AWS credentials themselves; the user must already have these.  They don't have to have `aws` installed; they can just get an access key and secret key from the AWS UI and set these via env vars.  These must come from the cb-sdk account for [SECRETS3].
[SECRETS3] There is a `fit-cli-role` that has all permissions needed for clean EC2 testing.  In GHAs we assume this role using OIDC.  When a user runs `fit-cli` we also assume the role.  The goal is that anyone on cb-sdk will be able to assume `fit-cli-role` and it'll work.
If they are not on that account, they should get output guidance on how to achieve it (`AWS_PROFILE="cb-sdk" fit run...`).
Similarly if they do not have AWS setup at all they should get guidance on that.

## Localhost testing
[CONFIG1] By extension of the [SECRETS2] decision, the user's localhost creds are only needed for localhost testing; not for clean cloud testing.  (With [CAPELLA1] excepted.)
So they are stored in a localhost section in the config:
```
cat /home/grahamp-work/.fit-cli/config.json5

{
  version: 1,
  ...
  localhost: {
    github: {
      user: 'programmatix',
      token: 'XXXX'
    },
    ...
  },
}
```
[CONFIG2] We don't try and use the creds in AWS Secrets when user just wants to do local testing, so we can avoid pulling in an AWS dependency. 