#!/usr/bin/env python3
"""A local stand-in for a Mattermost server, logging every call, so the panel's real request path can be checked.

POST /__mock with a JSON object changes its state (see STATE), and {"ws": {...}} pushes an event down every websocket."""
import base64, hashlib, json, os, re, struct, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

LOG = open(sys.argv[1], "a", buffering=1)
IMAGE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../mods/mattermost/demo/media/f-dashboard.jpg")
NOW = int(time.time() * 1000)
ME = "me1"
closed_shown = False
custom = {"emoji": "house", "text": "Working from home", "duration": ""}
STATE = {
    "status": "online", "manual": False, "pref": None,
    "license": {"IsLicensed": "true", "SkuShortName": "professional", "LDAPGroups": "false"},
    "config": {"EnableCustomUserStatuses": "true", "BuildEnterpriseReady": "true", "EnablePublicLink": "true", "EnableCustomGroups": "true"},
    "notify": {"mention_keys": "@sam,@channel,b2c,on:call", "first_name": "true", "channel": "true", "highlight_keys": "regression,dry-run"},
    "first_name": "Sam", "team_constrained": False, "channel_constrained": False,
    "groups": [{"id": "g1", "name": "b2c_team", "allow_reference": True, "delete_at": 0, "source": "custom"}, {"id": "g2", "name": "nope", "allow_reference": False, "delete_at": 0, "source": "custom"}, {"id": "g3", "name": "ldapers", "allow_reference": True, "delete_at": 0, "source": "ldap"}],
    "channel_groups": {},
    # Jira's notifications, served on /gateway/api/graphql. Replace the list through /__mock to test the empty state.
    "jira": [],
}
JIRA_AUTH = "Basic " + base64.b64encode(b"sam@x.example:fake-jira-token").decode()
JIRA_ICONS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../mods/mattermost/demo/jira")
J = "http://127.0.0.1:18069"
# Issue type icons sit behind the site's login, as on Jira Cloud; Confluence's page icon is public.
JIRA_ICON_IDS = {"10318": "task", "10303": "bug", "10315": "story"}
def jira_adf(text, link=None):
    content = [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]
    if link: content.append({"type": "bulletList", "content": [{"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": link, "marks": [{"type": "link", "attrs": {"href": link}}]}]}]}]})
    return json.dumps({"type": "doc", "version": 1, "content": content})
def jira_note(i, category, minutes, read, actor, message, where, comment=None, link=None, avatar=True):
    page = "space" in where
    base = f"{J}/wiki/spaces/ME/pages/{where['id']}" if page else f"{J}/browse/{where['key']}"
    url = f"{base}?focusedCommentId=9{i[1:]}#comment-9{i[1:]}" if comment else base
    return {"notificationId": i, "category": category, "readState": "read" if read else "unread",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(NOW / 1000 - minutes * 60)),
            "content": {"type": "created", "message": f"{actor} {message}", "url": url,
                        "actor": {"displayName": actor, "avatarURL": f"{J}/jira-avatars/u-jamie.png" if avatar else None},
                        "entity": {"title": where["title"], "url": url, "contentSubtype": None, "status": where.get("status"),
                                   "iconUrl": f"{J}/assets/confluence-page-icon.svg" if page else f"{J}/rest/api/2/universal_avatar/view/type/issuetype/avatar/{where['icon']}?size=medium"},
                        "path": [{"title": where["space"] if page else where["key"], "url": base}],
                        "bodyItems": [{"type": "PRIMARY", "appearance": "PRIMARY", "document": {"format": "ADF", "data": jira_adf(comment, link)}}] if comment else []}}
BUG12 = {"key": "BUG-12", "icon": "10303", "title": "Login loops on Android 15 after the session expires while the app is in the background", "status": "In Progress"}
SPEC = {"space": "Mobile Engineering", "id": "777", "title": "Release 2.0 plan"}
# Each list is a group: its head first, then the older items Jira folds under it.
STATE["jira"] = [
    [jira_note("j1", "direct", 5, False, "Ann B", "commented on a work item", BUG12, "@Sam G can you take a look at the logs? It starts after the token refresh.", "https://logs.x.example/search?q=session-expired&from=now-1h"),
     jira_note("j6", "direct", 30, False, "Ann B", "updated a work item", BUG12),
     jira_note("j7", "direct", 60, True, "Bob C", "commented on a work item", BUG12, "Seen it too.", avatar=False)],
    [jira_note("j2", "direct", 90, False, "Automation for Jira", "assigned a work item to you", {"key": "BUG-9", "icon": "10318", "title": "Rotate the API keys", "status": "To Do"}, avatar=False)],
    [jira_note("j3", "direct", 26 * 60, False, "Ann B", "changed the status of a work item", {"key": "APP-3", "icon": "10315", "title": "Dark mode for settings", "status": "Done"})],
    [jira_note("j4", "watching", 40, False, "Ann B", "commented on a page", SPEC, "Moving the date by a week."),
     jira_note("j8", "watching", 50, False, "Bob C", "updated a page", SPEC, avatar=False)],
    [jira_note("j5", "direct", 3 * 24 * 60, True, "Ann B", "created a work item", {"key": "APP-2", "icon": "10318", "title": "Write the release notes", "status": "Backlog"})],
]
def jira_all(): return [n for g in STATE["jira"] for n in g]
def jira_feed(pick):
    groups = sorted((g for g in STATE["jira"] if pick(g[0])), key=lambda g: g[0]["timestamp"], reverse=True)
    actors = lambda g: list({n["content"]["actor"]["displayName"]: n["content"]["actor"] for n in g[1:]}.values())
    return {"nodes": [{"groupId": "g-" + g[0]["notificationId"], "groupSize": len(g), "additionalActors": actors(g), "readStates": sorted({n["readState"] for n in g}), "headNotification": g[0]} for g in groups],
            "pageInfo": {"hasNextPage": False}}
ME_USER = lambda: {"id": ME, "username": "sam", "first_name": STATE["first_name"], "last_name": "G", "nickname": "", "position": "Dev", "email": "sam@x.example", "last_picture_update": 0,
                   "notify_props": STATE["notify"], "props": {"customStatus": json.dumps(custom)} if custom else {}}
OTHER = {"id": "u2", "username": "ann", "first_name": "Ann", "last_name": "B", "nickname": "", "position": "", "last_picture_update": 0, "props": {}}
def chan(i, t, name, disp): return {"id": i, "type": t, "name": name, "display_name": disp, "purpose": "", "header": "", "create_at": 1, "delete_at": 0, "last_post_at": NOW, "last_root_post_at": NOW, "total_msg_count": 1, "total_msg_count_root": 1, "group_constrained": STATE["channel_constrained"] if i == "c1" else False}
EXTRA = {"dclosed": chan("dclosed", "D", f"{ME}__u2", ""), "cleft": dict(chan("cleft", "O", "old", "Old times"), delete_at=5)}
def post(i, c, msg, **kw): return {"id": i, "channel_id": c, "user_id": "u2", "root_id": "", "create_at": NOW - 3600000 + int(i[1:]) * 1000, "update_at": NOW, "edit_at": 0, "delete_at": 0, "type": "", "message": msg, "props": {}, "reply_count": 0, "metadata": {}, **kw}
# Post ids must stay unique: elements of a post drawn twice get the same ids, and left clicks on them stop firing.
# The picture stays last because the wheel can't be injected, and its name tries to leave the downloads folder.
CHANNEL_POSTS = [
    post("p9", "c1", "Скрин приложения", metadata={"files": [{"id": "f1", "name": "../скриншот экрана.jpg", "extension": "jpg", "mime_type": "image/jpeg", "size": 10440, "width": 800, "height": 450, "has_preview_image": True, "post_id": "p9"}]}),
    post("p1", "c1", "Hello @sam"),
    post("p4", "c1", "Sam and sam and SAM: b2c, B2C-team, on:call, on call, @b2c_team, @ldapers, @nope"),
    post("p5", "c1", "Code stays: `b2c` and\n```\nb2c @sam\n```\n[b2c link](https://x.example/b2c) https://x.example/b2c mail b2c@x.example #b2c"),
    post("p6", "c1", "Licensed keyword: the regression and the dry-run, with @channel and @here"),
    post("p7", "c1", "From someone without channel mentions: @channel b2c @sam, regression stays", props={"mentionHighlightDisabled": True}),
    post("p8", "c1", "Group highlight off: @b2c_team b2c", props={"disable_group_highlight": True}),
    post("p10", "c1", "An attachment", props={"attachments": [{"pretext": "pretext b2c regression", "text": "text b2c @sam. regression", "fields": [{"title": "b2c", "value": "b2c", "short": True}]}]}),
]
POSTS = [CHANNEL_POSTS[0], post("p2", "dclosed", "In a closed DM @sam"), post("p3", "cleft", "In an archived channel b2c")]
CHANNEL_POSTS.append(CHANNEL_POSTS.pop(0))
def plist(ps): return {"order": [p["id"] for p in reversed(ps)], "posts": {p["id"]: p for p in ps}}
SOCKETS = []

def ws_frame(text):
    b = text.encode()
    head = b"\x81" + (bytes([len(b)]) if len(b) < 126 else b"\x7e" + struct.pack(">H", len(b)))
    return head + b

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def websocket(self):
        key = self.headers["Sec-WebSocket-Key"]
        accept = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        self.wfile.write(f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n".encode()); self.wfile.flush()
        self.wfile.write(ws_frame(json.dumps({"event": "hello", "data": {}, "broadcast": {}, "seq": 0}))); self.wfile.flush()
        SOCKETS.append(self.wfile)
        LOG.write(json.dumps({"t": round(time.time(), 1), "m": "WS", "p": self.path}) + "\n")
        try:
            while True:
                if not self.rfile.read(1): break
                n = self.rfile.read(1)[0] & 127
                if n == 126: n = struct.unpack(">H", self.rfile.read(2))[0]
                elif n == 127: n = struct.unpack(">Q", self.rfile.read(8))[0]
                self.rfile.read(n + 4)
        except Exception: pass
        SOCKETS.remove(self.wfile)
        self.close_connection = True
    def handle_any(self, method):
        if self.headers.get("Upgrade", "").lower() == "websocket": return self.websocket()
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        body = json.loads(raw) if raw else None
        u = urlparse(self.path); p = u.path.removeprefix("/api/v4"); q = parse_qs(u.query)
        LOG.write(json.dumps({"t": round(time.time(), 1), "m": method, "p": self.path, "auth": self.headers.get("Authorization"), "b": body}, ensure_ascii=False) + "\n")
        global custom, closed_shown
        if p == "/gateway/api/graphql" and method == "POST":
            if self.headers.get("Authorization") != JIRA_AUTH: return self.send({"message": "Unauthorized"}, 401)
            op, v = body.get("operationName"), body.get("variables") or {}
            if op == "JiraTenant":
                return self.send({"data": {"tenantContexts": [{"cloudId": "mock-cloud", "activationIdByProduct": {"active": "mock-jira"}}]}})
            if op != "JiraTenant" and v.get("ari") != "ari:cloud:jira:mock-cloud:workspace/mock-jira":
                # As the real gateway does without the routing id: an empty context.
                return self.send({"data": {"notifications": {"direct": {"nodes": []}, "watching": {"nodes": []}, "all": {"nodes": []}, "notificationGroup": {"nodes": []}}}})
            if op == "JiraFeed":
                data = {"direct": jira_feed(lambda n: n["category"] == "direct" and n["readState"] == "unread"),
                        "watching": jira_feed(lambda n: n["category"] == "watching" and n["readState"] == "unread")}
                if v.get("all"): data["all"] = jira_feed(lambda n: n["category"] == v.get("category"))
                return self.send({"data": {"notifications": data}})
            if op == "JiraGroup":
                g = next((g for g in STATE["jira"] if "g-" + g[0]["notificationId"] == v.get("groupId")), [])
                return self.send({"data": {"notifications": {"notificationGroup": {"nodes": g}}}})
            if op in ("JiraRead", "JiraUnread"):
                for n in jira_all():
                    if n["notificationId"] in v["ids"]: n["readState"] = "read" if op == "JiraRead" else "unread"
                return self.send({"data": {"notifications": {"markNotificationsByIdsAs" + op[4:]: "OK"}}})
            if op == "JiraReadAll":
                for n in jira_all():
                    if n["category"] == v.get("category"): n["readState"] = "read"
                return self.send({"data": {"notifications": {"markNotificationsAsRead": "OK"}}})
            return self.send({"errors": [{"message": f"mock has no operation {op}"}]}, 400)
        m = re.fullmatch(r"/jira-avatars/(u-[a-z]+\.png)", p)
        if m:
            data = open(os.path.join(JIRA_ICONS, "../avatars", m[1]), "rb").read()
            self.send_response(200); self.send_header("Content-Type", "image/png"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
            return
        m = re.fullmatch(r"/rest/api/2/universal_avatar/view/type/issuetype/avatar/(\d+)", p)
        if (m and m[1] in JIRA_ICON_IDS) or p == "/assets/confluence-page-icon.svg":
            if m and self.headers.get("Authorization") != JIRA_AUTH: return self.send({"message": "Unauthorized"}, 401)
            data = open(os.path.join(JIRA_ICONS, (JIRA_ICON_IDS[m[1]] if m else "page") + ".svg"), "rb").read()
            self.send_response(200); self.send_header("Content-Type", "image/svg+xml;charset=UTF-8"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
            return
        if p == "/__mock":
            ev = body.pop("ws", None)
            STATE.update(body)
            if ev:
                for w in list(SOCKETS):
                    try: w.write(ws_frame(json.dumps(ev))); w.flush()
                    except Exception: pass
            return self.send(STATE)
        if p == "/users/me" and method == "GET": return self.send(ME_USER())
        if p == "/users/me/teams" and method == "GET": return self.send([{"id": "t1", "name": "team", "display_name": "Team", "group_constrained": STATE["team_constrained"]}])
        if p == "/config/client": return self.send(STATE["config"])
        if p == "/license/client": return self.send(STATE["license"])
        if p == "/cloud/subscription": return self.send({"id": "s1", "product_id": "prod1"})
        if p == "/cloud/products": return self.send([{"id": "prod1", "sku": STATE.get("sku", "cloud-professional"), "name": "Plan"}])
        if p == "/users/me/teams/t1/channels": return self.send([chan("c1", "O", "bugs", "Баги и вопросы"), EXTRA["dclosed"]])
        if p == "/users/me/teams/t1/channels/members": return self.send([{"channel_id": "c1", "msg_count": 1, "msg_count_root": 1, "mention_count": 0, "mention_count_root": 0, "last_viewed_at": NOW, "notify_props": {}}])
        if p == "/users/me/teams/t1/channels/categories": return self.send({"order": ["cat", "dm"], "categories": [{"id": "dm", "type": "direct_messages", "display_name": "Direct Messages", "channel_ids": ["dclosed"], "sorting": "alpha", "muted": False, "collapsed": False}, {"id": "cat", "type": "channels", "display_name": "Channels", "channel_ids": ["c1"], "sorting": "", "collapsed": False, "muted": False}]})
        if p == "/users/me/preferences":
            prefs = [{"category": "direct_channel_show", "name": "u2", "value": "true" if closed_shown else "false"}, {"category": "custom_status", "name": "recent_custom_statuses", "value": json.dumps([{"emoji": "hamburger", "text": "Out for lunch", "duration": "thirty_minutes"}])}]
            if STATE["pref"] is not None: prefs.append({"category": "auto_reset_manual_status", "name": ME, "value": STATE["pref"]})
            return self.send(prefs)
        if p == "/users/me/preferences/flagged_post": return self.send([{"category": "flagged_post", "name": "p1", "value": "true"}])
        if p == "/users/status/ids": return self.send([{"user_id": i, "status": STATE["status"] if i == ME else "online", "manual": i == ME and STATE["manual"], "last_activity_at": NOW, "dnd_end_time": 0} for i in body])
        if p == "/users/ids": return self.send([ME_USER() if i == ME else OTHER for i in body])
        if p == "/groups": return self.send([g for g in STATE["groups"]] if q.get("filter_has_member") == [ME] else [])
        if p == "/teams/t1/groups": return self.send({"groups": [g for g in STATE["groups"] if g["name"] == "ldapers"], "total_group_count": 1})
        if p == "/teams/t1/groups_by_channels": return self.send({"groups": STATE["channel_groups"]})
        if re.fullmatch(rf"/users/{ME}/teams/t1/threads", p): return self.send({"threads": [], "total": 0, "total_unread_threads": 0, "total_unread_mentions": 0})
        if p == "/users/me/teams/t1/drafts": return self.send([])
        if p == "/teams/t1/posts/search" and method == "POST": return self.send({**plist(POSTS if body["page"] == 0 else []), "matches": {}})
        if p == f"/users/{ME}/posts/flagged": return self.send(plist(POSTS[:1]))
        m = re.fullmatch(r"/channels/([^/]+)", p)
        if m and m[1] in EXTRA: return self.send(EXTRA[m[1]])
        if re.fullmatch(r"/channels/[^/]+/posts", p): return self.send(plist(CHANNEL_POSTS + [post(f"p{100 + i}", "c1", m) for i, m in enumerate(STATE.get("extra", []))] if "c1" in p else [POSTS[1]] if "dclosed" in p else []))
        if re.fullmatch(r"/channels/[^/]+/stats", p): return self.send({"member_count": 2, "pinnedpost_count": 0, "files_count": 0})
        if p == "/channels/members/me/view": return self.send({"status": "OK"})
        if p == f"/users/{ME}/status" and method == "PUT":
            if body.get("user_id") != ME or body.get("status") not in ("online", "offline", "away", "dnd"): return self.send({"id": "mock.invalid", "message": f"bad status {body}"}, 400)
            if STATE["status"] == "ooo": LOG.write(json.dumps({"auto_responder": "disabled"}) + "\n")
            STATE["status"] = body["status"]; STATE["manual"] = body["status"] != "online"
            return self.send({**body, "manual": STATE["manual"]})
        if p == "/users/me/status/custom" and method == "PUT": custom = body; return self.send({"status": "OK"})
        if p == "/users/me/status/custom" and method == "DELETE": custom = None; return self.send({"status": "OK"})
        if p == "/users/me/status/custom/recent/delete": return self.send({"status": "OK"})
        if p == "/users/me/patch": return self.send({**ME_USER(), **body})
        if p == f"/users/{ME}/preferences":
            closed_shown = closed_shown or any(x["category"] == "direct_channel_show" and x["value"] == "true" for x in body)
            for x in body:
                if x["category"] == "auto_reset_manual_status": STATE["pref"] = x["value"]
            return self.send({"status": "OK"})
        if p == f"/users/{ME}/preferences/delete": return self.send({"status": "OK"})
        if p == "/posts" and method == "POST":
            np = post("p%d" % (500 + len(STATE.setdefault("sent", []))), body["channel_id"], body["message"], user_id=ME, root_id=body.get("root_id", ""))
            np["create_at"] = np["update_at"] = int(time.time() * 1000)
            STATE["sent"].append(np["id"])
            ev = {"event": "posted", "data": {"post": json.dumps(np), "channel_type": "O", "channel_display_name": "General", "sender_name": "@sam", "team_id": "t1"}, "broadcast": {"channel_id": np["channel_id"]}, "seq": 1}
            for w in list(SOCKETS):
                try: w.write(ws_frame(json.dumps(ev))); w.flush()
                except Exception: pass
            return self.send(np, 201)
        m = re.fullmatch(r"/posts/([^/]+)/thread", p)
        if m: return self.send(plist([x for x in CHANNEL_POSTS if x["id"] == m[1]]))
        if p == "/files/f1/link": return self.send({"link": "http://127.0.0.1:18069/files/f1/public?h=abc"})
        if re.fullmatch(r"/files/f1(/preview|/thumbnail)?", p):
            data = open(IMAGE, "rb").read()
            self.send_response(200); self.send_header("Content-Type", "image/jpeg"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
            return
        if p == "/commands/execute": return self.send({"text": "ran"})
        return self.send({"id": "mock.not_found", "message": f"mock has no {method} {p}"}, 404)
    def do_GET(self): self.handle_any("GET")
    def do_POST(self): self.handle_any("POST")
    def do_PUT(self): self.handle_any("PUT")
    def do_DELETE(self): self.handle_any("DELETE")
ThreadingHTTPServer(("127.0.0.1", 18069), H).serve_forever()
