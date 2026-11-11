// Supabase persistence for church records.
// Used only when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set.
// The service role key stays in the environment; it is never written to logs or files.
// Tables live in the church_game schema (PostgREST Accept-Profile / Content-Profile).
// That schema must be listed under the project's Settings → API → Exposed schemas.
import { spawnSync } from 'node:child_process';

export function supabaseEnabled() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function request({ method, path, body }) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!base || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase 설정이 없어요.');
  }
  const url = `${base}/rest/v1/${path}`;
  const child = `
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const { method, url, body } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await fetch(url, {
      method,
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Accept-Profile': 'church_game',
        'Content-Profile': 'church_game',
        Prefer: 'return=representation,resolution=merge-duplicates',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    process.stdout.write(JSON.stringify({ ok: res.ok, status: res.status, text }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    input: JSON.stringify({ method, url, body }),
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
  if (r.error) throw new Error(`반 기록 저장소에 연결하지 못했어요: ${r.error.message}`);
  if (r.status !== 0) {
    const err = String(r.stderr || '').trim().slice(0, 200);
    throw new Error(`반 기록 저장소 요청이 실패했어요${err ? `: ${err}` : '.'}`);
  }
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    throw new Error('반 기록 저장소 응답을 읽지 못했어요.');
  }
  if (!out.ok) {
    throw new Error(`반 기록 저장소 오류 (HTTP ${out.status}).`);
  }
  if (!out.text) return null;
  try {
    return JSON.parse(out.text);
  } catch {
    return null;
  }
}

export function loadClass(code) {
  const rows = request({
    method: 'GET',
    path: `classes?code=eq.${encodeURIComponent(code)}&select=data`,
  });
  return Array.isArray(rows) && rows[0] ? rows[0].data : null;
}

export function saveClass(group) {
  const weeklyCap = Number(group.settings?.weeklyCap);
  request({
    method: 'POST',
    path: 'classes?on_conflict=code',
    body: [
      {
        code: group.code,
        pin_hash: group.pinHash,
        pin_salt: group.pinSalt,
        weekly_cap: Number.isFinite(weeklyCap) ? weeklyCap : 20,
        created_at: group.createdAt ? new Date(group.createdAt).toISOString() : new Date().toISOString(),
        updated_at: new Date().toISOString(),
        data: group,
      },
    ],
  });
}

export function deleteClass(code) {
  request({
    method: 'DELETE',
    path: `classes?code=eq.${encodeURIComponent(code)}`,
  });
}
