import { Registry, collectDefaultMetrics, Counter, Histogram, Gauge } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const jobsCompleted = new Counter({
  name: 'vp_transcoder_jobs_completed_total',
  help: 'Total transcoding jobs completed successfully',
  registers: [registry],
});

export const jobsFailed = new Counter({
  name: 'vp_transcoder_jobs_failed_total',
  help: 'Total transcoding jobs that failed',
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: 'vp_transcoder_job_duration_seconds',
  help: 'Time taken to complete a transcoding job end-to-end',
  buckets: [30, 60, 120, 300, 600, 1200],
  registers: [registry],
});

export const activeJobs = new Gauge({
  name: 'vp_transcoder_active_jobs',
  help: 'Number of transcoding jobs currently in progress',
  registers: [registry],
});