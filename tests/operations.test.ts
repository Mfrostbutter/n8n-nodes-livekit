import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	buildAccessToken,
	buildRequest,
	builders,
	redact,
	twirpUrl,
	withTrunkAuth,
	type Getter,
} from '../nodes/LiveKit/operations';
import { matches, participantKind } from '../nodes/LiveKit/webhook';

const getter =
	(params: Record<string, unknown>): Getter =>
	(name, fallback) =>
		name in params ? params[name] : fallback;

test('transfer sends the Refer-To verbatim with room admin and sip call grants', () => {
	const referTo = 'sip:+4930123@trunk.example.com?User-to-User=313b61%3Bencoding%3Dhex';
	const r = buildRequest(
		'sip',
		'transfer',
		getter({
			roomName: 'call-1',
			identity: 'sip_+4930',
			transferTo: referTo,
			transferOptions: { ringingTimeout: 20, headers: '{"X-Case":"42"}' },
		}),
	);
	assert.equal(r.service, 'SIP');
	assert.equal(r.method, 'TransferSIPParticipant');
	assert.deepEqual(r.video, { roomAdmin: true, room: 'call-1' });
	assert.deepEqual(r.sip, { call: true });
	assert.deepEqual(r.body, {
		room_name: 'call-1',
		participant_identity: 'sip_+4930',
		transfer_to: referTo,
		headers: { 'X-Case': '42' },
		ringing_timeout: '20s',
	});
});

test('outbound call needs only the sip call grant', () => {
	const r = buildRequest(
		'sip',
		'createParticipant',
		getter({
			roomName: 'out-1',
			sipTrunkId: 'ST_x',
			callTo: '+15105550100',
			callOptions: { waitUntilAnswered: true, participantIdentity: 'callee' },
		}),
	);
	assert.equal(r.video, undefined);
	assert.deepEqual(r.sip, { call: true });
	assert.deepEqual(r.body, {
		sip_trunk_id: 'ST_x',
		sip_call_to: '+15105550100',
		room_name: 'out-1',
		participant_identity: 'callee',
		wait_until_answered: true,
	});
});

test('grants per room operation', () => {
	const get = getter({ roomName: 'r1', identity: 'p1', metadata: 'm' });
	assert.deepEqual(buildRequest('room', 'create', get).video, { roomCreate: true });
	assert.deepEqual(buildRequest('room', 'delete', get).video, { roomCreate: true });
	assert.deepEqual(buildRequest('room', 'getMany', get).video, { roomList: true });
	for (const key of Object.keys(builders)) {
		if (key.startsWith('participant:') || key.startsWith('agentDispatch:')) {
			const [resource, operation] = key.split(':');
			const r = buildRequest(resource, operation, get);
			assert.deepEqual(r.video, { roomAdmin: true, room: 'r1' }, key);
			assert.equal(r.sip, undefined, key);
		}
	}
});

test('room create carries an agent dispatch and drops empty options', () => {
	const r = buildRequest(
		'room',
		'create',
		getter({ roomName: 'r1', roomOptions: { agentName: 'booking', maxParticipants: 0 } }),
	);
	assert.deepEqual(r.body, { name: 'r1', agents: [{ agent_name: 'booking' }] });
});

test('room get many filters by name', () => {
	const r = buildRequest('room', 'getMany', getter({ roomNames: 'a, b,' }));
	assert.deepEqual(r.body, { names: ['a', 'b'] });
	assert.deepEqual(r.listKeys, ['rooms']);
});

test('send data encodes the payload as base64', () => {
	const r = buildRequest(
		'participant',
		'sendData',
		getter({ roomName: 'r1', data: 'hällo', dataOptions: { topic: 'control' } }),
	);
	assert.equal(Buffer.from(String(r.body.data), 'base64').toString('utf8'), 'hällo');
	assert.equal(r.body.kind, 'RELIABLE');
	assert.equal(r.body.topic, 'control');
});

test('invalid JSON map fields are refused', () => {
	assert.throws(
		() =>
			buildRequest(
				'participant',
				'update',
				getter({ roomName: 'r', identity: 'p', updateFields: { attributes: '[1]' } }),
			),
		/JSON object/,
	);
});

test('unknown operation is refused', () => {
	assert.throws(() => buildRequest('room', 'nope', getter({})), /Unsupported/);
});

test('access token claims', () => {
	const { claims, identity } = buildAccessToken(
		getter({
			identity: 'tester',
			roomName: 'r1',
			tokenOptions: { canPublishData: false, agentName: 'booking', attributes: '{"vin":"X"}' },
		}),
	);
	assert.equal(identity, 'tester');
	assert.deepEqual(claims.video, {
		roomJoin: true,
		room: 'r1',
		canPublish: true,
		canSubscribe: true,
		canPublishData: false,
	});
	assert.deepEqual(claims.attributes, { vin: 'X' });
	assert.deepEqual(claims.roomConfig, { agents: [{ agentName: 'booking' }] });
	assert.throws(() => buildAccessToken(getter({ identity: ' ' })), /Identity/);
});

test('twirp url from https, wss and trailing slash', () => {
	const want = 'https://x.livekit.cloud/twirp/livekit.SIP/TransferSIPParticipant';
	assert.equal(twirpUrl('https://x.livekit.cloud/', 'SIP', 'TransferSIPParticipant'), want);
	assert.equal(twirpUrl('wss://x.livekit.cloud', 'SIP', 'TransferSIPParticipant'), want);
});

test('trigger filters', () => {
	const sipJoin = { event: 'participant_joined', room: { name: 'call-1' }, participant: { kind: 'SIP' } };
	const any = { events: [], roomPrefix: '', participantKind: 'any' };
	assert.equal(matches(sipJoin, any), true);
	assert.equal(matches(sipJoin, { ...any, events: ['room_finished'] }), false);
	assert.equal(matches(sipJoin, { ...any, roomPrefix: 'call-' }), true);
	assert.equal(matches(sipJoin, { ...any, roomPrefix: 'web-' }), false);
	assert.equal(matches(sipJoin, { ...any, participantKind: 'SIP' }), true);
	assert.equal(matches(sipJoin, { ...any, participantKind: 'AGENT' }), false);
	assert.equal(participantKind({ participant: { kind: 3 } }), 'SIP');
	assert.equal(participantKind({ participant: {} }), 'STANDARD');
});

test('inbound trunk for a Genesys-style carrier', () => {
	const r = buildRequest(
		'sipTrunk',
		'create',
		getter({
			trunkType: 'inbound',
			trunkName: 'genesys-in',
			numbers: '+4930123, +4930124',
			trunkOptions: {
				allowedAddresses: '203.0.113.0/24',
				includeHeaders: 'SIP_ALL_HEADERS',
				headersToAttributes: '{"User-to-User":"uui"}',
				mediaEncryption: 'SIP_MEDIA_ENCRYPT_REQUIRE',
			},
		}),
	);
	assert.equal(r.method, 'CreateSIPInboundTrunk');
	assert.deepEqual(r.sip, { admin: true });
	assert.equal(r.video, undefined);
	assert.deepEqual(r.body, {
		trunk: {
			name: 'genesys-in',
			numbers: ['+4930123', '+4930124'],
			allowed_addresses: ['203.0.113.0/24'],
			include_headers: 'SIP_ALL_HEADERS',
			headers_to_attributes: { 'User-to-User': 'uui' },
			media: { encryption: 'SIP_MEDIA_ENCRYPT_REQUIRE' },
		},
	});
});

test('outbound trunk carries address and transport', () => {
	const r = buildRequest(
		'sipTrunk',
		'create',
		getter({
			trunkType: 'outbound',
			trunkName: 'out',
			address: 'sip.example.com',
			numbers: '+15105550100',
			trunkOptions: { transport: 'SIP_TRANSPORT_TLS' },
		}),
	);
	assert.equal(r.method, 'CreateSIPOutboundTrunk');
	assert.deepEqual(r.body, {
		trunk: {
			name: 'out',
			address: 'sip.example.com',
			numbers: ['+15105550100'],
			transport: 'SIP_TRANSPORT_TLS',
		},
	});
});

test('trunk list picks the method by type and delete sends the id', () => {
	const inbound = buildRequest('sipTrunk', 'getMany', getter({ trunkType: 'inbound' }));
	assert.equal(inbound.method, 'ListSIPInboundTrunk');
	assert.deepEqual(inbound.body, {});
	assert.deepEqual(inbound.listKeys, ['items']);
	const outbound = buildRequest(
		'sipTrunk',
		'getMany',
		getter({ trunkType: 'outbound', trunkIds: 'ST_1,ST_2' }),
	);
	assert.equal(outbound.method, 'ListSIPOutboundTrunk');
	assert.deepEqual(outbound.body, { trunk_ids: ['ST_1', 'ST_2'] });
	const del = buildRequest('sipTrunk', 'delete', getter({ sipTrunkId: 'ST_1' }));
	assert.equal(del.method, 'DeleteSIPTrunk');
	assert.deepEqual(del.body, { sip_trunk_id: 'ST_1' });
	assert.deepEqual(del.sip, { admin: true });
});

test('dispatch rule shapes: individual with agent, direct, callee', () => {
	const individual = buildRequest(
		'sipDispatchRule',
		'create',
		getter({
			ruleType: 'individual',
			roomPrefix: 'call-',
			ruleOptions: { name: 'race', trunkIds: 'ST_1', agentName: 'booking', agentMetadata: '{"m":1}' },
		}),
	);
	assert.equal(individual.method, 'CreateSIPDispatchRule');
	assert.deepEqual(individual.sip, { admin: true });
	assert.deepEqual(individual.body, {
		dispatch_rule: {
			rule: { dispatch_rule_individual: { room_prefix: 'call-' } },
			name: 'race',
			trunk_ids: ['ST_1'],
			room_config: { agents: [{ agent_name: 'booking', metadata: '{"m":1}' }] },
		},
	});
	const direct = buildRequest(
		'sipDispatchRule',
		'create',
		getter({ ruleType: 'direct', ruleRoomName: 'lobby' }),
	);
	assert.deepEqual(direct.body, {
		dispatch_rule: { rule: { dispatch_rule_direct: { room_name: 'lobby' } } },
	});
	const callee = buildRequest(
		'sipDispatchRule',
		'create',
		getter({ ruleType: 'callee', roomPrefix: 'num-' }),
	);
	assert.deepEqual(callee.body, {
		dispatch_rule: { rule: { dispatch_rule_callee: { room_prefix: 'num-' } } },
	});
});

test('dispatch rule list and delete', () => {
	const many = buildRequest('sipDispatchRule', 'getMany', getter({ ruleIds: 'SDR_1' }));
	assert.equal(many.method, 'ListSIPDispatchRule');
	assert.deepEqual(many.body, { dispatch_rule_ids: ['SDR_1'] });
	assert.deepEqual(many.listKeys, ['items']);
	const del = buildRequest('sipDispatchRule', 'delete', getter({ sipDispatchRuleId: 'SDR_1' }));
	assert.deepEqual(del.body, { sip_dispatch_rule_id: 'SDR_1' });
});

test('trunk auth is added to the trunk message, inbound and outbound', () => {
	const auth = { username: 'trunk-user', password: 'not-a-real-password' };
	for (const trunkType of ['inbound', 'outbound']) {
		const base = buildRequest(
			'sipTrunk',
			'create',
			getter({ trunkType, trunkName: 't', address: 'sip.example.com' }),
		);
		const r = withTrunkAuth(base, auth);
		const trunk = r.body.trunk as Record<string, unknown>;
		assert.equal(trunk.auth_username, 'trunk-user');
		assert.equal(trunk.auth_password, 'not-a-real-password');
		assert.equal(trunk.name, 't');
		assert.equal((base.body.trunk as Record<string, unknown>).auth_password, undefined);
	}
});

test('trunk auth is refused when incomplete or on a non-trunk request', () => {
	const trunk = buildRequest('sipTrunk', 'create', getter({ trunkName: 't' }));
	assert.throws(() => withTrunkAuth(trunk, { username: 'u', password: '' }), /incomplete/);
	const room = buildRequest('room', 'delete', getter({ roomName: 'r' }));
	assert.throws(() => withTrunkAuth(room, { username: 'u', password: 'p' }), /trunk creation/);
});

test('redact strips trunk passwords at any depth and keeps the rest', () => {
	const out = redact({
		items: [{ sip_trunk_id: 'ST_1', auth_username: 'u', auth_password: 'p' }],
		trunk: { authPassword: 'p', name: 'n' },
	});
	assert.deepEqual(out, {
		items: [{ sip_trunk_id: 'ST_1', auth_username: 'u' }],
		trunk: { name: 'n' },
	});
});
