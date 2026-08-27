<!-- Append to ~/.claude/CLAUDE.md so every session on the box follows it. -->

## Basecamp — a session hears the places it spoke in, never a whole project

Binding a session to a *project* was tried and retired on 2026-08-25: one link dragged
every unrelated thread in that project into one session. A session is bound to **places** —
the message board it posted to, the card or to-do it commented on. Everything else in the
same project stays silent.

```
bc-threads post <project> <subject> <body>   post a message; starts tracking that board
bc-threads reply <recording> "text"          comment on a thread; starts tracking it
bc-threads places                            what this box is tracking
bc-threads untrack <recording>               stop tracking one place
bc-threads track <recording> [session]       track a place you did not post in
```

**Nothing reaches you unless it @mentions the agent account.** An ordinary comment on a
thread you track is silence. People talk on these threads constantly without needing us,
and forwarding all of it buried the asks that were actually addressed to us. A mention is
someone deciding they want us; that is the only trigger.

**Tracking no longer decides WHETHER something is delivered, only WHERE it goes.** Posting
with `bc-threads post` or `bc-threads reply` registers the place you spoke in, and a mention
there routes to your session rather than being guessed at. `--no-track` opts out of that.
A whole project is not trackable — `track` refuses a project id.

**A mention arrives as a pointer into a transcript you subscribe to.** Each thread has an
append-only file under `~/.claude/bc-transcripts/<thread>.md` holding the whole
conversation in order — theirs and ours, untruncated. The pane message names the file and
the `#### <comment id>` marker where your unread entries start; read from there before
doing anything. This replaced inlining the conversation and the full instruction set into
every delivery: repeated instructions dilute, and sessions were skipping the gates. The
instructions live here, once; the message only says what is new.

The file is current at the moment you are hit; between hits it does not move, because
ordinary comments deliver nothing. `bc-threads sync <thread>` (or bare `sync` for all your
threads) pulls it up to now. **Always sync before you reply** — especially before claiming
a fix: the person may have added constraints, or answered your question, while you worked.

**Never widen the scope by hand.** Do not track a project, a whole dock tool you have not
posted in, or a thread someone merely mentioned. If a mention arrives somewhere this box
does not cover, say so and let the box owner decide — do not go tracking it to "have a look".

Basecamp only supports webhooks per project, so one project webhook is shared by every
place tracked in it. It is created on the first post and removed when the last place there
is untracked — `bc-threads hooks` reconciles both directions. Never create or delete a
webhook with the bare `basecamp webhooks` command; the refcount lives in the registry.

Reply with `bc-threads reply`, never the bare `basecamp comments create`: the wrapper is
what keeps our own posts from being read back to us as new.

### Never claim a fix you have not proven

A person on a thread reads "fixed" as *I can stop worrying about this*. Saying it before it
is true costs them a re-test, a second report, and their trust in every later "fixed" you
send. So the claim waits for evidence, in this order, with no steps skipped and none
reordered:

1. **Reproduce their case first.** Their words, their data, their browser path — not a
   proxy you find easier. If you cannot reproduce it, say so on the thread and ask for the
   missing detail. Never fix by guess.
2. **Make the change.**
3. **Write or extend a Playwright test for their case.** Then check it **fails without your
   change and passes with it** — stash or revert the change and watch it go red. A test
   that passes either way proves nothing and is worse than none, because it will convince
   you.
4. **Run it locally. Green.**
5. **Only now commit.** An unproven change does not enter the history.
6. **Deploy to prod.**
7. **Re-run that same test against prod.** Point the suite at the deployed url rather than
   writing a second test — your web repo's Playwright config may take `BASE_URL` and
   `COACHING_BASE_URL` for exactly this. Local green and prod green are different claims;
   only the second is the one they care about.
8. **Now reply on the thread**, saying what was wrong and that it is verified on prod.

Until step 7 is green, the words "fixed", "done", "deployed", "resolved" and "should be
working" are off limits — in a Basecamp reply, a ping, or a commit message that becomes one.
This is enforced, not just asked: `bc-threads reply` REFUSES a reply containing a fix-claim
unless you pass `--proven "<test file> green against <prod url>"`. Passing `--proven`
without having actually run that test against prod is lying to the person on the thread —
the flag states your evidence, it does not create it. And do not reword the claim to slip
past the check; if the gate cannot apply, say that on the thread and ask.

**When a step is genuinely impossible, say which and why.** Some repos have no Playwright
harness (check before you promise one), some changes are not web-facing, some things
have nothing to deploy. Post that on the thread and ask how they want it verified. What you
must never do is skip a gate silently and report success as though you had passed it — a
missing harness is a thing to raise, not a licence to guess.

**This gates the claim, not the conversation.** Clarifying questions go out immediately, as
always, and a short "looking at this now" is welcome when something will take a while. Only
the assertion that it is fixed waits for prod.

### Being @mentioned

`bc-threads watch` scans every recent comment in the account for a mention of the agent
account. A mention reaches a session only when that session **demonstrably owns** where it
landed — either it tracks that exact thread, or it tracks the board the thread sits on.

**Anything else is not guessed at.** A mention on a thread nobody owns is queued as an
unrouted mention for a human to assign, on the Basecamp page or with `bc-threads assign
<comment id> <session>`. Routing used to fall back on "some session that works elsewhere in
this project" and then on a catch-all session; both were guesses and both misfired, putting
one client's thread into another client's session. Waiting to be assigned is better than
arriving in the wrong place.

So if a thread is quiet, it is not being withheld from you — nobody owns it, and it is
sitting in the queue. Do not go looking for it or `track` it yourself.

A mention delivered by assignment says so: *you have been given this thread by hand*. Treat
that as a cold start — read the replayed history before assuming continuity, and if it
plainly belongs somewhere else, say so rather than taking it on.

**Being mentioned does not track anything by itself.** Answering is what keeps a thread:
`bc-threads reply <thread> "..."` tracks that thread and nothing wider. A mention you
decide is not yours leaves no trace.

Mentions are rendered by name — `@TheBot`, `@A Teammate` — so you can see who else
was tagged and whether the ask was aimed at you or merely near you.

### Two identities — the bot by default, the owner only when told

Two Basecamp profiles are configured on this box, both on one Basecamp account:

| profile | who | when |
|---|---|---|
| `agent` *(default)* | the bot account | everything, unless told otherwise |
| `owner` | your own account | only when the owner says to speak as them |

`agent` is pinned as `default_profile`, so every unattended path — `bc-threads`, the webhook
receiver, cron — posts as the bot account without anyone having to think about it. Leave that
default alone, and never post as a human on your own initiative: a comment under a human name
reads to everyone on the thread as him, not as an agent.

When they do ask you to speak as them, pass the profile and keep using the wrapper:

```
BASECAMP_PROFILE=owner bc-threads reply <recording> "text"   # answers as the owner
basecamp --profile owner projects list                       # reads as the owner
```

**Do not reach for a bare `basecamp comments create --profile owner`.** A comment is
skipped only if the bot account wrote it or `bc-threads reply` recorded its id against the
place. Posted as the owner outside the wrapper it matches neither, so it comes back as a
fresh instruction from him — an echo of your own post.

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

### Writing to Basecamp — the CLI reports success for bodies it did not store

Hit twice on 2026-08-24, both times returning `{ok:true}` with a real id and URL
for a post that was empty or half-missing. **Always read the recording back and
check the content length before calling a post delivered:**

```
basecamp api get "/buckets/<project>/messages/<id>.json" --json \
  --jq '.data.content | length'
```

Two known causes:

- **stdin `-` is not supported**, despite the skill documenting it. `printf ... |
  basecamp messages create "Title" - --in <p>` takes `-` as the *literal body*
  and Markdown-renders it to `<ul><li></li></ul>` — a blank post. Pass the body
  as a real argument instead: `BODY="$(cat body.md)"` then
  `messages create "Title" "$BODY"` or `messages update <id> --body "$BODY"`.
- **An unclosed `<bc-attachment>` swallows the rest of the document.** A missing
  `</bc-attachment>` stored 2.7 KB of a 7.9 KB body — one image and half the
  sections gone, silently.

### Inline images in a message

`messages update` has no `--attach`; `messages create --attach <file>`
(repeatable) does. To get images into an **existing** post without re-notifying
everyone: create a throwaway `--draft` carrying the attachments to mint sgids,
pull them out, then `messages update --body` with

```
<bc-attachment sgid="..." content-type="image/png" caption="..."></bc-attachment>
```

placed where you want each image, and trash the draft. Do not reuse the server's
expanded tag from the draft — it wraps a `<figure>`, so a `<bc-attachment[^>]*>`
regex captures only the opening tag, which is exactly what truncates the body.
Files made with `files uploads create` carry **no** `attachable_sgid` and cannot
be embedded — they only land in Docs & Files. `api post` sends JSON only, so it
cannot reach `/attachments.json` with binary. Raw HTML (`h2`, `ul`, `ol`,
`strong`) passes through the Markdown converter unchanged.

### Check the audience before posting

`bc-threads` can only *reply* — a new message board post must go through
`basecamp messages create`, bypassing the wrapper. That is safe for read-back
(the bridge filters this box's own account via `self` in
`~/.claude/bc-threads.json`), but nothing stops you posting internal detail into
a **client** project, and several bridged projects are named for clients. Before
posting, confirm the audience:

```
basecamp projects show <id> --jq '.data.clients_enabled'
basecamp people list --project <id> --jq '[.data[] | {name, client}]'
```
