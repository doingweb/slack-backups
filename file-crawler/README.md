Slack Backup File Crawler
=========================

Do a Backup
-----------

From your team's "Settings & Permissions" page, click "Import/Export Data", then do an export of whatever you want.

Extract this file and integrate it into your previous backup, taking care not to overwrite the JSON of content that has been hidden by the limit.

Crawl Files
-----------

Start Redis, which backs the queue:

```console
npm run redis
```

Optionally, start Arena, to monitor the queue with a nice web UI:

```console
npm run arena
```

Either use the "Launch File Crawler" launch config (setting your path arg), or run it from here, providing the path to your extracted export:

```console
npm start /absolute/path/to/export/directory
```
