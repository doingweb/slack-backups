import * as path from 'path';
import { promises as fs } from 'fs';


// TODO: Pass this in somehow
const slackExportPath = '/Users/chris/Downloads/export-test';

crawl();

async function crawl() {
  const channels = await getChannels();
  const users = await getUsers();

  for (const channel of channels) {
    crawlChannel(channel); // Note that it's async!
  }
}

async function crawlChannel(channel: SlackChannel) {
  const channelDirPath = path.join(slackExportPath, channel.name);
  const channelChatFilenames = await fs.readdir(channelDirPath, 'utf-8');

  for (const channelChatFilename of channelChatFilenames) {
    crawlChannelChatFile(channel, path.join(channelDirPath, channelChatFilename)); // Note that it's async!
  }
}

async function crawlChannelChatFile(channel: SlackChannel, filePath: string) {
  const messages = await getObjectsFromFile<SlackMessage>(filePath);
  const filesFromMessages = messages.filter(m => m.files).reduce(); // TODO: 👈 Pick up from here!

  debugger;
}

async function getChannels() {
  return getObjectsFromFile<SlackChannel>(path.join(slackExportPath, 'channels.json'));
}

async function getUsers() {
  return getObjectsFromFile(path.join(slackExportPath, 'users.json'));
}

async function getObjectsFromFile<T>(filePath: string): Promise<T[]> {
  const contents = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(contents);
}

interface SlackChannel {
  name: string
}

interface SlackMessage {
  files?: SlackFile[]
}

interface SlackFile {
  id: string,
  name: string,
  filetype: string,
  mode: string,
  url_private: string,
  url_private_download: string,
  permalink: string,
  permalink_public: string
}

type SlackImageFile = SlackFile & {
  thumb_64: string,
  thumb_80: string,
  thumb_160: string,
  thumb_360: string,
  thumb_480: string,
  thumb_720: string,
  thumb_800: string,
  thumb_960: string,
  thumb_1024: string
};

type SlackVideoFile = SlackFile & {
  thumb_video: string
};


/*
PROPOSAL:

Store images in a directory organized by year ➡ channel ➡ file (prefixed with timestamp).
At the top level of that directory, store a JSON (or whatever) database that maps file IDs to actual files downloaded:

```
{
  "FNMKFC99V": {
    "original": "2019/finn-pics/1568995684-image_from_ios.jpg",
    "thumb_64": "2019/finn-pics/1568995684-image_from_ios_64.jpg",
    ...
  }
}
```

Use a queue system like Bull (and get the backing database running in a Docker container) to perform the download-and-save jobs.
Since multiple workers might be trying to save at the same time, we'll want to use a database that can handle concurrent writes.
Collisions should be handled before files could be overwritten.
*/
