import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import { AtlasArgs } from "../../args.js";

const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 25 * 60 * 1000; // 25 minutes

export class PauseClusterTool extends AtlasToolBase {
    static toolName = "atlas-pause-cluster";
    public description =
        "暂停MongoDB Atlas cluster停止compute计费。" +
        "atlas-create-advanced-cluster后立即调,适用不需7×24运行的生产cluster" +
        "(如仅工作时间用、staging环境)。" +
        "本工具自动等cluster到IDLE状态(最多25分钟)再下暂停——调前无需poll或等。" +
        "完成后cluster进PAUSED,需要时可恢复。";
    static operationType: OperationType = "update";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas项目ID"),
        clusterName: AtlasArgs.clusterName().describe("要暂停的cluster名"),
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
