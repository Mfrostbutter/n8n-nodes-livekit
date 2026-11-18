// Runs the node's request builders against a live LiveKit server.
// Usage: LIVEKIT_URL=... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... node scripts/smoke.js
const {
	buildRequest,
	buildAccessToken,
	redact,
	twirpUrl,
	withTrunkAuth,
} = require('../dist/nodes/LiveKit/operations.js');
const { signToken, verifyToken } = require('../dist/nodes/LiveKit/token.js');

const url = process.env.LIVEKIT_URL;
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
if (!url || !apiKey || !apiSecret) {
	console.error('Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET');
	process.exit(2);
}

const room = `smoke-${Date.now()}`;
const getter = (params) => (name, fallback) => (name in params ? params[name] : fallback);
const results = [];

async function call(resource, operation, params, secret = apiSecret, auth) {
	let request = buildRequest(resource, operation, getter(params));
	if (auth) request = withTrunkAuth(request, auth);
	const token = signToken(
		{ video: request.video ?? {}, ...(request.sip ? { sip: request.sip } : {}) },
		{ apiKey, apiSecret: secret, ttlSeconds: 60 },
	);
	const res = await fetch(twirpUrl(url, request.service, request.method), {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(request.body),
	});
	const text = await res.text();
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = { raw: text.slice(0, 200) };
	}
	return { status: res.status, json, request };
}

async function step(label, resource, operation, params, expect = (r) => r.status === 200) {
	try {
		const r = await call(resource, operation, params);
		const ok = expect(r);
		const keys = r.request.listKeys
			? `list key: ${r.request.listKeys.find((k) => Array.isArray(r.json[k])) ?? 'NONE'}`
			: `keys: ${Object.keys(r.json).slice(0, 6).join(',')}`;
		const detail = r.status === 200 ? keys : `${r.json.code}: ${r.json.msg}`;
		results.push({ label, ok, status: r.status, detail });
		return r;
	} catch (error) {
		results.push({ label, ok: false, status: 'ERR', detail: error.message });
		return { status: 0, json: {} };
	}
}

(async () => {
	await step('room create', 'room', 'create', {
		roomName: room,
		roomOptions: { metadata: 'm0', emptyTimeout: 60 },
	});
	const rooms = await step('room getMany (filter)', 'room', 'getMany', { roomNames: room });
	const found = (rooms.json.rooms ?? []).find((r) => r.name === room);
	results.push({
		label: 'room visible in list',
		ok: !!found,
		status: '-',
		detail: found ? `fields: ${Object.keys(found).slice(0, 8).join(',')}` : 'not found',
	});
	const meta = await step('room updateMetadata', 'room', 'updateMetadata', {
		roomName: room,
		metadata: 'm1',
	});
	results.push({
		label: 'metadata applied',
		ok: meta.json.metadata === 'm1',
		status: '-',
		detail: `metadata=${meta.json.metadata}`,
	});
	await step('participant getMany', 'participant', 'getMany', { roomName: room });
	await step('participant get (absent)', 'participant', 'get', { roomName: room, identity: 'nobody' }, (r) => r.status === 404);
	await step('participant sendData', 'participant', 'sendData', {
		roomName: room,
		data: '{"type":"say","text":"hi"}',
		dataOptions: { topic: 'n8n.control' },
	});
	const dispatch = await step('agentDispatch create', 'agentDispatch', 'create', {
		roomName: room,
		agentName: 'smoke-agent',
		metadata: '{"k":1}',
	});
	await step('agentDispatch getMany', 'agentDispatch', 'getMany', { roomName: room });
	if (dispatch.json.id) {
		await step('agentDispatch delete', 'agentDispatch', 'delete', {
			roomName: room,
			dispatchId: dispatch.json.id,
		});
	}

	// SIP needs livekit-sip and Redis. Without them these report how the server answers.
	const sipOk = (r) => r.status === 200;
	await step('sipTrunk getMany inbound', 'sipTrunk', 'getMany', { trunkType: 'inbound' }, sipOk);
	await step('sipDispatchRule getMany', 'sipDispatchRule', 'getMany', {}, sipOk);
	// Trunk and dispatch rule lifecycle. Skipped when the SIP service is not connected.
	const probe = await call('sipTrunk', 'getMany', { trunkType: 'inbound' });
	if (probe.status === 200) {
		const number = `+1555${String(Date.now()).slice(-7)}`;
		const created = await call(
			'sipTrunk',
			'create',
			{
				trunkType: 'inbound',
				trunkName: `${room}-in`,
				numbers: number,
				trunkOptions: {
					includeHeaders: 'SIP_ALL_HEADERS',
					headersToAttributes: '{"User-to-User":"uui"}',
				},
			},
			apiSecret,
			{ username: 'smoke-user', password: 'smoke-not-a-real-password' },
		);
		const trunkId = created.json.sip_trunk_id;
		results.push({
			label: 'sipTrunk create inbound with digest auth',
			ok: created.status === 200 && !!trunkId,
			status: created.status,
			detail:
				created.status === 200
					? `id=${trunkId} echoes password: ${'auth_password' in created.json}; redacted: ${!('auth_password' in redact(created.json))}`
					: `${created.json.code}: ${created.json.msg}`,
		});
		const outbound = await step('sipTrunk create outbound', 'sipTrunk', 'create', {
			trunkType: 'outbound',
			trunkName: `${room}-out`,
			address: 'sip.example.com',
			numbers: number,
			trunkOptions: { transport: 'SIP_TRANSPORT_TLS' },
		});
		const rule = await step('sipDispatchRule create (individual + agent)', 'sipDispatchRule', 'create', {
			ruleType: 'individual',
			roomPrefix: 'call-',
			ruleOptions: { name: `${room}-rule`, trunkIds: trunkId, agentName: 'smoke-agent' },
		});
		const ruleId = rule.json.sip_dispatch_rule_id;
		results.push({
			label: 'dispatch rule stored as sent',
			ok:
				rule.json.rule?.dispatch_rule_individual?.room_prefix === 'call-' &&
				(rule.json.trunk_ids ?? [])[0] === trunkId &&
				rule.json.room_config?.agents?.[0]?.agent_name === 'smoke-agent',
			status: '-',
			detail: JSON.stringify({ rule: rule.json.rule, trunk_ids: rule.json.trunk_ids, agents: rule.json.room_config?.agents }).slice(0, 150),
		});
		const listed = await call('sipTrunk', 'getMany', { trunkType: 'inbound', trunkIds: trunkId });
		const item = (listed.json.items ?? [])[0] ?? {};
		results.push({
			label: 'trunk list by id returns header mapping',
			ok: item.sip_trunk_id === trunkId && item.headers_to_attributes?.['User-to-User'] === 'uui',
			status: listed.status,
			detail: `include_headers=${item.include_headers} numbers=${item.numbers}`,
		});
		if (ruleId) await step('sipDispatchRule delete', 'sipDispatchRule', 'delete', { sipDispatchRuleId: ruleId });
		if (trunkId) await step('sipTrunk delete inbound', 'sipTrunk', 'delete', { sipTrunkId: trunkId });
		const outId = outbound.json.sip_trunk_id;
		if (outId) await step('sipTrunk delete outbound', 'sipTrunk', 'delete', { sipTrunkId: outId });
	}

	await step('sip transfer (no SIP participant)', 'sip', 'transfer', {
		roomName: room,
		identity: 'nobody',
		transferTo: 'tel:+15105550100',
	}, (r) => r.status !== 200 && r.status !== 401);

	// Auth
	const bad = await call('room', 'getMany', {}, 'wrong-secret');
	results.push({
		label: 'wrong secret refused',
		ok: bad.status === 401,
		status: bad.status,
		detail: `${bad.json.code}: ${bad.json.msg}`,
	});
	const narrow = signToken({ video: { roomList: true } }, { apiKey, apiSecret, ttlSeconds: 60 });
	const denied = await fetch(twirpUrl(url, 'RoomService', 'DeleteRoom'), {
		method: 'POST',
		headers: { Authorization: `Bearer ${narrow}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ room }),
	});
	results.push({
		label: 'list-only token cannot delete',
		ok: denied.status === 401 || denied.status === 403,
		status: denied.status,
		detail: (await denied.text()).slice(0, 80),
	});

	const { claims, identity } = buildAccessToken(getter({ identity: 'tester', roomName: room }));
	const join = signToken(claims, { apiKey, apiSecret, ttlSeconds: 120, identity });
	const validate = await fetch(`${url.replace(/\/+$/, '')}/rtc/validate?access_token=${join}`);
	results.push({
		label: 'access token accepted by the server',
		ok: validate.status === 200 && !!verifyToken(join, { apiKey, apiSecret }),
		status: validate.status,
		detail: (await validate.text()).slice(0, 60),
	});

	await step('room delete', 'room', 'delete', { roomName: room });
	const after = await call('room', 'getMany', { roomNames: room });
	results.push({
		label: 'room gone after delete',
		ok: !(after.json.rooms ?? []).some((r) => r.name === room),
		status: after.status,
		detail: `rooms returned: ${(after.json.rooms ?? []).length}`,
	});

	for (const r of results) {
		console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${String(r.status).padEnd(4)} ${r.label.padEnd(36)} ${r.detail}`);
	}
	const failed = results.filter((r) => !r.ok).length;
	console.log(`RESULT: ${failed ? `${failed} failed` : 'ok'} (${results.length} checks)`);
	process.exit(failed ? 1 : 0);
})();
