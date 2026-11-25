# Mattermost for Herdr

A [Herdr](https://herdr.dev) mod that puts your Mattermost team in a panel beside your terminals: chats, threads, drafts and search, each a list with a reader beside it, live, with markdown, images, reactions, editing and file uploads. It fits a narrow side panel, a medium pane and a full window, and can show your Jira notifications too. Notifications, links, privacy and the optional agent hand-off are in the [guide](docs/guide.md).

Two ways to run it, picked by the panel's props. Both videos use the built-in demo data.

**Mattermost only** (the default):

https://github.com/user-attachments/assets/02914506-4f00-4183-926c-55647886fb65

[docs/demo.mp4](docs/demo.mp4) · layout props: `{ "mod": "mattermost" }`

**With the Jira inbox**, which adds a Jira tab (see [Jira notifications](docs/guide.md#jira-notifications-optional)):

https://github.com/user-attachments/assets/44257daa-200c-4077-b113-c83e263e8210

[docs/demo-jira.mp4](docs/demo-jira.mp4) · layout props: `{ "mod": "mattermost", "props": { "jira": { "site": "https://your-site.atlassian.net", "credentials": "~/.config/jira.conf" } } }`

## Install

Ask your agent in Herdr:

```text
Read ~/.config/herdr-app/AGENTS.md, then add the mod at https://github.com/dev-gvs/herdr-mattermost
```

The panel asks for your server and a token the first time it opens; see the [guide](docs/guide.md#login).

## License

MIT, see [LICENSE](LICENSE). The line icons in `mods/mattermost/icons/` are from [Lucide](https://lucide.dev) under the ISC license ([LICENSE-lucide](mods/mattermost/icons/LICENSE-lucide)). The icons in `mods/mattermost/icons/compass/` are Mattermost's [Compass Icons](https://github.com/mattermost/compass-icons) under the MIT license ([LICENSE-compass](mods/mattermost/icons/compass/LICENSE-compass)). The file-type icons in `mods/mattermost/icons/files/` are from Mattermost's web app under the Apache License 2.0 ([LICENSE-mattermost](mods/mattermost/icons/files/LICENSE-mattermost)). The Mattermost name and logo are trademarks of Mattermost, Inc.; this project is not affiliated with it.
