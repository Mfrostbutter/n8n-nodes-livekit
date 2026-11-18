import type {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

import { verifyWebhook } from './token';
import { matches, participantKind, type LiveKitEvent } from './webhook';

export class LiveKitTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'LiveKit Trigger',
		name: 'liveKitTrigger',
		icon: 'file:livekit.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ") || "all events"}}',
		description: 'Starts the workflow on LiveKit webhook events',
		defaults: { name: 'LiveKit Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'liveKitApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				responseData: 'noData',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'Add the webhook URL to the LiveKit server config (webhook.urls) or the LiveKit Cloud project settings. LiveKit has no API to register it. Use the production URL once the workflow is active.',
				name: 'setupNotice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				default: [],
				description: 'Events that start the workflow. Empty means every event.',
				options: [
					{ name: 'Agent Job Ended', value: 'agent_job_ended' },
					{ name: 'Agent Job Pending', value: 'agent_job_pending' },
					{ name: 'Agent Job Started', value: 'agent_job_started' },
					{ name: 'Egress Ended', value: 'egress_ended' },
					{ name: 'Egress Started', value: 'egress_started' },
					{ name: 'Egress Updated', value: 'egress_updated' },
					{ name: 'Ingress Ended', value: 'ingress_ended' },
					{ name: 'Ingress Started', value: 'ingress_started' },
					{ name: 'Participant Connection Aborted', value: 'participant_connection_aborted' },
					{ name: 'Participant Joined', value: 'participant_joined' },
					{ name: 'Participant Left', value: 'participant_left' },
					{ name: 'Room Finished', value: 'room_finished' },
					{ name: 'Room Started', value: 'room_started' },
					{ name: 'Track Published', value: 'track_published' },
					{ name: 'Track Unpublished', value: 'track_unpublished' },
				],
			},
			{
				displayName: 'Room Name Prefix',
				name: 'roomPrefix',
				type: 'string',
				default: '',
				description: 'Only events from rooms whose name starts with this value',
			},
			{
				displayName: 'Participant Kind',
				name: 'participantKind',
				type: 'options',
				default: 'any',
				description: 'Only participant and track events from this kind of participant',
				options: [
					{ name: 'Agent', value: 'AGENT' },
					{ name: 'Any', value: 'any' },
					{ name: 'Egress', value: 'EGRESS' },
					{ name: 'Ingress', value: 'INGRESS' },
					{ name: 'SIP', value: 'SIP' },
					{ name: 'Standard', value: 'STANDARD' },
				],
			},
		],
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const res = this.getResponseObject();
		const credentials = await this.getCredentials('liveKitApi');

		const reject = (message: string): IWebhookResponseData => {
			res.status(401).json({ message });
			return { noWebhookResponse: true };
		};

		// LiveKit posts application/webhook+json, which n8n does not parse.
		const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
		if (!rawBody?.length) return reject('Empty body');

		try {
			verifyWebhook(rawBody, req.headers.authorization, {
				apiKey: String(credentials.apiKey),
				apiSecret: String(credentials.apiSecret),
			});
		} catch {
			return reject('Webhook verification failed');
		}

		let event: LiveKitEvent;
		try {
			event = JSON.parse(rawBody.toString('utf8'));
		} catch {
			res.status(400).json({ message: 'Body is not JSON' });
			return { noWebhookResponse: true };
		}

		const filter = {
			events: this.getNodeParameter('events', []) as string[],
			roomPrefix: String(this.getNodeParameter('roomPrefix', '') ?? ''),
			participantKind: String(this.getNodeParameter('participantKind', 'any')),
		};
		const needsParticipant = filter.participantKind !== 'any';
		if (!matches(event, filter) || (needsParticipant && !event.participant)) return {};

		const json: IDataObject = { ...(event as IDataObject), eventId: event.id ?? null };
		if (event.participant) json.participantKind = participantKind(event);
		return { workflowData: [this.helpers.returnJsonArray(json)] };
	}
}
