import http from "http";
import { registry } from "../progress/metrics";
import { Worker, Job } from "bullmq";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();
import { VideoJob } from "../types/types";
import {
  downloadFromS3,
  uploadDirectoryToS3,
  uploadFileToS3,
} from "../s3-service/s3.service";
import { transcode, generateThumbnailFile, getVideoDuration } from "../transcoder/transcoder";
import { onProgress, clearProgress } from "../progress/progress";
import { jobsCompleted, jobsFailed, jobDuration, activeJobs } from "../progress/metrics";
import { compress } from "../processors/compress";
import { convert } from "../processors/convert";
import { extractAudio } from "../processors/extract-audio";
import { trim } from "../processors/trim";
import { downloadFromUrl, getUrlTitle } from "../processors/download-url";

interface VideoDoc {
  _id: string;
  status: string;
  masterPlaylistUrl?: string;
  resolutions?: string[];
  updatedAt?: Date;
  originalName?: string;
  sizeBytes?: number;
}
function videosCollection() {
  return mongoose.connection.collection<VideoDoc>("videos");
}
async function connectMongo() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGODB_URI!);
    console.info("[worker] MongoDB connected");
  }
}
async function markCompleted(videoId: string, masterPlaylistUrl: string, resolutions?: string[]) {
  const update: any = { status: "completed", masterPlaylistUrl, updatedAt: new Date() };
  if (resolutions) {
    update.resolutions = resolutions;
  }
  await videosCollection().updateOne(
    { _id: videoId },
    { $set: update },
  );
  console.info(
    `[${videoId}] DB updated — status: completed, masterPlaylistUrl set, resolutions: ${resolutions}`,
  );
}
async function markFailed(videoId: string, reason: string) {
  await videosCollection().updateOne(
    { _id: videoId },
    { $set: { status: "failed", updatedAt: new Date() } },
  );
  console.error(`[${videoId}] DB updated — status: failed. Reason: ${reason}`);
}
async function markCompletedWithOutput(videoId: string, outputUrl: string, sizeBytes?: number) {
  const updateDoc: any = { status: "completed", outputUrl, updatedAt: new Date() };
  if (sizeBytes !== undefined && sizeBytes > 0) {
    updateDoc.sizeBytes = sizeBytes;
  }
  await videosCollection().updateOne(
    { _id: videoId },
    { 
      $set: updateDoc,
      $unset: { masterPlaylistUrl: "", resolutions: "" }
    },
  );
  console.info(`[${videoId}] DB updated — outputUrl: ${outputUrl}${sizeBytes ? `, sizeBytes: ${sizeBytes}` : ""}`);
}
function buildOutputUrl(s3Key: string): string {
  const bucket = process.env.S3_PROCESSED_BUCKET!;
  const region = process.env.AWS_REGION || "us-east-1";
  return process.env.CLOUDFRONT_DOMAIN
    ? `https://${process.env.CLOUDFRONT_DOMAIN}/${s3Key}`
    : `https://${bucket}.s3.${region}.amazonaws.com/${s3Key}`;
}
async function tryGenerateAndUploadThumbnail(videoId: string, inputPath: string, timestampSeconds?: number) {
  try {
    const tmpThumbnailPath = path.join(os.tmpdir(), `thumbnail-${videoId}.jpg`);
    let ss = timestampSeconds !== undefined ? timestampSeconds : 2;
    if (timestampSeconds === undefined) {
      try {
        const duration = await getVideoDuration(inputPath);
        if (duration > 0) {
          ss = Math.min(2, duration * 0.1);
        }
      } catch {}
    }
    
    await generateThumbnailFile(inputPath, tmpThumbnailPath, ss);
    
    const processedBucket = process.env.S3_PROCESSED_BUCKET!;
    const s3Key = `processed/${videoId}/thumbnail.jpg`;
    await uploadFileToS3(tmpThumbnailPath, processedBucket, s3Key);
    
    const playbackOrigin = process.env.CLOUDFRONT_DOMAIN
      ? `https://${process.env.CLOUDFRONT_DOMAIN}`
      : `https://${processedBucket}.s3.${process.env.AWS_REGION}.amazonaws.com`;
    const thumbnailUrl = `${playbackOrigin}/${s3Key}`;
    
    await videosCollection().updateOne(
      { _id: videoId },
      { $set: { thumbnailUrl } }
    );
    console.info(`[${videoId}] Thumbnail generated and uploaded: ${thumbnailUrl}`);
    await fs.rm(tmpThumbnailPath, { force: true });
    return thumbnailUrl;
  } catch (err) {
    console.warn(`[${videoId}] Failed to generate/upload thumbnail:`, err);
    return null;
  }
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
  Math.min(Number(process.env.WORKER_CONCURRENCY ?? 1), 2),
);

const worker = new Worker<VideoJob>(
  "video-transcode",
  async (job: Job<VideoJob>) => {
    await connectMongo();

    console.log("[worker] Initialising job...");
    const { videoId, s3Key, bucket, jobType = "transcode" } = job.data;
    console.log(`[worker] Picked job: type=${jobType}`, job.data);

    const tmpDir = path.join(os.tmpdir(), `job-${videoId}`);
    const inputPath = path.join(tmpDir, "input.mp4");
    const outputDir = path.join(tmpDir, "out");
    activeJobs.inc();
    const endTimer = jobDuration.startTimer();
    try {
      await fs.mkdir(tmpDir, { recursive: true });
      if (jobType === "download-url") {
        const sourceUrl = job.data.sourceUrl!;
        console.info(`[${videoId}] Fetching YouTube title for ${sourceUrl}...`);
        const title = getUrlTitle(sourceUrl);
        if (title) {
          console.info(`[${videoId}] Updating originalName to "${title}"`);
          await videosCollection().updateOne(
            { _id: videoId },
            { $set: { originalName: title } },
          );
        }
        console.info(`[${videoId}] Downloading from URL...`);
        await job.updateProgress(10);
        const { downloadedPath } = await downloadFromUrl({
          videoId,
          sourceUrl,
          outputDir: tmpDir,
        });
        try {
          const stats = await fs.stat(downloadedPath);
          console.info(`[${videoId}] Updating sizeBytes to ${stats.size}`);
          const rawBucket = process.env.S3_RAW_BUCKET || "videoforge-raw";
          const rawS3Key = `uploads/${videoId}/original.mp4`;
          console.info(
            `[${videoId}] Uploading original downloaded file to S3: s3://${rawBucket}/${rawS3Key}`,
          );
          await uploadFileToS3(downloadedPath, rawBucket, rawS3Key);
          await videosCollection().updateOne(
            { _id: videoId },
            {
              $set: {
                sizeBytes: stats.size,
                s3Key: rawS3Key,
                bucket: rawBucket,
              },
            },
          );
        } catch (err) {
          console.warn(
            `[${videoId}] Failed to update sizeBytes or upload original to S3:`,
            err,
          );
        }
        const targetJobType = job.data.targetJobType;
        if (targetJobType === "compress") {
          console.info(`[${videoId}] Starting compression on downloaded file...`);
          await job.updateProgress(30);
          const result = await compress({
            videoId,
            inputPath: downloadedPath,
            outputDir,
            targetSizeMB: job.data.targetSizeMB!,
          });
          await job.updateProgress(90);
          const s3Key_out = `processed/${videoId}/compressed.mp4`;
          await uploadFileToS3(
            result.outputPath,
            process.env.S3_PROCESSED_BUCKET!,
            s3Key_out,
          );
          await job.updateProgress(100);
          const outputUrl = buildOutputUrl(s3Key_out);
          const sizeBytes = await fs.stat(result.outputPath).then(s => s.size).catch(() => 0);
          await markCompletedWithOutput(videoId, outputUrl, sizeBytes);
          jobsCompleted.inc();
          endTimer();
          return { videoId, outputUrl };
        }

        console.info(`[${videoId}] Starting transcode on downloaded file...`);
        await job.updateProgress(30);
        onProgress(videoId, (p) =>
          job.updateProgress(30 + Math.floor(p.percentage * 0.5)),
        );
        const result = await transcode({
          videoId,
          inputPath: downloadedPath,
          outputDir,
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
        await markCompleted(videoId, masterPlaylistUrl, result.resolutions);
        jobsCompleted.inc();
        endTimer();
        return { videoId, masterPlaylistUrl, resolutions: result.resolutions };
      }
      console.info(`[${videoId}] Downloading from S3...`);
      await job.updateProgress(5);
      await downloadFromS3(bucket, s3Key, inputPath);
      await job.updateProgress(10);
      switch (jobType) {
        case "transcode": {
          onProgress(videoId, (p) =>
            job.updateProgress(10 + Math.floor(p.percentage * 0.8)),
          );
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
          await markCompleted(videoId, masterPlaylistUrl, result.resolutions);
          jobsCompleted.inc();
          endTimer();
          return {
            videoId,
            masterPlaylistUrl,
            resolutions: result.resolutions,
          };
        }
        case "compress": {
          const result = await compress({
            videoId,
            inputPath,
            outputDir,
            targetSizeMB: job.data.targetSizeMB!,
            compressionMode: job.data.compressionMode,
            upscale: job.data.upscale,
          });
          if (result.skipped) {
            console.info(
              `[${videoId}] Compression skipped (file too small) — uploading source copy`,
            );
          }
          await job.updateProgress(90);
          const s3Key_out = `processed/${videoId}/compressed.mp4`;
          await uploadFileToS3(
            result.outputPath,
            process.env.S3_PROCESSED_BUCKET!,
            s3Key_out,
          );
          await job.updateProgress(100);
          const outputUrl = buildOutputUrl(s3Key_out);
          const sizeBytes = await fs.stat(result.outputPath).then(s => s.size).catch(() => 0);
          await markCompletedWithOutput(videoId, outputUrl, sizeBytes);
          jobsCompleted.inc();
          endTimer();
          return {
            videoId,
            outputUrl,
            mode: result.mode,
            skipped: result.skipped,
          };
        }
        case "convert": {
          const result = await convert({
            videoId,
            inputPath,
            outputDir,
            outputFormat: job.data.outputFormat!,
          });
          await job.updateProgress(90);
          const s3Key_out = `processed/${videoId}/converted.${job.data.outputFormat}`;
          await uploadFileToS3(
            result.outputPath,
            process.env.S3_PROCESSED_BUCKET!,
            s3Key_out,
          );
          await job.updateProgress(100);
          const outputUrl = buildOutputUrl(s3Key_out);
          const sizeBytes = await fs.stat(result.outputPath).then(s => s.size).catch(() => 0);
          await markCompletedWithOutput(videoId, outputUrl, sizeBytes);
          jobsCompleted.inc();
          endTimer();
          return { videoId, outputUrl };
        }
        case "extract-audio": {
          const result = await extractAudio({
            videoId,
            inputPath,
            outputDir,
            audioFormat: job.data.audioFormat!,
          });
          await job.updateProgress(90);
          const s3Key_out = `processed/${videoId}/audio.${job.data.audioFormat}`;
          await uploadFileToS3(
            result.outputPath,
            process.env.S3_PROCESSED_BUCKET!,
            s3Key_out,
          );
          await job.updateProgress(100);
          const outputUrl = buildOutputUrl(s3Key_out);
          const sizeBytes = await fs.stat(result.outputPath).then(s => s.size).catch(() => 0);
          await markCompletedWithOutput(videoId, outputUrl, sizeBytes);
          jobsCompleted.inc();
          endTimer();
          return { videoId, outputUrl };
        }
        case "trim": {
          const result = await trim({
            videoId,
            inputPath,
            outputDir,
            startTime: job.data.startTime!,
            endTime: job.data.endTime!,
          });
          await job.updateProgress(90);
          const s3Key_out = `processed/${videoId}/trimmed.mp4`;
          await uploadFileToS3(
            result.outputPath,
            process.env.S3_PROCESSED_BUCKET!,
            s3Key_out,
          );
          await job.updateProgress(100);
          const outputUrl = buildOutputUrl(s3Key_out);
          const sizeBytes = await fs.stat(result.outputPath).then(s => s.size).catch(() => 0);
          await markCompletedWithOutput(videoId, outputUrl, sizeBytes);
          jobsCompleted.inc();
          endTimer();
          return { videoId, outputUrl };
        }
        case "thumbnail": {
          await job.updateProgress(10);
          const duration = await getVideoDuration(inputPath);
          if (job.data.startTime !== undefined && job.data.startTime > duration) {
            throw new Error(`Requested timestamp ${job.data.startTime}s exceeds video duration of ${duration.toFixed(1)}s`);
          }
          await job.updateProgress(30);
          const thumbnailUrl = await tryGenerateAndUploadThumbnail(videoId, inputPath, job.data.startTime);
          await job.updateProgress(100);
          if (thumbnailUrl) {
            await videosCollection().updateOne(
              { _id: videoId },
              { $set: { status: "completed", outputUrl: thumbnailUrl, updatedAt: new Date() } },
            );
            jobsCompleted.inc();
            endTimer();
            return { videoId, thumbnailUrl };
          } else {
            throw new Error("Failed to generate thumbnail");
          }
        }
        default:
          throw new Error(`Unknown jobType: ${jobType}`);
      }
    } catch (err: any) {
      jobsFailed.inc();
      endTimer();
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isFinalAttempt) {
        await markFailed(videoId, err?.message ?? "unknown");
        console.error(`[${videoId}] Job permanently failed:`, err);
      } else {
        console.warn(
          `[${videoId}] Attempt ${job.attemptsMade + 1} failed, retrying... Error:`,
          err,
        );
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
  },
);

worker.on("completed", (job) => {
  console.info(`Job completed: ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`Job failed: ${job?.id}`, err.message);
});

console.info("Transcoder worker started");

async function shutdown(signal: string): Promise<void> {
  console.info(`[worker] ${signal} received, closing worker...`);
  await worker.close();
  await mongoose.disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

http
  .createServer(async (_req, res) => {
    res.setHeader("Content-Type", registry.contentType);
    res.end(await registry.metrics());
  })
  .listen(9091, () => {
    console.info("[worker] Metrics server listening on :9091");
  });
