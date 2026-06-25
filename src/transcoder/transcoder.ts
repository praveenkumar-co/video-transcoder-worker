import * as fs from "fs/promises";
import * as path from "path";
import { execSync, spawn } from "child_process";
import * as os from "os";
import ffmpeg from "fluent-ffmpeg";
import { emitProgress } from "../progress/progress";
import dotenv from "dotenv";
dotenv.config();

const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";
const FFMPEG_THREADS = Math.max(
  1,
  Math.min(Number(process.env.FFMPEG_THREADS ?? 2), os.cpus().length),
);
try {
  execSync(`${FFMPEG_PATH} -version`, { stdio: "ignore" });
  execSync(`${FFPROBE_PATH} -version`, { stdio: "ignore" });
} catch {
  throw new Error(
    `[transcoder] FFmpeg/FFprobe not found!\n  ffmpeg: ${FFMPEG_PATH}\n  ffprobe: ${FFPROBE_PATH}`,
  );
}
export let supportsVideoToolbox = false;
try {
  const encoders = execSync(`${FFMPEG_PATH} -encoders`, { encoding: "utf-8" });
  supportsVideoToolbox = encoders.includes("h264_videotoolbox");
  console.info(
    `[transcoder] h264_videotoolbox support detected: ${supportsVideoToolbox}`,
  );
} catch (err) {
  console.warn(
    "[transcoder] Failed to check for h264_videotoolbox support, defaulting to false:",
    err,
  );
}

ffmpeg.setFfmpegPath(FFMPEG_PATH);
ffmpeg.setFfprobePath(FFPROBE_PATH);

const FFMPEG_TIMEOUT_MS = 30 * 60 * 1000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(new Error(`[transcoder] Timeout (${ms / 1000}s): ${label}`)),
        ms,
      ),
    ),
  ]);
}
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

const RESOLUTION_LADDER: Resolution[] = [
  {
    name: "1080p",
    width: 1920,
    height: 1080,
    videoBitrate: "4500k",
    audioBitrate: "128k",
  },
  {
    name: "720p",
    width: 1280,
    height: 720,
    videoBitrate: "2500k",
    audioBitrate: "128k",
  },
  {
    name: "480p",
    width: 854,
    height: 480,
    videoBitrate: "1200k",
    audioBitrate: "96k",
  },
  {
    name: "360p",
    width: 640,
    height: 360,
    videoBitrate: "700k",
    audioBitrate: "96k",
  },
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
      const videoStream = metadata.streams.find(
        (s) => s.codec_type === "video",
      );
      const hasAudio = metadata.streams.some((s) => s.codec_type === "audio");
      if (!videoStream?.width || !videoStream?.height)
        return reject(new Error(`No valid video stream in: ${inputPath}`));
      resolve({
        duration: metadata.format.duration ?? 0,
        width: videoStream.width,
        height: videoStream.height,
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
function runFFmpeg(
  args: string[],
  videoId: string,
  totalDuration: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    console.info(`[ffmpeg] ${FFMPEG_PATH} ${args.slice(0, 6).join(" ")} ...`);
    const proc = spawn(FFMPEG_PATH, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderrBuf = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;

      const m = text.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d+)/);
      if (m) {
        const currentTime = +m[1] * 3600 + +m[2] * 60 + +m[3];
        const percentage =
          totalDuration > 0
            ? Math.min((currentTime / totalDuration) * 100, 100)
            : 0;
        emitProgress({ videoId, percentage, currentTime, totalDuration });
      }
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = stderrBuf.split("\n").slice(-20).join("\n");
        reject(new Error(`ffmpeg exited with code ${code}: ${tail}`));
      }
    });

    proc.on("error", reject);
  });
}

function remuxHlsToMp4(
  playlistPath: string,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, [
      "-y",
      "-i",
      playlistPath,
      "-c",
      "copy",
      outputPath,
    ]);

    let stderr = "";
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = stderr.split("\n").slice(-20).join("\n");
        reject(new Error(`ffmpeg exited with code ${code}: ${tail}`));
      }
    });

    proc.on("error", reject);
  });
}

export async function transcode(
  options: TranscodeOptions,
): Promise<TranscodeResult> {
  const { videoId, inputPath, outputDir } = options;

  await fs.mkdir(outputDir, { recursive: true });

  const {
    duration: totalDuration,
    width,
    height,
    hasAudio,
    sizeMB,
  } = await probeVideo(inputPath);

  if (sizeMB < SKIP_TRANSCODE_BELOW_MB) {
    console.info(
      `[transcoder] ${videoId}: ${sizeMB.toFixed(1)} MB < ${SKIP_TRANSCODE_BELOW_MB} MB ` +
        `— skipping full HLS transcode. Producing a single-rendition passthrough.`,
    );
  }

  let targetResolutions: Resolution[];

  if (options.resolution) {
    const picked = RESOLUTION_LADDER.find((r) => r.name === options.resolution);
    targetResolutions = picked ? [picked] : [RESOLUTION_LADDER[0]];
  } else {
    targetResolutions = RESOLUTION_LADDER.filter((r) => r.height <= height);
    if (targetResolutions.length === 0) {
      targetResolutions = [RESOLUTION_LADDER[RESOLUTION_LADDER.length - 1]];
    }
  }
  console.info(
    `[transcoder] ${videoId}: ${width}×${height} (${sizeMB.toFixed(1)} MB) → ` +
      `${targetResolutions.map((r) => r.name).join(", ")}`,
  );
  const splitCount = targetResolutions.length;
  const splitLabels = targetResolutions.map((_, i) => `[v${i + 1}]`).join("");
  const scaleFilters = targetResolutions
    .map((r, i) => `[v${i + 1}]scale=${r.width}:${r.height}[v${i + 1}out]`)
    .join("; ");
  const filterComplex = `[0:v]split=${splitCount}${splitLabels}; ${scaleFilters}`;

  const jobStart = Date.now();
  const transcodeArgs: string[] = [
    "-y",
    "-i",
    inputPath,
    "-filter_complex",
    filterComplex,
  ];

  for (let i = 0; i < targetResolutions.length; i++) {
    const r = targetResolutions[i];
    await fs.mkdir(path.join(outputDir, String(i)), { recursive: true });

    transcodeArgs.push("-map", `[v${i + 1}out]`);
    if (hasAudio) transcodeArgs.push("-map", "0:a:0");

    if (supportsVideoToolbox) {
      transcodeArgs.push("-c:v", "h264_videotoolbox");
    } else {
      transcodeArgs.push("-c:v", "libx264");
      transcodeArgs.push("-preset", "veryfast");
    }
    transcodeArgs.push("-b:v", r.videoBitrate);

    if (hasAudio) {
      transcodeArgs.push("-c:a", "aac");
      transcodeArgs.push("-b:a", r.audioBitrate);
    }

    transcodeArgs.push("-threads", FFMPEG_THREADS.toString());
    transcodeArgs.push(path.join(outputDir, String(i), "video.mp4"));
  }

  console.info(`[transcoder] ${videoId}: Step 1 - Transcoding to MP4s...`);
  await withTimeout(
    runFFmpeg(transcodeArgs, videoId, totalDuration),
    FFMPEG_TIMEOUT_MS,
    `${videoId} transcode MP4s`,
  );
  for (let i = 0; i < targetResolutions.length; i++) {
    const r = targetResolutions[i];
    const mp4Path = path.join(outputDir, String(i), "video.mp4");
    const hlsIndex = path.join(outputDir, String(i), "index.m3u8");
    const segmentPattern = path.join(outputDir, String(i), "seg_%03d.ts");

    console.info(
      `[transcoder] ${videoId}: Step 2 - Segmenting ${r.name} to HLS...`,
    );

    const segmentArgs = [
      "-y",
      "-i",
      mp4Path,
      "-c",
      "copy",
      "-f",
      "hls",
      "-hls_time",
      "6",
      "-hls_list_size",
      "0",
      "-hls_segment_filename",
      segmentPattern,
      hlsIndex,
    ];
    await runFFmpeg(segmentArgs, videoId, totalDuration);
  }
  let masterPlaylistContent = "#EXTM3U\n#EXT-X-VERSION:3\n";
  for (let i = 0; i < targetResolutions.length; i++) {
    const r = targetResolutions[i];
    const bandwidth =
      r.name === "1080p"
        ? 4500000
        : r.name === "720p"
          ? 2500000
          : r.name === "480p"
            ? 1200000
            : 700000;
    masterPlaylistContent += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${r.width}x${r.height}\n`;
    masterPlaylistContent += `${i}/index.m3u8\n`;
  }
  await fs.writeFile(
    path.join(outputDir, "master.m3u8"),
    masterPlaylistContent,
  );
  const durationMs = Date.now() - jobStart;
  console.info(
    `[transcoder] ${videoId} done in ${(durationMs / 1000).toFixed(1)}s | ` +
      `renditions: ${targetResolutions.map((r) => r.name).join(", ")}`,
  );

  return {
    masterPlaylistPath: path.join(outputDir, "master.m3u8"),
    resolutions: targetResolutions.map((r) => r.name),
    durationMs,
  };
}

export function generateThumbnailFile(
  inputPath: string,
  outputPath: string,
  timestampSeconds = 2
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-ss",
      timestampSeconds.toString(),
      "-i",
      inputPath,
      "-vframes",
      "1",
      "-q:v",
      "2",
      "-vf",
      "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2",
      outputPath,
    ];
    console.info(`[thumbnail] running: ${FFMPEG_PATH} ${args.join(" ")}`);
    const proc = spawn(FFMPEG_PATH, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const tail = stderr.split("\n").slice(-10).join("\n");
        reject(new Error(`FFmpeg thumbnail exited with code ${code}: ${tail}`));
      }
    });
    proc.on("error", reject);
  });
}
