// The media library lives in an S3-compatible bucket (the Worker file system does not persist). This step asks for
// the bucket, checks the key can write, read, list and delete there, and turns the answers into Worker settings.
import { p, pc, Abort, spinner } from './ui.mjs';
import { createS3 } from '../runtime/src/s3.js';

const ENV_KEYS = { accessKeyId: 'HOSTLESSWP_S3_ACCESS_KEY_ID', secretAccessKey: 'HOSTLESSWP_S3_SECRET_ACCESS_KEY' };
const REQUIRED = ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'];
const S3_FLAGS = ['s3-endpoint', 's3-region', 's3-bucket', 's3-prefix', 's3-public-url'];

const urlProblem = (v) => {
  try {
    return /^https?:$/.test(new URL(v).protocol) ? undefined : 'Must start with https://';
  } catch {
    return 'Not a URL';
  }
};

function probeHint(e, s3) {
  if (e.code === 'NoSuchBucket' || e.status === 404) return `Bucket "${s3.bucket}" was not found at ${s3.endpoint}. Create it first, or check the endpoint.`;
  if (e.code === 'AuthorizationHeaderMalformed' || e.code === 'PermanentRedirect' || e.status === 301) return `The region "${s3.region}" does not match the bucket (R2 uses "auto").`;
  if (e.status === 403 || e.status === 401) return `Check the access key and that it can read and write bucket "${s3.bucket}" (R2: an API token with Object Read & Write on this bucket). SignatureDoesNotMatch can also mean a wrong region.`;
  return `Could not reach ${s3.endpoint}. Check the address.`;
}

export async function probeS3(s3) {
  const client = createS3(s3);
  const key = client.prefix + '.hostlesswp-probe';
  const steps = [
    ['write (PutObject)', () => client.put(key, new TextEncoder().encode('hostlesswp'), 'text/plain')],
    ['read (HeadObject)', async () => {
      if (!(await client.head(key))) throw new Error('the object was missing right after writing it');
    }],
    ['list (ListObjectsV2)', () => client.list(client.prefix, { delimiter: '/', maxKeys: 1 })],
    ['delete (DeleteObject)', () => client.del(key)],
  ];
  for (const [what, run] of steps) {
    try {
      await run();
    } catch (e) {
      throw new Abort(`Media storage check failed at ${what}: ${e.message}\n${probeHint(e, s3)}`);
    }
  }
}

async function ask(ui, previous = {}) {
  await ui.text({ flag: 's3-endpoint', remember: 's3.endpoint', message: 'S3 endpoint URL', placeholder: 'https://<account-id>.r2.cloudflarestorage.com', initial: previous.endpoint, validate: urlProblem });
  await ui.text({ flag: 's3-region', remember: 's3.region', message: 'Region (R2: auto; AWS: the bucket region, e.g. us-east-1)', initial: previous.region ?? 'auto' });
  await ui.text({ flag: 's3-bucket', remember: 's3.bucket', message: 'Bucket name', initial: previous.bucket, validate: (v) => (v ? undefined : 'Required') });
  await ui.password({ remember: 's3.accessKeyId', hint: ENV_KEYS.accessKeyId, message: 'Access key ID' });
  await ui.password({ remember: 's3.secretAccessKey', hint: ENV_KEYS.secretAccessKey, message: 'Secret access key' });
  await ui.text({ flag: 's3-prefix', remember: 's3.prefix', message: 'Key prefix inside the bucket (empty: bucket root)', initial: previous.prefix ?? '' });
  await ui.text({ flag: 's3-public-url', remember: 's3.publicUrl', message: 'Public or CDN address of the bucket (empty: media is served through the Worker)', initial: previous.publicUrl ?? '', validate: (v) => (v ? urlProblem(v) : undefined) });
}

// probe: check the bucket even when every answer was already saved (first setup). New answers are always checked.
export async function ensureMediaStorage(ui, flags, { probe = false } = {}) {
  const config = ui.config;
  for (const [k, name] of Object.entries(ENV_KEYS)) {
    if (process.env[name] && config.get('s3.' + k) !== process.env[name]) config.set('s3.' + k, process.env[name]);
  }
  const complete = REQUIRED.every((k) => config.has('s3.' + k));
  if (!complete) {
    p.note(
      [
        'Workers have no lasting disk, so your media library goes to',
        'S3-compatible storage: Cloudflare R2, AWS S3, Backblaze B2, MinIO,',
        'Aliyun OSS or any other S3 API. Each deploy copies files the bucket',
        'does not have yet; uploads from the admin go there directly.',
        '',
        `R2: create a bucket and an API token with ${pc.bold('Object Read & Write')}`,
        'on it (R2 > Manage API tokens). The endpoint is',
        'https://<account-id>.r2.cloudflarestorage.com and the region is auto.',
        '',
        'Keys can also come from environment variables:',
        `${ENV_KEYS.accessKeyId}, ${ENV_KEYS.secretAccessKey}`,
      ].join('\n'),
      'Media storage',
    );
  }
  let previous = {};
  for (;;) {
    await ask(ui, previous);
    if (!config.has('s3.forcePathStyle')) config.set('s3.forcePathStyle', true);
    if (!config.has('s3.maxUploadMb')) config.set('s3.maxUploadMb', 32);
    const s3 = config.get('s3');
    if (!probe && complete) return s3;
    const s = spinner();
    s.start(`Checking bucket ${s3.bucket}`);
    try {
      await probeS3(s3);
      s.stop(`Media storage ready: ${s3.bucket}${s3.prefix ? '/' + s3.prefix : ''}`);
      return s3;
    } catch (e) {
      s.stop(pc.red('Media storage check failed'), 1);
      // Flags would give the same answers again; without a terminal there is nobody to ask.
      if (!ui.interactive || S3_FLAGS.some((f) => flags[f] !== undefined)) throw e;
      p.log.error(e.message);
      if (!(await ui.confirm({ message: 'Enter the media storage details again?', initial: true }))) throw new Abort('Stopped. Fix the media storage details and run again.');
      const { accessKeyId, secretAccessKey, ...rest } = s3;
      previous = rest;
      config.set('s3', undefined);
    }
  }
}

export function workerBindings(s3) {
  return {
    vars: {
      S3_ENDPOINT: s3.endpoint,
      S3_REGION: s3.region,
      S3_BUCKET: s3.bucket,
      S3_PREFIX: s3.prefix || '',
      S3_PUBLIC_URL: s3.publicUrl || '',
      S3_FORCE_PATH_STYLE: s3.forcePathStyle === false ? '0' : '1',
      S3_MAX_UPLOAD_MB: String(s3.maxUploadMb || 32),
    },
    secrets: { S3_ACCESS_KEY_ID: s3.accessKeyId, S3_SECRET_ACCESS_KEY: s3.secretAccessKey },
  };
}
