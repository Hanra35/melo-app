const { createHash } = require('crypto');

/* ══════════════════════════
   COMPTES BACKBLAZE
   ══════════════════════════ */
const ACCOUNTS = {
  1: {
    keyId:  '003ec0649a89f090000000001',
    appKey: 'K003dwNhrjinpVEyi4VKsJxxZmL3LO4',
    bucket: 'melo-music-2026',
  },
  2: {
    keyId:  '005ac1e426dba9b0000000001',
    appKey: 'K005BBpJA11ponJY7pvKaPK94H4//qQ',
    bucket: 'melo-music-2-bucket',
  },
};

const META_FILE = 'melo-metadata.json';
const GB = 1073741824;

/* ── helpers B2 ── */
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

async function authB2(acct) {
  const cfg = ACCOUNTS[acct];
  if (!cfg) throw new Error('Compte inconnu: ' + acct);
  const r = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.keyId}:${cfg.appKey}`).toString('base64') }
  });
  if (!r.ok) throw new Error(`Auth B2 compte${acct} failed: ${r.status}`);
  const d = await r.json();
  return { ...d, _bucket: cfg.bucket };
}

async function getBucketId(a) {
  if (a.allowed?.bucketId) return a.allowed.bucketId;
  const r = await fetch(`${a.apiUrl}/b2api/v2/b2_list_buckets`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: a.accountId, bucketName: a._bucket })
  });
  const d = await r.json();
  if (!d.buckets?.length) throw new Error(`Bucket "${a._bucket}" introuvable`);
  return d.buckets[0].bucketId;
}

async function fixCors(a, bid) {
  await fetch(`${a.apiUrl}/b2api/v2/b2_update_bucket`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId: a.accountId, bucketId: bid,
      corsRules: [{ corsRuleName: 'melo', allowedOrigins: ['*'], allowedHeaders: ['*'],
        allowedOperations: ['b2_download_file_by_name','b2_download_file_by_id','b2_upload_file','b2_upload_part'],
        exposeHeaders: ['Content-Length'], maxAgeSeconds: 3600 }]
    })
  });
}

async function getUploadUrl(a, bid) {
  const r = await fetch(`${a.apiUrl}/b2api/v2/b2_get_upload_url`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: bid })
  });
  return r.json();
}

async function getDlToken(a, bid) {
  const r = await fetch(`${a.apiUrl}/b2api/v2/b2_get_download_authorization`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ bucketId: bid, fileNamePrefix: '', validDurationInSeconds: 43200 })
  });
  return (await r.json()).authorizationToken;
}

async function b2Upload(upUrl, upToken, key, buf, mime) {
  const sha1 = createHash('sha1').update(buf).digest('hex');
  const r = await fetch(upUrl, {
    method: 'POST',
    headers: { Authorization: upToken, 'X-Bz-File-Name': encodeURIComponent(key),
      'Content-Type': mime, 'X-Bz-Content-Sha1': sha1 },
    body: buf,
  });
  if (!r.ok) throw new Error('Upload B2 failed: ' + await r.text());
  return r.json();
}

function parseMeta(raw) {
  if (!raw) return { tracks: [], playlists: [], albums: [], artists: [] };
  if (Array.isArray(raw)) return { tracks: raw, playlists: [], albums: [], artists: [] };
  return {
    tracks:    Array.isArray(raw.tracks)    ? raw.tracks    : [],
    playlists: Array.isArray(raw.playlists) ? raw.playlists : [],
    albums:    Array.isArray(raw.albums)    ? raw.albums    : [],
    artists:   Array.isArray(raw.artists)   ? raw.artists   : [],
  };
}

function storageStats(tracks) {
  const used = tracks.reduce((s, t) => s + (t.fileSize || 6 * 1024 * 1024), 0);
  const total = 10 * GB;
  return { used, total, free: Math.max(0, total - used), count: tracks.length,
           pct: Math.min(100, Math.round(used / total * 100)) };
}

/* ══════════════════════════
   HANDLER PRINCIPAL
   ══════════════════════════ */
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action, account: acctParam } = req.query;
  const acct = parseInt(acctParam) === 2 ? 2 : 1;

  try {

    /* ── INIT : charge les données du compte demandé ── */
    if (action === 'init') {
      const a   = await authB2(acct);
      const bid = await getBucketId(a);
      await fixCors(a, bid);

      let meta = { tracks: [], playlists: [], albums: [], artists: [] };
      try {
        const r = await fetch(`${a.downloadUrl}/file/${a._bucket}/${META_FILE}`, {
          headers: { Authorization: a.authorizationToken }
        });
        if (r.ok) meta = parseMeta(await r.json());
      } catch (_) {}

      const dlToken = await getDlToken(a, bid);

      /* Stats pour les deux comptes (init compte 1 charge aussi les stats du compte 2) */
      let stats1 = storageStats(acct === 1 ? meta.tracks : []);
      let stats2 = storageStats(acct === 2 ? meta.tracks : []);

      if (acct === 1) {
        /* Charge les stats du compte 2 en parallèle silencieusement */
        try {
          const a2 = await authB2(2);
          const bid2 = await getBucketId(a2);
          let m2 = { tracks: [] };
          try {
            const r2 = await fetch(`${a2.downloadUrl}/file/${a2._bucket}/${META_FILE}`, {
              headers: { Authorization: a2.authorizationToken }
            });
            if (r2.ok) m2 = parseMeta(await r2.json());
          } catch (_) {}
          stats2 = storageStats(m2.tracks);
        } catch (_) {}
      } else {
        try {
          const a1 = await authB2(1);
          const bid1 = await getBucketId(a1);
          let m1 = { tracks: [] };
          try {
            const r1 = await fetch(`${a1.downloadUrl}/file/${a1._bucket}/${META_FILE}`, {
              headers: { Authorization: a1.authorizationToken }
            });
            if (r1.ok) m1 = parseMeta(await r1.json());
          } catch (_) {}
          stats1 = storageStats(m1.tracks);
        } catch (_) {}
      }

      res.status(200).json({
        account: acct,
        tracks: meta.tracks, playlists: meta.playlists,
        albums: meta.albums, artists: meta.artists,
        downloadUrl: a.downloadUrl, downloadToken: dlToken, bucketName: a._bucket,
        stats1, stats2,
        combined: { used: stats1.used + stats2.used, total: 2 * GB * 10,
          free: Math.max(0, 2 * GB * 10 - stats1.used - stats2.used) }
      });
      return;
    }

    /* ── UPLOAD-CREDS : upload vers le compte actif ── */
    if (action === 'upload-creds') {
      const a   = await authB2(acct);
      const bid = await getBucketId(a);
      const up  = await getUploadUrl(a, bid);
      res.status(200).json({ uploadUrl: up.uploadUrl, authorizationToken: up.authorizationToken, account: acct });
      return;
    }

    /* ── SAVE-META : sauvegarde dans le bucket du compte actif ── */
    if (action === 'save-meta' && req.method === 'POST') {
      const body = req.body;
      const meta = parseMeta(body);
      const buf  = Buffer.from(JSON.stringify(meta), 'utf-8');
      const a    = await authB2(acct);
      const bid  = await getBucketId(a);
      const up   = await getUploadUrl(a, bid);
      await b2Upload(up.uploadUrl, up.authorizationToken, META_FILE, buf, 'application/json');
      res.status(200).json({ ok: true });
      return;
    }

    /* ── DELETE ── */
    if (action === 'delete') {
      const { key, fileId } = req.query;
      if (key && fileId) {
        const a = await authB2(acct);
        await fetch(`${a.apiUrl}/b2api/v2/b2_delete_file_version`, {
          method: 'POST',
          headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: key, fileId })
        });
      }
      res.status(200).json({ ok: true });
      return;
    }

    /* ── STORAGE-STATS ── */
    if (action === 'storage-stats') {
      const [a1, a2] = await Promise.all([authB2(1), authB2(2)]);
      let m1 = { tracks: [] }, m2 = { tracks: [] };
      try {
        const r = await fetch(`${a1.downloadUrl}/file/${a1._bucket}/${META_FILE}`, { headers: { Authorization: a1.authorizationToken }});
        if (r.ok) m1 = parseMeta(await r.json());
      } catch (_) {}
      try {
        const r = await fetch(`${a2.downloadUrl}/file/${a2._bucket}/${META_FILE}`, { headers: { Authorization: a2.authorizationToken }});
        if (r.ok) m2 = parseMeta(await r.json());
      } catch (_) {}
      const s1 = storageStats(m1.tracks);
      const s2 = storageStats(m2.tracks);
      res.status(200).json({ stats1: s1, stats2: s2,
        combined: { used: s1.used + s2.used, total: 2 * GB * 10, free: Math.max(0, 2 * GB * 10 - s1.used - s2.used) }
      });
      return;
    }

    res.status(404).json({ error: 'Action inconnue' });

  } catch (e) {
    console.error('api error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
