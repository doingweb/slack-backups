import * as path from 'path';
import { promises as fs } from 'fs';
import * as Queue from 'bull';

// TODO: Pass this in somehow -- command line arg?
const slackExportPath = '/Users/chris/Downloads/export-test';

const downloadConcurrency = 2;
const fileDownloadQueue = createFileDownloadQueue();

crawl();

async function crawl() {
  // DEBUG: Change back to const when limit removed.
  let channels = await getChannels();
  const users = await getUsers();

  // DEBUG: Limits to finn-pics
  channels = channels.filter(c => c.name === 'finn-pics');

  const queueDrained = new Promise(resolve => {
    fileDownloadQueue.on('drained', resolve);
  });

  fileDownloadQueue.on('success', (job: FileDownloadJobData) => {
    console.log(`Success from queue: ${job.file.id}`);
  });

  // DEBUG
  fileDownloadQueue.on('progress', (job: Queue.Job, progress: number) => {
    // TODO: Something nicer? How to do bars?
    console.log(`Progress on job ${job.id} (${job.data.name}) -- ${progress}`);
  });

  await Promise.all(
    channels.map(crawlChannel)
  );

  await queueDrained;
  await fileDownloadQueue.whenCurrentJobsFinished();

  const jobCounts = await fileDownloadQueue.getJobCounts();

  await fileDownloadQueue.close();

  console.log('Queue drained 🕳', JSON.stringify(jobCounts, null, 2));

  console.log(`did all the things I guess 🤷‍♀️`);
}

async function crawlChannel(channel: SlackChannel) {
  const channelDirPath = path.join(slackExportPath, channel.name);
  // DEBUG: Change back to const when limit removed.
  let channelChatFilenames = await fs.readdir(channelDirPath, 'utf-8');

  // DEBUG: Limit to this one interesting day.
  // TODO: Also test against an older day, to ensure we gracefully handle `hidden_by_limit`.
  channelChatFilenames = channelChatFilenames.filter(f => f.includes('2019-12-11') || f.includes('2019-07-04'));

  await Promise.all(
    channelChatFilenames.map(channelChatFilename =>
      crawlChannelChatFile(channel, path.join(channelDirPath, channelChatFilename))
    )
  );
}

async function crawlChannelChatFile(channel: SlackChannel, filePath: string) {
  const messages = await getObjectsFromFile<SlackMessage>(filePath);
  const messagesWithFiles = messages.filter(m => m.files);

  await Promise.all(messagesWithFiles.map(async message => {
    for (const file of message.files) {
      if (file.mode === 'hidden_by_limit') {
        const messageTime = new Date(parseFloat(message.ts) * 1000);
        console.error(`File ${file.id} (in #${channel.name} at ${messageTime.toLocaleString()}) cannot be downloaded because it is hidden by the Free account storage limit.`);
        continue;
      }

      console.log(`Queuein' file ${file.id} 🇬🇧`);

      const job = await fileDownloadQueue.add({
        name: getNewFilePathParts(file, channel).join(' / '),
        newFilePathAbsolute: path.join(slackExportPath, '.files', ...getNewFilePathParts(file, channel)),
        channel,
        message,
        file
      });

      console.log(`Queued job ${job.id}`);
    }
  }));
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

function createFileDownloadQueue() {
  const queue = new Queue<FileDownloadJobData>('slack-backups-file-crawler-download-queue');

  queue.process(downloadConcurrency, async job => {
    // TODO: Actual downloading

    // Simulate downloading
    for (let i = 1; i <= 5; i++) {
      await wait(1);
      await job.progress(i * 20);
    }

    return { status: 'success' };

    function wait(seconds: number) {
      return new Promise(resolve => setTimeout(resolve, seconds * 1000));
    }
  });

  return queue;
}

function getNewFilePathParts(file: SlackFile, channel: SlackChannel): Array<string> {
  const year = new Date(file.timestamp * 1000).getFullYear().toString();
  const filename = `${file.timestamp}-${file.id}-${file.name}`;

  return [
    year,
    channel.name,
    filename
  ];
}

interface SlackChannel {
  name: string
}

interface SlackMessage {
  files?: SlackFile[],
  ts: string
}

interface SlackFile {
  id: string,
  created: number,
  timestamp: number,
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

interface FileDownloadJobData {
  name: string,
  newFilePathAbsolute: string,
  file: SlackFile,
  message: SlackMessage,
  channel: SlackChannel
}
/*
PROPOSAL:

Store images in a directory organized by year ➡ channel ➡ file (prefixed with timestamp & ID).
At the top level of that directory, store a JSON (or whatever) database that maps file IDs to actual files downloaded:

```
{
  "FNMKFC99V": {
    "original": "2019/finn-pics/1568995684-FNMKFC99V-image_from_ios.jpg",
    "thumb_64": "2019/finn-pics/1568995684-FNMKFC99V-image_from_ios_64.jpg",
    ...
  }
}
```

Side note 1: Should we actually store thumbnails? How would they be used?
  Could we get by generating them on-the-fly? Think about the case of videos especially.

Side note 2: Could we just have it store filenames, since a given file should have only one (determinable,
  given channel and file data) year-channel-timestamp-id combination?

Use a queue system like Bull (and get the backing database running in a Docker container) to perform the download-and-save jobs.
Since multiple workers might be trying to save at the same time, we'll want to use a database that can handle concurrent writes.
Collisions should be handled before files could be overwritten.

See more:
- https://api.slack.com/types/file
- https://api.slack.com/tutorials/working-with-files
- https://www.npmjs.com/package/bull
- https://medium.com/@alvenw/how-to-store-images-to-mongodb-with-node-js-fb3905c37e6d
- https://docs.mongodb.com/manual/core/gridfs/
- https://stackoverflow.com/questions/10648729/mongo-avoid-duplicate-files-in-gridfs
*/
