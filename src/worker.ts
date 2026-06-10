import http from 'http';
import { registry } from './metrics';
import { Worker, Job } from 'bullmq';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();
import { VideoJob } from './types';
import { downloadFromS3, uploadDirectoryToS3, uploadFileToS3 } from './s3.service';
import { transcode } from './transcoder';
import { onProgress, clearProgress } from './progress';
import { jobsCompleted, jobsFailed, jobDuration, activeJobs } from './metrics';
import { compress } from './processors/compress';
import { convert } from './processors/convert';
import { extractAudio } from './processors/extract-audio';
import { trim } from './processors/trim';
import { downloadFromUrl, getUrlTitle } from './processors/download-url';

interface VideoDoc {
  _id: string;
  status: string;
  masterPlaylistUrl?: string;
  updatedAt?: Date;
  originalName?: string;
  sizeBytes?: number;
}

function videosCollection() {
  return mongoose.connection.collection<VideoDoc>('videos');
}

async function connectMongo() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI!);
    console.info('[worker] MongoDB connected');
  }
}

async function markCompleted(videoId: string, masterPlaylistUrl: string) {
  await videosCollection().updateOne(
    { _id: videoId },
    { $set: { status: 'completed', masterPlaylistUrl, updatedAt: new Date() } }
  );
  console.info(`[${videoId}] DB updated — status: completed, masterPlaylistUrl set`);
}

async function markFailed(videoId: string, reason: string) {
  await videosCollection().updateOne(
    { _id: videoId },
    { $set: { status: 'failed', updatedAt: new Date() } }
  );
  console.error(`[${videoId}] DB updated — status: failed. Reason: ${reason}`);
}

async function markCompletedWithOutput(videoId: string, outputUrl: string) {
  await videosCollection().updateOne(
    { _id: videoId },
    { $set: { status: 'completed', outputUrl, updatedAt: new Date() } }
  );
  console.info(`[${videoId}] DB updated — outputUrl: ${outputUrl}`);
}

function buildOutputUrl(s3Key: string): string {
  const bucket = process.env.S3_PROCESSED_BUCKET!;
  const region = process.env.AWS_REGION || 'us-east-1';
  return process.env.CLOUDFRONT_DOMAIN
    ? `https://${process.env.CLOUDFRONT_DOMAIN}/${s3Key}`
    : `https://${bucket}.s3.${region}.amazonaws.com/${s3Key}`;
}
if (!process.env.REDIS_HOST) {
  throw new Error("REDIS_HOST missing");
}
const REDIS_CONNECTION = {
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT ?? 6379),
};
const WORKER_CONCURRENCY = Math.max(
  1,
  Math.min(Number(process.env.WORKER_CONCURRENCY ?? 1), 2)
);

const worker = new Worker<VideoJob>(
  'video-transcode',
  async (job: Job<VideoJob>) => {
    await connectMongo();

    console.log('[worker] Initialising job...');
    const { videoId, s3Key, bucket, jobType = 'transcode' } = job.data;
    console.log(`[worker] Picked job: type=${jobType}`, job.data);

    const tmpDir = path.join(os.tmpdir(), `job-${videoId}`);
    const inputPath = path.join(tmpDir, 'input.mp4');
    const outputDir = path.join(tmpDir, 'out');

    activeJobs.inc();
    const endTimer = jobDuration.startTimer();

    try {
      await fs.mkdir(tmpDir, { recursive: true });

      // download-url skips S3 download — gets file from internet directly
      if (jobType === 'download-url') {
        const sourceUrl = job.data.sourceUrl!;
        console.info(`[${videoId}] Fetching YouTube title for ${sourceUrl}...`);
        const title = getUrlTitle(sourceUrl);
        if (title) {
          console.info(`[${videoId}] Updating originalName to "${title}"`);
          await videosCollection().updateOne(
            { _id: videoId },
            { $set: { originalName: title } }
          );
        }

        console.info(`[${videoId}] Downloading from URL...`);
        await job.updateProgress(10);
        const { downloadedPath } = await downloadFromUrl({
          videoId,
          sourceUrl,
          outputDir: tmpDir,
        });

        // After download completes, get size and update DB
        const stats = await fs.stat(downloadedPath);
        console.info(`[${videoId}] Updating sizeBytes to ${stats.size}`);
        await videosCollection().updateOne(
          { _id: videoId },
          { $set: { sizeBytes: stats.size } }
        );

        // After download, run HLS transcode on it
        console.info(`[${videoId}] Starting transcode on downloaded file...`);
        await job.updateProgress(30);
        onProgress(videoId, (p) => job.updateProgress(30 + Math.floor(p.percentage * 0.5)));

        const result = await transcode({ videoId, inputPath: downloadedPath, outputDir });
        clearProgress(videoId);

        await job.updateProgress(90);
        const processedBucket = process.env.S3_PROCESSED_BUCKET!;
        const s3OutputPrefix = `processed/${videoId}`;
        await uploadDirectoryToS3(outputDir, processedBucket, s3OutputPrefix);

        await job.updateProgress(100);
        const playbackOrigin = process.env.CLOUDFRONT_DOMAIN
          ? `https://${process.env.CLOUDFRONT_DOMAIN}`
          : `https://${processedBucket}.s3.${process.env.AWS_REGION}.amazonaws.com`;
        const masterPlaylistUrl = `${playbackOrigin}/${s3OutputPrefix}/master.m3u8`;
        await markCompleted(videoId, masterPlaylistUrl);
        jobsCompleted.inc();
        endTimer();
        return { videoId, masterPlaylistUrl, resolutions: result.resolutions };
      }

      // All other job types — first download from S3
      console.info(`[${videoId}] Downloading from S3...`);
      await job.updateProgress(5);
      await downloadFromS3(bucket, s3Key, inputPath);
      await job.updateProgress(10);

      switch (jobType) {

        case 'transcode': {
          onProgress(videoId, (p) => job.updateProgress(10 + Math.floor(p.percentage * 0.8)));
          const result = await transcode({
            videoId,
            inputPath,
            outputDir,
            resolution: job.data.resolution,
          });
          clearProgress(videoId);
          await job.updateProgress(90);

          const processedBucket = process.env.S3_PROCESSED_BUCKET!;
          const s3OutputPrefix = `processed/${videoId}`;
          await uploadDirectoryToS3(outputDir, processedBucket, s3OutputPrefix);
          await job.updateProgress(100);

          const playbackOrigin = process.env.CLOUDFRONT_DOMAIN
            ? `https://${process.env.CLOUDFRONT_DOMAIN}`
            : `https://${processedBucket}.s3.${process.env.AWS_REGION}.amazonaws.com`;
          const masterPlaylistUrl = `${playbackOrigin}/${s3OutputPrefix}/master.m3u8`;
          await markCompleted(videoId, masterPlaylistUrl);
          jobsCompleted.inc();
          endTimer();
          return { videoId, masterPlaylistUrl, resolutions: result.resolutions };
        }

        case 'compress': {
          const result = await compress({
            videoId,
            inputPath,
            outputDir,
            targetSizeMB: job.data.targetSizeMB!,
            // forward the caller's mode preference; defaults to FAST inside compress()
            compressionMode: job.data.compressionMode,
            upscale: job.data.upscale,
          });
          if (result.skipped) {
            console.info(`[${videoId}] Compression skipped (file too small) — uploading source copy`);
          }
          await job.updateProgress(90);
          const s3Key_out = `processed/${videoId}/compressed.mp4`;
          await uploadFileToS3(result.outputPath, process.env.S3_PROCESSED_BUCKET!, s3Key_out);
          await job.updateProgress(100);
          const outputUrl = buildOutputUrl(s3Key_out);
          await markCompletedWithOutput(videoId, outputUrl);
          jobsCompleted.inc();
          endTimer();
          return { videoId, outputUrl, mode: result.mode, skipped: result.skipped };
        }

        case 'convert': {
          const result = await convert({
            videoId,
            inputPath,
            outputDir,
            outputFormat: job.data.outputFormat!,
          });
          await job.updateProgress(90);
          const s3Key_out = `processed/${videoId}/converted.${job.data.outputFormat}`;
          await uploadFileToS3(result.outputPath, process.env.S3_PROCESSED_BUCKET!, s3Key_out);
          await job.updateProgress(100);
          const outputUrl = buildOutputUrl(s3Key_out);
          await markCompletedWithOutput(videoId, outputUrl);
          jobsCompleted.inc();
          endTimer();
          return { videoId, outputUrl };
        }

        case 'extract-audio': {
          const result = await extractAudio({
            videoId,
            inputPath,
            outputDir,
            audioFormat: job.data.audioFormat!,
          });
          await job.updateProgress(90);
          const s3Key_out = `processed/${videoId}/audio.${job.data.audioFormat}`;
          await uploadFileToS3(result.outputPath, process.env.S3_PROCESSED_BUCKET!, s3Key_out);
          await job.updateProgress(100);
          const outputUrl = buildOutputUrl(s3Key_out);
          await markCompletedWithOutput(videoId, outputUrl);
          jobsCompleted.inc();
          endTimer();
          return { videoId, outputUrl };
        }

        case 'trim': {
          const result = await trim({
            videoId,
            inputPath,
            outputDir,
            startTime: job.data.startTime!,
            endTime: job.data.endTime!,
          });
          await job.updateProgress(90);
          const s3Key_out = `processed/${videoId}/trimmed.mp4`;
          await uploadFileToS3(result.outputPath, process.env.S3_PROCESSED_BUCKET!, s3Key_out);
          await job.updateProgress(100);
          const outputUrl = buildOutputUrl(s3Key_out);
          await markCompletedWithOutput(videoId, outputUrl);
          jobsCompleted.inc();
          endTimer();
          return { videoId, outputUrl };
        }

        default:
          throw new Error(`Unknown jobType: ${jobType}`);
      }

    } catch (err: any) {
      jobsFailed.inc();
      endTimer();
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isFinalAttempt) {
        await markFailed(videoId, err?.message ?? 'unknown');
        console.error(`[${videoId}] Job permanently failed:`, err);
      } else {
        console.warn(`[${videoId}] Attempt ${job.attemptsMade + 1} failed, retrying... Error:`, err);
      }
      throw err;
    } finally {
      clearProgress(videoId);
      activeJobs.dec();
      await fs.rm(tmpDir, { recursive: true, force: true });
      console.info(`[${videoId}] Tmp cleaned`);
    }
  },
  {
    connection: REDIS_CONNECTION,
    concurrency: WORKER_CONCURRENCY,
    lockDuration: 600_000,
    stalledInterval: 30_000,
    maxStalledCount: 2,
  }
);

worker.on('completed', (job) => {
  console.info(`Job completed: ${job.id}`);
});

worker.on('failed', (job, err) => {
  console.error(`Job failed: ${job?.id}`, err.message);
});

console.info('Transcoder worker started');

async function shutdown(signal: string): Promise<void> {
  console.info(`[worker] ${signal} received, closing worker...`);
  await worker.close();
  await mongoose.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

http.createServer(async (_req, res) => {
  res.setHeader('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}).listen(9091, () => {
  console.info('[worker] Metrics server listening on :9091');
});
