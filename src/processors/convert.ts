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

const FORMAT_CODEC_MAP: Record<string, string[]> = {
  mp4:  ['-c:v', 'libx264', '-c:a', 'aac'],
  webm: ['-c:v', 'libvpx-vp9', '-c:a', 'libopus'],
  mov:  ['-c:v', 'libx264', '-c:a', 'aac'],
  avi:  ['-c:v', 'mpeg4', '-c:a', 'mp3'],
  mkv:  ['-c:v', 'libx264', '-c:a', 'aac'],
};

export interface ConvertOptions {
  videoId: string;
  inputPath: string;
  outputDir: string;
  outputFormat: 'mp4' | 'webm' | 'mov' | 'avi' | 'mkv';
}

export interface ConvertResult {
  outputPath: string;
  outputFormat: string;
  durationMs: number;
}

export async function convert(options: ConvertOptions): Promise<ConvertResult> {
  const { videoId, inputPath, outputDir, outputFormat } = options;

  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `${videoId}_converted.${outputFormat}`);
  const codecs = FORMAT_CODEC_MAP[outputFormat];

  console.info(`[convert] ${videoId}: → .${outputFormat}`);

  const jobStart = Date.now();

  await runFFmpeg([
    '-y',
    '-i', inputPath,
    ...codecs,
    '-preset', 'veryfast',
    outputPath,
  ]);

  const durationMs = Date.now() - jobStart;
  console.info(`[convert] Done in ${(durationMs / 1000).toFixed(1)}s`);

  return {
    outputPath,
    outputFormat,
    durationMs,
  };
}