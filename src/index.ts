import { SignJWT, importPKCS8 } from 'jose';
import type { Env } from './types';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const AUD = 'https://oauth2.googleapis.com/token';

/* --- in-memory token cache (per isolate) ----------------------- */
let tokenCache = { token: '', exp: 0 };

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(req.url);

		/* 0 ── simple shared-secret gate */
		if (url.searchParams.get('key') !== env.API_KEY) return new Response('forbidden', { status: 403 });

		/* 1 ── GET /lists  (cached 24 h in KV) ---------------------- */
		if (url.pathname === '/lists' && req.method === 'GET') {
			const cached = await env.LIST_CACHE.get('v1', { type: 'json' });
			if (cached) return json(cached);

			// Check for required environment variables
			if (typeof env.PURPOSE_TAB !== 'string' || !env.PURPOSE_TAB) {
				console.error('Server configuration error: PURPOSE_TAB environment variable is not defined or not a string.');
				return new Response('Server configuration error: Missing PURPOSE_TAB setting.', { status: 500 });
			}
			if (typeof env.ACCOUNT_TAB !== 'string' || !env.ACCOUNT_TAB) {
				console.error('Server configuration error: ACCOUNT_TAB environment variable is not defined or not a string.');
				return new Response('Server configuration error: Missing ACCOUNT_TAB setting.', { status: 500 });
			}

			const [purposes, accounts] = await batchGet([`${env.PURPOSE_TAB}!A2:A`, `${env.ACCOUNT_TAB}!A2:A`], env);

			const payload = {
				purposes: purposes.filter(Boolean),
				accounts: accounts.filter(Boolean),
			};

			ctx.waitUntil(
				// async cache write
				env.LIST_CACHE.put('v1', JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 }) // 24 h
			);

			return json(payload);
		}

		/* 2 ── POST /add ------------------------------------------- */
		if (url.pathname === '/add' && req.method === 'POST') {
			const body = (await req.json()) as {
				date: string;
				amount: number;
				currency: string;
				description: string;
				purpose: string;
				account: string;
			};

			await appendRow([body.date, body.amount, body.currency, body.description, body.purpose, body.account], env);

			return json({ status: 'OK' });
		}

		/* 3 ── POST /flush-cache ----------------------------------- */
		if (url.pathname === '/flush-cache' && req.method === 'POST') {
			try {
				await env.LIST_CACHE.delete('v1');
				return json({ status: 'OK', message: "Cache key 'v1' flushed successfully." });
			} catch (error) {
				console.error('Error flushing cache:', error);
				return json({ status: 'Error', message: 'Failed to flush cache.' }, 500);
			}
		}

		return new Response('not found', { status: 404 });
	},
};

/* ---- Google Sheets helpers ----------------------------------- */
async function batchGet(ranges: string[], env: Env): Promise<string[][]> {
	const token = await accessToken(env);
	const q = ranges.map((r) => 'ranges=' + encodeURIComponent(r)).join('&');

	const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values:batchGet?${q}`, {
		headers: { Authorization: `Bearer ${token}` },
	});

	if (!res.ok) {
		console.error(`Google Sheets API error: ${res.status} ${res.statusText}. Response body: ${await res.text()}`);
		// Return an array of empty arrays, one for each requested range
		return ranges.map(() => []);
	}

	// Make valueRanges optional in the type to handle cases where it might be missing
	const r = await res.json() as { valueRanges?: { values?: string[][] }[] };

	// If valueRanges is not present in the response, or is not an array
	if (!r.valueRanges || !Array.isArray(r.valueRanges)) {
		console.error('Google Sheets API response did not contain a valid valueRanges array. Response:', r);
		// Return an array of empty arrays, matching the number of requested ranges
		return ranges.map(() => []);
	}

	console.log('Google Sheets API response:', JSON.stringify(r, null, 2));
	return r.valueRanges.map((v) => v.values?.flat() ?? []);
}

async function appendRow(cells: (string | number)[], env: Env): Promise<void> {
	const token = await accessToken(env);
	await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}/values/${env.TX_RANGE}:append?valueInputOption=USER_ENTERED`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ values: [cells] }),
	});
}

/* ---- Service-account JWT → OAuth 2 access-token -------------- */
async function accessToken(env: Env): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	if (tokenCache.token && now < tokenCache.exp - 60) return tokenCache.token;

	const privateKey = await importPKCS8(env.SA_PRIVATE_KEY, 'RS256');

	const jwt = await new SignJWT({ scope: SCOPE })
		.setProtectedHeader({ alg: 'RS256' })
		.setIssuer(env.SA_EMAIL)
		.setSubject(env.SA_EMAIL)
		.setAudience(AUD)
		.setIssuedAt(now)
		.setExpirationTime(now + 3600)
		.sign(privateKey);

	const resp = await fetch(AUD, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt),
	}).then((r) => r.json() as Promise<{ access_token: string; expires_in: number }>);

	tokenCache = { token: resp.access_token, exp: now + resp.expires_in };
	return tokenCache.token;
}

/* ---- small helper -------------------------------------------- */
function json(obj: unknown, status = 200): Response {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}
