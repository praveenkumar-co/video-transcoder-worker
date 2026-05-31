import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

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

export interface TrimOptions {
  videoId: string;
  inputPath: string;
  outputDir: string;
  startTime: number;  
  endTime: number;    
}

export interface TrimResult {
  outputPath: string;
  clipDurationSec: number;
  durationMs: number;
}

export async function trim(options: TrimOptions): Promise<TrimResult> {
  const { videoId, inputPath, outputDir, startTime, endTime } = options;

  await fs.mkdir(outputDir, { recursive: true });

  if (endTime <= startTime) {
    throw new Error(`endTime (${endTime}s) must be greater than startTime (${startTime}s)`);
  }

  const clipDurationSec = endTime - startTime;
  const outputPath = path.join(outputDir, `${videoId}_trimmed.mp4`);

  console.info(`[trim] ${videoId}: ${startTime}s → ${endTime}s (${clipDurationSec}s clip)`);

  const jobStart = Date.now();

  await runFFmpeg([
    '-y',
    '-ss', String(startTime),  
    '-to', String(endTime),    
    '-i', inputPath,
    '-c', 'copy',             
    outputPath,
  ]);

  const durationMs = Date.now() - jobStart;
  console.info(`[trim] Done in ${(durationMs / 1000).toFixed(1)}s`);

  return {
    outputPath,
    clipDurationSec,
    durationMs,
  };
}