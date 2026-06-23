
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import dotenv from 'dotenv';
dotenv.config();
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Agent as HttpsAgent } from 'https';

if (!process.env.REDIS_HOST) {
  throw new Error("REDIS_HOST missing");
}
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
  maxAttempts: 3,
  requestHandler: new NodeHttpHandler({
    httpsAgent: new HttpsAgent({
      keepAlive: true,
      family: 4,
      maxSockets: 100,
    }),
    requestTimeout: 300000, 
    connectionTimeout: 10000, 
  }),
});

export async function downloadFromS3(
  bucket: string, 
  key: string,
  localPath: string
): Promise<void> {
  console.info(`[downloadFromS3] Fetching s3://${bucket}/${key}`);
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  
  try {
    const response = await s3Client.send(command);
    console.info(`[downloadFromS3] S3 response received, piping to ${localPath}`);
    
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    
    if (!response.Body) {
      throw new Error('No body in S3 response');
    }

    const downloadPromise = new Promise<void>((resolve, reject) => {
      const { createWriteStream } = require('fs');
      const writable = createWriteStream(localPath);
      const readable = response.Body as any;

      readable.pipe(writable);

      readable.on('error', (err: any) => { 
        console.error(`[${key}] Readable error:`, err); 
        reject(err); 
      });
      writable.on('error', (err: any) => { 
        console.error(`[${key}] Writable error:`, err); 
        reject(err); 
      });
      writable.on('finish', () => {
        console.info(`Downloaded: ${key} → ${localPath}`);
        resolve();
      });
    });

    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error(`Download timeout for ${key} after 10 minutes`)), 600_000);
    });

    return Promise.race([downloadPromise, timeoutPromise]);
  } catch (err) {
    console.error("Error in downloadFromS3 s3Client.send", err);
    throw err;
  }
}
export async function uploadDirectoryToS3(
  localDir: string,
  bucket: string,
  s3Prefix: string
): Promise<void> {
  console.info(`[uploadDirectoryToS3] Scanning directory: ${localDir}`);
  const files = await getAllFiles(localDir);
  console.info(`[uploadDirectoryToS3] Found ${files.length} file(s) to upload — uploading with high speed`);

  const concurrency = Math.max(
    1,
    Math.min(Number(process.env.S3_UPLOAD_CONCURRENCY ?? 30), 100)
  );
  console.info(`[uploadDirectoryToS3] Using concurrency: ${concurrency}`);

  let uploadedCount = 0;
  const tasks = files.map((filePath) => {
    return async () => {
      const relativePath = path.relative(localDir, filePath);
      const s3Key = `${s3Prefix}/${relativePath}`.replace(/\\/g, '/');
      const contentType = getContentType(filePath);
      const cacheControl = filePath.endsWith('.ts')
        ? 'max-age=31536000'
        : 'max-age=0, no-cache';

      try {
        const stat = await fs.stat(filePath);
        if (stat.size < 5 * 1024 * 1024) {
          const fileBuffer = await fs.readFile(filePath);
          await s3Client.send(new PutObjectCommand({
            Bucket: bucket,
            Key: s3Key,
            Body: fileBuffer,
            ContentType: contentType,
            CacheControl: cacheControl,
          }));
        } else {
          const upload = new Upload({
            client: s3Client,
            params: {
              Bucket: bucket,
              Key: s3Key,
              Body: createReadStream(filePath),
              ContentType: contentType,
              CacheControl: cacheControl,
            },
          });
          await upload.done();
        }

        uploadedCount++;
        if (uploadedCount % 20 === 0 || uploadedCount === files.length) {
          console.info(`[uploadDirectoryToS3] Progress: ${uploadedCount}/${files.length} files uploaded (${Math.round((uploadedCount / files.length) * 100)}%)`);
        }
      } catch (err) {
        console.error(`[uploadDirectoryToS3] Failed to upload ${s3Key}:`, err);
        throw err;
      }
    };
  });

  const workers = Array.from({ length: concurrency }, async () => {
    while (tasks.length > 0) {
      const task = tasks.shift();
      if (task) {
        await task();
      }
    }
  });

  await Promise.all(workers);
  console.info(`[uploadDirectoryToS3] All ${files.length} files successfully uploaded!`);
}
 
export async function getVideoDurationFromS3(
  bucket: string,
  key: string
): Promise<number> {
  console.info(`[getVideoDurationFromS3] Fetching metadata for s3://${bucket}/${key}`);
  const command = new HeadObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3Client.send(command);
  const duration = response.Metadata?.['duration'];
  return duration ? parseFloat(duration) : 0;
}

async function getAllFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await getAllFiles(fullPath)));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

export async function uploadFileToS3(
  localPath: string,
  bucket: string,
  s3Key: string
): Promise<void> {
  console.info(`[uploadFileToS3] Uploading ${localPath} → s3://${bucket}/${s3Key}`);
  const contentType = getContentType(localPath);
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: bucket,
      Key: s3Key,
      Body: createReadStream(localPath),
      ContentType: contentType,
    },
  });
  await upload.done();
  console.info(`[uploadFileToS3] Done: ${s3Key}`);
}

function getContentType(filePath: string): string {
  if (filePath.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (filePath.endsWith('.ts'))   return 'video/mp2t';
  if (filePath.endsWith('.mp4'))  return 'video/mp4';
  if (filePath.endsWith('.webm')) return 'video/webm';
  if (filePath.endsWith('.mov'))  return 'video/quicktime';
  if (filePath.endsWith('.avi'))  return 'video/x-msvideo';
  if (filePath.endsWith('.mkv'))  return 'video/x-matroska';
  if (filePath.endsWith('.mp3'))  return 'audio/mpeg';
  if (filePath.endsWith('.wav'))  return 'audio/wav';
  if (filePath.endsWith('.aac'))  return 'audio/aac';
  return 'application/octet-stream';
}
