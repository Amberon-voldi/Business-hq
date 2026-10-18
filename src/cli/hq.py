#!/usr/bin/env python3
"""hq: command-line client for business-hq (the AI Interns coordination server).

Single file, Python 3.8+ standard library only. Install:

    mkdir -p ~/.local/bin
    curl -fsSL https://<worker>/agent/hq -o ~/.local/bin/hq && chmod +x ~/.local/bin/hq
    hq setup --url https://<worker> --key <your agent key>

Always-on loop:  while true; do hq wait && hq checkin; <handle it>; done
Run `hq --help` or `hq <command> --help` for details.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

VERSION = "1.0.0"
CONFIG_PATH = os.path.join(
    os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "business-hq", "config.json"
)
KINDS = ["general", "email", "research", "social", "copy", "code", "doc"]
OWNERS = ["Code", "Pro", "Grok", "Muse"]


class HqError(Exception):
    pass


# ---------- config ----------
def load_config():
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
    url = os.environ.get("HQ_URL") or cfg.get("url")
    key = os.environ.get("HQ_KEY") or cfg.get("key")
    if not url or not key:
        raise HqError("Not set up. Run: hq setup --url https://<worker> --key <your agent key>")
    return url.rstrip("/"), key


def save_config(url, key):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    fd = os.open(CONFIG_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"url": url.rstrip("/"), "key": key}, f)


# ---------- http ----------
def call(method, path, body=None, raw=False):
    url, key = load_config()
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{url}/agent/v1{path}",
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": f"hq/{VERSION}"},
    )
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                text = resp.read().decode()
                return text if raw else (json.loads(text) if text else None)
        except urllib.error.HTTPError as e:
            text = e.read().decode()
            try:
                msg = json.loads(text).get("error", text)
            except ValueError:
                msg = text or e.reason
            if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                last = msg
                time.sleep(2 ** attempt)
                continue
            raise HqError(f"{e.code}: {msg}")
        except urllib.error.URLError as e:
            last = str(e.reason)
            if attempt < 3:
                time.sleep(2 ** attempt)
                continue
    raise HqError(f"Could not reach business-hq: {last}")


# ---------- output ----------
def out(data, as_json):
    if isinstance(data, str) and not as_json:
        print(data)
    else:
        print(json.dumps(data, indent=2, ensure_ascii=False))


def print_messages(messages):
    for m in messages:
        biz = f" [{m['business']}]" if m.get("business") else ""
        task = f" (task {m['taskId']})" if m.get("taskId") else ""
        print(f"  {m['from']} → {m['to']}{biz}{task}: {m['text']}")


def print_tasks(tasks):
    for t in tasks:
        print(f"  {t['id']}  [{t['business']}/{t['kind']}] {t['status']}: {t['task']}")


def read_body(args):
    if getattr(args, "file", None):
        with open(args.file) as f:
            return f.read()
    if getattr(args, "text", None):
        return args.text
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise HqError("Give the content with --file, --text, or pipe it on stdin")


# ---------- commands ----------
def cmd_setup(a):
    save_config(a.url, a.key)
    me = call("GET", "/me")
    print(f"✓ Connected to {a.url} as {me['owner']}. Config saved to {CONFIG_PATH} (mode 600).")
    print(f"  Businesses: {', '.join(b['id'] for b in me['businesses'])}")
    print("  Next: hq checkin")


def cmd_me(a):
    out(call("GET", "/me"), a.json)


def cmd_checkin(a):
    me = call("GET", "/me")
    msgs = call("GET", "/messages")
    tasks = call("GET", "/tasks")["tasks"]
    if a.json:
        return out({"owner": me["owner"], "unreadMessages": msgs["unread"], "tasks": tasks}, True)
    print(f"{me['owner']} · {len(msgs['unread'])} new message(s) · {len(tasks)} open task(s)")
    if msgs["unread"]:
        print("\nMessages:")
        print_messages(msgs["unread"])
    if tasks:
        print("\nInbox (oldest first):")
        print_tasks(tasks)
        print("\nNext: hq task <id>  →  hq claim <id>  →  hq complete <id> --summary '…' --file result.md")
    elif not msgs["unread"]:
        print("Nothing to do. Use `hq wait` to sleep until work arrives.")


def cmd_briefing(a):
    q = f"?business={a.business}" if a.business else ""
    print(call("GET", f"/briefing{q}", raw=True))


def cmd_tasks(a):
    tasks = call("GET", "/tasks")["tasks"]
    if a.json:
        return out(tasks, True)
    if not tasks:
        print("Inbox empty.")
    print_tasks(tasks)


def cmd_task(a):
    t = call("GET", f"/tasks/{a.id}")
    if a.json:
        return out(t, True)
    print(f"# Task {t['id']} · {t['business']} · {t['kind']} · {t['status']}")
    if t.get("delegatedBy"):
        print(f"Delegated by {t['delegatedBy']}")
    if t.get("notionTaskUrl"):
        print(f"Notion: {t['notionTaskUrl']}")
    print("\n=== SYSTEM PROMPT (context + rules) ===\n" + t["prompt"]["system"])
    print("\n=== TASK ===\n" + t["prompt"]["user"])


def cmd_claim(a):
    out(call("POST", f"/tasks/{a.id}/claim"), a.json)


def cmd_complete(a):
    body = {"output": read_body(a)}
    if a.summary:
        body["summary"] = a.summary
    r = call("POST", f"/tasks/{a.id}/complete", body)
    if a.json:
        return out(r, True)
    print(f"✓ Done: {r['summary']}")
    for w in r.get("warnings", []):
        print(f"  ⚠ {w}")


def cmd_fail(a):
    out(call("POST", f"/tasks/{a.id}/fail", {"reason": a.reason}), a.json)


def cmd_delegate(a):
    body = {"task": " ".join(a.task), "kind": a.kind}
    for k in ("to", "business", "notes", "parent"):
        v = getattr(a, k)
        if v:
            body[{"to": "owner", "parent": "parent_task_id"}.get(k, k)] = v
    r = call("POST", "/delegate", body)
    if a.json:
        return out(r, True)
    print(f"✓ Delegated to {r['owner']} ({r['business']}), task {r['id']} [{r['status']}]")


def cmd_msg(a):
    body = {"to": a.to, "text": " ".join(a.text)}
    if a.business:
        body["business"] = a.business
    if a.task:
        body["task_id"] = a.task
    r = call("POST", "/messages", body)
    if a.json:
        return out(r, True)
    print(f"✓ Sent to {r['to']}")


def cmd_inbox(a):
    r = call("GET", "/messages" + ("?history=1" if a.history else ""))
    if a.json:
        return out(r, True)
    if not r["unread"]:
        print("No new messages.")
    print_messages(r["unread"])
    if a.history and r.get("recentTeamFeed"):
        print("\nRecent team chat:")
        print_messages(r["recentTeamFeed"])


def cmd_log(a):
    body = {"message": " ".join(a.message)}
    if a.business:
        body["business"] = a.business
    out(call("POST", "/log", body), a.json)


def cmd_wait(a):
    """Blocks until there is a task or an unread message. Exit 0 = work waiting, 2 = timed out."""
    start = time.time()
    while True:
        p = call("GET", "/pending")
        if p["tasks"] or p["unread"]:
            if a.json:
                return out(p, True)
            print(f"{p['tasks']} task(s), {p['unread']} message(s) waiting. Run: hq checkin")
            return
        if a.timeout and time.time() - start >= a.timeout:
            if not a.quiet:
                print("Nothing arrived before the timeout.")
            sys.exit(2)
        time.sleep(max(a.interval, 15))


def main():
    p = argparse.ArgumentParser(prog="hq", description="business-hq CLI for AI Interns")
    p.add_argument("--json", action="store_true", help="raw JSON output")
    p.add_argument("--version", action="version", version=f"hq {VERSION}")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("setup", help="save the server URL and your agent key")
    s.add_argument("--url", required=True)
    s.add_argument("--key", required=True)
    s.set_defaults(fn=cmd_setup)

    sub.add_parser("me", help="who you are, businesses, teammates").set_defaults(fn=cmd_me)
    sub.add_parser("checkin", help="new messages (marked read) + your open tasks").set_defaults(fn=cmd_checkin)

    s = sub.add_parser("briefing", help="shared context from the businesses' HQ docs")
    s.add_argument("--business")
    s.set_defaults(fn=cmd_briefing)

    sub.add_parser("tasks", help="your inbox").set_defaults(fn=cmd_tasks)

    for name, fn, hlp in (("task", cmd_task, "show a task with its ready-made prompt"), ("claim", cmd_claim, "mark a task in progress")):
        s = sub.add_parser(name, help=hlp)
        s.add_argument("id")
        s.set_defaults(fn=fn)

    s = sub.add_parser("complete", help="submit a deliverable (Markdown); it's written to Notion")
    s.add_argument("id")
    s.add_argument("--summary", help="one sentence")
    s.add_argument("--file", help="read the deliverable from this file")
    s.add_argument("--text", help="the deliverable inline")
    s.set_defaults(fn=cmd_complete)

    s = sub.add_parser("fail", help="only when blocked: marks it Blocked and says what you need")
    s.add_argument("id")
    s.add_argument("--reason", required=True)
    s.set_defaults(fn=cmd_fail)

    s = sub.add_parser("delegate", help="hand work to a teammate")
    s.add_argument("task", nargs="+")
    s.add_argument("--to", choices=OWNERS, help="teammate (optional if --kind implies one)")
    s.add_argument("--kind", choices=KINDS, default="general")
    s.add_argument("--business")
    s.add_argument("--notes")
    s.add_argument("--parent", help="your task id this is part of")
    s.set_defaults(fn=cmd_delegate)

    s = sub.add_parser("msg", help="message a teammate, Human or team")
    s.add_argument("to", help="Code | Pro | Grok | Muse | Human | team")
    s.add_argument("text", nargs="+")
    s.add_argument("--business")
    s.add_argument("--task")
    s.set_defaults(fn=cmd_msg)

    s = sub.add_parser("inbox", help="read new messages (marked read)")
    s.add_argument("--history", action="store_true", help="include recent team chat")
    s.set_defaults(fn=cmd_inbox)

    s = sub.add_parser("log", help="add a note to a business's HQ Log in Notion")
    s.add_argument("message", nargs="+")
    s.add_argument("--business")
    s.set_defaults(fn=cmd_log)

    s = sub.add_parser("wait", help="block until a task or message arrives (exit 0), or timeout (exit 2)")
    s.add_argument("--interval", type=int, default=60, help="seconds between polls (min 15, default 60)")
    s.add_argument("--timeout", type=int, default=0, help="give up after N seconds (0 = never)")
    s.add_argument("--quiet", action="store_true")
    s.set_defaults(fn=cmd_wait)

    args = p.parse_args()
    try:
        args.fn(args)
    except HqError as e:
        print(f"hq: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
