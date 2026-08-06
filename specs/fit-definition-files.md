This doc covers the FIT definition file format.
This is a human-written doc.  Targeted, specific, reviewed LLM edits are permitted; but keep this doc concise and accurate.

# Definition files
A handful of important top-level workflows, generally ones run on CI, have their own YAML definition files.
These start with:
```
version: 1
type: fit-functional-tests
```
These allow us to drive repeatable workflows, much more reliably than replay files.
See `examples/documented.yaml` for an annotated example; run one with `fit run definition <file.yaml>`.

Definition file rules while generating:
- If there are fields that are added later at runtime, add a very short comment saying that.
- Comments are injected by decorating the definition object with `"//<6 chars>": "text"` marker keys before the field they annotate and replacing them at render time (see `generate-definition.ts`).
- Add new comments there by keying off the field name, not the output text.
- Take a lot of care when adding new fields.  The broad idea is that the definition file should be concise, and we should generate most stuff at runtime - like cbdinocluster init strings, and FITConfigurations - rather than having it here.  That gives us a lot more wiggle room to adapt in future.
    - Generally we will be aiming to have a higher level abstraction of the feature in the definition file, capturing the essentials.  While also having passthrough post-generation patch support so the user can easily customise details like generated FITConfigurations for adhoc experimentation.
    - An exception to this broad rule is the cbdinocluster allocate def file, which we include verbatim as that is also a stable interface.
- Take full advantage of being able to move cluster, cbdinocluster and fitConfig definitions elsewhere in the file and reference them by id.  This makes it much easier to read.

## Definition file versions
- We only have major versions.  Minor and patch are not worth the trouble here.
- Each type of definition file has its own major version, they don't have to align.
- Bump the version when adding or changing any field that controls or changes behaviour — an old fit-cli would silently ignore the new field and produce wrong results.  Purely informational fields (e.g. `description`) don't need a bump.  In practice, almost every new field we add is the first kind, so "adding stuff usually bumps the version" is a reasonable rule of thumb.
- That said: LLMs, please stop and check with the user when considering adding a major version, to confirm it's sensible.  User: don't be afraid to agree :)  Change is good.
- LLMs, also please don't add multiple versions while iterating through a new feature.  We only need to worry about versions at the point when we're making the feature available to others.
- Breaking changes are fine and expected.  We should be refactoring the yaml as we go to keep it clear.
- But, wherever possible, try and automatically upgrade previous versions to new versions, major by major.  Add unit tests for this.
- Generally do this upgrade in-memory but also provide a mini CLI tool that does an inplace upgrade of the definition file.
- In the rare case auto-upgrade isn't possible, explicitly fail fast with an unsupported version error and provide guidance on how the user can resolve it.

## yaml and json5
We support both as input and output formats.  YAML is a little more concise, JSON5 is easier to read (IMO).  Users: use whichever you prefer.
Follow these rules on output regardless:
- Use this sort of casing for multi-word field: gerritRef.  With a handful of exceptions like "transactions-fit-performer" for names.
