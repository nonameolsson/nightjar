// A project's process, and the work item types it gives a Feature and a Ticket.
import { z } from 'zod';
import type { AzureDevOpsApi } from './api.js';

export interface WorkItemTypes {
	readonly featureType: string;
	readonly ticketType: string;
}

// the system processes by name, in lower case
const SYSTEM_TYPES: ReadonlyMap<string, WorkItemTypes> = new Map([
	['agile', { featureType: 'Feature', ticketType: 'User Story' }],
	['scrum', { featureType: 'Feature', ticketType: 'Product Backlog Item' }],
	['basic', { featureType: 'Epic', ticketType: 'Issue' }],
	['cmmi', { featureType: 'Feature', ticketType: 'Requirement' }]
]);

const ProjectSchema = z.looseObject({
	capabilities: z.looseObject({
		processTemplate: z.looseObject({ templateTypeId: z.string().min(1) })
	})
});

const ProcessSchema = z.looseObject({
	name: z.string(),
	// system, inherited, or custom for one uploaded as XML
	customizationType: z.string(),
	parentProcessTypeId: z.string().optional()
});

export interface ProjectProcess {
	readonly name: string;
	// null when the process is no system one and inherits from none
	readonly types: WorkItemTypes | null;
}

// The process of `project`, with the types of the system process it is or inherits from.
export async function projectProcess(
	api: AzureDevOpsApi,
	project: string
): Promise<ProjectProcess> {
	const get = <T>(what: string, path: string, schema: z.ZodType<T>) =>
		api.parse(what, { method: 'GET', url: api.at(path) }, schema);
	const processOf = (id: string) =>
		get(
			`read the process of ${project}`,
			`_apis/work/processes/${encodeURIComponent(id)}?api-version=7.1`,
			ProcessSchema
		);
	const { capabilities } = await get(
		`read the project ${project}`,
		`_apis/projects/${encodeURIComponent(project)}?includeCapabilities=true&api-version=7.1`,
		ProjectSchema
	);
	const own = await processOf(capabilities.processTemplate.templateTypeId);
	const system =
		own.customizationType === 'inherited' && own.parentProcessTypeId !== undefined
			? await processOf(own.parentProcessTypeId)
			: own;
	const types =
		system.customizationType === 'system'
			? (SYSTEM_TYPES.get(system.name.toLowerCase()) ?? null)
			: null;
	return { name: own.name, types };
}
