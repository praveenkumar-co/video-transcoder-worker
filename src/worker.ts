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
import { downloadFromS3, uploadDirectoryToS3 } from './s3.service';
import { transcode } from './transcoder';
import { onProgress, clearProgress } from './progress';
import { jobsCompleted, jobsFailed, jobDuration, activeJobs } from './metrics';

interface VideoDoc {
  _id: string;
  status: string;
  masterPlaylistUrl?: string;
  updatedAt?: Date;
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
    const { videoId, s3Key, bucket } = job.data;
    console.log(`[worker] Picked job:`, job.data);
    const tmpDir = path.join(os.tmpdir(), `transcode-${videoId}`);
    const inputPath = path.join(tmpDir, 'input.mp4');
    const outputDir = path.join(tmpDir, 'out');
    console.log(`[worker] Temp dir: ${tmpDir}`);
    activeJobs.inc();
    const endTimer = jobDuration.startTimer();
    try {
      await fs.mkdir(tmpDir, { recursive: true });
      console.info(`[${videoId}] Downloading from S3...`);
      await job.updateProgress(5);
      await downloadFromS3(bucket, s3Key, inputPath);

      console.info(`[${videoId}] Starting FFmpeg...`);
      await job.updateProgress(10);

      onProgress(videoId, (progress) => {
        job.updateProgress(10 + Math.floor(progress.percentage * 0.8));
      });

      const result = await transcode({ videoId, inputPath, outputDir });

      clearProgress(videoId);

      console.info(`[${videoId}] Uploading HLS output...`);
      await job.updateProgress(90);

      const processedBucket = process.env.S3_PROCESSED_BUCKET!;
      const s3OutputPrefix = `processed/${videoId}`;

      await uploadDirectoryToS3(outputDir, processedBucket, s3OutputPrefix);

      await job.updateProgress(100);
      const region = process.env.AWS_REGION || 'us-east-1';
      const playbackOrigin = process.env.CLOUDFRONT_DOMAIN
        ? `https://${process.env.CLOUDFRONT_DOMAIN}`
        : `https://${processedBucket}.s3.${region}.amazonaws.com`;
      const masterPlaylistUrl = `${playbackOrigin}/${s3OutputPrefix}/master.m3u8`;
      await markCompleted(videoId, masterPlaylistUrl);
      jobsCompleted.inc();
      endTimer();
      console.info(`[${videoId}] Done. Resolutions: ${result.resolutions.join(', ')}`);
      return {
        videoId,
        masterPlaylistUrl,
        resolutions: result.resolutions,
        masterPlaylist: result.masterPlaylistPath,
      };
    } catch (err: any) {
      jobsFailed.inc();
      endTimer();
      const attemptsAllowed = job.opts.attempts ?? 1;
      const isFinalAttempt = job.attemptsMade + 1 >= attemptsAllowed;

      if (isFinalAttempt) {
        await markFailed(videoId, err?.message ?? 'unknown error');
      } else {
        console.warn(
          `[${videoId}] Attempt ${job.attemptsMade + 1}/${attemptsAllowed} failed; BullMQ will retry. Reason: ${err?.message ?? 'unknown error'}`
        );
      }
      throw err;
    } finally {
      clearProgress(videoId);
      activeJobs.dec();
      await fs.rm(tmpDir, { recursive: true, force: true });
      console.info(`[${videoId}] Tmp cleaned up`);
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
