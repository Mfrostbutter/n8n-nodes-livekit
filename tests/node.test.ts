import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';

import { LiveKit } from '../nodes/LiveKit/LiveKit.node';
import { LiveKitTrigger } from '../nodes/LiveKit/LiveKitTrigger.node';
import { bodyHash, signToken, verifyToken } from '../nodes/LiveKit/token';

const creds = { apiKey: 'APItest', apiSecret: 'test-secret-not-real', serverUrl: '' };

interface Seen {
	path: string;
	body: any;
	claims: any;
}
const seen: Seen[] = [];
let server: Server;

const read = (req: IncomingMessage) =>
	new Promise<string>((resolve) => {
		let data = '';
		req.on('data', (c) => (data += c));
		req.on('end', () => resolve(data));
	});

// Fake LiveKit Twirp server. Verifies the token, records the call.
before(async () => {
	server = createServer(async (req, res) => {
		const body = JSON.parse((await read(req)) || '{}');
		let claims: any;
		try {
			claims = verifyToken(String(req.headers.authorization).replace(/^Bearer /, ''), creds);
		} catch {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ code: 'unauthenticated', msg: 'invalid token' }));
			return;
		}
		const path = req.url ?? '';
		seen.push({ path, body, claims });
		const reply = (status: number, json: unknown) => {
			res.writeHead(status, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(json));
		};
		if (path.endsWith('/ListRooms')) return reply(200, { rooms: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
		if (path.endsWith('/ListDispatch')) return reply(200, { agent_dispatches: [{ id: 'AD_1' }] });
		if (path.endsWith('/DeleteRoom')) return reply(200, {});
		if (path.endsWith('/CreateSIPInboundTrunk')) {
			return reply(200, { sip_trunk_id: 'ST_new', ...body.trunk });
		}
		if (path.endsWith('/TransferSIPParticipant')) {
			if (body.transfer_to === 'tel:+busy') {
				return reply(409, { code: 'aborted', msg: 'sip status: 486: Busy Here' });
			}
			return reply(200, {});
		}
		return reply(200, { echo: body });
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	creds.serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

// Minimal stand-in for n8n's execute context.
function executeContext(items: Record<string, unknown>[], continueOnFail = false) {
	return {
		getInputData: () => items.map((json) => ({ json })),
		getCredentials: async (name: string) =>
			name === 'liveKitSipTrunkAuthApi'
				? { username: 'trunk-user', password: 'not-a-real-password' }
				: creds,
		getNodeParameter: (name: string, i: number, fallback?: unknown) =>
			name in items[i] ? items[i][name] : fallback,
		getNode: () => ({ name: 'LiveKit', type: 'liveKit', typeVersion: 1, parameters: {} }),
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequest: async (o: any) => {
				const res = await fetch(o.url, {
					method: o.method,
					headers: o.headers,
					body: typeof o.body === 'string' ? o.body : JSON.stringify(o.body),
				});
				const json = await res.json();
				if (!res.ok) {
					throw Object.assign(new Error(json.msg), { httpCode: String(res.status), description: json.msg });
				}
				return json;
			},
		},
	};
}

const run = (items: Record<string, unknown>[], continueOnFail = false) =>
	new LiveKit().execute.call(executeContext(items, continueOnFail) as any);

test('transfer posts to the SIP service with a scoped short-lived token', async () => {
	seen.length = 0;
	const [out] = await run([
		{ resource: 'sip', operation: 'transfer', roomName: 'call-1', identity: 'sip_1', transferTo: 'tel:+4930' },
	]);
	assert.deepEqual(out[0].json, { success: true });
	assert.equal(seen[0].path, '/twirp/livekit.SIP/TransferSIPParticipant');
	assert.deepEqual(seen[0].claims.video, { roomAdmin: true, room: 'call-1' });
	assert.deepEqual(seen[0].claims.sip, { call: true });
	assert.equal(seen[0].claims.exp - seen[0].claims.nbf, 60);
	assert.equal(seen[0].body.transfer_to, 'tel:+4930');
});

test('a failed transfer is a node error carrying the SIP status', async () => {
	await assert.rejects(
		run([{ resource: 'sip', operation: 'transfer', roomName: 'r', identity: 'p', transferTo: 'tel:+busy' }]),
		(error: any) => /486/.test(`${error.message} ${error.description}`),
	);
});

test('continue on fail returns the error as an item and keeps going', async () => {
	const [out] = await run(
		[
			{ resource: 'sip', operation: 'transfer', roomName: 'r', identity: 'p', transferTo: 'tel:+busy' },
			{ resource: 'room', operation: 'delete', roomName: 'r' },
		],
		true,
	);
	assert.equal(out.length, 2);
	assert.ok(out[0].json.error);
	assert.deepEqual(out[0].pairedItem, { item: 0 });
	assert.deepEqual(out[1].json, { success: true });
});

test('get many unwraps the list, honours the limit and pairs items', async () => {
	const [all] = await run([{ resource: 'room', operation: 'getMany' }]);
	assert.deepEqual(all.map((i) => i.json.name), ['a', 'b', 'c']);
	const [two] = await run([{ resource: 'room', operation: 'getMany', returnAll: false, limit: 2 }]);
	assert.equal(two.length, 2);
	const [dispatches] = await run([{ resource: 'agentDispatch', operation: 'getMany', roomName: 'r' }]);
	assert.deepEqual(dispatches[0].json, { id: 'AD_1' });
});

test('access token is signed locally and sends no request', async () => {
	seen.length = 0;
	const [out] = await run([
		{ resource: 'accessToken', operation: 'create', identity: 'tester', roomName: 'r1', ttl: 120 },
	]);
	assert.equal(seen.length, 0);
	const claims = verifyToken(String(out[0].json.token), creds) as any;
	assert.equal(claims.sub, 'tester');
	assert.equal(claims.video.room, 'r1');
	assert.equal(claims.video.roomJoin, true);
	assert.equal(claims.exp - claims.nbf, 120);
});

test('a missing required field fails before any request', async () => {
	seen.length = 0;
	await assert.rejects(run([{ resource: 'accessToken', operation: 'create', identity: '' }]), /Identity/);
	assert.equal(seen.length, 0);
});

// Minimal stand-in for n8n's webhook context.
function webhookContext(rawBody: Buffer | undefined, authorization: string | undefined, params = {}) {
	const response = { code: 200, body: undefined as unknown };
	const res = {
		status(code: number) {
			response.code = code;
			return res;
		},
		json(body: unknown) {
			response.body = body;
			return res;
		},
	};
	const ctx = {
		getRequestObject: () => ({ rawBody, headers: { authorization }, body: {} }),
		getResponseObject: () => res,
		getCredentials: async () => creds,
		getNodeParameter: (name: string, fallback?: unknown) =>
			name in params ? (params as any)[name] : fallback,
		helpers: { returnJsonArray: (json: unknown) => [{ json }] },
	};
	return { ctx, response };
}

const event = JSON.stringify({
	event: 'participant_left',
	id: 'EV_1',
	room: { name: 'call-1' },
	participant: { identity: 'sip_1', kind: 'SIP' },
});
const auth = (body: string, secret = creds.apiSecret) =>
	signToken({ sha256: bodyHash(body) }, { apiKey: creds.apiKey, apiSecret: secret, ttlSeconds: 300 });

const hook = (ctx: unknown) => new LiveKitTrigger().webhook.call(ctx as any);

test('trigger emits a verified event parsed from the raw body', async () => {
	const { ctx, response } = webhookContext(Buffer.from(event), auth(event));
	const result = await hook(ctx);
	const json = result.workflowData![0][0].json;
	assert.equal(json.event, 'participant_left');
	assert.equal(json.eventId, 'EV_1');
	assert.equal(json.participantKind, 'SIP');
	assert.equal(response.code, 200);
});

test('trigger answers 401 and starts nothing on a bad signature, tampered or missing body', async () => {
	const cases: [Buffer | undefined, string | undefined][] = [
		[Buffer.from(event), auth(event, 'other-secret')],
		[Buffer.from(event + ' '), auth(event)],
		[Buffer.from(event), undefined],
		[undefined, auth(event)],
	];
	for (const [body, header] of cases) {
		const { ctx, response } = webhookContext(body, header);
		const result = await hook(ctx);
		assert.equal(response.code, 401);
		assert.deepEqual(result, { noWebhookResponse: true });
	}
});

test('trigger drops filtered events without an execution', async () => {
	const filters = [
		{ events: ['room_finished'] },
		{ roomPrefix: 'web-' },
		{ participantKind: 'AGENT' },
	];
	for (const params of filters) {
		const { ctx, response } = webhookContext(Buffer.from(event), auth(event), params);
		assert.deepEqual(await hook(ctx), {});
		assert.equal(response.code, 200);
	}
	const { ctx } = webhookContext(Buffer.from(event), auth(event), {
		events: ['participant_left'],
		roomPrefix: 'call-',
		participantKind: 'SIP',
	});
	assert.ok((await hook(ctx)).workflowData);
});

test('trigger with a participant filter drops events that carry no participant', async () => {
	const roomEvent = JSON.stringify({ event: 'room_finished', id: 'EV_2', room: { name: 'call-1' } });
	const { ctx } = webhookContext(Buffer.from(roomEvent), auth(roomEvent), { participantKind: 'SIP' });
	assert.deepEqual(await hook(ctx), {});
});

test('digest trunk auth comes from the credential and the password never reaches the output', async () => {
	seen.length = 0;
	const [out] = await run([
		{
			resource: 'sipTrunk',
			operation: 'create',
			trunkType: 'inbound',
			trunkName: 'in',
			numbers: '+4930123',
			trunkAuthentication: 'digest',
		},
	]);
	assert.equal(seen[0].body.trunk.auth_username, 'trunk-user');
	assert.equal(seen[0].body.trunk.auth_password, 'not-a-real-password');
	assert.deepEqual(seen[0].claims.sip, { admin: true });
	assert.equal(out[0].json.sip_trunk_id, 'ST_new');
	assert.equal(out[0].json.auth_username, 'trunk-user');
	assert.equal('auth_password' in out[0].json, false);
	assert.equal(JSON.stringify(out).includes('not-a-real-password'), false);
});

test('a trunk without digest auth sends no auth fields', async () => {
	seen.length = 0;
	await run([{ resource: 'sipTrunk', operation: 'create', trunkType: 'inbound', trunkName: 'in' }]);
	assert.equal('auth_username' in seen[0].body.trunk, false);
	assert.equal('auth_password' in seen[0].body.trunk, false);
});
