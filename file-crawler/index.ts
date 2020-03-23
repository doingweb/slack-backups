import * as path from 'path';
import { promises as fs } from 'fs';
import * as url from 'url';
import * as Queue from 'bull';
import * as level from 'level';
import { LevelUp } from 'levelup';
import * as moment from 'moment';
import * as Spinnies from 'spinnies';

// TODO: Pass this in somehow -- command line arg?
const slackExportPath = '/Users/chris/Downloads/export-test';
const downloadedFilesPath = path.join(slackExportPath, '.files');

const downloadConcurrency = 2;
const fileDownloadQueue = createFileDownloadQueue();
const db: LevelUp = level(path.join(downloadedFilesPath, 'manifest-db'));

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

  setUpProgressMonitoring(fileDownloadQueue);

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

  // DEBUG: Limit to this couple of interesting days.
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
        const messageTime = moment.unix(parseFloat(message.ts));
        console.error(`File ${file.id} (in #${channel.name} at ${messageTime.toLocaleString()}) cannot be downloaded because it is hidden by the Free account storage limit.`);
        continue;
      }

      // TODO: Handling async efficiently here? Each additional file in a message has to wait for the previous one to be added to the queue.
      await fileDownloadQueue.add({
        name: path.join(getNewDirectoryPath(file, channel), file.name).split('/').join(' / '),
        channel,
        message,
        file
      });
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

  queue.process(downloadConcurrency, processDownload);

  return queue;
}

async function processDownload(job: Queue.Job<FileDownloadJobData>) {
  const { data: { channel, file } } = job;

  // Check database for existence
  try {
    await db.get(file.id); // Not throwing means the record exists
    return { status: JobStatus.AlreadyDownloaded };
  } catch (error) {
    if (error.name !== 'NotFoundError') {
      throw error;
    }
  }

  // Enumerate exact files to download
  const urlsToDownload = getDownloadArgsList(file, channel);

  // TODO: Pick up here
  debugger;

  // Download each in series (reporting progress along the way)
  for (let i = 1; i <= 5; i++) {
    await wait(1);
    await job.progress(i * 20);
  }
  function wait(seconds: number) {
    return new Promise(resolve => setTimeout(resolve, seconds * 1000));
  }

  // Stop all the downloading (verify files?)

  // Write to database

  return { status: JobStatus.Success };
}

/**
 * Builds a list of all the information needed to download the file and its derivatives
 *
 * @param {SlackFile} file
 * @returns {string[]}
 */
function getDownloadArgsList(file: SlackFile, channel: SlackChannel): FileDownloadArgs[] {
  const newDirectoryPath = getNewDirectoryPath(file, channel);
  const downloads = [];
  downloads.push({
    url: file.url_private, // TODO: Or is it 'url_private_download'?
    localPath: path.join(downloadedFilesPath, newDirectoryPath, getNewFilename(getFilenameFromUrl(file.url_private), file))
  });

  const derivativeKeys = getDerivativeUrlKeysForFiletype(file.filetype);
  for (const key of derivativeKeys) {
    downloads.push({
      url: file[key],
      localPath: path.join(
        downloadedFilesPath,
        newDirectoryPath,
        key,
        getNewFilename(getFilenameFromUrl(file[key]), file)
      )
    })
  }

  return downloads;
}

function getFilenameFromUrl(u: string) {
  return path.basename(url.parse(u).pathname);
}

interface FileDownloadArgs {
  url: string,
  localPath: string,
}

enum JobStatus {
  Success = 'Success', // The file was successfully downloaded
  AlreadyDownloaded = 'Already Downloaded', // The file had already been downloaded
}

/**
 * A file we were about to download had already been downloaded, but there was no record in the database.
 *
 * @class FileExistsError
 * @extends {Error}
 */
class FileExistsError extends Error {}

/**
 * Gets the keys for a given filetype that contain the URLs of derivative files that we want to download
 */
function getDerivativeUrlKeysForFiletype(filetype: string) {
  switch (filetype) {
    case 'jpg':
      return [
        'thumb_64',
        'thumb_80',
        'thumb_160',
        'thumb_360',
        'thumb_480',
        'thumb_720',
        'thumb_800',
        'thumb_960',
        'thumb_1024',
      ];
    case 'mp4':
    case 'mov':
      return [
        'thumb_video',
      ];
    case 'gif':
      return [
        'thumb_64',
        'thumb_80',
        'thumb_360',
        'thumb_480',
        'thumb_160',
        'thumb_360_gif',
        'thumb_480_gif',
        'deanimate_gif',
      ];
    default:
      throw new Error(`Unrecognized filetype: ${filetype}`);
  }
}

/**
 * Gets the relative path in the repository where the given file should live.
 *
 * @param {SlackFile} file
 * @param {SlackChannel} channel
 * @returns {string} The relative path.
 */
function getNewDirectoryPath(file: SlackFile, channel: SlackChannel): string {
  const year = moment.unix(file.timestamp).year();

  return path.join(year.toString(), channel.name);
}

/**
 * Generates the new filename that we save in our repository.
 *
 * Filename is also included, since it may be for a derivative.
 *
 * @param {string} filename The name of the file on Slack's server.
 * @param {SlackFile} file The file object, which contains the original and derivatives.
 * @returns
 */
function getNewFilename(filename: string, file: SlackFile) {
  const fileTime = moment.unix(file.timestamp);
  return `${fileTime.format('YYYYMMDDHHmmss')}-${file.id}-${filename}`;
}

function setUpProgressMonitoring(queue: Queue.Queue<FileDownloadJobData>) {
  const spinnies = new Spinnies();

  queue.on('active', job => {
    spinnies.add(job.id, { text: spinnerText(job) });
  });

  queue.on('progress', (job, progress: number) => {
    spinnies.update(job.id, { text: spinnerText(job, progress) });
  });

  queue.on('completed', job => {
    spinnies.succeed(job.id);
  });

  function spinnerText(job: Queue.Job<FileDownloadJobData>, progress = 0) {
    return `${progress}% [Job ${job.id}] ${job.data.name}`;
  }
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
  file: SlackFile,
  message: SlackMessage,
  channel: SlackChannel
}

interface DownloadedFile {
  original: string, // Relative path to the downloaded copy of the original file
}
/*
PROPOSAL:

Store images in a directory organized by year ➡ channel ➡ file (prefixed with timestamp & ID).
At the top level of that directory, store a JSON (or whatever) database that maps file IDs to actual files downloaded:

```
{
  "FNMKFC99V": {
    "original": "2019/finn-pics/1568995684-FNMKFC99V-image_from_ios.jpg",
    "thumb_64": "2019/finn-pics/thumb_64/1568995684-FNMKFC99V-image_from_ios.jpg",
    ...
  }
}
```

Side note 1: Should we actually store thumbnails? How would they be used?
  Could we get by generating them on-the-fly? Or maybe just save them -- think about the case of videos especially.

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
