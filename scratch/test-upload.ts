import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import dotenv from 'dotenv';
dotenv.config();

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

async function main() {
  const bucket = process.env.S3_PROCESSED_BUCKET!;
  const key = 'test-integrity-file.bin';
  
  // 1. Create a dummy binary buffer with random bytes (10KB)
  const originalBuffer = crypto.randomBytes(10240);
  const originalHash = crypto.createHash('md5').update(originalBuffer).digest('hex');
  console.log('Original Buffer MD5:', originalHash);

  // 2. Upload via PutObjectCommand
  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: originalBuffer,
    ContentType: 'application/octet-stream',
  }));
  console.log('Upload completed.');

  // 3. Download back
  const response = await s3Client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));

  const chunks: Buffer[] = [];
  const body = response.Body as any;
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
  }
  const downloadedBuffer = Buffer.concat(chunks);
  const downloadedHash = crypto.createHash('md5').update(downloadedBuffer).digest('hex');
  console.log('Downloaded Buffer MD5:', downloadedHash);

  if (originalHash === downloadedHash) {
    console.log('SUCCESS: Hash matches! Binary data uploaded and downloaded without corruption.');
  } else {
    console.error('ERROR: Hash mismatch! Binary data got corrupted.');
  }
}

main().catch(console.error);
