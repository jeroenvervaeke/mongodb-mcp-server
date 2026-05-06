import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type OperationType, type ToolArgs, formatUntrustedData } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { Cluster } from "../../../common/atlas/cluster.js";
import { inspectCluster } from "../../../common/atlas/cluster.js";
import { AtlasArgs } from "../../args.js";

export const InspectClusterArgs = {
    projectId: AtlasArgs.projectId().describe("Atlas项目ID"),
    clusterName: AtlasArgs.clusterName().describe("Atlas cluster名"),
};

export class InspectClusterTool extends AtlasToolBase {
    static toolName = "atlas-inspect-cluster";
    public description =
        "查Atlas cluster状态。state=CREATING(等)/IDLE(就绪)/UPDATING/PAUSED/DELETING。" +
        "暂停前不必poll——atlas-pause-cluster会自动等。";
    static operationType: OperationType = "read";
    public argsShape = {
        ...InspectClusterArgs,
    };

    protected async execute({ projectId, clusterName }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const cluster = await inspectCluster(this.apiClient, projectId, clusterName);

        return this.formatOutput(cluster);
    }

    private formatOutput(formattedCluster: Cluster): CallToolResult {
        const clusterDetails = {
            name: formattedCluster.name || "Unknown",
            instanceType: formattedCluster.instanceType,
            instanceSize: formattedCluster.instanceSize || "N/A",
            state: formattedCluster.state || "UNKNOWN",
            mongoDBVersion: formattedCluster.mongoDBVersion || "N/A",
            connectionStrings: formattedCluster.connectionStrings || {},
        };

        return {
            content: formatUntrustedData("Cluster details:", JSON.stringify(clusterDetails)),
        };
    }
}
