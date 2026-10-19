// Picks the Worker placement region next to the database. WordPress makes dozens of sequential queries per page,
// so running the Worker close to MySQL matters far more than running it close to the visitor.
import dns from 'node:dns/promises';
import net from 'node:net';

// Approximate coordinates of AWS regions, used as Cloudflare placement hints ("aws:<region>").
const REGIONS = {
  'us-east-1': [38.9, -77.4], 'us-east-2': [40.0, -83.0], 'us-west-1': [37.4, -121.9], 'us-west-2': [45.8, -119.7],
  'ca-central-1': [45.5, -73.6], 'sa-east-1': [-23.5, -46.6], 'eu-west-1': [53.3, -6.3], 'eu-west-2': [51.5, -0.1],
  'eu-west-3': [48.9, 2.35], 'eu-central-1': [50.1, 8.7], 'eu-north-1': [59.3, 18.1], 'eu-south-1': [45.5, 9.2],
  'ap-northeast-1': [35.7, 139.7], 'ap-northeast-2': [37.6, 127.0], 'ap-northeast-3': [34.7, 135.5],
  'ap-southeast-1': [1.35, 103.8], 'ap-southeast-2': [-33.9, 151.2], 'ap-south-1': [19.1, 72.9], 'ap-east-1': [22.3, 114.2],
  'me-south-1': [26.1, 50.6], 'af-south-1': [-33.9, 18.4],
};
export const REGION_NAMES = Object.keys(REGIONS);

// Durable Object location hint for an AWS region (on the Free plan PHP runs in a Durable Object, which is not
// moved by Worker placement).
export function locationHint(region) {
  if (!region) return null;
  if (/^us-(east|west)-|^ca-/.test(region)) return /^us-east|^ca-/.test(region) ? 'enam' : 'wnam';
  if (region.startsWith('sa-')) return 'sam';
  if (region.startsWith('eu-')) return /^eu-north/.test(region) ? 'eeur' : 'weur';
  if (region === 'ap-southeast-2') return 'oc';
  if (region.startsWith('ap-')) return 'apac';
  if (region.startsWith('me-')) return 'me';
  if (region.startsWith('af-')) return 'afr';
  return null;
}

export function isPrivateIp(ip) {
  if (!net.isIP(ip)) return false;
  if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

function haversine([la1, lo1], [la2, lo2]) {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(la2 - la1) / 2) ** 2 + Math.cos(r(la1)) * Math.cos(r(la2)) * Math.sin(r(lo2 - lo1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function nearestRegion(latlon) {
  let best = null;
  for (const [name, c] of Object.entries(REGIONS)) {
    const d = haversine(latlon, c);
    if (!best || d < best.km) best = { region: name, km: Math.round(d) };
  }
  return best;
}

async function publicIpOfThisMachine() {
  const t = await (await fetch('https://cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(8000) })).text();
  return (t.match(/^ip=(.+)$/m) || [])[1] || null;
}

// Where the database is: its own public IP, or this machine's when the database is local/private
// (then the database sits next to this server). Returns { ip, city, country, latlon, viaThisMachine } or null.
export async function locateDatabase(host) {
  let ip = net.isIP(host) ? host : null;
  if (!ip) {
    try {
      ip = (await dns.lookup(host)).address;
    } catch {
      ip = null;
    }
  }
  let viaThisMachine = false;
  if (!ip || isPrivateIp(ip) || host === 'localhost') {
    ip = await publicIpOfThisMachine().catch(() => null);
    viaThisMachine = true;
  }
  if (!ip) return null;
  try {
    const info = await (await fetch(`https://ipinfo.io/${ip}/json`, { signal: AbortSignal.timeout(8000) })).json();
    if (!info.loc) return null;
    return { ip, city: info.city, region: info.region, country: info.country, org: info.org, latlon: info.loc.split(',').map(Number), viaThisMachine };
  } catch {
    return null;
  }
}
