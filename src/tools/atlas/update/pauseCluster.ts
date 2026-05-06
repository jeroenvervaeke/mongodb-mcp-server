import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { AtlasArgs } from "../../args.js";

const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes

export class PauseClusterTool extends AtlasToolBase {
    static toolName = "atlas-pause-cluster";
    public description = "止群。候IDLE。";
    static operationType: OperationType = "update";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("项"),
        clusterName: AtlasArgs.clusterName().describe("名"),
    };

    protected async execute({ projectId, clusterName }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let state: string | undefined;
        let pollCount = 0;

        while (Date.now() < deadline) {
            const cluster = await this.apiClient.getCluster({
                params: { path: { groupId: projectId, clusterName } },
            });
            state = cluster.stateName;
            pollCount++;

            if (state === "IDLE") {
                break;
            }

            if (state === "PAUSED") {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Cluster "${clusterName}" is already paused. No action needed.`,
                        },
                    ],
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
                            `Cluster "${clusterName}" did not reach IDLE after ${pollCount} polls ` +
                            `(current state: ${state ?? "unknown"}). ` +
                            `Call atlas-pause-cluster again once the cluster finishes provisioning.`,
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
                        `Cluster "${clusterName}" has been paused successfully. ` +
                        `Compute billing is now stopped. The cluster reached IDLE after ${pollCount} state check(s). ` +
                        `Task complete.`,
                },
            ],
        };
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
