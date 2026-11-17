import type { ICredentialType, INodeProperties } from 'n8n-workflow';

// Digest authentication for a LiveKit SIP trunk.
export class LiveKitSipTrunkAuthApi implements ICredentialType {
	name = 'liveKitSipTrunkAuthApi';

	displayName = 'LiveKit SIP Trunk Auth API';

	icon = 'file:livekit.svg' as const;

	documentationUrl = 'https://docs.livekit.io/sip/trunk-inbound/';

	properties: INodeProperties[] = [
		{
			displayName:
				'Username and password a SIP trunk uses for digest authentication. Inbound: what the caller must present. Outbound: what LiveKit presents to the provider. There is no connection test; the values are sent when a trunk is created.',
			name: 'notice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
	];
}
