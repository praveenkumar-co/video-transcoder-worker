

import { TranscodeProgress } from './types';

// a progress callback function that keep on track of every user progress

type ProgressCallback = (progress: TranscodeProgress) => void;

// to store every callback related with every Video

const progressCallbacks = new Map<string, ProgressCallback>();

// setting up the callback progress of every video ID 

export function onProgress(videoId: string, cb: ProgressCallback): void {
  progressCallbacks.set(videoId, cb);
}
// emitting the progress bar for every videoId 

export function emitProgress(progress: TranscodeProgress): void {
  const cb = progressCallbacks.get(progress.videoId);
  if (cb) cb(progress);
  console.info(
    `Progress [${progress.videoId}]: ${progress.percentage.toFixed(1)}%`
  );
}
export function clearProgress(videoId: string): void {
  progressCallbacks.delete(videoId);
}

