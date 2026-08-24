<!-- Append to ~/.claude/CLAUDE.md so every session on the box follows it. -->

## API keys — use them, never look at them

Shared keys (Twilio, SendGrid, HubSpot, Firecrawl, Gemini, Kartra, Smartlead, Spoke, the
catalogs MCP) are already in your environment. `~/.claude/secrets/.env` is the only place
the values live; sessions get them injected at launch.

Reference them by name and let the shell expand them:

```bash
curl -H "Authorization: Bearer $HUBSPOT_API_KEY" ...      # correct
python3 -c 'import os; k = os.environ["SENDGRID_API_KEY"]' # correct
```

**Never render a value into your own output.** No `echo $KEY`, no `env`, no `cat` of the
secrets file, no writing a key into a config file, script, or commit — anything you print
lands in the transcript and syncs to claude.ai, and the only fix afterwards is rotating the
key. If you need to check one is present, test its length or emptiness, not its content:
`[ -n "$KEY" ]`.

If a key you need is missing, say which name is missing and stop — do not go looking for it
in files or ask for it to be pasted into the conversation.
