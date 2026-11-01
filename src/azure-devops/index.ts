// One signed-in API per organization, shared by every Azure DevOps Adapter, so a person signs in once.
import type { Env } from '../git.js';
import { AzureDevOpsApi, fetchRequest, type AzureDevOpsRequest } from './api.js';
import { azRunner, azureDevOpsSignIn, type AzureDevOpsSignIn } from './sign-in.js';

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

export {
	AzureReposCodeHost,
	DESCRIPTION_LIMIT,
	type AzureGitRunner,
	type AzureReposSettings,
	type ReferencesAs
} from './code-host.js';

// A second organization's API passes the first one's `signIn`, so a person still signs in once.
export function openAzureDevOps(
	organization: string,
	root: string,
	env: Env,
	signIn: AzureDevOpsSignIn = azureDevOpsSignIn(azRunner(root, env), env),
	request: AzureDevOpsRequest = fetchRequest
): AzureDevOpsApi {
	return new AzureDevOpsApi(organization, signIn, request);
}
