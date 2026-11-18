import type {
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';

import { signToken } from '../nodes/LiveKit/token';

export class LiveKitApi implements ICredentialType {
	name = 'liveKitApi';

	displayName = 'LiveKit API';

	icon = 'file:livekit.svg' as const;

	documentationUrl = 'https://docs.livekit.io/home/server/managing-rooms/';

	properties: INodeProperties[] = [
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'string',
			default: '',
			placeholder: 'https://my-project.livekit.cloud',
			required: true,
			description: 'LiveKit Cloud project URL or the API URL of a self-hosted server',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			default: '',
			required: true,
		},
		{
			displayName: 'API Secret',
			name: 'apiSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
	];

	// Signs a list-rooms token. Used by the credential test only.
	async authenticate(
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> {
		const token = signToken(
			{ video: { roomList: true } },
			{
				apiKey: String(credentials.apiKey),
				apiSecret: String(credentials.apiSecret),
				ttlSeconds: 60,
			},
		);
		requestOptions.headers = { ...requestOptions.headers, Authorization: `Bearer ${token}` };
		return requestOptions;
	}

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.serverUrl.replace(/^ws/, "http").replace(/\\/+$/, "")}}',
			url: '/twirp/livekit.RoomService/ListRooms',
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			// Non-empty on purpose: n8n drops an empty body and Twirp rejects a missing one.
			body: { names: [] },
			json: true,
		},
	};
}
