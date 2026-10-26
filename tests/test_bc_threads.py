#!/usr/bin/env python3
"""Regression suite for the bc-threads sweep.

Every case here is a bug that shipped: held mentions replaying, edits never seen, posts
never swept, a quarantined owner woken, an MCP dialog blinking its clock away, a submitted
message mistaken for unsent input, a dismissed mention re-queued, a held mention nobody heard
about. The sweep is loaded as a module with Basecamp, tmux and the dashboard stubbed out, so
a run touches nothing on the box.

    python3 tests/test_bc_threads.py
"""
import json, os, sys, tempfile, types, unittest, argparse, re, warnings
warnings.simplefilter("ignore", ResourceWarning)

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "bin", "bc-threads")
ME = 52994184


def load_module(tmp):
    os.environ["BC_THREADS_FILE"] = os.path.join(tmp, "bc-threads.json")
    os.environ["BC_HISTORY_FILE"] = os.path.join(tmp, "bc-history.jsonl")
    os.environ["BC_TRANSCRIPTS_DIR"] = os.path.join(tmp, "transcripts")
    src = open(SRC).read()
    cut = src.rfind("\n", 0, src.index("argparse.ArgumentParser("))
    m = types.ModuleType("bct")
    exec(compile(src[:cut], "bc-threads", "exec"), m.__dict__)
    m.SLEEPING = os.path.join(tmp, "sleeping.json")
    m.GAPS = os.path.join(tmp, "gaps.jsonl")
    return m


def mention(text, who=ME):
    return ('<bc-attachment sgid="x" content-type="application/vnd.basecamp.mention">'
            '<figure>gid://bc3/Person/%d</figure></bc-attachment> %s' % (who, text))


def comment(cid, thread, text, at="2026-10-16T10:00:00.000Z", updated=None, creator=(1, "Christy"),
            project="26534091", kind="Todo", title="Thread"):
    return {"id": cid, "created_at": at, "updated_at": updated or at,
            "creator": {"id": creator[0], "name": creator[1]}, "bucket": {"id": project, "name": "P"},
            "parent": {"id": thread, "title": title, "type": kind, "url": ""},
            "content": mention(text), "app_url": "https://bc/%s" % cid}


class Harness:
    """Stubs for everything that leaves the process."""

    def __init__(self, m, sessions, places, parents=None, last=100):
        self.m, self.sessions, self.deliveries, self.spawns, self.parents = m, sessions, [], [], parents or {}
        self.comments, self.posts = [], []
        m.sessions = lambda: {n: dict(alive=True, status=s, bridge="b") for n, s in self.sessions.items()}
        m.tmux_has = lambda n: n in self.sessions or n == "_dashboard"
        m.pane_blocked = lambda s: False
        m.ensure_bridge = lambda n, wait=30: True
        m.deliver = lambda n, t: self.deliveries.append((n, t))
        m.sweep_comments = lambda limit: list(self.comments)
        m.sweep_posts = lambda: list(self.posts)
        m.whoami = lambda reg: {"id": ME, "name": "AI"}
        m.parent_id = lambda reg, proj, rid, url="": self.parents.get(str(rid), "")
        m.sync_transcript = lambda reg, p, t, title="", url="", write=True, edited=(): ("/tmp/t.md", "1", 1)
        m.dialog_sweep = lambda reg, notify, dry=False: False
        m.orphan_notice = lambda *a, **k: None
        m.ensure_hook = lambda reg, p: None
        m.drop_hook = lambda *a, **k: None
        m.bc = lambda *a, **k: {}
        m.wake = lambda n, wait=120: self.sessions.__setitem__(n, "idle") or True
        m.fetch = lambda p, r: {}
        m.spawn_child = self._spawn
        reg = {"places": places, "parents": {}, "orphans": {}, "edits": {}, "delivered": {},
               "mention_last_id": last, "post_last_id": 0, "transcripts": {}, "self": {"id": ME}}
        m.save(reg)

    def _spawn(self, reg, parent, project, tid, title, url, kind):
        name = parent + "__child"
        self.spawns.append((parent, tid))
        reg["places"][str(tid)] = {"session": name, "kind": kind, "project": project, "title": title}
        self.sessions[name] = "busy"
        return name

    def sweep(self):
        a = argparse.Namespace(no_pings=True, dry_run=False, verbose=False, limit=100, notify="_dashboard")
        self.m.cmd_watch(a)
        return self.m.load()

    def to(self, sess):
        return [t for n, t in self.deliveries if n == sess]


class SweepTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.m = load_module(self.tmp)

    # -- held mentions must not replay what was already delivered --------------------
    def test_held_mention_does_not_replay_delivered_ones(self):
        h = Harness(self.m, {"a": "busy", "b": "idle"},
                    {"T1": {"session": "a", "kind": "Todo", "project": "26534091"},
                     "T2": {"session": "b", "kind": "Todo", "project": "26534091"}})
        h.comments = [comment(101, "T1", "for a"), comment(102, "T2", "for b")]
        reg = h.sweep()
        self.assertEqual(len(h.to("b")), 1)
        self.assertEqual(reg["mention_last_id"], 100, "watermark pinned below the held mention")
        self.assertIn("102", reg["delivered"])
        h.sweep(); h.sweep()
        self.assertEqual(len(h.to("b")), 1, "b must not receive 102 again while a's mention is held")
        h.sessions["a"] = "idle"
        reg = h.sweep()
        self.assertEqual(len(h.to("a")), 1)
        self.assertEqual(reg["mention_last_id"], 102)

    # -- an edited comment is seen once more; Basecamp's own seconds-later bump is not ----
    def test_edit_is_redelivered_once_and_a_tiny_bump_is_not(self):
        h = Harness(self.m, {"a": "idle"}, {"T1": {"session": "a", "kind": "Todo", "project": "26534091"}})
        c = comment(101, "T1", "first")
        h.comments = [c]; h.sweep()
        self.assertEqual(len(h.to("a")), 1)
        c["updated_at"] = "2026-10-16T10:00:09.000Z"; h.sweep()
        self.assertEqual(len(h.to("a")), 1, "a 9-second bump is not an edit")
        c["updated_at"] = "2026-10-16T10:05:00.000Z"; c["content"] = mention("first, and please publish")
        h.sweep()
        self.assertEqual(len(h.to("a")), 2, "a real edit is delivered again")
        self.assertIn("EDITED", h.to("a")[1])
        h.sweep()
        self.assertEqual(len(h.to("a")), 2, "but only once")

    # -- a message-board post is swept like a comment and spawns from the board's owner --
    def test_post_with_mention_spawns_from_board_owner(self):
        h = Harness(self.m, {"a": "idle"}, {"B1": {"session": "a", "kind": "Message::Board", "project": "26534091"}},
                    parents={"103": "B1"})
        h.posts = [{"id": 103, "created_at": "2026-10-16T10:00:00.000Z", "updated_at": "2026-10-16T10:00:00.000Z",
                    "creator": {"id": 1, "name": "Christy"}, "bucket": {"id": "26534091"}, "_post": True,
                    "content": "Q & A\n" + mention("where do I add contacts?"), "app_url": "",
                    "parent": {"id": 103, "title": "Q & A", "type": "Message", "url": ""}}]
        reg = h.sweep()
        self.assertEqual(h.spawns, [("a", "103")])
        self.assertEqual(reg["places"]["103"]["session"], "a__child")
        self.assertLess(reg["post_last_id"], 103, "post watermark pinned below the held post")
        h.sessions["a__child"] = "idle"
        reg = h.sweep()
        self.assertEqual(len(h.to("a__child")), 1)
        self.assertEqual(reg["post_last_id"], 103)

    # -- a quarantined owner is no owner: the mention queues, nothing is woken ------------
    def test_quarantined_owner_queues_instead_of_waking(self):
        h = Harness(self.m, {}, {"T1": {"session": "rogue", "kind": "Message", "project": "49228821"}})
        json.dump({"rogue": {"sid": "x", "cwd": "/tmp", "dir": "/tmp", "quarantine": True}}, open(self.m.SLEEPING, "w"))
        h.comments = [comment(101, "T1", "fix it", project="49228821", kind="Message")]
        reg = h.sweep()
        self.assertIn("101", reg["orphans"])
        self.assertIn("quarantined", reg["orphans"]["101"]["why"])
        self.assertEqual(h.deliveries, [])

    # -- a submitted message echoes with the prompt glyph; that is not a dialog ------------
    def test_echoed_message_is_not_an_overlay(self):
        self.assertFalse(self.m.OVERLAY.search("❯ build it here\n  new task? /clear to save 126k tokens"))
        self.assertTrue(self.m.OVERLAY.search("  MCP server “x” requests your input\n  Esc to cancel"))
        self.assertTrue(self.m.OVERLAY.search("Yes, I accept"))

    # -- a mention held past the nag threshold is reported once -------------------------
    def test_long_hold_is_reported_once(self):
        h = Harness(self.m, {"a": "busy"}, {"T1": {"session": "a", "kind": "Todo", "project": "26534091"}})
        h.comments = [comment(101, "T1", "old ask", at="2026-10-16T05:00:00.000Z")]
        self.m.HOLD_NAG_HOURS = 0.01
        h.sweep(); h.sweep()
        nags = [t for n, t in h.deliveries if n == "_dashboard" and "HELD" in t]
        self.assertEqual(len(nags), 1)
        self.assertIn("Christy", nags[0])

    # -- assign wakes a sleeping target; a quarantined one is refused ---------------------
    def test_assign_wakes_sleeper_and_refuses_quarantined(self):
        h = Harness(self.m, {"_dashboard": "idle"}, {})
        h.comments = [comment(101, "T9", "orphan")]; h.sweep()
        json.dump({"zz": {"sid": "x", "cwd": "/tmp", "dir": "/tmp"}, "q": {"sid": "x", "cwd": "/tmp", "dir": "/tmp", "quarantine": True}},
                  open(self.m.SLEEPING, "w"))
        self.m.tmux_has = lambda n: n in h.sessions
        woke = []
        self.m.wake = lambda n, wait=120: (woke.append(n), h.sessions.__setitem__(n, "idle")) and True
        self.m.register = lambda reg, pid, project, session, **k: reg["places"].setdefault(str(pid), {"session": session, "kind": "Todo", "project": project})
        with self.assertRaises(SystemExit): self.m.cmd_assign(argparse.Namespace(cid="101", session="q", fork=False))
        self.m.cmd_assign(argparse.Namespace(cid="101", session="zz", fork=False))
        self.assertEqual(woke, ["zz"])
        self.assertEqual(len(h.to("zz")), 1)

    # -- a to-do assigned to the agent routes like a mention, once -----------------------
    def test_assignment_routes_once(self):
        h = Harness(self.m, {}, {})
        self.m.sweep_assignments = lambda reg: [{"id": 555, "created_at": "2026-10-21T10:00:00.000Z", "updated_at": "2026-10-21T10:00:00.000Z",
            "creator": {"id": 7, "name": "Bibi"}, "bucket": {"id": "49334092"}, "content": "ASSIGNED TO THE AGENT: covers", "app_url": "",
            "_post": True, "_assigned": True, "parent": {"id": 555, "title": "Full Beauty Brands", "type": "Todo", "url": ""}}]
        reg = h.sweep()
        self.assertIn("555", reg["orphans"], "nobody owns it: it queues for a person")
        self.assertIn("555", reg["assigned_seen"])
        n = len(reg["orphans"]); h.sweep()
        self.assertEqual(len(h.m.load()["orphans"]), n, "injected once, not every sweep")

    # -- dismiss finishes a mention for good ---------------------------------------------
    def test_dismiss_marks_handled(self):
        h = Harness(self.m, {}, {})
        h.comments = [comment(101, "T9", "nobody owns this")]
        reg = h.sweep()
        self.assertIn("101", reg["orphans"])
        self.m.cmd_dismiss(argparse.Namespace(cid="101"))
        reg = h.sweep()
        self.assertNotIn("101", reg["orphans"], "a dismissed mention must not re-queue")
        self.assertIn("101", reg["delivered"])


class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(); self.m = load_module(self.tmp)
        self.m.parent_id = lambda reg, proj, rid, url="": {"L2": "B1", "999": "LIST"}.get(str(rid), "")
        self.m.superseded_by = lambda tid: {"OLD": "NEW"}.get(str(tid), "")
        self.m.tmux_has = lambda n: True
        self.m.ensure_hook = lambda reg, p: None
        self.reg = {"places": {
            "L1": {"session": "owner", "kind": "Todo", "project": "P"},
            "B1": {"session": "parent", "kind": "Message::Board", "project": "P"},
            "NEW": {"session": "succ", "kind": "Message", "project": "P"},
            "M1": {"session": "multi", "kind": "Todo", "project": "P"},
            "M2": {"session": "multi", "kind": "Todo", "project": "P"},
            "LIST": {"session": "lister", "kind": "Todolist", "project": "P"},
        }, "parents": {}, "spawn_per_task": True}

    def test_owned_leaf_delivers_in_place(self):
        self.assertEqual(self.m.nearest_session(self.reg, "P", "L1")[0::2], ("owner", True))
        self.assertEqual(self.m.nearest_session(self.reg, "P", "L1")[3], "")

    def test_container_spawns_a_child(self):
        s, why, owned, spawn_from = self.m.nearest_session(self.reg, "P", "L2")
        self.assertEqual((s, owned, spawn_from), ("parent", True, "parent"))

    def test_superseded_thread_routes_to_successor_owner(self):
        self.assertEqual(self.m.nearest_session(self.reg, "P", "OLD")[0], "succ")

    def test_multi_thread_owner_is_peeled(self):
        s, why, owned, spawn_from = self.m.nearest_session(self.reg, "P", "M1")
        self.assertEqual((s, spawn_from), ("multi", "multi"))
        self.assertIn("peeling", why)

    def test_unknown_thread_is_not_claimed(self):
        self.assertFalse(self.m.nearest_session(self.reg, "P", "ZZZ")[2])

    def test_forwarded_email_is_a_leaf_and_its_inbox_a_container(self):
        self.reg["places"]["INBOX"] = {"session": "parent", "kind": "Inbox", "project": "P"}
        self.m.parent_id = lambda reg, proj, rid, url="": {"FWD": "INBOX"}.get(str(rid), "")
        s, why, owned, spawn_from = self.m.nearest_session(self.reg, "P", "FWD")
        self.assertEqual((s, owned, spawn_from), ("parent", True, "parent"))
        with self.assertRaises(SystemExit): self.m.assert_one_leaf(self.reg, "owner", "FWD", "Inbox::Forward")

    def test_nested_folder_finds_the_vault_owner(self):
        self.reg["places"]["VAULT"] = {"session": "parent", "kind": "Vault", "project": "P"}
        self.m.parent_id = lambda reg, proj, rid, url="": {"DOC": "FOLDER", "FOLDER": "VAULT"}.get(str(rid), "")
        s, why, owned, spawn_from = self.m.nearest_session(self.reg, "P", "DOC")
        self.assertEqual((s, owned, spawn_from), ("parent", True, "parent"))

    def test_one_leaf_per_session(self):
        with self.assertRaises(SystemExit): self.m.assert_one_leaf(self.reg, "owner", "L9", "Todo")
        with self.assertRaises(SystemExit): self.m.assert_one_leaf(self.reg, "_dashboard", "L9", "Message")
        self.m.assert_one_leaf(self.reg, "owner", "LIST2", "Todolist")      # containers do not count
        self.m.assert_one_leaf(self.reg, "owner", "L1", "Todo")             # re-binding its own thread is fine
        self.m.assert_one_leaf(self.reg, "fresh", "L9", "Todo")


class DeliverTests(unittest.TestCase):
    """deliver() must notice when its keystrokes were not taken."""

    def setUp(self):
        self.m = load_module(tempfile.mkdtemp()); self.keys = []; self.status = "idle"; self.pane = ""
        m = self.m; h = self
        class R:
            def __init__(self, args, **k):
                self.stdout = h.pane
                if "send-keys" in args: h.keys.append(args[-1])
        m.subprocess = types.SimpleNamespace(run=lambda args, **k: R(args, **k), CalledProcessError=Exception)
        m.sessions = lambda: {"s": dict(alive=True, status=h.status)}
        m.time = types.SimpleNamespace(time=m.time.time, sleep=lambda x: None, strftime=m.time.strftime)

    def test_taken_when_session_goes_busy(self):
        self.status = "busy"; self.m.deliver("s", "hello there")
        self.assertEqual(self.keys.count("Enter"), 1)

    def test_taken_when_echoed(self):
        self.pane = "\u276f hello there\n"; self.m.deliver("s", "hello there")
        self.assertEqual(self.keys.count("Enter"), 1)

    def test_retyped_once_then_reported(self):
        with self.assertRaises(RuntimeError): self.m.deliver("s", "hello there")
        self.assertEqual(self.keys.count("Enter"), 2)

    def test_prompt_ready(self):
        self.pane = "Resume full session\n  Enter to confirm"; self.assertFalse(self.m.prompt_ready("s"))
        self.pane = "\u276f \n  bypass permissions on"; self.assertTrue(self.m.prompt_ready("s"))


class GateTests(unittest.TestCase):
    def setUp(self):
        self.m = load_module(tempfile.mkdtemp())

    def test_prose_wall(self):
        self.assertEqual(self.m.prose_wall("Done.\n- fixed X\n- next: Y"), "")
        self.assertIn("no bullets", self.m.prose_wall(" ".join(["word"] * 120)))
        self.assertIn("words", self.m.prose_wall("\n".join("- item %d with a few more words here" % i for i in range(40))))

    def test_fix_claims(self):
        for s in ("fixed", "it is now live", "should be working", "deployed"):
            self.assertTrue(self.m.CLAIM_RE.search("ok, %s" % s), s)
        self.assertFalse(self.m.CLAIM_RE.search("looking at this now"))


class DialogTests(unittest.TestCase):
    """The MCP dialog sweep against a scripted pane and a controllable clock."""

    def setUp(self):
        self.m = load_module(tempfile.mkdtemp())
        self.now = 1_000_000.0
        self.pane = ""
        self.keys = []
        m = self.m
        m.sessions = lambda: {"s": dict(alive=True, status="waiting")}
        m.tmux_has = lambda n: True
        self.sent = []
        m.deliver = lambda n, t: self.sent.append(t)
        fake_time = types.SimpleNamespace(time=lambda: self.now, sleep=lambda s: None,
                                          strftime=m.time.strftime, gmtime=m.time.gmtime, localtime=m.time.localtime, strptime=m.time.strptime)
        m.time = fake_time
        harness = self

        class R:  # subprocess.run stand-in
            def __init__(self, args, **k):
                self.stdout = harness.pane
                if "send-keys" in args:
                    harness.keys.append(args[-1])
                    if args[-1] == "Right": harness.pane = harness.pane.replace("❯ Accept    Decline", "Accept  ❯ Decline")
        m.subprocess = types.SimpleNamespace(run=lambda args, **k: R(args, **k), CalledProcessError=Exception)
        self.reg = {"dialogs": {}}

    DIALOG = ("  MCP server “claude.ai Supabase” requests your input\n"
              "  This SQL includes destructive operations (DROP, DELETE, TRUNCATE or UPDAT…\n"
              "  Run it on project abc?\n  ❯ Accept    Decline\n  Esc to cancel")

    def test_blink_keeps_clock_and_pings_once_then_declines(self):
        m = self.m
        self.pane = self.DIALOG; m.dialog_sweep(self.reg, "_dashboard")
        self.assertEqual(len(self.sent), 1); self.assertIn("parked on an MCP dialog", self.sent[0])
        since = self.reg["dialogs"]["s"]["since"]
        self.now += 120; self.pane = "❯ \n  bypass permissions on"; m.dialog_sweep(self.reg, "_dashboard")
        self.assertIn("s", self.reg["dialogs"], "a blink must not drop the record")
        self.now += 180; self.pane = self.DIALOG.replace("UPDAT…", "UPDATE without WHERE)"); m.dialog_sweep(self.reg, "_dashboard")
        self.assertEqual(len(self.sent), 1, "a redraw of the same dialog is not a new one")
        self.assertEqual(self.reg["dialogs"]["s"]["since"], since)
        self.now = since + 31 * 60; m.dialog_sweep(self.reg, "_dashboard")
        self.assertTrue(self.reg["dialogs"]["s"]["declined"])
        self.assertEqual(self.keys[-2:], ["Right", "Enter"])
        self.assertTrue(any("Declined" in t for t in self.sent))

    def test_never_accepts(self):
        m = self.m
        self.pane = self.DIALOG.replace("❯ Accept    Decline", "Accept    Decline")   # cursor nowhere
        m.dialog_sweep(self.reg, "_dashboard")
        self.now += 40 * 60; m.dialog_sweep(self.reg, "_dashboard")
        self.assertNotIn("Enter", self.keys, "Enter is only pressed with the cursor verifiably on Decline")


if __name__ == "__main__":
    unittest.main(verbosity=1)
