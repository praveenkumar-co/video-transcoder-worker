import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import * as os from 'os';
import ffmpeg from 'fluent-ffmpeg';
import { emitProgress } from './progress';
import dotenv from 'dotenv';
dotenv.config();
const FFMPEG_PATH  = process.env.FFMPEG_PATH  || '/usr/bin/ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';
const FFMPEG_THREADS = Math.max(
  1,
  Math.min(Number(process.env.FFMPEG_THREADS ?? 2), os.cpus().length)
);

try {
  execSync(`${FFMPEG_PATH} -version`,  { stdio: 'ignore' });
  execSync(`${FFPROBE_PATH} -version`, { stdio: 'ignore' });
} catch {
  throw new Error(
    `[transcoder] FFmpeg/FFprobe not found!\n  ffmpeg: ${FFMPEG_PATH}\n  ffprobe: ${FFPROBE_PATH}`
  );
}

ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);

export interface TranscodeOptions {
  videoId: string;
  inputPath: string;
  outputDir: string;
}

export interface TranscodeResult {
  masterPlaylistPath: string;
  resolutions: string[];
  durationMs: number;
}

interface Resolution {
  name: string;
  width: number;
  height: number;
  videoBitrate: string;
  audioBitrate: string;
}

const RESOLUTION_LADDER: Resolution[] = [
  { name: '1080p', width: 1920, height: 1080, videoBitrate: '5000k', audioBitrate: '192k' },
  { name: '720p',  width: 1280, height: 720,  videoBitrate: '2800k', audioBitrate: '128k' },
  { name: '360p',  width: 640,  height: 360,  videoBitrate: '800k',  audioBitrate: '96k'  },
];

interface VideoProbeResult { duration: number; width: number; height: number; hasAudio: boolean; }

async function probeVideo(inputPath: string): Promise<VideoProbeResult> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);
      const stream = metadata.streams.find((s) => s.codec_type === 'video');
      const hasAudio = metadata.streams.some((s) => s.codec_type === 'audio');
      if (!stream?.width || !stream?.height)
        return reject(new Error(`No valid video stream in: ${inputPath}`));
      resolve({
        duration: metadata.format.duration ?? 0,
        width:    stream.width,
        height:   stream.height,
        hasAudio,
      });
    });
  });
}

export async function getVideoDuration(inputPath: string): Promise<number> {
  const { duration } = await probeVideo(inputPath);
  return duration;
}

function runFFmpeg(
  args: string[],
  videoId: string,
  totalDuration: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    console.info(`[ffmpeg] ${FFMPEG_PATH} ${args.slice(0, 6).join(' ')} ...`);
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    let stderrBuf = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      const m = text.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d+)/);
      if (m) {
        const currentTime = +m[1] * 3600 + +m[2] * 60 + +m[3];
        const percentage  = totalDuration > 0
          ? Math.min((currentTime / totalDuration) * 100, 100)
          : 0;
        emitProgress({ videoId, percentage, currentTime, totalDuration });
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = stderrBuf.split('\n').slice(-20).join('\n');
        reject(new Error(`ffmpeg exited with code ${code}: ${tail}`));
      }
    });

    proc.on('error', reject);
  });
}

export async function transcode(options: TranscodeOptions): Promise<TranscodeResult> {
  const { videoId, inputPath, outputDir } = options;

  await fs.mkdir(outputDir, { recursive: true });

  const { duration: totalDuration, width, height, hasAudio } = await probeVideo(inputPath);

  let targetResolutions = RESOLUTION_LADDER.filter((r) => r.height <= height);
  if (targetResolutions.length === 0) {
    targetResolutions = [RESOLUTION_LADDER[RESOLUTION_LADDER.length - 1]];
  }

  console.info(
    `Transcoding ${videoId}: ${width}x${height} → ${targetResolutions.map((r) => r.name).join(', ')}`
  );
  const splitCount  = targetResolutions.length;
  const splitLabels = targetResolutions.map((_, i) => `[v${i + 1}]`).join('');
  const scaleFilters = targetResolutions
    .map((r, i) => `[v${i + 1}]scale=${r.width}:${r.height}[v${i + 1}out]`)
    .join('; ');
  const filterComplex = `[0:v]split=${splitCount}${splitLabels}; ${scaleFilters}`;
  const varStreamMap  = targetResolutions.map((_, i) => hasAudio ? `v:${i},a:${i}` : `v:${i}`).join(' ');

  for (let i = 0; i < targetResolutions.length; i++) {
    await fs.mkdir(path.join(outputDir, String(i)), { recursive: true });
  }
  const args: string[] = [
    '-y',                 
    '-i', inputPath,
    '-filter_complex', filterComplex,
  ];
  for (let i = 0; i < targetResolutions.length; i++) {
    const r = targetResolutions[i];
    args.push(
      '-map', `[v${i + 1}out]`,
    );
    if (hasAudio) {
      args.push('-map', '0:a:0');
    }
    args.push(
      `-c:v:${i}`, 'libx264',
      `-b:v:${i}`, r.videoBitrate,
    );
    if (hasAudio) {
      args.push(
        `-c:a:${i}`, 'aac',
        `-b:a:${i}`, r.audioBitrate,
      );
    }
  }
  args.push(
    '-preset',   'veryfast',
    '-threads',  FFMPEG_THREADS.toString(),
    '-f',        'hls',
    '-var_stream_map',        varStreamMap,
    '-master_pl_name',        'master.m3u8',
    '-hls_time',              '6',
    '-hls_list_size',         '0',
    '-hls_segment_filename',  `${outputDir}/%v/seg_%03d.ts`,
    `${outputDir}/%v/index.m3u8`,   
  );

  const jobStart = Date.now();

  await runFFmpeg(args, videoId, totalDuration);

  const durationMs = Date.now() - jobStart;
  console.info(
    `[transcoder] ${videoId} done in ${(durationMs / 1000).toFixed(1)}s | ` +
    `resolutions: ${targetResolutions.map((r) => r.name).join(', ')}`
  );

  return {
    masterPlaylistPath: path.join(outputDir, 'master.m3u8'),
    resolutions: targetResolutions.map((r) => r.name),
    durationMs,
  };
}
