# Mattermost for Herdr

A [Herdr](https://herdr.dev) mod that puts your Mattermost team in a panel beside your terminals, drawn like the Mattermost desktop app. It has the channel sidebar with your categories, unreads and statuses, and live channels with threads, reactions, the emoji picker, Find Channels, inline editing and the post menu.

![Mattermost in Herdr](preview.png)

## Install

Ask your agent in Herdr:

```text
Read ~/.config/herdr-app/AGENTS.md, then add the mod at https://github.com/dev-gvs/herdr-mattermost
```

Or by hand:

1. Copy `mods/mattermost/` into `~/.config/herdr-app/mods/`.
2. Open it as a pane (`herdr-app do pane.split --direction right --mod mattermost`), or add a block for it to a layout you own (see [RECIPE.md](RECIPE.md#built-from)).
3. Run `herdr-app check ~/.config/herdr-app/mods/mattermost`.

## Login

The first time it opens, the panel asks for your server's address and a personal access token, checks them, lets you pick a team if you're in several, and saves them to `~/.config/herdr-app/mattermost.json`, readable only by you.

To get a token, open Profile → Security → Personal Access Tokens → Create Token in Mattermost ([how to](https://docs.mattermost.com/developers/integrate/reference/personal-access-token)). If that section isn't there, an admin has to enable personal access tokens and allow your account to create them; the same page shows where.

You can also write the file yourself and `chmod 600` it:

```json
{ "url": "https://chat.example.com", "token": "<token>", "team": "<team name>" }
```

To try it without a server, give the block `"props": { "demo": true }`. It shows a made-up team and nothing reaches the network.

## Privacy

- The token goes only to your Mattermost server: the API, the websocket and the downloads of its images.
- Webhook icons from other hosts are downloaded without it.
- Avatars, emoji and thumbnails are cached in `~/.config/herdr-app/data/mattermost/`.
- The mod runs `curl` for those downloads, and `wl-copy` for Copy Link (Wayland only).

[RECIPE.md](RECIPE.md) is the full brief for building or changing it.

## Screenshots

Threads:

![Threads](screenshots/threads.png)
