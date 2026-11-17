import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bodyHash, signToken, verifyToken, verifyWebhook } from '../nodes/LiveKit/token';

const key = { apiKey: 'APItest', apiSecret: 'test-secret-not-real' };
const now = 1_800_000_000;

function webhookAuth(body: string, overrides: Partial<typeof key> = {}, at = now) {
	return signToken({ sha256: bodyHash(body) }, { ...key, ...overrides, ttlSeconds: 300, now: at });
}

test('signed token round-trips with issuer, expiry and grants', () => {
	const token = signToken(
		{ video: { roomAdmin: true, room: 'r1' }, sip: { call: true } },
		{ ...key, ttlSeconds: 60, now, identity: 'n8n' },
	);
	const claims = verifyToken(token, { ...key, now }) as Record<string, any>;
	assert.equal(claims.iss, 'APItest');
	assert.equal(claims.sub, 'n8n');
	assert.equal(claims.exp, now + 60);
	assert.equal(claims.nbf, now);
	assert.deepEqual(claims.video, { roomAdmin: true, room: 'r1' });
	assert.deepEqual(claims.sip, { call: true });
});

test('token header is HS256 JWT', () => {
	const token = signToken({}, { ...key, ttlSeconds: 60, now });
	const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
	assert.deepEqual(header, { alg: 'HS256', typ: 'JWT' });
});

test('verify rejects a wrong secret, issuer, expiry and shape', () => {
	const token = signToken({}, { ...key, ttlSeconds: 60, now });
	assert.throws(() => verifyToken(token, { ...key, apiSecret: 'other', now }), /signature/);
	assert.throws(() => verifyToken(token, { ...key, apiKey: 'APIother', now }), /issuer/);
	assert.throws(() => verifyToken(token, { ...key, now: now + 3600 }), /expired/);
	assert.throws(() => verifyToken('a.b', { ...key, now }), /malformed/);
});

test('verify rejects alg none', () => {
	const head = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
	const body = Buffer.from(JSON.stringify({ iss: key.apiKey, exp: now + 60 })).toString('base64url');
	assert.throws(() => verifyToken(`${head}.${body}.`, { ...key, now }), /algorithm/);
});

test('webhook accepts a matching body, bare or with Bearer', () => {
	const body = '{"event":"room_started","id":"EV_1"}';
	const auth = webhookAuth(body);
	assert.ok(verifyWebhook(body, auth, { ...key, now }));
	assert.ok(verifyWebhook(Buffer.from(body), `Bearer ${auth}`, { ...key, now }));
});

test('webhook rejects a tampered body, wrong secret, missing header and missing hash', () => {
	const body = '{"event":"room_started"}';
	const auth = webhookAuth(body);
	assert.throws(() => verifyWebhook(body + ' ', auth, { ...key, now }), /checksum/);
	assert.throws(
		() => verifyWebhook(body, webhookAuth(body, { apiSecret: 'other' }), { ...key, now }),
		/signature/,
	);
	assert.throws(() => verifyWebhook(body, undefined, { ...key, now }), /empty/);
	const noHash = signToken({}, { ...key, ttlSeconds: 300, now });
	assert.throws(() => verifyWebhook(body, noHash, { ...key, now }), /sha256/);
});
