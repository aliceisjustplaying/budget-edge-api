import { JWT } from 'google-auth-library';
import { Hono } from 'hono';

export interface Env {
  LIST_CACHE: KVNamespace;
  API_KEY: string;
  SHEET_ID: string;
  SA_EMAIL: string;
  SA_PRIVATE_KEY: string;
  TX_RANGE: string;
  PURPOSE_TAB: string;
  ACCOUNT_TAB: string;
}

interface AddRequestBody {
  date: string;
  amount: number;
  currency: string;
  description: string;
  purpose: string;
  account: string;
}

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const LIST_CACHE_KEY = 'lists-v1';
const TOKEN_CACHE_KEY = 'token-v1';

let jwtClient: JWT | null = null;

async function accessToken(env: Env): Promise<string> {
  const now = Date.now();
  // Try KV cache
  const cached = await env.LIST_CACHE.get<{ token: string; expiry: number }>(TOKEN_CACHE_KEY, { type: 'json' });
  if (cached && now < cached.expiry - 60000) {
    return cached.token;
  }
  // Initialize client if needed
  jwtClient ??= new JWT({
    email: env.SA_EMAIL,
    key: env.SA_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: [SCOPE],
  });
  await jwtClient.authorize();
  const token = jwtClient.credentials.access_token;
  const expiry = jwtClient.credentials.expiry_date ?? now + 3600 * 1000;
  if (!token) throw new Error('Failed to obtain access token');
  // Store in KV with TTL
  const ttl = Math.max(Math.floor((expiry - now) / 1000), 1);
  await env.LIST_CACHE.put(TOKEN_CACHE_KEY, JSON.stringify({ token, expiry }), {
    expirationTtl: ttl,
  });
  return token;
}

async function batchGet(ranges: string[], env: Env): Promise<string[][]> {
  const token = await accessToken(env);
  const q = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values:batchGet?${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Sheets batchGet failed: ${res.status} ${res.statusText} - ${errorText}`);
  }
  const { valueRanges } = await res.json<{ valueRanges?: { values?: string[][] }[] }>();
  return valueRanges?.map((v) => v.values?.flat().filter((s) => s.trim() !== '') ?? []) ?? ranges.map(() => []);
}

async function appendRow(cells: (string | number)[], env: Env): Promise<void> {
  const token = await accessToken(env);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(env.TX_RANGE)}:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [cells] }),
    },
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Append failed: ${res.status} ${res.statusText} - ${errorText}`);
  }
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const { API_KEY, SHEET_ID, TX_RANGE, PURPOSE_TAB, ACCOUNT_TAB, SA_EMAIL, SA_PRIVATE_KEY } = c.env;
  if (![API_KEY, SHEET_ID, TX_RANGE, PURPOSE_TAB, ACCOUNT_TAB, SA_EMAIL, SA_PRIVATE_KEY].every(Boolean)) {
    return c.json({ status: 'ERROR', message: 'Server misconfigured' }, 500);
  }
  const { pathname, searchParams } = new URL(c.req.url);
  if (pathname !== '/' && searchParams.get('key') !== API_KEY) {
    return c.json({ status: 'ERROR', message: 'Forbidden' }, 403);
  }
  await next();
});

app.get('/lists', async (c) => {
  const env = c.env;
  try {
    const cached = await env.LIST_CACHE.get(LIST_CACHE_KEY, { type: 'json' });
    if (cached) {
      return c.json(cached);
    }

    const [purposesData, accountsData] = await batchGet([`${env.PURPOSE_TAB}!A2:A`, `${env.ACCOUNT_TAB}!A2:A`], env);
    const payload = { purposes: purposesData, accounts: accountsData };

    c.executionCtx.waitUntil(
      env.LIST_CACHE.put(LIST_CACHE_KEY, JSON.stringify(payload), {
        expirationTtl: 86400,
      }),
    );
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ status: 'ERROR', message: 'Failed to fetch lists.', detail: message }, 500);
  }
});

app.post('/add', async (c) => {
  const env = c.env;
  try {
    const body = await c.req.json<AddRequestBody>();

    const { amount, currency, description, purpose, account } = body;
    const date = new Date(body.date).toISOString().split('T')[0];

    if (!date || !amount || !currency || !description || !purpose || !account) {
      return c.json(
        {
          status: 'ERROR',
          message: 'Missing required fields in request body.',
        },
        400,
      );
    }

    await appendRow([date, amount, currency, description, purpose, account], env);
    return c.json({ status: 'OK', message: 'Transaction added successfully.' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        status: 'ERROR',
        message: 'Failed to add transaction.',
        detail: message,
      },
      500,
    );
  }
});

app.post('/flush-cache', async (c) => {
  const env = c.env;
  try {
    await env.LIST_CACHE.delete(LIST_CACHE_KEY);
    return c.json({
      status: 'OK',
      message: `Cache key '${LIST_CACHE_KEY}' flushed successfully.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ status: 'ERROR', message: 'Failed to flush cache.', detail: message }, 500);
  }
});

app.get('/', (c) => c.text('Budget Edge Worker is running!'));

app.notFound((c) => c.json({ status: 'ERROR', message: 'Not Found' }, 404));

app.onError((err, c) => c.json({ status: 'ERROR', message: 'Internal Server Error', detail: err.message }, 500));

export default app;
