<!-- Append to ~/.claude/CLAUDE.md so every session on the box follows it. -->

## Basecamp threads — always post through `bc-threads`

Post and reply with `bc-threads`, never the bare `basecamp messages create` /
`basecamp comments create`. It wraps the same CLI but records which session owns the
thread, so human replies come back to you instead of being lost:

```
bc-threads post <project> "Subject" "body"    # new thread, registered automatically
bc-threads reply <recording_id> "text"        # answer on a thread
bc-threads list                               # threads this box is watching
```

`bc-watch.timer` polls every 90s and types new human comments into the owning session,
with the thread URL and the exact reply command. If you post with the raw CLI instead,
nobody hears the answer.

**Never execute an ill-formed ask.** A delivered comment or ping is a request from a real
person who is reachable — so when it is underspecified, ask them, do not guess and do not
half-build something and hope.

1. Decide whether the ask is fully specified. Anything you would have to guess at — scope,
   which repo or file, what "done" looks like, a constraint nobody stated — means it is not.
2. If it is not, reply on the thread with your questions: numbered, specific, and all of
   them in one reply rather than trickling them out over an afternoon. Do not ask what you
   could answer yourself by reading the code, the repo, or the rest of the thread — check
   first, ask only what genuinely needs a person.
3. Their answers come back to you the same way the original did. Once the ask is clear —
   immediately, if it already was — do the work and report back on the thread.

`bc-threads reply` / `ping-reply` go out under this box's Basecamp account and are visible
immediately to everyone on the thread, clients included, so write them for that audience:
plain, brief, no internal jargon or file paths nobody there recognises.
