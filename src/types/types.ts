export type JobType =
  | 'transcode'
  | 'compress'
  | 'convert'
  | 'extract-audio'
  | 'trim'
  | 'download-url'
  | 'thumbnail';

export interface VideoJob {
  videoId: string;
  s3Key: string;
  bucket: string;
  jobType: JobType;

  resolution?: '1080p' | '720p' | '480p' | '360p';

  targetSizeMB?: number;

  outputFormat?: 'mp4' | 'webm' | 'mov' | 'avi' | 'mkv';

  audioFormat?: 'mp3' | 'wav' | 'aac';

  startTime?: number;   
  endTime?: number;

  sourceUrl?: string;
  compressionMode?: 'FAST' | 'HIGH_QUALITY';
  upscale?: boolean;
  targetJobType?: string;
}

export interface TranscodeProgress {
  videoId: string;
  percentage: number;
  currentTime: number;
  totalDuration: number;
}

export interface TranscodeOutput {
  masterPlaylistKey: string;
  resolutions: string[];
}