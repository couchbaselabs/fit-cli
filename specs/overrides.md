This doc covers useful CLI overrides.
This is a human-written doc.  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate.

Most versions are controlled by environments.json5 and they can all be overridden with --env-override.  See examples below.

# cbdinocluster version
Use a cbdino PR:
```
fit run preset op-capella-sit-lite --override setup.cbdinocluster.source.git.pr=456
```

Use a released version:
```
fit run preset op-capella-sit-lite --env-override defaults.cbdinoclusterVersion=v0.0.121
```

# Server version
```
fit run preset op-onprem-func-lite --performer java-fit-performer:main --env-override defaults.clusterVersion=7.6-stable
```

# transactions-fit-performer
Use a Gerrit changeset:
```
fit run preset op-capella-sit-lite --performer scala-fit-performer:main --override setup.repos.transactions-fit-performer.gerritRef=refs/changes/45/249345/2
```

Use a local repo:
```
fit run preset op-capella-sit-lite --performer scala-fit-performer:main --interactive --repo-dir transactions-fit-performer=/path/to/local/tfp/checkout
```