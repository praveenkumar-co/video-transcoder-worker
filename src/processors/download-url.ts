import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

const YTDLP_PATH = process.env.YTDLP_PATH || 'yt-dlp';

export function getUrlTitle(sourceUrl: string): string {
  try {
    const result = spawnSync(YTDLP_PATH, ['--get-title', '--no-playlist', sourceUrl], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch (err) {
    console.warn(`[getUrlTitle] Failed to fetch title using yt-dlp:`, err);
  }
  return '';
}


function runYtDlp(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    console.info(`[yt-dlp] running: yt-dlp ${args.join(' ')}`);
    const proc = spawn(YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let outBuf = '';
    let errBuf = '';
    proc.stdout.on('data', (c: Buffer) => {
      outBuf += c.toString();
      console.info(`[yt-dlp] ${c.toString().trim()}`);
    });
    proc.stderr.on('data', (c: Buffer) => (errBuf += c.toString()));

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exited ${code}: ${errBuf.slice(-500)}`));
    });
    proc.on('error', (err) =>
      reject(new Error(`yt-dlp not found at ${YTDLP_PATH}. Is it installed? ${err.message}`))
    );
  });
}

export interface DownloadUrlOptions {
  videoId: string;
  sourceUrl: string;     
  outputDir: string;
}

export interface DownloadUrlResult {
  downloadedPath: string;
  durationMs: number;
}  

export async function downloadFromUrl(options: DownloadUrlOptions): Promise<DownloadUrlResult> {
  const { videoId, sourceUrl, outputDir } = options;

  await fs.mkdir(outputDir, { recursive: true });

  const outputTemplate = path.join(outputDir, `${videoId}_source.mp4`);

  console.info(`[download-url] ${videoId}: downloading from ${sourceUrl}`);

  const jobStart = Date.now();

  await runYtDlp([
    sourceUrl,
    '--output', outputTemplate,
    '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--no-playlist',          
    '--no-warnings',
  ]);

  const durationMs = Date.now() - jobStart;
  console.info(`[download-url] Done in ${(durationMs / 1000).toFixed(1)}s`);

  return {
    downloadedPath: outputTemplate,
    durationMs,
  };
}