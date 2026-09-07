// Serverless function: stores receipts as a JSON file (and receipt files as
// individual blobs) inside a GitHub repo, using the GitHub Contents API.
// The GitHub token lives only in Netlify's environment variables — it is
// never sent to the browser.

const GITHUB_API = 'https://api.github.com';

function repoInfo() {
  return {
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH || 'main',
    dataPath: process.env.GITHUB_DATA_PATH || 'data/receipts.json',
  };
}

function ghHeaders(extra) {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    ...extra,
  };
}

function assertConfigured() {
  const { owner, repo } = repoInfo();
  if (!process.env.GITHUB_TOKEN || !owner || !repo) {
    throw new Error(
      'Missing GitHub configuration. Set GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO as Netlify environment variables.'
    );
  }
}

async function getFile(path) {
  const { owner, repo, branch } = repoInfo();
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${branch}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read failed (${res.status}): ${await res.text()}`);
  return res.json(); // { content (base64), sha, ... }
}

async function putFile(path, contentBase64, message, sha) {
  const { owner, repo, branch } = repoInfo();
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const body = { message, content: contentBase64, branch };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method: 'PUT',
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`GitHub write failed (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function deleteFile(path, sha, message) {
  const { owner, repo, branch } = repoInfo();
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ message, sha, branch }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`GitHub delete failed (${res.status}): ${await res.text()}`);
  }
}

async function loadReceipts() {
  const { dataPath } = repoInfo();
  const file = await getFile(dataPath);
  if (!file) return { receipts: [], sha: null };
  const json = Buffer.from(file.content, 'base64').toString('utf-8');
  return { receipts: json ? JSON.parse(json) : [], sha: file.sha };
}

async function saveReceipts(receipts, sha, message) {
  const { dataPath } = repoInfo();
  const content = Buffer.from(JSON.stringify(receipts, null, 2)).toString('base64');
  return putFile(dataPath, content, message, sha);
}

// Retries the load -> transform -> save cycle a few times in case two people
// save at the same instant (GitHub rejects a write if the file changed
// underneath it, similar to an optimistic-lock conflict).
async function mutateReceipts(transformFn, message) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { receipts, sha } = await loadReceipts();
    const newReceipts = transformFn(receipts);
    try {
      await saveReceipts(newReceipts, sha, message);
      return;
    } catch (e) {
      lastErr = e;
      if (e.status !== 409 && e.status !== 422) throw e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr;
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    assertConfigured();

    if (event.httpMethod === 'GET') {
      const params = event.queryStringParameters || {};

      if (params.file) {
        const file = await getFile(params.file);
        if (!file) return { statusCode: 404, headers: cors, body: 'File not found' };
        return {
          statusCode: 200,
          headers: { ...cors, 'Content-Type': 'application/octet-stream' },
          body: file.content,
          isBase64Encoded: true,
        };
      }

      const { receipts } = await loadReceipts();
      return {
        statusCode: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
        body: JSON.stringify(receipts),
      };
    }

    if (event.httpMethod === 'POST') {
      const payload = JSON.parse(event.body || '{}');

      if (payload.action === 'add') {
        const record = payload.record;
        if (record.fileDataBase64 && record.fileName) {
          const filePath = `receipts/${record.id}/${record.fileName}`;
          await putFile(filePath, record.fileDataBase64, `Add receipt file for ${record.id}`);
          record.storagePath = filePath;
        }
        delete record.fileDataBase64;

        await mutateReceipts((receipts) => {
          receipts.unshift(record);
          return receipts;
        }, `Add receipt ${record.id}`);

        return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
      }

      if (payload.action === 'delete') {
        const { receipts } = await loadReceipts();
        const target = receipts.find((r) => r.id === payload.id);

        await mutateReceipts(
          (list) => list.filter((r) => r.id !== payload.id),
          `Delete receipt ${payload.id}`
        );

        if (target && target.storagePath) {
          const fileMeta = await getFile(target.storagePath);
          if (fileMeta) {
            await deleteFile(target.storagePath, fileMeta.sha, `Delete receipt file for ${payload.id}`);
          }
        }

        return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
      }

      return { statusCode: 400, headers: cors, body: 'Unknown action' };
    }

    return { statusCode: 405, headers: cors, body: 'Method not allowed' };
  } catch (e) {
    console.error(e);
    return {
      statusCode: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: e.message }),
    };
  }
};
