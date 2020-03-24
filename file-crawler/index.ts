import * as path from 'path';
import { promises as fs, createWriteStream } from 'fs';
import { parse as urlParse } from 'url';
import Axios from 'axios';
import * as Queue from 'bull';
import * as level from 'level';
import { LevelUp } from 'levelup';
import * as low from 'lowdb';
import * as FileSync from 'lowdb/adapters/FileSync';
import * as mkdirp from 'mkdirp';
import * as moment from 'moment';
import * as Spinnies from 'spinnies';

// TODO: Pass this in somehow -- command line arg?
const slackExportPath = '/Users/chris/Downloads/export-test';

const downloadedFilesPath = path.join(slackExportPath, '.files');
const downloadConcurrency = 2;
const fileDownloadQueue = createFileDownloadQueue();

const manifestDb: LevelUp = level(path.join(downloadedFilesPath, 'manifest-db'));
const problemsDb = low(new FileSync(path.join(downloadedFilesPath, 'problems.json')));
problemsDb.defaults({ hiddenByLimit: [], failedDownload: [] }).write();

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
        reportFileHiddenByLimit(file);

        console.error(`File ${file.id} (in #${channel.name} at ${moment.unix(parseFloat(message.ts)).toLocaleString()}) cannot be downloaded because it is hidden by the Free account storage limit.`);
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

function reportFileHiddenByLimit(file: SlackFile) {
  const hiddenByLimitList = problemsDb.get('hiddenByLimit');

  if (hiddenByLimitList.includes(file.id)) {
    return;
  }

  hiddenByLimitList.push(file.id).write();
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
    await manifestDb.get(file.id); // Not throwing means the record exists
    return { status: JobStatus.AlreadyDownloaded };
  } catch (error) {
    if (error.name !== 'NotFoundError') {
      throw error;
    }
  }

  // Enumerate exact files to download
  const downloadables = getDownloadArgsList(file, channel);
  const pathsDownloaded = [];

  // Download each in series (reporting progress along the way).
  // Report non-downloadable files in the `problemsDb` (and throw to fail the job???).
  // TODO: Refactor all this
  for (const [index, {url, localPath}] of downloadables.entries()) {
    const { data, headers, status, statusText } = await Axios({
      url,
      responseType: 'stream'
    });

    // TODO: Report problem and continue if status not 200?

    const totalDownloadSize = parseInt(headers['content-length']);
    let downloadedSize = 0;

    try {
      const existingFileStats = await fs.stat(localPath);
      if (existingFileStats.size === totalDownloadSize) {
        // The file has been downloaded already
        console.log(`😎 Already downloaded ${localPath}`);
        continue;
      }
      // If the size doesn't match, it probably means the download was interrupted. Re-download it.
    } catch (error) {
      // ENOENT means the file doesn't exist, which is fine; we'll go ahead and download it.
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }

    await mkdirp(path.dirname(localPath));
    const writer = createWriteStream(localPath);
    data.on('data', chunk => {
      downloadedSize += chunk.length;
      const downloadRatio = downloadedSize / totalDownloadSize;
      const singleFileProportion = 1 / downloadables.length;
      const progressFromFilesAlreadyDownloaded = singleFileProportion * index;
      const progress = (progressFromFilesAlreadyDownloaded + (downloadRatio * singleFileProportion)) * 100;

      job.progress(progress);
    });

    data.pipe(writer);

    try {
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve)
        writer.on('error', reject)
      });
    }
    catch (error) {
      problemsDb.get('failedDownload')
        .push({
          url,
          localPath,
          error
        })
        .write();

      console.error(error);
      continue;
    }

    // Stop all the downloading (verify file)
    const downloadedFileStats = await fs.stat(localPath);
    if (downloadedFileStats.size !== totalDownloadSize) {
      problemsDb.get('failedDownload')
        .push({
          url,
          localPath,
          error: { message: 'Local file size did not match.' }
        })
        .write();
      continue;
    }

    // Write to database
    // TODO: Switch to lowdb from level? Would be nice to be able to see what gets produced and be able to diff it etc.

    pathsDownloaded.push(localPath);

    console.log(`🎉 Successfully downloaded ${localPath}`);
  }

  return { status: JobStatus.Success, pathsDownloaded };
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
    url: file.url_private,
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
  return path.basename(urlParse(u).pathname);
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
