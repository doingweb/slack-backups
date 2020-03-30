import * as path from 'path';
import { promises as fs, createWriteStream } from 'fs';
import { Readable } from 'stream';
import { parse as urlParse } from 'url';
import axios, { AxiosResponse } from 'axios';
import * as Queue from 'bull';
import * as low from 'lowdb';
import * as FileSync from 'lowdb/adapters/FileSync';
import * as mkdirp from 'mkdirp';
import * as moment from 'moment';
import * as Spinnies from 'spinnies';

const slackExportPath = process.argv[2];

const downloadedFilesPath = path.join(slackExportPath, '.files');
mkdirp.sync(downloadedFilesPath);

const downloadConcurrency = 2;
const fileDownloadQueue = createFileDownloadQueue();
const queueDrained = new Promise(resolve => {
  fileDownloadQueue.on('drained', resolve);
});
setUpProgressMonitoring(fileDownloadQueue);

const manifestDb = createManifestDb();
const problemsDb = createProblemsDb();

crawl().then(() => process.exit());

async function crawl() {
  const channels = await getChannels();
  const users = await getUsers();

  await Promise.all(
    channels.map(crawlChannel)
  );

  if ((await fileDownloadQueue.count()) > 0) {
    await queueDrained;
  }
  await fileDownloadQueue.whenCurrentJobsFinished();

  const jobCounts = await fileDownloadQueue.getJobCounts();

  await fileDownloadQueue.close();

  console.log('Queue drained 🕳', JSON.stringify(jobCounts, null, 2));

  console.log(`did all the things I guess 🤷‍♀️`);
}

async function crawlChannel(channel: SlackChannel) {
  const channelDirPath = path.join(slackExportPath, channel.name);
  const channelChatFilenames = await fs.readdir(channelDirPath, 'utf-8');

  await Promise.all(
    channelChatFilenames.map(channelChatFilename =>
      crawlChannelChatFile(channel, path.join(channelDirPath, channelChatFilename))
    )
  );
}

async function crawlChannelChatFile(channel: SlackChannel, filePath: string) {
  const messages = await getObjectsFromFile<SlackMessage>(filePath);
  const messagesWithFiles = messages.filter(m => m.files);

  const manifest = manifestDb.getState();

  await Promise.all(messagesWithFiles.map(async message => {
    await Promise.all(message.files.map(async file => {
      if (file.mode === 'hidden_by_limit') {
        reportFileHiddenByLimit(file);
        console.error(`File ${file.id} (in #${channel.name} at ${moment.unix(parseFloat(message.ts)).toLocaleString()}) cannot be downloaded because it is hidden by the Free account storage limit.`);
        return;
      }

      if (manifest[file.id]) {
        console.log(`✅ ${file.id} was already in the manifest. Skipping.`);
        return;
      }

      await fileDownloadQueue.add({
        name: path.join(getNewDirectoryPath(file, channel), file.name).split('/').join(' / '),
        channel,
        message,
        file
      });
    }));
  }));
}

async function processDownload(job: Queue.Job<FileDownloadJobData>) {
  const { data: { channel, file } } = job;

  // Enumerate exact files to download
  const downloadables = getDownloadArgsList(file, channel);

  // The object we'll save to the manifest for this file ID
  // We already checked that it doesn't exist before queueing the job
  const manifestRecord = {};

  // Download each in series (reporting progress along the way).
  for (const [index, {url, localPath, derivativeKey}] of downloadables.entries()) {
    try {
      await downloadSingleFile(url, localPath, index, downloadables.length, job.progress.bind(job));
    }
    catch (error) {
      handleSingleFileDownloadError(error);
      continue;
    }

    const relativePath = path.relative(downloadedFilesPath, localPath);
    Object.assign(
      manifestRecord,
      derivativeKey ? { [derivativeKey]: relativePath } : { original: relativePath }
    );

    console.log(`🎉 Successfully downloaded ${localPath}`);
  }

  // Write to database
  manifestDb.set(file.id, manifestRecord).write();

  return { status: JobStatus.Success, manifestRecord };
}

async function downloadSingleFile(url: string, localPath: string, seriesIndex: number, seriesSize: number, progressReporter: (currentPercentage: number) => void) {
  const downloadStream = await getFileDownloadStream(url);

  // TODO: Report problem and throw if status not 200?

  const totalDownloadSize = getDownloadSize(downloadStream);
  let downloadedSize = 0;

  if (await isFileAlreadyDownloaded(localPath, totalDownloadSize)) {
    return;
  }

  await mkdirp(path.dirname(localPath));
  const localFileWriter = createWriteStream(localPath);
  downloadStream.data.on('data', chunk => {
    downloadedSize += chunk.length;
    const downloadRatio = downloadedSize / totalDownloadSize;
    const singleFileProportion = 1 / seriesSize;
    const progressFromFilesAlreadyDownloaded = singleFileProportion * seriesIndex;
    const progress = (progressFromFilesAlreadyDownloaded + (downloadRatio * singleFileProportion)) * 100;

    progressReporter(progress);
  });

  downloadStream.data.pipe(localFileWriter);

  try {
    await new Promise((resolve, reject) => {
      localFileWriter.on('finish', resolve);
      localFileWriter.on('error', reject);
    });
  }
  catch (writerError) {
    throw new FileWriteError(url, localPath, writerError)
  }

  // Stop all the downloading (verify file)
  const downloadedFileStats = await fs.stat(localPath);
  if (downloadedFileStats.size !== totalDownloadSize) {
    throw new FileSizeMismatchError(url, localPath);
  }
}

async function isFileAlreadyDownloaded(filePath: string, expectedSize: number): Promise<boolean> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size === expectedSize;
  } catch (error) {
    return false;
  }
}

function getDownloadSize(downloadStream: AxiosResponse<Readable>) {
  return parseInt(downloadStream.headers['content-length']);
}

async function getFileDownloadStream(url: string): Promise<AxiosResponse<Readable>> {
  return axios.get<Readable>(url, {
    responseType: 'stream'
  });
}

function reportFileHiddenByLimit(file: SlackFile) {
  const hiddenByLimitList = problemsDb.get('hiddenByLimit').value();

  if (hiddenByLimitList.includes(file.id)) {
    return;
  }

  problemsDb.get('hiddenByLimit')
    .push(file.id)
    .write();
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

function createManifestDb() {
  const db = low(new FileSync(path.join(downloadedFilesPath, 'manifest.json')));
  db.defaults({}).write();
  return db;
}

function createProblemsDb() {
  const db = low(new FileSync(path.join(downloadedFilesPath, 'problems.json')));
  db.defaults({ hiddenByLimit: [], failedDownload: [] }).write();
  return db;
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
    if (!file[key]) {
      // Sometimes we don't have all the derivatives, and that's okay 🌈
      continue;
    }

    downloads.push({
      derivativeKey: key,
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
  derivativeKey?: string,
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
    case 'png':
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

function handleSingleFileDownloadError(error: SingleFileDownloadError) {
  const downloadFailureRecord: any = {
    reason: error.message,
    url: error.url,
    localPath: error.localPath
  };

  if (error instanceof FileWriteError) {
    downloadFailureRecord.error = error.innerError;
    console.error(error.innerError);
  } else if (error instanceof FileSizeMismatchError) {
    console.error(`😶 File size mismatch: ${error.localPath}`);
  } else {
    console.error(`😨 Unknown download error: ${error.message}`);
    downloadFailureRecord.error = error;
  }

  problemsDb.get('failedDownload')
    .push(downloadFailureRecord)
    .write();
}

class SingleFileDownloadError extends Error {
  constructor(public url: string, public localPath: string, message: string) {
    super(message);
    Object.setPrototypeOf(this, SingleFileDownloadError.prototype);
  }
}

class FileWriteError extends SingleFileDownloadError {
  constructor(public url: string, public localPath: string, public innerError: Error) {
    super(url, localPath, 'Local fs write stream error.');
    Object.setPrototypeOf(this, FileWriteError.prototype);
  }
}

class FileSizeMismatchError extends SingleFileDownloadError {
  constructor(public url: string, public localPath: string) {
    super(url, localPath, 'Local file size did not match.');
    Object.setPrototypeOf(this, FileSizeMismatchError.prototype);
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

interface FileDownloadJobData {
  name: string,
  file: SlackFile,
  message: SlackMessage,
  channel: SlackChannel
}
