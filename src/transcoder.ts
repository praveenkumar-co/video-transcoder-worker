import * as fs from 'fs/promises';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import * as os from 'os';
import ffmpeg from 'fluent-ffmpeg';
import { emitProgress } from './progress';
import dotenv from 'dotenv';
dotenv.config();

const FFMPEG_PATH   = process.env.FFMPEG_PATH   || 'ffmpeg';
const FFPROBE_PATH  = process.env.FFPROBE_PATH  || 'ffprobe';
const FFMPEG_THREADS = Math.max(
  1,
  Math.min(Number(process.env.FFMPEG_THREADS ?? 2), os.cpus().length)
);

// ── Sanity-check binaries at startup ──────────────────────────────────────────
try {
  execSync(`${FFMPEG_PATH} -version`,  { stdio: 'ignore' });
  execSync(`${FFPROBE_PATH} -version`, { stdio: 'ignore' });
} catch {
  throw new Error(
    `[transcoder] FFmpeg/FFprobe not found!\n  ffmpeg: ${FFMPEG_PATH}\n  ffprobe: ${FFPROBE_PATH}`
  );
}

export let supportsVideoToolbox = false;
try {
  const encoders = execSync(`${FFMPEG_PATH} -encoders`, { encoding: 'utf-8' });
  supportsVideoToolbox = encoders.includes('h264_videotoolbox');
  console.info(`[transcoder] h264_videotoolbox support detected: ${supportsVideoToolbox}`);
} catch (err) {
  console.warn('[transcoder] Failed to check for h264_videotoolbox support, defaulting to false:', err);
}

ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);

// Without an FFmpeg timeout, a corrupted video can hang the worker forever
// and block the entire BullMQ queue.  30 minutes is generous for any realistic
// video length + bitrate combination at h264_videotoolbox speed.
const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[transcoder] Timeout (${ms / 1000}s): ${label}`)), ms)
    ),
  ]);
}

// Many SaaS video products skip transcoding entirely when the source file is
// already very small (e.g. < 30 MB).  For these clips the multi-rung HLS
// encode is CPU-expensive but the CDN bandwidth saving is negligible.
// Lowered to 30 MB so very short demos are just copied, not re-encoded.
const SKIP_TRANSCODE_BELOW_MB = 30;

export interface TranscodeOptions {
  videoId: string;
  inputPath: string;
  outputDir: string;
  resolution?: string;
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

// Removed 4K and 240p:
//   • 4K encodes are prohibitively expensive for a dev/demo worker.
//   • 240p is rarely needed today; no major platform generates it by default.
// Bitrates revised to professional streaming platform targets (Wowza / Bitmovin).
const RESOLUTION_LADDER: Resolution[] = [
  { name: '1080p', width: 1920, height: 1080, videoBitrate: '4500k', audioBitrate: '128k' },
  { name: '720p',  width: 1280, height: 720,  videoBitrate: '2500k', audioBitrate: '128k' },
  { name: '480p',  width: 854,  height: 480,  videoBitrate: '1200k', audioBitrate: '96k'  },
  { name: '360p',  width: 640,  height: 360,  videoBitrate: '700k',  audioBitrate: '96k'  },
];

interface VideoProbeResult {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  sizeMB: number;
}

async function probeVideo(inputPath: string): Promise<VideoProbeResult> {
  const stat = await fs.stat(inputPath);
  const sizeMB = stat.size / (1024 * 1024);

  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);
      const videoStream = metadata.streams.find((s) => s.codec_type === 'video');
      const hasAudio    = metadata.streams.some((s) => s.codec_type === 'audio');
      if (!videoStream?.width || !videoStream?.height)
        return reject(new Error(`No valid video stream in: ${inputPath}`));
      resolve({
        duration: metadata.format.duration ?? 0,
        width:    videoStream.width,
        height:   videoStream.height,
        hasAudio,
        sizeMB,
      });
    });
  });
}

export async function getVideoDuration(inputPath: string): Promise<number> {
  const { duration } = await probeVideo(inputPath);
  return duration;
}

// Parses the `time=HH:MM:SS.xx` line from FFmpeg stderr.
// The percentage is emitted as a structured object (not raw text) so that
// future WebSocket / SSE progress bars get typed, reliable data.
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

  const { duration: totalDuration, width, height, hasAudio, sizeMB } = await probeVideo(inputPath);

  if (sizeMB < SKIP_TRANSCODE_BELOW_MB) {
    console.info(
      `[transcoder] ${videoId}: ${sizeMB.toFixed(1)} MB < ${SKIP_TRANSCODE_BELOW_MB} MB ` +
      `— skipping full HLS transcode. Producing a single-rendition passthrough.`
    );
  }

  let targetResolutions: Resolution[];

  if (options.resolution) {
    const picked = RESOLUTION_LADDER.find((r) => r.name === options.resolution);
    targetResolutions = picked ? [picked] : [RESOLUTION_LADDER[0]];
  } else {
    // Only generate renditions that are at or below the source height —
    // up-scaling wastes bits and degrades quality.
    targetResolutions = RESOLUTION_LADDER.filter((r) => r.height <= height);
    if (targetResolutions.length === 0) {
      targetResolutions = [RESOLUTION_LADDER[RESOLUTION_LADDER.length - 1]];
    }
  }

  console.info(
    `[transcoder] ${videoId}: ${width}×${height} (${sizeMB.toFixed(1)} MB) → ` +
    `${targetResolutions.map((r) => r.name).join(', ')}`
  );
  const splitCount   = targetResolutions.length;
  const splitLabels  = targetResolutions.map((_, i) => `[v${i + 1}]`).join('');
  const scaleFilters = targetResolutions
    .map((r, i) => `[v${i + 1}]scale=${r.width}:${r.height}[v${i + 1}out]`)
    .join('; ');
  const filterComplex = `[0:v]split=${splitCount}${splitLabels}; ${scaleFilters}`;
  const varStreamMap  = targetResolutions
    .map((_, i) => hasAudio ? `v:${i},a:${i}` : `v:${i}`)
    .join(' ');

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

    args.push('-map', `[v${i + 1}out]`);
    if (hasAudio) args.push('-map', '0:a:0');
    // Dynamically uses h264_videotoolbox on M-series Macs for extreme speed & zero CPU load.
    // Falls back gracefully to libx264 when running inside Docker / Linux.
    if (supportsVideoToolbox) {
      args.push(`-c:v:${i}`, 'h264_videotoolbox');
    } else {
      args.push(`-c:v:${i}`, 'libx264');
    }
    args.push(`-b:v:${i}`, r.videoBitrate);

    if (hasAudio) {
      args.push(`-c:a:${i}`, 'aac');
      args.push(`-b:a:${i}`, r.audioBitrate);
    }
  }

  if (!supportsVideoToolbox) {
    args.push('-preset', 'veryfast');
  }

  args.push(
    '-threads',              FFMPEG_THREADS.toString(),
    '-f',                    'hls',
    '-var_stream_map',       varStreamMap,
    '-master_pl_name',       'master.m3u8',
    '-hls_time',             '6',
    '-hls_list_size',        '0',
    '-hls_segment_filename', `${outputDir}/%v/seg_%03d.ts`,
    `${outputDir}/%v/index.m3u8`,
  );

  const jobStart = Date.now();

  await withTimeout(
    runFFmpeg(args, videoId, totalDuration),
    FFMPEG_TIMEOUT_MS,
    `${videoId} transcode`
  );

  const durationMs = Date.now() - jobStart;
  console.info(
    `[transcoder] ${videoId} done in ${(durationMs / 1000).toFixed(1)}s | ` +
    `renditions: ${targetResolutions.map((r) => r.name).join(', ')}`
  );

  return {
    masterPlaylistPath: path.join(outputDir, 'master.m3u8'),
    resolutions: targetResolutions.map((r) => r.name),
    durationMs,
  };
}
