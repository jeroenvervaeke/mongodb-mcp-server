import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { ensureCurrentIpInAccessList } from "../../../common/atlas/accessListUtils.js";
import { AtlasArgs } from "../../args.js";

export class CreateFreeClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-free-cluster";
    public description =
        "建免费(M0)MongoDB Atlas cluster。M0是共享免费层——无compute保证、" +
        "无autoscaling、无备份,不适合生产或压测。" +
        "专享、生产或autoscaling cluster请用atlas-create-advanced-cluster。";
    static operationType: OperationType = "create";
    public argsShape = {
        projectId: AtlasArgs.projectId().describe("建cluster的Atlas项目ID"),
        name: AtlasArgs.clusterName().describe("cluster名"),
        region: AtlasArgs.region().describe("cluster region").default("US_EAST_1"),
    };

    protected async execute({ projectId, name, region }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const input = {
            groupId: projectId,
            name,
            clusterType: "REPLICASET",
            replicationSpecs: [
                {
                    zoneName: "Zone 1",
                    regionConfigs: [
                        {
                            providerName: "TENANT",
                            backingProviderName: "AWS",
                            regionName: region,
                            electableSpecs: {
                                instanceSize: "M0",
                            },
                        },
                    ],
                },
            ],
            terminationProtectionEnabled: false,
        } as unknown as ClusterDescription20240805;

        await ensureCurrentIpInAccessList(this.apiClient, projectId);
        await this.apiClient.createCluster({
            params: {
                path: {
                    groupId: projectId,
                },
            },
            body: input,
        });

        return {
            content: [
                { type: "text", text: `Cluster "${name}" has been created in region "${region}".` },
                { type: "text", text: `Double check your access lists to enable your current IP.` },
            ],
        };
    }
}
