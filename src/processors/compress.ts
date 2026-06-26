import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { supportsVideoToolbox } from '../transcoder/transcoder';

const FFMPEG_PATH  = process.env.FFMPEG_PATH  || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';

const SKIP_COMPRESSION_BELOW_MB = 30;

export type CompressionMode = 'FAST' | 'HIGH_QUALITY';

async function getFileSizeMB(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return stat.size / (1024 * 1024);
}

function getVideoDuration(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE_PATH, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      inputPath,
    ]);
    let out = '';
    proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      resolve(parseFloat(out.trim()));
    });
    proc.on('error', reject);
  });
}
function runFFmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errBuf = '';
    proc.stderr.on('data', (c: Buffer) => (errBuf += c.toString()));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${errBuf.slice(-500)}`));
    });
    proc.on('error', reject);
  });
}
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[compress] Timeout after ${ms / 1000}s — ${label}`)), ms)
    ),
  ]);
}

export interface CompressOptions {
  videoId: string;
  inputPath: string;
  outputDir: string;
  targetSizeMB: number;
  compressionMode?: CompressionMode;
  upscale?: boolean;
}

export interface CompressResult {
  outputPath: string;
  originalSizeMB: number;
  compressedSizeMB: number;
  durationMs: number;
  skipped?: boolean;  
  mode: CompressionMode;
}

export async function compress(options: CompressOptions): Promise<CompressResult> {
  const {
    videoId,
    inputPath,
    outputDir,
    targetSizeMB,
    compressionMode = 'FAST',  
    upscale = false,
  } = options;

  await fs.mkdir(outputDir, { recursive: true });

  const outputPath    = path.join(outputDir, `${videoId}_compressed.mp4`);
  const originalSizeMB = await getFileSizeMB(inputPath);
  if (originalSizeMB <= targetSizeMB) {
    console.info(
      `[compress] ${videoId}: ${originalSizeMB.toFixed(1)} MB <= ${targetSizeMB} MB target — ` +
      `skipping compression, copying source file.`
    );
    await fs.copyFile(inputPath, outputPath);
    const jobStart = Date.now();
    return {
      outputPath,
      originalSizeMB,
      compressedSizeMB: originalSizeMB,
      durationMs: Date.now() - jobStart,
      skipped: true,
      mode: compressionMode,
    };
  }

  const duration = await getVideoDuration(inputPath);

  console.info(`[compress] ${videoId}: ${originalSizeMB.toFixed(1)} MB → target ${targetSizeMB} MB [mode: ${compressionMode}]`);

  /*
     formula to get totalBitRate in Kilobytes per second:
       1 byte   = 8 bit
       1 KiloByte (KB) = 8 000 bit  or  8 kilobit (kb)
       1 KiloByte      = 1 024 Byte
       1 MegaByte      = 1 024 KB    ← not (kb) but (KB)
       1 GigaByte      = 1 024 MB
       1 TB            = 1 024 GB
       1 PB            = 1 024 TB
   */
  const totalBitrateKbps  = (targetSizeMB * 8192) / duration;
  const audioBitrateKbps  = 128;
  const videoBitrateKbps  = Math.max(100, Math.floor(totalBitrateKbps - audioBitrateKbps));

  console.info(`[compress] Target bitrate: ${videoBitrateKbps}k video + ${audioBitrateKbps}k audio`);

  const jobStart = Date.now();
  const ffmpegArgs = [
    '-y',
    '-i', inputPath,
  ];
  if (upscale) {
    ffmpegArgs.push('-vf', 'scale=3840:2160:flags=lanczos');
  }
  ffmpegArgs.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', `${videoBitrateKbps}k`,
    '-maxrate', `${videoBitrateKbps}k`,
    '-bufsize', `${videoBitrateKbps * 2}k`,
    '-pix_fmt', 'yuv420p'
  );
  ffmpegArgs.push(
    '-c:a', 'aac',
    '-b:a', `${audioBitrateKbps}k`,
    outputPath
  );
  await withTimeout(
    runFFmpeg(ffmpegArgs),
    30 * 60 * 1000,
    `${videoId} compress`
  );
  const compressedSizeMB = await getFileSizeMB(outputPath);
  console.info(`[compress] Done [FAST]: ${compressedSizeMB.toFixed(1)} MB`);

  if (compressedSizeMB >= originalSizeMB) {
    console.warn(`[compress] Compressed size (${compressedSizeMB.toFixed(1)} MB) >= original size (${originalSizeMB.toFixed(1)} MB). Fallback to copying original file.`);
    await fs.copyFile(inputPath, outputPath);
    return {
      outputPath,
      originalSizeMB,
      compressedSizeMB: originalSizeMB,
      durationMs: Date.now() - jobStart,
      skipped: true,
      mode: 'FAST',
    };
  }

  return {
    outputPath,
    originalSizeMB,
    compressedSizeMB,
    durationMs: Date.now() - jobStart,
    mode: 'FAST',
  };
}