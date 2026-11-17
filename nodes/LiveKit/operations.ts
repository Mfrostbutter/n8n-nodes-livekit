import type { SipGrant, TokenClaims, VideoGrant } from './token';

// Reads a node parameter by name, with a fallback.
export type Getter = (name: string, fallback?: unknown) => unknown;

export interface ApiRequest {
	service: 'RoomService' | 'SIP' | 'AgentDispatchService';
	method: string;
	body: Record<string, unknown>;
	video?: VideoGrant;
	sip?: SipGrant;
	// Response key holding the list, for Get Many operations.
	listKeys?: string[];
}

const str = (get: Getter, name: string) => String(get(name, '') ?? '').trim();
const obj = (get: Getter, name: string) => (get(name, {}) ?? {}) as Record<string, unknown>;

// Splits a comma-separated field into trimmed values.
export function list(value: unknown): string[] {
	return String(value ?? '')
		.split(',')
		.map((v) => v.trim())
		.filter(Boolean);
}

// Parses a JSON object field into a string map.
export function stringMap(value: unknown, field: string): Record<string, string> | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	let parsed = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			throw new Error(`${field} must be a JSON object`);
		}
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${field} must be a JSON object`);
	}
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(parsed)) out[k] = String(v);
	return Object.keys(out).length ? out : undefined;
}

const seconds = (value: unknown) => (Number(value) > 0 ? `${Number(value)}s` : undefined);

// Drops undefined and empty-string values.
function compact(body: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(body)) {
		if (v !== undefined && v !== '') out[k] = v;
	}
	return out;
}

function agents(name: unknown, metadata: unknown) {
	const agentName = String(name ?? '').trim();
	if (!agentName) return undefined;
	return [compact({ agent_name: agentName, metadata: metadata as string })];
}

const roomAdmin = (room: string): VideoGrant => ({ roomAdmin: true, room });

type Builder = (get: Getter) => ApiRequest;

// One builder per resource:operation. Field names follow livekit/protocol.
export const builders: Record<string, Builder> = {
	'room:create': (get) => {
		const o = obj(get, 'roomOptions');
		return {
			service: 'RoomService',
			method: 'CreateRoom',
			video: { roomCreate: true },
			body: compact({
				name: str(get, 'roomName'),
				empty_timeout: o.emptyTimeout || undefined,
				departure_timeout: o.departureTimeout || undefined,
				max_participants: o.maxParticipants || undefined,
				metadata: o.metadata,
				agents: agents(o.agentName, o.agentMetadata),
			}),
		};
	},
	'room:getMany': (get) => {
		const names = list(get('roomNames', ''));
		return {
			service: 'RoomService',
			method: 'ListRooms',
			video: { roomList: true },
			body: names.length ? { names } : {},
			listKeys: ['rooms'],
		};
	},
	'room:delete': (get) => ({
		service: 'RoomService',
		method: 'DeleteRoom',
		video: { roomCreate: true },
		body: { room: str(get, 'roomName') },
	}),
	'room:updateMetadata': (get) => {
		const room = str(get, 'roomName');
		return {
			service: 'RoomService',
			method: 'UpdateRoomMetadata',
			video: roomAdmin(room),
			body: { room, metadata: String(get('metadata', '') ?? '') },
		};
	},
	'participant:get': (get) => {
		const room = str(get, 'roomName');
		return {
			service: 'RoomService',
			method: 'GetParticipant',
			video: roomAdmin(room),
			body: { room, identity: str(get, 'identity') },
		};
	},
	'participant:getMany': (get) => {
		const room = str(get, 'roomName');
		return {
			service: 'RoomService',
			method: 'ListParticipants',
			video: roomAdmin(room),
			body: { room },
			listKeys: ['participants'],
		};
	},
	'participant:remove': (get) => {
		const room = str(get, 'roomName');
		return {
			service: 'RoomService',
			method: 'RemoveParticipant',
			video: roomAdmin(room),
			body: { room, identity: str(get, 'identity') },
		};
	},
	'participant:update': (get) => {
		const room = str(get, 'roomName');
		const u = obj(get, 'updateFields');
		return {
			service: 'RoomService',
			method: 'UpdateParticipant',
			video: roomAdmin(room),
			body: compact({
				room,
				identity: str(get, 'identity'),
				name: u.name,
				metadata: u.metadata,
				attributes: stringMap(u.attributes, 'Attributes'),
			}),
		};
	},
	'participant:sendData': (get) => {
		const room = str(get, 'roomName');
		const o = obj(get, 'dataOptions');
		const to = list(o.destinationIdentities);
		return {
			service: 'RoomService',
			method: 'SendData',
			video: roomAdmin(room),
			body: compact({
				room,
				data: Buffer.from(String(get('data', '') ?? ''), 'utf8').toString('base64'),
				kind: o.lossy ? 'LOSSY' : 'RELIABLE',
				topic: o.topic,
				destination_identities: to.length ? to : undefined,
			}),
		};
	},
	'sip:transfer': (get) => {
		const room = str(get, 'roomName');
		const o = obj(get, 'transferOptions');
		return {
			service: 'SIP',
			method: 'TransferSIPParticipant',
			video: roomAdmin(room),
			sip: { call: true },
			body: compact({
				room_name: room,
				participant_identity: str(get, 'identity'),
				transfer_to: str(get, 'transferTo'),
				play_dialtone: o.playDialtone ? true : undefined,
				headers: stringMap(o.headers, 'Headers'),
				ringing_timeout: seconds(o.ringingTimeout),
			}),
		};
	},
	'sip:createParticipant': (get) => {
		const o = obj(get, 'callOptions');
		return {
			service: 'SIP',
			method: 'CreateSIPParticipant',
			sip: { call: true },
			body: compact({
				sip_trunk_id: str(get, 'sipTrunkId'),
				sip_call_to: str(get, 'callTo'),
				room_name: str(get, 'roomName'),
				sip_number: o.fromNumber,
				participant_identity: o.participantIdentity,
				participant_name: o.participantName,
				participant_metadata: o.participantMetadata,
				participant_attributes: stringMap(o.participantAttributes, 'Participant Attributes'),
				dtmf: o.dtmf,
				headers: stringMap(o.headers, 'Headers'),
				ringing_timeout: seconds(o.ringingTimeout),
				max_call_duration: seconds(o.maxCallDuration),
				wait_until_answered: o.waitUntilAnswered ? true : undefined,
				hide_phone_number: o.hidePhoneNumber ? true : undefined,
				krisp_enabled: o.krispEnabled ? true : undefined,
			}),
		};
	},
	'agentDispatch:create': (get) => {
		const room = str(get, 'roomName');
		return {
			service: 'AgentDispatchService',
			method: 'CreateDispatch',
			video: roomAdmin(room),
			body: compact({
				room,
				agent_name: str(get, 'agentName'),
				metadata: String(get('metadata', '') ?? ''),
			}),
		};
	},
	'agentDispatch:getMany': (get) => {
		const room = str(get, 'roomName');
		return {
			service: 'AgentDispatchService',
			method: 'ListDispatch',
			video: roomAdmin(room),
			body: compact({ room, dispatch_id: str(get, 'dispatchId') }),
			listKeys: ['agent_dispatches', 'agentDispatches'],
		};
	},
	'agentDispatch:delete': (get) => {
		const room = str(get, 'roomName');
		return {
			service: 'AgentDispatchService',
			method: 'DeleteDispatch',
			video: roomAdmin(room),
			body: { room, dispatch_id: str(get, 'dispatchId') },
		};
	},
};

export function buildRequest(resource: string, operation: string, get: Getter): ApiRequest {
	const builder = builders[`${resource}:${operation}`];
	if (!builder) throw new Error(`Unsupported operation: ${resource} ${operation}`);
	return builder(get);
}

// Claims and identity for a participant join token.
export function buildAccessToken(get: Getter): { claims: TokenClaims; identity: string } {
	const identity = str(get, 'identity');
	if (!identity) throw new Error('Identity is required');
	const o = obj(get, 'tokenOptions');
	const room = str(get, 'roomName');
	const video: VideoGrant = {
		roomJoin: true,
		canPublish: o.canPublish !== false,
		canSubscribe: o.canSubscribe !== false,
		canPublishData: o.canPublishData !== false,
	};
	if (room) video.room = room;
	const claims: TokenClaims = { video };
	if (o.name) claims.name = String(o.name);
	if (o.metadata) claims.metadata = String(o.metadata);
	const attributes = stringMap(o.attributes, 'Attributes');
	if (attributes) claims.attributes = attributes;
	const agentName = String(o.agentName ?? '').trim();
	if (agentName) {
		claims.roomConfig = {
			agents: [compact({ agentName, metadata: o.agentMetadata as string })],
		};
	}
	return { claims, identity };
}

export function twirpUrl(serverUrl: string, service: string, method: string): string {
	const base = serverUrl
		.trim()
		.replace(/^ws(s?):\/\//i, 'http$1://')
		.replace(/\/+$/, '');
	return `${base}/twirp/livekit.${service}/${method}`;
}
