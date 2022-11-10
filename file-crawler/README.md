Slack Backup File Crawler
=========================

Do a Backup
-----------

From your team's "Settings & Permissions" page, click "Import/Export Data", then do an export of whatever you want.

Note: If you're integrating this export into your previous backup copy, take care not to overwrite the references to files that have been hidden by the limit.

Crawl Files
-----------

Start the queue stuff:

```console
docker compose up
```

Run the crawler, providing the paths to your extracted export and where to put the files:

```console
npm start /path/to/export/directory /path/to/files/destination
```
