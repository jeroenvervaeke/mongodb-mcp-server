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
    region: z
        .string()
        .describe(
            "AWS region name. Common values: US_EAST_1 (N. Virginia, lowest cost, primary app region), " +
                "US_WEST_2 (Oregon), US_EAST_2 (Ohio), EU_WEST_1 (Ireland), AP_SOUTHEAST_1 (Singapore). " +
                "Use US_EAST_1 for single-region production unless told otherwise."
        ),
    nodeCount: z
        .number()
        .int()
        .min(1)
        .default(3)
        .describe(
            "Electable nodes in this region. Use 3 for single-region. " +
                "For 3-region HA distribute as 2+2+1 (5 total) or 3+1+1 (5 total). " +
                "Total electable nodes across all regions must be odd (3, 5, 7) to guarantee quorum."
        ),
    priority: z
        .number()
        .int()
        .min(1)
        .max(7)
        .default(7)
        .describe(
            "Election priority. 7 = primary region (receives all writes). " +
                "Secondary regions use 6, 5, 4 … in descending order. " +
                "Every region must have a unique priority."
        ),
});

export class CreateAdvancedClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-advanced-cluster";
    public description =
        "Create a dedicated MongoDB Atlas replica set cluster on AWS. " +
        "Covers all production patterns: " +
        "(1) Dev/test: M10, single region, autoScaling=true; " +
        "(2) Budget production (single-region): M30, US_EAST_1, autoScaling=true, backupEnabled=true; " +
        "(3) High-availability production (multi-region): M30+, 3 AWS regions (e.g. US_EAST_1 + US_WEST_2 + US_EAST_2), " +
        "2+2+1 node distribution (5 total electable nodes), autoScaling=true, backupEnabled=true. " +
        "After creating a production cluster that should be paused, call atlas-pause-cluster next.";
    static operationType: OperationType = "create";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe(
            "Atlas project ID (read from bootstrap_outputs.json with jq -r '.project_id.value')"
        ),
        name: AtlasArgs.clusterName().describe("Cluster name"),
        instanceSize: z
            .enum(INSTANCE_SIZES)
            .default("M10")
            .describe(
                "Instance size. " +
                    "M10: cheapest dedicated tier, best for dev/test with light load. " +
                    "M20: small dev workloads. " +
                    "M30: MINIMUM for any production workload — handles hundreds of concurrent connections, " +
                    "flash-sale bursts via autoscaling, and databases up to ~150 GB. " +
                    "M40+: high-throughput production, large datasets, or many concurrent connections. " +
                    "Rule of thumb: use M10 for dev, M30 for production."
            ),
        regions: z
            .array(RegionConfigSchema)
            .min(1)
            .describe(
                "Region list. " +
                    "Single-region example: [{region: 'US_EAST_1', nodeCount: 3, priority: 7}]. " +
                    "3-region HA example: [{region: 'US_EAST_1', nodeCount: 2, priority: 7}, " +
                    "{region: 'US_WEST_2', nodeCount: 2, priority: 6}, " +
                    "{region: 'US_EAST_2', nodeCount: 1, priority: 5}]. " +
                    "HA requirement: 3+ distinct regions, electable nodes in each, total >= 5."
            ),
        autoScaling: z
            .boolean()
            .default(false)
            .describe(
                "Enable compute AND disk auto-scaling. " +
                    "STRONGLY RECOMMENDED for any cluster that may see variable load (dev spikes, flash sales, seasonal traffic). " +
                    "Required for all production clusters. " +
                    "When true, the cluster scales between instanceSize (min) and maxInstanceSize automatically."
            ),
        maxInstanceSize: z
            .enum(INSTANCE_SIZES)
            .optional()
            .describe(
                "Upper bound for auto-scaling. Required when autoScaling=true. " +
                    "If omitted, defaults to a sensible ceiling (M10→M40, M30→M60, M40→M80). " +
                    "Must be larger than instanceSize."
            ),
        backupEnabled: z
            .boolean()
            .default(false)
            .describe(
                "Enable continuous cloud backup (daily snapshots). " +
                    "REQUIRED for all production clusters (M30+). " +
                    "Set to true whenever creating a production cluster."
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
        const resolvedMax =
            maxInstanceSize ?? (AUTOSCALE_MAX_DEFAULTS[instanceSize] as (typeof INSTANCE_SIZES)[number]);

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

        const totalElectable = regions.reduce((sum, r) => sum + r.nodeCount, 0);
        const isProduction = ["M30", "M40", "M50", "M60", "M80", "M140", "M200", "M300", "M400", "M700"].includes(
            instanceSize
        );

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
                            ? `NEXT STEP: Call atlas-pause-cluster with projectId="${projectId}" and clusterName="${name}" ` +
                              `to pause this cluster. That tool will wait for IDLE automatically before pausing.`
                            : `Use atlas-inspect-cluster to check stateName (CREATING → IDLE).`),
                },
            ],
        };
    }
}
