import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';

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

export interface CompressOptions {
  videoId: string;
  inputPath: string;
  outputDir: string;
  targetSizeMB: number;  
}

export interface CompressResult {
  outputPath: string;
  originalSizeMB: number;
  compressedSizeMB: number;
  durationMs: number;
}

export async function compress(options: CompressOptions): Promise<CompressResult> {
  const { videoId, inputPath, outputDir, targetSizeMB } = options;

  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `${videoId}_compressed.mp4`);
  const originalSizeMB = await getFileSizeMB(inputPath);
  const duration = await getVideoDuration(inputPath);

  console.info(`[compress] ${videoId}: ${originalSizeMB.toFixed(1)}MB → target ${targetSizeMB}MB`);

  const totalBitrateKbps = (targetSizeMB * 8192) / duration;
  const audioBitrateKbps = 128;
  const videoBitrateKbps = Math.max(100, Math.floor(totalBitrateKbps - audioBitrateKbps));

  console.info(`[compress] Target bitrate: ${videoBitrateKbps}k video + ${audioBitrateKbps}k audio`);

  const passLogPath = path.join(outputDir, 'ffmpeg2pass');

  await runFFmpeg([
    '-y',
    '-i', inputPath,
    '-c:v', 'libx264',
    '-b:v', `${videoBitrateKbps}k`,
    '-pass', '1',
    '-passlogfile', passLogPath,
    '-an',
    '-f', 'null',
    '/dev/null',
  ]);

  await runFFmpeg([
    '-y',
    '-i', inputPath,
    '-c:v', 'libx264',
    '-b:v', `${videoBitrateKbps}k`,
    '-pass', '2',
    '-passlogfile', passLogPath,
    '-c:a', 'aac',
    '-b:a', `${audioBitrateKbps}k`,
    outputPath,
  ]);

  const compressedSizeMB = await getFileSizeMB(outputPath);
  console.info(`[compress] Done: ${compressedSizeMB.toFixed(1)}MB`);

  const jobStart = Date.now();
  return {
    outputPath,
    originalSizeMB,
    compressedSizeMB,
    durationMs: Date.now() - jobStart,
  };
}