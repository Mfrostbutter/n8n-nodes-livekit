import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface VideoGrant {
	roomCreate?: boolean;
	roomList?: boolean;
	roomAdmin?: boolean;
	roomJoin?: boolean;
	room?: string;
	canPublish?: boolean;
	canSubscribe?: boolean;
	canPublishData?: boolean;
}

export interface SipGrant {
	admin?: boolean;
	call?: boolean;
}

export interface TokenClaims {
	video?: VideoGrant;
	sip?: SipGrant;
	name?: string;
	metadata?: string;
	attributes?: Record<string, string>;
	roomConfig?: Record<string, unknown>;
	sha256?: string;
	[key: string]: unknown;
}

export interface SignOptions {
	apiKey: string;
	apiSecret: string;
	ttlSeconds: number;
	identity?: string;
	now?: number;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

// Signs a LiveKit HS256 token.
export function signToken(claims: TokenClaims, options: SignOptions): string {
	const now = options.now ?? Math.floor(Date.now() / 1000);
	const payload: Record<string, unknown> = {
		...claims,
		iss: options.apiKey,
		nbf: now,
		exp: now + options.ttlSeconds,
	};
	if (options.identity) payload.sub = options.identity;
	const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
	const body = b64url(JSON.stringify(payload));
	const signature = createHmac('sha256', options.apiSecret).update(`${head}.${body}`).digest();
	return `${head}.${body}.${b64url(signature)}`;
}

export interface VerifyOptions {
	apiKey: string;
	apiSecret: string;
	now?: number;
	toleranceSeconds?: number;
}

// Verifies a LiveKit HS256 token and returns its claims. Throws on any failure.
export function verifyToken(token: string, options: VerifyOptions): TokenClaims {
	const parts = token.split('.');
	if (parts.length !== 3) throw new Error('malformed token');
	const [head, body, signature] = parts;

	let header: { alg?: string };
	try {
		header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
	} catch {
		throw new Error('malformed token header');
	}
	if (header.alg !== 'HS256') throw new Error('unsupported algorithm');

	const expected = createHmac('sha256', options.apiSecret).update(`${head}.${body}`).digest();
	const given = Buffer.from(signature, 'base64url');
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
		throw new Error('invalid signature');
	}

	let claims: TokenClaims & { iss?: string; exp?: number; nbf?: number };
	try {
		claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
	} catch {
		throw new Error('malformed token payload');
	}

	const now = options.now ?? Math.floor(Date.now() / 1000);
	const tolerance = options.toleranceSeconds ?? 10;
	if (claims.iss !== options.apiKey) throw new Error('issuer mismatch');
	if (typeof claims.exp !== 'number') throw new Error('token has no expiry');
	if (claims.exp + tolerance < now) throw new Error('token expired');
	if (typeof claims.nbf === 'number' && claims.nbf - tolerance > now) {
		throw new Error('token not yet valid');
	}
	return claims;
}

// Base64 SHA-256 of a webhook body, as LiveKit puts it in the sha256 claim.
export function bodyHash(rawBody: Buffer | string): string {
	return createHash('sha256').update(rawBody).digest('base64');
}

// Verifies a LiveKit webhook: token signature, issuer, expiry and body hash.
export function verifyWebhook(
	rawBody: Buffer | string,
	authHeader: string | undefined,
	options: VerifyOptions,
): TokenClaims {
	if (!authHeader) throw new Error('authorization header is empty');
	const token = authHeader.replace(/^Bearer\s+/i, '').trim();
	const claims = verifyToken(token, options);
	if (!claims.sha256) throw new Error('sha256 was not found in the token');
	const expected = Buffer.from(bodyHash(rawBody));
	const given = Buffer.from(claims.sha256);
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
		throw new Error('sha256 checksum of body does not match');
	}
	return claims;
}
