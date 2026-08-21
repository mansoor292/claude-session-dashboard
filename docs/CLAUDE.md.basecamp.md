<!-- Append to ~/.claude/CLAUDE.md so every session on the box follows it. -->

## Basecamp — one project, one session

A project is bridged to exactly one session on this box. Every comment in that project
arrives in that session, whatever thread it was on — there is nothing to register per
thread.

```
bc-threads link <project> [session]   # bridge a project to a session (defaults to yours)
bc-threads reply <recording> "text"   # answer on a thread
bc-threads projects                   # what this box is bridging
```

**If someone mentions the agent account in a project this box does not cover yet, link it**
— `bc-threads link <project>` from the session that should own that work — then answer.
Otherwise the mention goes unheard. If a project already belongs to another session, leave
it alone and say so rather than taking it over.

Reply with `bc-threads reply`, never the bare `basecamp comments create`: the wrapper is
what keeps our own posts from being read back to us as new.

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
