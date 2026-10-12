// Client for a running tinyimgen server (proxied same-origin under /tinyimgen by vite.config.js): its rigged
// characters and holdable props, for the editor's Models tab and the playtest's character picker.

export const TINYIMGEN = '/tinyimgen';

const media = (job, file) => `${TINYIMGEN}/media/3d/${job.id}/${file}`;

async function fetchJobs() {
  let res;
  try {
    res = await fetch(`${TINYIMGEN}/api/3d`, { cache: 'no-cache' });
  } catch {
    throw new Error('tinyimgen is not reachable');
  }
  if (!res.ok) throw new Error(`tinyimgen is not reachable (HTTP ${res.status})`);
  return (await res.json()).filter((j) => j.status === 'done');
}

const jobName = (j) => j.title || shortName(j.config?.describe) || new Date(j.created * 1000).toLocaleDateString();
const thumbOf = (j) => (j.outputs.thumb ? media(j, j.outputs.thumb) : null);

/**
 * Everything usable from tinyimgen. Throws if the server can't be reached.
 *   characters: [{ role: 'character', id, name, thumb, url }]            rigged.glb (Rig + animations)
 *   props:      [{ role: 'prop', id, name, thumb, url, gripUrl, hands, hold }]   prop.glb + grip.json (Prop Editor)
 */
export async function listTinyimgen() {
  const jobs = await fetchJobs();
  const characters = jobs.filter((j) => j.outputs?.rigged).map((j) => ({
    role: 'character', id: j.id, name: jobName(j), thumb: thumbOf(j), url: media(j, j.outputs.rigged),
  }));
  const props = jobs.filter((j) => j.outputs?.prop).map((j) => ({
    role: 'prop', id: j.id, name: jobName(j), thumb: thumbOf(j), url: media(j, j.outputs.prop),
    gripUrl: j.outputs.grip ? media(j, j.outputs.grip) : null, hands: j.grip?.hands ?? 1, hold: j.grip?.hold ?? 'upright',
  }));
  return { characters, props };
}

/** Rigged characters only: [{ id, name, thumb, url }]. */
export async function listTinyimgenCharacters() {
  return (await listTinyimgen()).characters;
}

/** Download a file from tinyimgen, revalidating so a re-rig or re-saved grip shows up. */
export async function fetchTinyimgen(url, as = 'arrayBuffer') {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Couldn't download ${url.split('/').pop()} from tinyimgen (HTTP ${res.status})`);
  return res[as]();
}

/** "a full 3d game character t-posed, front view. a dark fantasy medieval soldier wearing…" -> "dark fantasy medieval soldier" */
function shortName(describe) {
  if (!describe) return '';
  let s = describe.replace(/^[^.]*\b(3d|character|view)\b[^.]*\.\s*/i, '');
  s = s.split(/[,.;]| wearing | with | in a /i)[0].replace(/^(a|an|the)\s+/i, '').trim();
  return s.length > 32 ? `${s.slice(0, 30).trim()}…` : s;
}
