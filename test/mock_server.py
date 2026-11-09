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
    "config": {"EnableCustomUserStatuses": "true", "BuildEnterpriseReady": "true", "EnablePublicLink": "true", "EnableCustomGroups": "true", "PostPriority": "true", "PostAcknowledgements": "true", "EnableFileAttachments": "true"},
    "format": {}, "uploads": [],
    "notify": {"mention_keys": "@sam,@channel,b2c,on:call", "first_name": "true", "channel": "true", "highlight_keys": "regression,dry-run"},
    "first_name": "Sam", "team_constrained": False, "channel_constrained": False,
    "groups": [{"id": "g1", "name": "b2c_team", "allow_reference": True, "delete_at": 0, "source": "custom"}, {"id": "g2", "name": "nope", "allow_reference": False, "delete_at": 0, "source": "custom"}, {"id": "g3", "name": "ldapers", "allow_reference": True, "delete_at": 0, "source": "ldap"}],
    "channel_groups": {},
    # Drafts as the web app would leave them, files on the server by id, and bytes a second for uploads, to watch one go up.
    "drafts": [], "files": {}, "upload_rate": 0,
}
UPLOADED = {}

def image_info(data):
    """The MIME type, width and height Mattermost's server would record for an image, from its header."""
    if data[:8] == b"\x89PNG\r\n\x1a\n": return "image/png", *struct.unpack(">II", data[16:24])
    if data[:6] in (b"GIF87a", b"GIF89a"): return "image/gif", *struct.unpack("<HH", data[6:10])
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP": return "image/webp", 0, 0
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF: i += 1; continue
            marker, size = data[i + 1], struct.unpack(">H", data[i + 2:i + 4])[0]
            if marker in (0xC0, 0xC1, 0xC2):
                h, w = struct.unpack(">HH", data[i + 5:i + 9]); return "image/jpeg", w, h
            i += 2 + size
        return "image/jpeg", 0, 0
    return None, 0, 0

# What /files/{id} serves for files that aren't uploads, by id; anything else gets the JPEG.
FILE_BODIES = {"f2": b"Plan\n\n1. Ship the attachment cards\n2. Open them in the viewer\n3. Celebrate\n"}

def multipart_files(raw):
    out = []
    for part in raw.split(b"\r\n--"):
        m = re.search(rb'filename="([^"]*)"', part)
        if m and b"\r\n\r\n" in part: out.append((m[1].decode(), part.split(b"\r\n\r\n", 1)[1].removesuffix(b"\r\n")))
    return out
ME_USER = lambda: {"id": ME, "username": "sam", "roles": "system_user", "first_name": STATE["first_name"], "last_name": "G", "nickname": "", "position": "Dev", "email": "sam@x.example", "last_picture_update": 0,
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
    post("p11", "c1", "My note, with the plan attached", user_id=ME, file_ids=["f2"], metadata={"files": [{"id": "f2", "name": "plan.txt", "extension": "txt", "mime_type": "text/plain", "size": 120, "post_id": "p11"}]}),
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
        rate = STATE["upload_rate"] if self.headers.get("Content-Type", "").startswith("multipart/") else 0
        raw = b""
        while len(raw) < n:
            raw += self.rfile.read(min(n - len(raw), rate or n))
            if rate: time.sleep(1)
        multipart = self.headers.get("Content-Type", "").startswith("multipart/")
        body = {"multipart": len(raw), "files": re.findall(rb'filename="([^"]*)"', raw)} if multipart else json.loads(raw) if raw else None
        if multipart: body["files"] = [f.decode() for f in body["files"]]
        u = urlparse(self.path); p = u.path.removeprefix("/api/v4"); q = parse_qs(u.query)
        LOG.write(json.dumps({"t": round(time.time(), 1), "m": method, "p": self.path, "auth": self.headers.get("Authorization"), "b": body}, ensure_ascii=False) + "\n")
        global custom, closed_shown
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
            prefs += [{"category": "advanced_text_editor", "name": k, "value": v} for k, v in STATE["format"].items()]
            return self.send(prefs)
        if p == "/users/me/preferences/flagged_post": return self.send([{"category": "flagged_post", "name": "p1", "value": "true"}])
        if p == "/users/status/ids": return self.send([{"user_id": i, "status": STATE["status"] if i == ME else "online", "manual": i == ME and STATE["manual"], "last_activity_at": NOW, "dnd_end_time": 0} for i in body])
        if p == "/users/ids": return self.send([ME_USER() if i == ME else OTHER for i in body])
        if p == "/groups": return self.send([g for g in STATE["groups"]] if q.get("filter_has_member") == [ME] else [])
        if p == "/teams/t1/groups": return self.send({"groups": [g for g in STATE["groups"] if g["name"] == "ldapers"], "total_group_count": 1})
        if p == "/teams/t1/groups_by_channels": return self.send({"groups": STATE["channel_groups"]})
        if re.fullmatch(rf"/users/{ME}/teams/t1/threads", p): return self.send({"threads": [], "total": 0, "total_unread_threads": 0, "total_unread_mentions": 0})
        if p == "/users/me/teams/t1/drafts": return self.send(STATE["drafts"])
        if p == "/teams/t1/posts/search" and method == "POST": return self.send({**plist(POSTS if body["page"] == 0 else []), "matches": {}})
        if p == f"/users/{ME}/posts/flagged": return self.send(plist(POSTS[:1]))
        m = re.fullmatch(r"/channels/([^/]+)", p)
        if m and m[1] in EXTRA: return self.send(EXTRA[m[1]])
        # {"last": id} through /__mock moves that post to the end, where it can be reached without the wheel.
        if re.fullmatch(r"/channels/[^/]+/posts", p):
            ps = CHANNEL_POSTS + [post(f"p{100 + i}", "c1", m) for i, m in enumerate(STATE.get("extra", []))]
            ps = sorted(ps, key=lambda x: x["id"] == STATE.get("last"))
            # {"post_files": {post id: [file ids from "files"]}} gives a post those files instead of its own.
            ps = [{**x, "file_ids": ids, "metadata": {**x["metadata"], "files": [STATE["files"][f] for f in ids]}} if (ids := STATE.get("post_files", {}).get(x["id"])) else x for x in ps]
            return self.send(plist(ps if "c1" in p else [POSTS[1]] if "dclosed" in p else []))
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
                if x["category"] == "advanced_text_editor": STATE["format"][x["name"]] = x["value"]
            return self.send({"status": "OK"})
        if p == f"/users/{ME}/preferences/delete": return self.send({"status": "OK"})
        if p == "/posts" and method == "POST":
            np = post("p%d" % (500 + len(STATE.setdefault("sent", []))), body["channel_id"], body["message"], user_id=ME, root_id=body.get("root_id", ""), metadata=body.get("metadata", {}), file_ids=body.get("file_ids", []))
            np["create_at"] = np["update_at"] = int(time.time() * 1000)
            STATE["sent"].append(np["id"])
            ev = {"event": "posted", "data": {"post": json.dumps(np), "channel_type": "O", "channel_display_name": "General", "sender_name": "@sam", "team_id": "t1"}, "broadcast": {"channel_id": np["channel_id"]}, "seq": 1}
            for w in list(SOCKETS):
                try: w.write(ws_frame(json.dumps(ev))); w.flush()
                except Exception: pass
            return self.send(np, 201)
        m = re.fullmatch(r"/posts/([^/]+)/patch", p)
        if m and method == "PUT":
            if STATE.get("patch_error"): return self.send({"id": "mock.patch", "message": STATE["patch_error"]}, 400)
            old = next((x for x in CHANNEL_POSTS if x["id"] == m[1]), None) or post(m[1], "c1", "", user_id=ME)
            files = [f for f in old["metadata"].get("files", []) + list(STATE["files"].values()) if f["id"] in body.get("file_ids", [])] + [f for f in STATE["uploads"] if f["id"] in body.get("file_ids", [])]
            np = {**old, "message": body["message"], "file_ids": body.get("file_ids", []), "metadata": {**old["metadata"], "files": files}, "edit_at": int(time.time() * 1000)}
            ev = {"event": "post_edited", "data": {"post": json.dumps(np)}, "broadcast": {"channel_id": np["channel_id"]}, "seq": 1}
            for w in list(SOCKETS):
                try: w.write(ws_frame(json.dumps(ev))); w.flush()
                except Exception: pass
            return self.send(np)
        m = re.fullmatch(r"/posts/([^/]+)/thread", p)
        if m: return self.send(plist([x for x in CHANNEL_POSTS if x["id"] == m[1]]))
        # As the server does, only a file some post holds gets a public link.
        m = re.fullmatch(r"/files/([^/]+)/link", p)
        if m:
            if any(x["id"] == m[1] for x in STATE["uploads"]): return self.send({"id": "api.file.get_public_link.no_post.app_error", "message": "Unable to get public link for file. File must be attached to a post that can be read."}, 400)
            return self.send({"link": f"http://127.0.0.1:18069/files/{m[1]}/public?h=abc"})
        if re.fullmatch(r"/files/f1(/preview|/thumbnail)?", p):
            data = open(IMAGE, "rb").read()
            self.send_response(200); self.send_header("Content-Type", "image/jpeg"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
            return
        # {"roles": [permissions]} through /__mock gives every role exactly those; without it roles are unknown.
        if p == "/roles/names" and STATE.get("roles") is not None: return self.send([{"name": n, "permissions": STATE["roles"]} for n in body])
        if p == "/commands/execute": return self.send({"text": "ran"})
        if p == "/files" and method == "POST":
            infos = []
            channel = (re.search(rb'name="channel_id"\r\n\r\n([^\r]*)', raw) or [b"", b""])[1].decode()
            for i, (name, data) in enumerate(multipart_files(raw)):
                mime, w, h = image_info(data)
                fid = "up%d" % (len(STATE["uploads"]) + i)
                UPLOADED[fid] = data
                infos.append({"id": fid, "name": name, "extension": name.rsplit(".", 1)[-1].lower() if "." in name else "", "size": len(data), "mime_type": mime or "application/octet-stream", "width": w, "height": h, "has_preview_image": bool(mime), "user_id": ME, "channel_id": channel, "post_id": "", "delete_at": 0})
            STATE["uploads"] += infos
            return self.send({"file_infos": infos, "client_ids": []}, 201)
        m = re.fullmatch(r"/files/([^/]+)(/preview|/thumbnail)?", p)
        if m and (m[1] in UPLOADED or m[1] in STATE["files"] or m[1] in FILE_BODIES):
            data = UPLOADED.get(m[1]) or FILE_BODIES.get(m[1]) or open(IMAGE, "rb").read()
            self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
            return
        m = re.fullmatch(r"/files/([^/]+)/info", p)
        if m: return self.send(next((x for x in STATE["uploads"] if x["id"] == m[1]), STATE["files"].get(m[1], {"id": m[1], "name": "old.txt", "extension": "txt", "size": 12})))
        return self.send({"id": "mock.not_found", "message": f"mock has no {method} {p}"}, 404)
    def do_GET(self): self.handle_any("GET")
    def do_POST(self): self.handle_any("POST")
    def do_PUT(self): self.handle_any("PUT")
    def do_DELETE(self): self.handle_any("DELETE")
ThreadingHTTPServer(("127.0.0.1", 18069), H).serve_forever()
