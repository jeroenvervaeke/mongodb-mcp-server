import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { AtlasArgs } from "../../args.js";

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

export class PauseClusterTool extends AtlasToolBase {
    static toolName = "atlas-pause-cluster";
    public description =
        "Pause a MongoDB Atlas cluster. The cluster must reach IDLE state before it can be paused. " +
        "This tool waits for the cluster to become IDLE (up to 20 minutes), then issues the pause. " +
        "Use this after creating a cluster that should not run continuously (e.g., dev/staging environments, " +
        "clusters that only need to run during business hours).";
    static operationType: OperationType = "update";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID"),
        clusterName: AtlasArgs.clusterName().describe("Name of the cluster to pause"),
    };

    protected async execute({ projectId, clusterName }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        // Poll until the cluster reaches IDLE state
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let state: string | undefined;

        while (Date.now() < deadline) {
            const cluster = await this.apiClient.getCluster({
                params: { path: { groupId: projectId, clusterName } },
            });
            state = cluster.stateName;

            if (state === "IDLE") {
                break;
            }

            if (state === "PAUSED") {
                return {
                    content: [{ type: "text", text: `Cluster "${clusterName}" is already paused.` }],
                };
            }

            if (state === "DELETING") {
                return {
                    content: [
                        { type: "text", text: `Cluster "${clusterName}" is being deleted and cannot be paused.` },
                    ],
                };
            }

            await sleep(POLL_INTERVAL_MS);
        }

        if (state !== "IDLE") {
            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Cluster "${clusterName}" did not reach IDLE within the timeout (current state: ${state ?? "unknown"}). ` +
                            `The cluster may still be provisioning. Try pausing again once it reaches IDLE state.`,
                    },
                ],
                isError: true,
            };
        }

        await this.apiClient.updateCluster(projectId, clusterName, { paused: true });

        return {
            content: [
                {
                    type: "text",
                    text:
                        `Cluster "${clusterName}" pause has been requested. ` +
                        `The cluster will transition to PAUSED state shortly.`,
                },
            ],
        };
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
