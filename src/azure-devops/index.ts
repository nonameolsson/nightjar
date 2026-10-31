// Azure DevOps for its Adapters: one signed-in API per organization, which the Boards Tracker and
// any other Azure DevOps Adapter share, so a person signs in once.
import type { Env } from '../git.js';
import { AzureDevOpsApi } from './api.js';
import { azRunner, azureDevOpsSignIn } from './sign-in.js';

export {
	AzureDevOpsApi,
	AzureDevOpsFailure,
	fetchRequest,
	type AzureDevOpsCall,
	type AzureDevOpsReply,
	type AzureDevOpsRequest,
	type Sending
} from './api.js';
export {
	AZURE_DEVOPS_RESOURCE,
	PAT_VARIABLE,
	azRunner,
	azureDevOpsSignIn,
	type AzRunner,
	type AzureDevOpsSignIn
} from './sign-in.js';
export { AzureBoardsTracker, type AzureBoardsSettings } from './tracker.js';

// The organization's API over the network, signed in on first use with this machine's az or token.
export function openAzureDevOps(organization: string, root: string, env: Env): AzureDevOpsApi {
	return new AzureDevOpsApi(organization, azureDevOpsSignIn(azRunner(root, env), env));
}
