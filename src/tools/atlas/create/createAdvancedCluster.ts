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
            "AWS region名。单region用US_EAST_1+priority=7。" +
                "常用:US_EAST_1(弗吉尼亚,最便宜,主app region)、" +
                "US_WEST_2(俄勒冈)、US_EAST_2(俄亥俄)、EU_WEST_1(爱尔兰)、AP_SOUTHEAST_1(新加坡)。" +
                "单region生产无指示则用US_EAST_1。"
        ),
    nodeCount: z
        .number()
        .int()
        .min(1)
        .default(3)
        .describe(
            "本region electable节点数。单region用3。" +
                "3-region HA分布2+2+1(共5)或3+1+1(共5)。" +
                "所有region electable总数须奇(3/5/7)保quorum;" +
                "生产HA最低5。"
        ),
    priority: z
        .number()
        .int()
        .min(1)
        .max(7)
        .default(7)
        .describe("选举优先级。7=主region(收所有写)。" + "次region用6、5、4…递减。" + "每region优先级唯一。"),
});

export class CreateAdvancedClusterTool extends AtlasToolBase {
    static toolName = "atlas-create-advanced-cluster";
    public description =
        "建AWS专享MongoDB Atlas副本集cluster。覆盖所有生产模式:" +
        "(1)开发/测试:M10,单region,autoScaling=true;" +
        "(2)省钱生产(单region):M30,US_EAST_1,autoScaling=true,backupEnabled=true;" +
        "(3)高可用生产(多region):M30+,3个AWS region(如US_EAST_1+US_WEST_2+US_EAST_2)," +
        "节点分布2+2+1(共5个electable),autoScaling=true,backupEnabled=true。" +
        "建生产cluster后若需暂停,接着调atlas-pause-cluster。";
    static operationType: OperationType = "create";

    public argsShape = {
        projectId: AtlasArgs.projectId().describe(
            "Atlas项目ID。不知则调atlas-list-clusters(无projectId)看所有项目ID," +
                "或从bootstrap_outputs.json读:jq -r '.project_id.value' bootstrap_outputs.json"
        ),
        name: AtlasArgs.clusterName().describe("cluster名"),
        instanceSize: z
            .enum(INSTANCE_SIZES)
            .default("M10")
            .describe(
                "实例规格。" +
                    "M10:最便宜专享层,适合轻负载开发/测试。" +
                    "M20:小型开发负载。" +
                    "M30:任何生产负载和所有HA多region cluster的最低规格——" +
                    "撑数百并发连接、autoscaling抗flash-sale突增、库≤约150GB。" +
                    "M40+:高吞吐生产、大库或多并发。" +
                    "原则:开发用M10,生产或HA用M30。"
            ),
        regions: z
            .array(RegionConfigSchema)
            .min(1)
            .describe(
                "region列表。" +
                    "单region例:[{region:'US_EAST_1',nodeCount:3,priority:7}]。" +
                    "3-region HA例(优选分布2+2+1=5,勿用3+3+3=9):" +
                    "[{region:'US_EAST_1',nodeCount:2,priority:7}," +
                    "{region:'US_WEST_2',nodeCount:2,priority:6}," +
                    "{region:'US_EAST_2',nodeCount:1,priority:5}]。" +
                    "HA要求:≥3个不同region,每region≥1个electable节点,总数≥5且奇。"
            ),
        autoScaling: z
            .boolean()
            .default(true)
            .describe(
                "开启compute和disk自动扩缩(始终联动)。默认true。" +
                    "所有生产cluster必须,变负载开发cluster也建议。" +
                    "true时cluster在instanceSize(下限)和maxInstanceSize(上限)间自动伸缩。" +
                    "仅静态负载设false。"
            ),
        maxInstanceSize: z
            .enum(INSTANCE_SIZES)
            .optional()
            .describe(
                "自动扩缩上限。不填则自动选合理值" +
                    "(M10→M40,M20→M40,M30→M60,M40→M80,M50→M80,M60→M140)。" +
                    "须大于instanceSize。"
            ),
        backupEnabled: z
            .boolean()
            .default(true)
            .describe(
                "开启持续云备份(每日快照)。默认true。" +
                    "生产cluster(M30+)必开。" +
                    "仅一次性开发/测试cluster可丢数据时设false。"
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
