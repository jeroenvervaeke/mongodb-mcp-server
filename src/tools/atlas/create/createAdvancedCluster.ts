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

// Used to auto-select a sensible autoscaling ceiling when maxInstanceSize is omitted
const AUTOSCALE_MAX_DEFAULTS: Record<string, string> = {
    M10: "M40",
    M20: "M40",
    M30: "M60",
    M40: "M80",
    M50: "M80",
    M60: "M140",
    M80: "M200",
    M140: "M200",
    M200: "M300",
    M300: "M400",
    M400: "M700",
    M700: "M700",
};

const RegionConfigSchema = z.object({
    region: z.string().describe("AWS region。默认US_EAST_1。其他:US_WEST_2/US_EAST_2/EU_WEST_1/AP_SOUTHEAST_1。"),
    nodeCount: z
        .number()
        .int()
        .min(1)
        .default(3)
        .describe("本region electable数。单region→3;HA→2+2+1或3+1+1。总数奇≥5。"),
    priority: z.number().int().min(1).max(7).default(7).describe("选举优先级。主→7,次→6/5/4。各region唯一。"),
});

export class CreateAdvancedClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-advanced-cluster";
    public description =
        "建AWS Atlas专享cluster。用例:测试→M10单region;生产省钱→M30 US_EAST_1;" +
        "HA→M30+ 3 region 2+2+1。autoScaling+backup默认true。生产要暂停接调atlas-pause-cluster。";
    static operationType: OperationType = "create";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe("Atlas项目ID。无→atlas-list-clusters或bootstrap_outputs.json"),
        name: AtlasArgs.clusterName().describe("cluster名"),
        instanceSize: z
            .enum(INSTANCE_SIZES)
            .default("M10")
            .describe("测试→M10;小测试→M20;生产/HA→M30;高吞吐/大库→M40+"),
        regions: z
            .array(RegionConfigSchema)
            .min(1)
            .describe(
                "例:[{region:'US_EAST_1',nodeCount:3,priority:7}]。" + "HA例:2+2+1=5,各region≥1 electable,总数奇≥5。"
            ),
        autoScaling: z.boolean().default(true).describe("compute+disk扩缩。生产必true。"),
        maxInstanceSize: z.enum(INSTANCE_SIZES).optional().describe("扩缩上限。空→自动。须>instanceSize。"),
        backupEnabled: z.boolean().default(true).describe("云备份。生产必true。"),
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
        const resolvedMax =
            maxInstanceSize ?? (AUTOSCALE_MAX_DEFAULTS[instanceSize] as (typeof INSTANCE_SIZES)[number]);

        // Validate maxInstanceSize >= instanceSize
        if (maxInstanceSize) {
            const sizeOrder = INSTANCE_SIZES as readonly string[];
            if (sizeOrder.indexOf(maxInstanceSize) <= sizeOrder.indexOf(instanceSize)) {
                throw new Error(
                    `maxInstanceSize (${maxInstanceSize}) must be larger than instanceSize (${instanceSize}).`
                );
            }
        }

        // Validate unique priorities
        const priorities = regions.map((r) => r.priority);
        const uniquePriorities = new Set(priorities);
        if (uniquePriorities.size !== priorities.length) {
            throw new Error(
                `All region priorities must be unique. Found duplicates in: ${regions.map((r) => `${r.region}=${r.priority}`).join(", ")}`
            );
        }

        // Validate each region has at least 1 electable node
        const zeroNodeRegions = regions.filter((r) => r.nodeCount < 1);
        if (zeroNodeRegions.length > 0) {
            throw new Error(
                `Every region must have at least 1 electable node. Regions with 0 nodes: ${zeroNodeRegions.map((r) => r.region).join(", ")}`
            );
        }

        // Validate total electable nodes is odd
        const totalNodes = regions.reduce((sum, r) => sum + r.nodeCount, 0);
        if (totalNodes % 2 === 0) {
            throw new Error(
                `Total electable nodes (${totalNodes}) must be odd (3, 5, 7…) to maintain quorum. ` +
                    `Adjust nodeCount values so they sum to an odd number.`
            );
        }

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
                config.autoScaling = {
                    compute: {
                        enabled: true,
                        scaleDownEnabled: true,
                        minInstanceSize: instanceSize,
                        maxInstanceSize: resolvedMax,
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
                    zoneName: "Zone 1", // default zone name for single replication spec replica sets
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

        const totalElectable = regions.reduce((sum, r) => sum + r.nodeCount, 0);
        const isProduction = !["M10", "M20"].includes(instanceSize);

        return {
            content: [
                {
                    type: "text",
                    text:
                        `Cluster "${name}" (${instanceSize}) creation requested.\n` +
                        `Regions: ${regionSummary}\n` +
                        `Total electable nodes: ${totalElectable}\n` +
                        `Auto-scaling: ${autoScaling ? `enabled (${instanceSize} → ${resolvedMax})` : "disabled"}\n` +
                        `Backup: ${backupEnabled ? "enabled" : "disabled"}\n` +
                        `\n` +
                        `The cluster is now provisioning (stateName: CREATING).\n` +
                        (isProduction
                            ? `NEXT STEP: Call atlas-pause-cluster with projectId="${projectId}" and clusterName="${name}". ` +
                              `That tool automatically waits for the cluster to reach IDLE before pausing — call it immediately.`
                            : `Use atlas-inspect-cluster to check stateName (CREATING → IDLE).`),
                },
            ],
        };
    }
}
