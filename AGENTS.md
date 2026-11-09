# herdr-mattermost

`mods/mattermost/` is the mod. `RECIPE.md` says what it does, how it's built and what to watch out for. Read it before changing the mod.

## Testing

Test every change that affects what the panel shows or does in the throwaway window before calling it done. `test/sandbox.sh` runs a separate Herdr in a headless KWin, from copies of the binaries, with its own home in `/var/tmp/mmt`. Nothing in it can reach the live window. It needs `kwin_wayland`, `dbus-run-session`, `python3` and an installed `herdr-app`.

### Rules

- Never test with the live window, the real server or the real token in `~/.config/herdr-app/mattermost.json`. Against the live Herdr, use only `herdr-app check` and `herdr-app status`.
- Change code in the repo, then run `sync`. A temporary trace or reordered test data goes only in the sandbox copy at `/var/tmp/mmt/app/mods/mattermost`. Never copy anything from there back to the repo.
- Stop the sandbox only with `test/sandbox.sh stop`. Never use `pkill -f` here: it can kill your own shell or the real desktop's KWin.
- Run `test/sandbox.sh stop` when you're done. It deletes `/var/tmp/mmt`.

### Commands

Run from the repo root.

```sh
test/sandbox.sh start [demo|server]     # Stops any old sandbox and builds a fresh one. Takes about 5 s. Default: demo.
test/sandbox.sh sync                    # Copies the repo's mod in. Herdr reloads it by itself.
test/sandbox.sh layout demo|server      # Switches the data source.
test/sandbox.sh restart [demo|server]   # New Herdr process, same home. Default: demo.
test/sandbox.sh shot NAME [STEPS...]    # Runs the steps, waits, saves /var/tmp/mmt/shots/NAME.png, prints errors and overlays.
test/sandbox.sh in STEPS...             # Runs the steps only.
test/sandbox.sh herdr ARGS...           # herdr-app against the sandbox, e.g. do tab.new '{...}'. `herdr commands` lists them.
test/sandbox.sh run CMD...              # Any program in the sandbox's environment, e.g. wl-paste --list-types.
test/sandbox.sh stop
```

`WAIT=2 test/sandbox.sh shot ...` waits 2 s before the screenshot instead of 1.2 s. Longer waits are for anything that has to download or open a window.

`HIDE="kdialog zenity" test/sandbox.sh restart server` hides those programs for that run. Use it to test fallbacks. The next `restart` without `HIDE` brings them back.

### Steps

Coordinates are pixels in a screenshot of the `demo` or `server` layout. In any other layout, take a screenshot first and use its coordinates.

| Step | Effect |
|---|---|
| `at:X,Y` | Moves the pointer. |
| `click`, `rclick` | Left or right click where the pointer is. |
| `press`, `release` | Left button down or up, for drags. |
| `key:esc`, `key:ctrl+a` | Key names: letters, digits, `enter esc tab up down left right home end pageup pagedown bs del ctrl shift alt`. |
| `type:hello` | Types Latin letters, digits and common punctuation. Cyrillic can't be typed. |
| `sleep:0.5` | Waits. |

Every shot prints `errors: [...] overlays: [...]`. `errors` must stay empty. `overlays` tells you what's open, such as `mattermost` for a menu or dialog and `toast` for a notification. Always read the PNG as well: a clean status doesn't prove it looks right.

Typical run:

```sh
test/sandbox.sh start server
WAIT=1 test/sandbox.sh shot menu at:700,528 sleep:0.8 rclick
test/sandbox.sh in key:esc
test/sandbox.sh stop
```

### Data sources

- `demo` uses the mod's built-in data from `mods/mattermost/demo/demo.js`. It's the fastest way to check looks and has the widest range of content.
- `demo-jira` and `server-jira` are the same two with the Jira inbox on. `server-jira` reads the made-up credentials in `/var/tmp/mmt/home/.config/jira-test.conf` and talks to the mock's `/gateway/api/graphql`, whose notifications are `STATE["jira"]`. Without the `-jira` layouts the panel must look as it did before Jira.
- `server` talks to `test/mock_server.py` on `127.0.0.1:18069` with the token `fake-token`. Use it to check the real request path. Every call is logged as a JSON line in `/var/tmp/mmt/mock.log`, with its `Authorization` header. A route the mock lacks answers 404 and shows up there, so add it to the mock. `POST http://127.0.0.1:18069/__mock` with a JSON object changes the mock's `STATE`, and a `ws` key in it pushes that event down the websockets. Its `drafts` are what the server's drafts list returns (they show only with `AllowSyncedDrafts` in `config`), `files` are server files by id for `/files/{id}/info` and `/thumbnail`, `post_files` (`{"p11": ["f2", "f3"]}`) gives a post those files, and `upload_rate` (bytes a second) slows `POST /files` down so an upload can be watched; loopback buffers take the first few MB at once.

### Traps

- The wheel can't be injected, so you can't scroll. To reach a post, make it the last one: move its line to the end of `DESIGN` in the sandbox's `demo/demo.js`, or to the end of `CHANNEL_POSTS` in the mock, or `POST /__mock` with `{"last": "p11"}` and `restart server` (p11 is your own post with a file, for editing). The demo orders posts by their place in that array, not by time. After changing the mock, run `start server`, because `restart` leaves the mock running with its old code.
- Never list a post id twice in test data. Its elements then get the same ids, and left clicks on them stop firing while right clicks still work.
- The row under the pointer counts as hovered and post action bars appear on it, so park the pointer elsewhere (`at:1000,20`) before judging a screenshot.
- Changing a mod file while a dialog is open loses keyboard focus, so Esc stops closing it. Close dialogs before `sync`.
- `xdg-open` is a stub that appends its arguments to `/var/tmp/mmt/xdg-open.log`. Check links there.
- Saved files land in `/var/tmp/mmt/home/Downloads`.
- File dialogs open as real windows in the sandbox and take the keyboard: `key:esc` cancels, and `key:ctrl+a type:name.jpg key:enter` accepts. Check for them with `pgrep -a kdialog` or `pgrep -a zenity`.
- Check the clipboard with `test/sandbox.sh run wl-paste --list-types`. Never print clipboard contents, which may be a PNG.
- Tabs need a space, and the `demo` and `server` layouts have none. To test them: `herdr do layout.switch '{"name":"main"}'`, `herdr do space.new '{"name":"t"}'`, then `herdr do tab.new '{"name":"mm","mod":"mattermost","props":{"demo":true,"channel":"design"}}'`.
- A fresh start shows an "Updated to x.y.z" toast at the bottom right until it's closed or Herdr restarts. It's only the new home, and no update ran.

### Screenshots for the repo

`preview.png` and `screenshots/` come from the sandbox's demo. Use only demo data, and leave `demo/demo.js` in the repo alone.

```sh
SCREEN_W=1450 SCREEN_H=905 test/sandbox.sh start demo
test/sandbox.sh restart demo                       # Clears the "Updated to" toast.
python3 test/frame_shot.py IN.png OUT.png          # Rounded corners and the unfocused border. Needs Pillow.
```

- Park the pointer with `at:1000,20` before each shot, except for a shot of something that needs hovering.
- In the sandbox copy of `demo/demo.js`, delete the posts holding `Not your name` and `someone who can't notify`, which only exercise highlighting, and move the posts you want to the end of `DESIGN`.
- To leave other channels unread, write a layout file in `/var/tmp/mmt/app/layouts/` like the `demo` one, with `"channel": "engineering"`, and switch to it instead of clicking through channels.
- "Open in new tab" stays disabled until `test/sandbox.sh herdr do space.new '{"name":"t"}'`.
- The caret blinks. Take the shot again if it shows.

### What this can't test

Say so in your report when a change depends on one of these:

- Scrolling with the wheel.
- A real Mattermost server. The mock returns only what its routes were written to return.
- The live window's own layout and mods.
