import { Hono, type Context, type Next } from 'hono';
import { JWT } from 'google-auth-library';

// Define the Env type for bindings
export type Env = {
  // KV Namespace
  LIST_CACHE: KVNamespace;

  // Environment Variables (Secrets)
  API_KEY: string;
  SHEET_ID: string;
  SA_EMAIL: string;
  SA_PRIVATE_KEY: string;

  // Environment Variables (Non-Secrets)
  TX_RANGE: string;
  PURPOSE_TAB: string;
  ACCOUNT_TAB: string;
};

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const LIST_CACHE_KEY = 'lists-v1'; // Memory mentioned 'v2', but code uses 'lists-v1'. Sticking to 'lists-v1'.

let jwtClient: JWT; // Global JWT client for Google Auth

// --- Helper Functions --- (Adapted to use Env type)

async function accessToken(env: Env): Promise<string> {
  if (!jwtClient) {
    jwtClient = new JWT({
      email: env.SA_EMAIL,
      key: env.SA_PRIVATE_KEY.replace(/\\n/g, '\n'), // Crucial for env var private keys
      scopes: [SCOPE],
    });
  }
  await jwtClient.authorize();
  const token = jwtClient.credentials.access_token;
  if (!token) throw new Error('Failed to obtain access token');
  return token;
}

async function batchGet(ranges: string[], env: Env): Promise<string[][]> {
  const token = await accessToken(env);
  const q = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values:batchGet?${q}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Sheets batchGet failed: ${res.status} ${res.statusText} - ${errorText}`);
  }
  const { valueRanges } = (await res.json()) as { valueRanges?: { values?: string[][] }[] };
  // Ensure each sub-array in valueRanges.values is filtered for empty/null strings
  return valueRanges?.map((v) => v.values?.flat().filter(s => typeof s === 'string' && s.trim() !== '') ?? []) ?? ranges.map(() => []);
}

async function appendRow(cells: (string | number)[], env: Env): Promise<void> {
  const token = await accessToken(env);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${encodeURIComponent(env.TX_RANGE)}:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [cells] }),
    },
  );
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Append failed: ${res.status} ${res.statusText} - ${errorText}`);
  }
}

// --- Hono Application Setup ---
const app = new Hono<{ Bindings: Env }>();

// Middleware: Server Configuration Check
app.use('*', async (c: Context<{ Bindings: Env }>, next: Next) => {
  const { API_KEY, SHEET_ID, TX_RANGE, PURPOSE_TAB, ACCOUNT_TAB, SA_EMAIL, SA_PRIVATE_KEY, LIST_CACHE } = c.env;
  if (
    ![API_KEY, SHEET_ID, TX_RANGE, PURPOSE_TAB, ACCOUNT_TAB, SA_EMAIL, SA_PRIVATE_KEY].every(Boolean) ||
    !LIST_CACHE
  ) {
    return c.json({ status: 'ERROR', message: 'Server misconfigured. Essential bindings are missing.' }, 500);
  }
  await next();
});

// Middleware: API Key Check (applied to all routes after config check)
app.use('*', async (c: Context<{ Bindings: Env }>, next: Next) => {
  const url = new URL(c.req.url);
  // Allow root path without API key for a basic health check
  if (url.pathname === '/') {
    await next();
    return;
  }
  if (url.searchParams.get('key') !== c.env.API_KEY) {
    return c.json({ status: 'ERROR', message: 'Forbidden: Invalid or missing API key.' }, 403);
  }
  await next();
});

// --- Route Handlers ---

// GET /lists: Fetches purposes and accounts, uses cache
app.get('/lists', async (c: Context<{ Bindings: Env }>) => {
  const env = c.env;
  try {
    const cached = await env.LIST_CACHE.get(LIST_CACHE_KEY, { type: 'json' }) as { purposes: string[], accounts: string[] } | null;
    if (cached) {
      return c.json(cached);
    }

    const [purposesData, accountsData] = await batchGet(
      [`${env.PURPOSE_TAB}!A2:A`, `${env.ACCOUNT_TAB}!A2:A`],
      env,
    );
    // Data from batchGet is already string[] and filtered by the helper itself.
    const payload = { purposes: purposesData, accounts: accountsData };

    c.executionCtx.waitUntil(
      env.LIST_CACHE.put(LIST_CACHE_KEY, JSON.stringify(payload), { expirationTtl: 86400 }), // 24 hours TTL
    );
    return c.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // console.error('Error in /lists:', message, (err as Error).stack); // For server-side debugging
    return c.json({ status: 'ERROR', message: 'Failed to fetch lists.', detail: message }, 500);
  }
});

// POST /add: Appends a new transaction row
app.post('/add', async (c: Context<{ Bindings: Env }>) => {
  const env = c.env;
  try {
    // Define the expected type for the request body
    type AddRequestBody = {
      date: string;
      amount: number;
      currency: string;
      description: string;
      purpose: string;
      account: string;
    };
    const body = await c.req.json<AddRequestBody>();

    const { date, amount, currency, description, purpose, account } = body;

    if (!date || amount == null || !currency || !description || !purpose || !account) {
      return c.json({ status: 'ERROR', message: 'Missing required fields in request body.' }, 400);
    }

    await appendRow([date, amount, currency, description, purpose, account], env);
    return c.json({ status: 'OK', message: 'Transaction added successfully.' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // console.error('Error in /add:', message, (err as Error).stack); // For server-side debugging
    return c.json({ status: 'ERROR', message: 'Failed to add transaction.', detail: message }, 500);
  }
});

// POST /flush-cache: Clears the cache for /lists
app.post('/flush-cache', async (c: Context<{ Bindings: Env }>) => {
  const env = c.env;
  try {
    await env.LIST_CACHE.delete(LIST_CACHE_KEY);
    return c.json({ status: 'OK', message: `Cache key '${LIST_CACHE_KEY}' flushed successfully.` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // console.error('Error in /flush-cache:', message, (err as Error).stack); // For server-side debugging
    return c.json({ status: 'ERROR', message: 'Failed to flush cache.', detail: message }, 500);
  }
});

// Root path for basic health check (does not require API key due to middleware logic)
app.get('/', (c: Context<{ Bindings: Env }>) => {
  return c.text('Budget Edge Worker with Hono is running!');
});

// --- Hono Error Handling ---

// Not Found Handler
app.notFound((c: Context<{ Bindings: Env }>) => {
  return c.json({ status: 'ERROR', message: 'Not Found. The requested endpoint does not exist.' }, 404);
});

// Global Error Handler
app.onError((err: Error, c: Context<{ Bindings: Env }>) => {
  // console.error('Global Hono Error:', err.message, err.stack); // For server-side debugging
  return c.json({ status: 'ERROR', message: 'Internal Server Error.', detail: err.message }, 500);
});

export default app;
