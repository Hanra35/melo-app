const { createHash } = require('crypto');

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

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

async function authB2(acct) {
  const cfg = ACCOUNTS[acct];
  const auth = Buffer.from(`${cfg.keyId}:${cfg.appKey}`).toString('base64');
  const r = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: `Basic ${auth}` }
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.message || 'Auth B2 failed');
  return { ...d, _cfg: cfg };
}

async function getBucketId(a) {
  const r = await fetch(`${a.apiUrl}/b2api/v2/b2_list_buckets`, {
    method: 'POST',
    headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: a.accountId })
  });
  const d = await r.json();
  const b = d.buckets.find(x => x.bucketName === a._cfg.bucket);
  return b ? b.bucketId : null;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { action, acct = 1 } = req.query;

    if (action === 'auth') {
      const a = await authB2(acct);
      return res.status(200).json({
        authorizationToken: a.authorizationToken,
        apiUrl: a.apiUrl,
        downloadUrl: a.downloadUrl,
        accountId: a.accountId,
        bucketName: a._cfg.bucket
      });
    }

    if (action === 'upload-auth') {
      const a = await authB2(acct);
      const bid = await getBucketId(a);
      const r = await fetch(`${a.apiUrl}/b2api/v2/b2_get_upload_url`, {
        method: 'POST',
        headers: { Authorization: a.authorizationToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucketId: bid })
      });
      const d = await r.json();
      return res.status(200).json({
        uploadUrl: d.uploadUrl,
        uploadToken: d.authorizationToken,
        downloadUrl: a.downloadUrl
      });
    }

    return res.status(400).json({ error: 'Action inconnue' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
