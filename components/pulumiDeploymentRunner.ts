import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

/**
 * Arguments for the PulumiDeploymentRunner component.
 * Configures self-managed deployment runners for Pulumi Cloud.
 */
export interface PulumiDeploymentRunnerArgs {
    /**
     * The Kubernetes namespace where the deployment runner will be created.
     */
    namespace: pulumi.Input<string>;

    /**
     * The name of the deployment pool.
     * This identifies the pool in Pulumi Cloud.
     */
    poolName: pulumi.Input<string>;

    /**
     * The container image for the deployment runner.
     * Example: "pulumi/customer-managed-workflow-agent:latest-amd64"
     */
    imageName: pulumi.Input<string>;

    /**
     * Image pull policy for the deployment runner container.
     * Default: "Always"
     */
    imagePullPolicy?: pulumi.Input<string>;

    /**
     * Number of deployment runner replicas to run.
     * Default: 3
     */
    replicas?: pulumi.Input<number>;

    /**
     * Access token for authenticating with Pulumi Cloud.
     * This should be a secret value.
     */
    accessToken: pulumi.Input<string>;

    /**
     * Pulumi service URL.
     * Default: "https://api.pulumi.com"
     */
    serviceUrl?: pulumi.Input<string>;

    /**
     * Optional service account for worker pods.
     * If not provided, a default service account will be used.
     */
    workerServiceAccountName?: pulumi.Input<string>;

    /**
     * Additional environment variables to pass to the deployment runner.
     */
    envVars?: k8s.types.input.core.v1.EnvVar[];

    /**
     * Number of CPUs to allocate for Fargate worker pods.
     * Only applicable when running on AWS EKS Fargate.
     */
    agentNumCpus?: pulumi.Input<number>;

    /**
     * Amount of memory in GB to allocate for Fargate worker pods.
     * Only applicable when running on AWS EKS Fargate.
     */
    agentMemQuantity?: pulumi.Input<number>;

    /**
     * Custom pod template for worker pods.
     * Allows customization of node selectors, tolerations, resource limits, etc.
     * Uses Kubernetes Strategic Merge Patch semantics.
     * Can be a plain object or loaded from YAML/JSON.
     */
    podTemplate?: any;

    /**
     * Enable Prometheus ServiceMonitor for metrics collection.
     * Default: false
     */
    enableServiceMonitor?: pulumi.Input<boolean>;
}

/**
 * PulumiDeploymentRunner is a Pulumi ComponentResource that encapsulates
 * the deployment of self-managed deployment runners for Pulumi Cloud.
 *
 * This component creates all necessary Kubernetes resources including:
 * - Namespace (if needed)
 * - ServiceAccount with RBAC permissions
 * - ConfigMap for agent configuration
 * - Secret for access token
 * - Deployment with configurable replicas
 * - Service for health/metrics endpoints
 * - Optional ServiceMonitor for Prometheus
 *
 * Based on: https://github.com/pulumi/customer-managed-workflow-agent/tree/main/kubernetes
 */
export class PulumiDeploymentRunner extends pulumi.ComponentResource {
    public readonly namespace: k8s.core.v1.Namespace;
    public readonly agentDeployment: k8s.apps.v1.Deployment;
    public readonly agentServiceAccount: k8s.core.v1.ServiceAccount;
    public readonly agentRole: k8s.rbac.v1.Role;
    public readonly agentRoleBinding: k8s.rbac.v1.RoleBinding;
    public readonly agentService: k8s.core.v1.Service;
    public readonly serviceMonitor?: k8s.apiextensions.CustomResource;

    private readonly labels = {
        "app.kubernetes.io/name": "pulumi-deployment-runner",
        "app.kubernetes.io/managed-by": "pulumi",
    };

    constructor(name: string, args: PulumiDeploymentRunnerArgs, opts?: pulumi.ComponentResourceOptions) {
        super("custom:k8s:PulumiDeploymentRunner", name, args, opts);

        const imagePullPolicy = args.imagePullPolicy ?? "Always";
        const replicas = args.replicas ?? 3;
        const serviceUrl = args.serviceUrl ?? "https://api.pulumi.com";
        const enableServiceMonitor = args.enableServiceMonitor ?? false;

        // Create or reference namespace
        this.namespace = new k8s.core.v1.Namespace(
            `${name}-namespace`,
            {
                metadata: {
                    name: args.namespace,
                },
            },
            { parent: this }
        );

        // Create ConfigMap for agent configuration
        const agentConfig = new k8s.core.v1.ConfigMap(
            `${name}-config`,
            {
                metadata: {
                    name: pulumi.interpolate`${args.poolName}-config`,
                    namespace: this.namespace.metadata.name,
                    labels: this.labels,
                },
                data: {
                    "PULUMI_AGENT_SERVICE_URL": pulumi.output(serviceUrl),
                    "PULUMI_AGENT_IMAGE": args.imageName,
                    "PULUMI_AGENT_IMAGE_PULL_POLICY": pulumi.output(imagePullPolicy),
                    "worker-pod.json": JSON.stringify(args.podTemplate ?? {}, null, 2),
                },
            },
            { parent: this }
        );

        // Create Secret for access token
        const agentSecret = new k8s.core.v1.Secret(
            `${name}-secret`,
            {
                metadata: {
                    name: pulumi.interpolate`${args.poolName}-secret`,
                    namespace: this.namespace.metadata.name,
                    labels: this.labels,
                },
                stringData: {
                    "PULUMI_AGENT_TOKEN": args.accessToken,
                },
            },
            { parent: this }
        );

        // Create ServiceAccount for the agent
        this.agentServiceAccount = new k8s.core.v1.ServiceAccount(
            `${name}-sa`,
            {
                metadata: {
                    name: pulumi.interpolate`${args.poolName}-agent`,
                    namespace: this.namespace.metadata.name,
                    labels: this.labels,
                },
            },
            { parent: this }
        );

        // Create Role with required permissions
        this.agentRole = new k8s.rbac.v1.Role(
            `${name}-role`,
            {
                metadata: {
                    name: pulumi.interpolate`${args.poolName}-agent`,
                    namespace: this.namespace.metadata.name,
                    labels: this.labels,
                },
                rules: [
                    {
                        apiGroups: [""],
                        resources: ["pods", "pods/log", "configmaps"],
                        verbs: ["create", "get", "list", "watch", "update", "delete"],
                    },
                ],
            },
            { parent: this }
        );

        // Create RoleBinding
        this.agentRoleBinding = new k8s.rbac.v1.RoleBinding(
            `${name}-rolebinding`,
            {
                metadata: {
                    name: pulumi.interpolate`${args.poolName}-agent`,
                    namespace: this.namespace.metadata.name,
                    labels: this.labels,
                },
                subjects: [
                    {
                        kind: "ServiceAccount",
                        name: this.agentServiceAccount.metadata.name,
                        namespace: this.namespace.metadata.name,
                    },
                ],
                roleRef: {
                    kind: "Role",
                    name: this.agentRole.metadata.name,
                    apiGroup: "rbac.authorization.k8s.io",
                },
            },
            { parent: this }
        );

        // Build environment variables
        const envVars: k8s.types.input.core.v1.EnvVar[] = [
            {
                name: "PULUMI_AGENT_DEPLOY_TARGET",
                value: "kubernetes",
            },
            {
                name: "PULUMI_AGENT_SHARED_VOLUME_DIRECTORY",
                value: "/mnt/work",
            },
            {
                name: "PULUMI_AGENT_SERVICE_URL",
                valueFrom: {
                    configMapKeyRef: {
                        name: agentConfig.metadata.name,
                        key: "PULUMI_AGENT_SERVICE_URL",
                    },
                },
            },
            {
                name: "PULUMI_AGENT_IMAGE",
                valueFrom: {
                    configMapKeyRef: {
                        name: agentConfig.metadata.name,
                        key: "PULUMI_AGENT_IMAGE",
                    },
                },
            },
            {
                name: "PULUMI_AGENT_IMAGE_PULL_POLICY",
                valueFrom: {
                    configMapKeyRef: {
                        name: agentConfig.metadata.name,
                        key: "PULUMI_AGENT_IMAGE_PULL_POLICY",
                    },
                },
            },
            {
                name: "PULUMI_AGENT_TOKEN",
                valueFrom: {
                    secretKeyRef: {
                        name: agentSecret.metadata.name,
                        key: "PULUMI_AGENT_TOKEN",
                    },
                },
            },
        ];

        // Add optional worker service account env var
        if (args.workerServiceAccountName) {
            envVars.push({
                name: "PULUMI_AGENT_SERVICE_ACCOUNT_NAME",
                value: args.workerServiceAccountName,
            });
        }

        // Add optional CPU env var
        if (args.agentNumCpus) {
            envVars.push({
                name: "PULUMI_AGENT_NUM_CPUS",
                value: pulumi.output(args.agentNumCpus).apply(v => v.toString()),
            });
        }

        // Add optional memory env var
        if (args.agentMemQuantity) {
            envVars.push({
                name: "PULUMI_AGENT_MEM_QUANTITY",
                value: pulumi.output(args.agentMemQuantity).apply(v => v.toString()),
            });
        }

        // Add any additional env vars
        if (args.envVars) {
            envVars.push(...args.envVars);
        }

        // Create Deployment
        this.agentDeployment = new k8s.apps.v1.Deployment(
            `${name}-deployment`,
            {
                metadata: {
                    name: pulumi.interpolate`${args.poolName}-pool`,
                    namespace: this.namespace.metadata.name,
                    labels: {
                        ...this.labels,
                        "pulumi.com/pool-name": args.poolName,
                    },
                    annotations: {
                        "app.kubernetes.io/name": "pulumi-deployment-runner-pool",
                    },
                },
                spec: {
                    replicas: replicas,
                    selector: {
                        matchLabels: this.labels,
                    },
                    template: {
                        metadata: {
                            labels: {
                                ...this.labels,
                                "pulumi.com/pool-name": args.poolName,
                            },
                        },
                        spec: {
                            serviceAccountName: this.agentServiceAccount.metadata.name,
                            containers: [
                                {
                                    name: "agent",
                                    image: args.imageName,
                                    imagePullPolicy: imagePullPolicy,
                                    env: envVars,
                                    ports: [
                                        {
                                            name: "http",
                                            containerPort: 8080,
                                            protocol: "TCP",
                                        },
                                    ],
                                    volumeMounts: [
                                        {
                                            name: "agent-work",
                                            mountPath: "/mnt/work",
                                        },
                                        {
                                            name: "agent-config",
                                            mountPath: "/mnt/worker-pod.json",
                                            subPath: "worker-pod.json",
                                            readOnly: true,
                                        },
                                    ],
                                },
                            ],
                            volumes: [
                                {
                                    name: "agent-work",
                                    emptyDir: {},
                                },
                                {
                                    name: "agent-config",
                                    configMap: {
                                        name: agentConfig.metadata.name,
                                    },
                                },
                            ],
                        },
                    },
                },
            },
            { parent: this }
        );

        // Create Service for health/metrics endpoints
        this.agentService = new k8s.core.v1.Service(
            `${name}-service`,
            {
                metadata: {
                    name: pulumi.interpolate`${args.poolName}-service`,
                    namespace: this.namespace.metadata.name,
                    labels: {
                        ...this.labels,
                        "app.kubernetes.io/component": "metrics",
                    },
                    annotations: {
                        "prometheus.io/scrape": "true",
                        "prometheus.io/port": "8080",
                        "prometheus.io/path": "/healthz",
                    },
                },
                spec: {
                    selector: this.labels,
                    ports: [
                        {
                            name: "http",
                            port: 8080,
                            targetPort: 8080,
                            protocol: "TCP",
                        },
                    ],
                    type: "ClusterIP",
                },
            },
            { parent: this }
        );

        // Optionally create ServiceMonitor for Prometheus Operator
        if (enableServiceMonitor) {
            this.serviceMonitor = new k8s.apiextensions.CustomResource(
                `${name}-servicemonitor`,
                {
                    apiVersion: "monitoring.coreos.com/v1",
                    kind: "ServiceMonitor",
                    metadata: {
                        name: pulumi.interpolate`${args.poolName}-servicemonitor`,
                        namespace: this.namespace.metadata.name,
                        labels: this.labels,
                    },
                    spec: {
                        selector: {
                            matchLabels: {
                                ...this.labels,
                                "app.kubernetes.io/component": "metrics",
                            },
                        },
                        endpoints: [
                            {
                                port: "http",
                                path: "/healthz",
                                interval: "30s",
                            },
                        ],
                    },
                },
                { parent: this }
            );
        }

        this.registerOutputs({
            namespaceName: this.namespace.metadata.name,
            deploymentName: this.agentDeployment.metadata.name,
            serviceName: this.agentService.metadata.name,
            serviceAccountName: this.agentServiceAccount.metadata.name,
        });
    }
}
