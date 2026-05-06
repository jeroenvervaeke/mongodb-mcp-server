import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type ToolArgs, type OperationType } from "../../tool.js";
import { AtlasToolBase } from "../atlasTool.js";
import type { ClusterDescription20240805 } from "../../../common/atlas/openapi.js";
import { AtlasArgs } from "../../args.js";

const INSTANCE_SIZES = [
    "M10",
    "M20",
    "M30",
    "M40",
    "M50",
    "M60",
    "M80",
    "M140",
    "M200",
    "M300",
    "M400",
    "M700",
] as const;

const RegionConfigSchema = z.object({
    region: z.string().describe("AWS region name (e.g., US_EAST_1, US_WEST_2, EU_WEST_1)"),
    nodeCount: z.number().int().min(1).default(3).describe("Number of electable nodes in this region"),
    priority: z
        .number()
        .int()
        .min(1)
        .max(7)
        .default(7)
        .describe("Election priority: 7 for primary region, lower for secondaries"),
});

export class CreateAdvancedClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-advanced-cluster";
    public description =
        "Create a dedicated MongoDB Atlas replica set cluster (M10+) with full control over instance size, " +
        "auto-scaling, backup, and multi-region topology. Use this for production or development clusters " +
        "that require specific sizing, auto-scaling, or high-availability across multiple regions.";
    static operationType: OperationType = "create";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas project ID to create the cluster in"),
        name: AtlasArgs.clusterName().describe("Name of the cluster"),
        instanceSize: z
            .enum(INSTANCE_SIZES)
            .default("M10")
            .describe(
                "Dedicated instance size. M10/M20 for dev/test, M30+ for production. " +
                    "When auto-scaling is enabled this is the initial/minimum size."
            ),
        regions: z
            .array(RegionConfigSchema)
            .min(1)
            .describe(
                "Regions for the cluster. Single entry for standard deployments; " +
                    "3+ entries (each with electable nodes) for multi-region HA. " +
                    "The region with priority=7 is the primary. Secondary regions use priority 6, 5, etc."
            ),
        autoScaling: z
            .boolean()
            .default(false)
            .describe(
                "Enable compute and disk auto-scaling. When true, the cluster scales instance size " +
                    "automatically between minInstanceSize and maxInstanceSize."
            ),
        maxInstanceSize: z
            .enum(INSTANCE_SIZES)
            .optional()
            .describe(
                "Maximum instance size for auto-scaling. Required when autoScaling=true. " +
                    "Must be larger than instanceSize."
            ),
        backupEnabled: z
            .boolean()
            .default(false)
            .describe(
                "Enable continuous cloud backup (required for production clusters that need point-in-time recovery)."
            ),
    };

    protected async execute({
        projectId,
        name,
        instanceSize,
        regions,
        autoScaling,
        maxInstanceSize,
        backupEnabled,
    }: ToolArgs<typeof this.argsShape>): Promise<CallToolResult> {
        const regionConfigs = regions.map((r) => {
            const config: Record<string, unknown> = {
                providerName: "AWS",
                regionName: r.region,
                priority: r.priority,
                electableSpecs: {
                    instanceSize,
                    nodeCount: r.nodeCount,
                },
            };

            if (autoScaling) {
                const maxSize = maxInstanceSize ?? instanceSize;
                config.autoScaling = {
                    compute: {
                        enabled: true,
                        scaleDownEnabled: true,
                        minInstanceSize: instanceSize,
                        maxInstanceSize: maxSize,
                    },
                    diskGB: {
                        enabled: true,
                    },
                };
            }

            return config;
        });

        const body = {
            groupId: projectId,
            name,
            clusterType: "REPLICASET",
            replicationSpecs: [
                {
                    zoneName: "Zone 1",
                    regionConfigs,
                },
            ],
            backupEnabled,
            terminationProtectionEnabled: false,
        } as unknown as ClusterDescription20240805;

        await this.apiClient.createCluster({
            params: { path: { groupId: projectId } },
            body,
        });

        const regionSummary = regions
            .map((r) => `${r.region} (${r.nodeCount} nodes, priority=${r.priority})`)
            .join(", ");

        return {
            content: [
                {
                    type: "text",
                    text:
                        `Cluster "${name}" (${instanceSize}) creation requested.\n` +
                        `Regions: ${regionSummary}\n` +
                        `Auto-scaling: ${autoScaling ? `enabled (max: ${maxInstanceSize ?? instanceSize})` : "disabled"}\n` +
                        `Backup: ${backupEnabled ? "enabled" : "disabled"}\n` +
                        `The cluster is now provisioning. Use atlas-inspect-cluster to check its state.`,
                },
            ],
        };
    }
}
