This doc covers how CNG is tested.
This is a human-written doc.  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate.

We test CNG on a [shared ROSA OpenShift cluster](https://github.com/couchbaselabs/sdkqe-rosa-tf) owned by the CNG team, as this is their recommendation as the only setup that can 100% end-to-end testing with CNG [source](https://couchbase.slack.com/archives/C04DB7P157T/p1781030728929899?thread_ts=1780922194.086169&cid=C04DB7P157T).

CNG is not currently supported on localhost testing, only on clean cloud instances, though it might be possible to get it working.  It has a dependency on at least the OpenShift tooling (`oc`).

# Docker images
## Server
Server images we run on ROSA OpenShift need to come from `cb-rhcc` rather than usual `cb-vanilla` repo.  [source](https://couchbase.slack.com/archives/C04DB7P157T/p1781783413258219)

https://github.com/orgs/cb-rhcc/packages/container/package/server

The same versions _should_ exist on both, so cb-alias labels like "8.0-stable" _should_ work for both.  
But we have seen cases where that does not happen.  [source](https://couchbase.slack.com/archives/C04DB7P157T/p1781783413258219) [source](https://couchbase.slack.com/archives/CDPKTQYP9/p1781794972308139)

## CNG
Cloud Native Gateway gets installed from: 
https://github.com/orgs/cb-rhcc/packages/container/package/cloud-native-gateway

# ROSA OpenShift
You can install the OpenShift CLI (`oc`) and then interact with the shared ROSA OpenShift cluster for debugging:

```
# Login - request password on #protostellar, or use `aws secretsmanager get-secret-value --secret-id fit-cli/rosa/openshift` if you have permissions
oc login https://api.sdkqe-rosa.rmuu.p3.openshiftapps.com:443 -u cluster-admin

# Couchbase clusters
oc get couchbaseclusters.couchbase.com --all-namespaces \
  -o 'custom-columns=NAMESPACE:.metadata.namespace,NAME:.metadata.name,STARTED:.metadata.creationTimestamp,STATUS:.status.conditions[-1].type' \
  --sort-by=.metadata.creationTimestamp

# Emergency cleanup - delete a cluster (really it's deleting the only cluster in a particular namespace).
oc delete couchbasecluster cluster -n cbdc2-f92ba....ed03ea
```

## Cleanup on ROSA OpenShift
There should be a cleanup job that clears up dangling clusters after some time.  [source](https://couchbase.slack.com/archives/C04DB7P157T/p1781868246427409)

The cleanup job is cbdc-cleanup-cronjob, in namespace cbdc-shared (schedule */15 * * * *). To see its logs:

Recent runs:
oc get jobs -n cbdc-shared --sort-by=.status.startTime -o custom-columns=NAME:.metadata.name,START_TIME:.status.startTime,COMPLETIONS:.status.succeeded

Logs from the most recent run:
oc logs -n cbdc-shared job/$(oc get jobs -n cbdc-shared --sort-by=.status.startTime -o name | tail -1 | cut -d/ -f2)

For reference, the job itself just runs `cbdinocluster init -v --auto && cbdinocluster cleanup -v` from a fresh alpine container each time.

To force remove all cbdino clusters (note this is an emergency operation, as it will get rid of everything including active healthy clusters that just happen to be being created):

cbdinocluster -v ls 2>&1 | grep 'State: creating' | awk '{print $1}' | xargs -I{} cbdinocluster remove {}
