export type JobType =
  | 'transcode'
  | 'compress'
  | 'convert'
  | 'extract-audio'
  | 'trim'
  | 'download-url';

export interface VideoJob {
  videoId: string;
  s3Key: string;
  bucket: string;
  jobType: JobType;

  resolution?: '4K' | '1080p' | '720p' | '480p' | '360p' | '240p';

  targetSizeMB?: number;

  outputFormat?: 'mp4' | 'webm' | 'mov' | 'avi' | 'mkv';

  audioFormat?: 'mp3' | 'wav' | 'aac';

  startTime?: number;   
  endTime?: number;

  sourceUrl?: string;
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