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

const AUDIO_CODEC_MAP: Record<string, string[]> = {
  mp3: ['-c:a', 'libmp3lame', '-q:a', '2'],  
  wav: ['-c:a', 'pcm_s16le'],
  aac: ['-c:a', 'aac', '-b:a', '192k'],     
};

export interface ExtractAudioOptions {
  videoId: string;
  inputPath: string;
  outputDir: string;
  audioFormat: 'mp3' | 'wav' | 'aac';
}

export interface ExtractAudioResult {
  outputPath: string;
  audioFormat: string;
  durationMs: number;
}

export async function extractAudio(options: ExtractAudioOptions): Promise<ExtractAudioResult> {
  const { videoId, inputPath, outputDir, audioFormat } = options;

  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `${videoId}_audio.${audioFormat}`);
  const codecs = AUDIO_CODEC_MAP[audioFormat];

  console.info(`[extract-audio] ${videoId}: → .${audioFormat}`);

  const jobStart = Date.now();

  await runFFmpeg([
    '-y',
    '-i', inputPath,
    '-vn',
    ...codecs,
    outputPath,
  ]);

  const durationMs = Date.now() - jobStart;
  console.info(`[extract-audio] Done in ${(durationMs / 1000).toFixed(1)}s`);

  return {
    outputPath,
    audioFormat,
    durationMs,
  };
}