import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { properties } from './description';
import { buildAccessToken, buildRequest, twirpUrl } from './operations';
import { signToken } from './token';

// Lifetime of the per-request API token.
const API_TOKEN_TTL = 60;

export class LiveKit implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'LiveKit',
		name: 'liveKit',
		icon: 'file:livekit.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Manage LiveKit rooms, participants, SIP calls, agent dispatch and access tokens',
		defaults: { name: 'LiveKit' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'liveKitApi', required: true }],
		properties,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		const credentials = await this.getCredentials('liveKitApi');
		const apiKey = String(credentials.apiKey);
		const apiSecret = String(credentials.apiSecret);
		const serverUrl = String(credentials.serverUrl);

		for (let i = 0; i < items.length; i++) {
			const get = (name: string, fallback?: unknown) => this.getNodeParameter(name, i, fallback);
			try {
				const resource = String(get('resource'));
				const operation = String(get('operation'));

				if (resource === 'accessToken') {
					const { claims, identity } = buildAccessToken(get);
					const ttlSeconds = Number(get('ttl', 3600)) || 3600;
					const token = signToken(claims, { apiKey, apiSecret, ttlSeconds, identity });
					out.push({
						json: {
							token,
							identity,
							room: claims.video?.room ?? null,
							serverUrl,
							expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
						},
						pairedItem: { item: i },
					});
					continue;
				}

				const request = buildRequest(resource, operation, get);
				const token = signToken(
					{ video: request.video ?? {}, ...(request.sip ? { sip: request.sip } : {}) },
					{ apiKey, apiSecret, ttlSeconds: API_TOKEN_TTL },
				);

				let response: IDataObject;
				try {
					response = (await this.helpers.httpRequest({
						method: 'POST',
						url: twirpUrl(serverUrl, request.service, request.method),
						headers: {
							Authorization: `Bearer ${token}`,
							'Content-Type': 'application/json',
						},
						body: request.body,
						json: true,
						timeout: (Number(get('requestTimeout', 30)) || 30) * 1000,
					})) as IDataObject;
				} catch (error) {
					throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
				}

				if (request.listKeys) {
					const key = request.listKeys.find((k) => Array.isArray(response?.[k]));
					let rows = (key ? response[key] : []) as IDataObject[];
					if (!get('returnAll', true)) rows = rows.slice(0, Number(get('limit', 50)));
					for (const row of rows) out.push({ json: row, pairedItem: { item: i } });
					continue;
				}

				const json =
					response && typeof response === 'object' && Object.keys(response).length
						? response
						: { success: true };
				out.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				if (error instanceof NodeApiError) throw error;
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [out];
	}
}
