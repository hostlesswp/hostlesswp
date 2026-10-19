import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HOSTLESSWP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-home-'));
const { saveState, loadState, withInputs, INPUT_KEYS } = await import('../lib/pipeline.mjs');
const { openSiteConfig } = await import('../lib/config.mjs');

test('state.json keeps resources only', () => {
  saveState({ name: 'wp-a', root: '/srv/a', hyperdriveId: 'h1', accountId: 'acc', dbAccess: 'public', dbPublicHost: '1.2.3.4', region: 'us-east-1' });
  const saved = loadState('wp-a');
  assert.equal(saved.hyperdriveId, 'h1');
  for (const k of INPUT_KEYS) assert.equal(saved[k], undefined, k);
});

test('inputs from an older state.json move into the config once; config wins afterwards', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-root-'));
  const config = openSiteConfig(root);
  config.set('region', 'eu-central-1');
  const state = withInputs({ name: 'wp-b', accountId: 'acc', dbAccess: 'tunnel', region: 'us-east-1' }, config);
  assert.equal(config.get('accountId'), 'acc');
  assert.equal(config.get('dbAccess'), 'tunnel');
  assert.equal(state.region, 'eu-central-1');
  assert.equal(config.get('dbPublicHost'), undefined);
});
