export interface EventFilter {
	events: string[];
	roomPrefix: string;
	participantKind: string;
}

export interface LiveKitEvent {
	event?: string;
	id?: string;
	room?: { name?: string };
	participant?: { kind?: string | number };
	[key: string]: unknown;
}

// Participant kinds by enum number, for servers that send numbers.
const KINDS = ['STANDARD', 'INGRESS', 'EGRESS', 'SIP', 'AGENT'];

export function participantKind(event: LiveKitEvent): string {
	const kind = event.participant?.kind;
	if (typeof kind === 'number') return KINDS[kind] ?? String(kind);
	// An omitted kind is the proto default.
	if (kind === undefined && event.participant) return 'STANDARD';
	return String(kind ?? '');
}

// True when the event passes the trigger's filters.
export function matches(event: LiveKitEvent, filter: EventFilter): boolean {
	if (filter.events.length && !filter.events.includes(String(event.event ?? ''))) return false;
	if (filter.roomPrefix && !String(event.room?.name ?? '').startsWith(filter.roomPrefix)) {
		return false;
	}
	if (filter.participantKind && filter.participantKind !== 'any') {
		if (participantKind(event) !== filter.participantKind) return false;
	}
	return true;
}
