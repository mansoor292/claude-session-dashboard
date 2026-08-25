## Splitting a session by context

When a session is carrying two jobs at once, you can hand one of them to a fresh session:

```
session-split <new-name> <brief-file>          # brief from a file
session-split <new-name> -                     # brief on stdin
session-split <new-name> brief.md --cwd ~/Code/foo
```

This is **not** a fork. The dashboard's ⑂ button forks with `--fork-session`, copying the
whole transcript — every tangent included, which is usually the thing you were trying to
get rid of. A split starts a session with a **clean context** holding exactly one thing:
a brief you wrote. There is no way to slice a real conversation history; a distilled brief
is the mechanism, and in practice it is the better one.

**You write the brief, so you decide what survives.** A summary of the conversation is not
a brief. What the new session needs is:

  GOAL          what done looks like, in a sentence or two
  DECIDED       what is already settled, and WHY — otherwise it gets relitigated
  STATE         files touched, what is committed, what is half-finished
  OUT OF SCOPE  what it must not wander into
  OPEN          what is genuinely still undecided

Say plainly what you do not know. The new session is told to ASK rather than assume, so an
honest OPEN section costs one question; a brief that quietly papers over a gap costs a
wrong turn. Do not claim something was decided if it was only mentioned.

**What it will not have:** anything you left out. Not the wording of a request forty turns
back, not a constraint you took as read, not a file you forgot to name. Before you split,
reread the brief and ask whether someone who had never seen this conversation could act on
it. If not, it is not finished.

Use a split when the work genuinely divides — two features, or a long investigation whose
conclusion is all the next step needs. Use the ⑂ branch when the new session needs the
*same* history and an isolated git worktree. If neither is clearly right, ask rather than
guess: the choice is cheap to make and expensive to undo.
