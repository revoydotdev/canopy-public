# gate:remedy-coverage canary — why this fixture is a bare package.json

The fixture's entire content is a `package.json` whose `scripts` map is empty.
That is the input: `enumerateGates(REPO_ROOT)` returns no gate names, so all
five `EXEMPT_GATES` entries name a gate that is "no longer in package.json" and
the gate exits non-zero.

`link_repo_paths: ["scripts"]` is required and is the interesting half. Without
it, `loadSource` returns null for every cited file and the gate would ALSO report
"exempt entry cites … which no longer exists" — a second, unrelated failure
reason. With the link, the five `verify(text)` predicates read the real current
source and pass, so the failure isolates to exactly one declared condition: the
roster drifted out from under the exemption list.

The `over_floor` ratchet — the rule the gate's header spends most of its prose on
— cannot be exercised from any fixture. `EXEMPT_GATES` is a frozen literal in
the gate's own source; nothing a caller can pass reaches it. See the report.

## Obligations

None.
