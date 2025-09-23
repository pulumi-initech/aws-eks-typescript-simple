import * as pulumi from "@pulumi/pulumi";
import * as eks from "@pulumi/eks";
import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config();

const name = config.require("clusterName");
const vpcId = config.require("VpcId");

const awsConfig = new pulumi.Config("aws");
const region = awsConfig.require("region");

const publicSubnetIds = config.requireObject<string[]>("PublicSubnetIds");
const privateSubnetIds = config.requireObject<string[]>("PrivateSubnetIds");
const useFargate = config.getBoolean("useFargate") ?? false;
const secretStoreEnvironment = config.require("secretStoreEnvironment");
const externalSecretsVersion = config.get("externalSecretsVersion") ?? "0.10.4";
const pkoVersion = config.get("pkoVersion") ?? "v2.0.0";
const clusterVersion = config.get("clusterVersion") ?? "1.31";

const clusterOptions: eks.ClusterOptions = {
  vpcId: vpcId,
  version: clusterVersion,
  privateSubnetIds: privateSubnetIds,
  publicSubnetIds: publicSubnetIds,
  createOidcProvider: true,
  fargate: useFargate,
  corednsAddonOptions: { enabled: true }, 
  autoMode: {
    enabled: true,
    createNodeRole: true,
  },
  maxSize: 6,
  desiredCapacity: 4,
  minSize: 4,
  authenticationMode: "API_AND_CONFIG_MAP",
  instanceType: "t3.large", // Upgraded from deprecated m3.medium
  // Security enhancements
  encryptionConfigKeyArn: config.get("kmsKeyArn"), // Enable cluster encryption
  endpointConfigPrivateAccess: true,
  endpointConfigPublicAccess: config.getBoolean("allowPublicAccess") ?? false, // Restrict public access
  publicAccessCidrs: config.getObject<string[]>("publicAccessCidrs") ?? ["10.0.0.0/8"], // Limit public access
  // Node security
  nodeRootVolumeEncrypted: true, // Encrypt node root volumes
  nodeRootVolumeSize: 50, // Increase root volume size for better performance
  tags: {
    Owner: "jconnell@pulumi.com",
    Environment: "production",
    "kubernetes.io/cluster-autoscaler/enabled": "true",
    "kubernetes.io/cluster-autoscaler/jconnell-eks-demo": "owned",
  },
};

if (!useFargate) {
  clusterOptions.instanceType = config.get("instanceType") ?? "t3.large";
}
const cluster = new eks.Cluster(name, clusterOptions);

// Add additional managed node groups for better availability and scaling
if (!useFargate) {
  // Create a spot instance node group for cost optimization
  const spotNodeGroup = new aws.eks.NodeGroup("spot-nodes", {
    clusterName: cluster.eksCluster.name,
    nodeGroupName: `${name}-spot-nodes`,
    nodeRoleArn: cluster.instanceRoles[0].apply(role => `arn:aws:iam::${aws.getCallerIdentity().accountId}:role/${role}`),
    subnetIds: privateSubnetIds,
    capacityType: "SPOT",
    instanceTypes: ["t3.large", "t3.xlarge", "m5.large", "m5.xlarge"],
    scalingConfig: {
      desiredSize: 2,
      maxSize: 10,
      minSize: 0,
    },
    updateConfig: {
      maxUnavailablePercentage: 25,
    },
    diskSize: 50,
    amiType: "AL2_x86_64",
    labels: {
      "node-type": "spot",
      "workload": "general",
    },
    taints: [
      {
        key: "spot-instance",
        value: "true",
        effect: "NO_SCHEDULE",
      },
    ],
    tags: {
      "kubernetes.io/cluster-autoscaler/enabled": "true",
      "kubernetes.io/cluster-autoscaler/node-template/label/node-type": "spot",
      [`kubernetes.io/cluster-autoscaler/${name}`]: "owned",
    },
  }, { dependsOn: [cluster] });

  // Create a dedicated node group for system workloads
  const systemNodeGroup = new aws.eks.NodeGroup("system-nodes", {
    clusterName: cluster.eksCluster.name,
    nodeGroupName: `${name}-system-nodes`,
    nodeRoleArn: cluster.instanceRoles[0].apply(role => `arn:aws:iam::${aws.getCallerIdentity().accountId}:role/${role}`),
    subnetIds: privateSubnetIds,
    capacityType: "ON_DEMAND",
    instanceTypes: ["t3.medium"],
    scalingConfig: {
      desiredSize: 2,
      maxSize: 4,
      minSize: 2,
    },
    updateConfig: {
      maxUnavailablePercentage: 25,
    },
    diskSize: 50,
    amiType: "AL2_x86_64",
    labels: {
      "node-type": "system",
      "workload": "system",
    },
    taints: [
      {
        key: "CriticalAddonsOnly",
        value: "true",
        effect: "NO_SCHEDULE",
      },
    ],
    tags: {
      "kubernetes.io/cluster-autoscaler/enabled": "true",
      "kubernetes.io/cluster-autoscaler/node-template/label/node-type": "system",
      [`kubernetes.io/cluster-autoscaler/${name}`]: "owned",
    },
  }, { dependsOn: [cluster] });
}

if (useFargate) {
  const podExecutionRole = new aws.iam.Role("podExecutionRole", {
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: {
            Service: "eks.amazonaws.com",
          },
          Action: "sts:AssumeRole",
        },
        {
          Effect: "Allow",
          Principal: {
            Service: "eks-fargate-pods.amazonaws.com",
          },
          Action: "sts:AssumeRole",
        },
      ],
    }),
  });

  // Attach the AmazonEKSFargatePodExecutionRolePolicy to the role
  const podExecutionRolePolicyAttachment = new aws.iam.RolePolicyAttachment(
    "podExecutionRolePolicyAttachment",
    {
      role: podExecutionRole.name,
      policyArn:
        "arn:aws:iam::aws:policy/AmazonEKSFargatePodExecutionRolePolicy",
    }
  );

  new aws.eks.FargateProfile(
    "externalSecrets",
    {
      clusterName: cluster.eksCluster.name,
      podExecutionRoleArn: podExecutionRole.arn,
      subnetIds: cluster.core.privateSubnetIds,
      selectors: [
        {
          namespace: "external-secrets",
        },
      ],
    },
    { dependsOn: [cluster] }
  );
}

const kubeProvider = new k8s.Provider("kube", {
  clusterIdentifier: cluster.eksCluster.id,
  kubeconfig: cluster.kubeconfig,
});

// Create a Kubernetes namespace
const ns = new k8s.core.v1.Namespace(
  "external-secrets",
  {
    metadata: {
      name: "external-secrets",
    },
  },
  { provider: kubeProvider, dependsOn: [cluster] }
);

if (config.getBoolean("usePrometheus")) {
  // Create monitoring namespace
  const monitoringNs = new k8s.core.v1.Namespace(
    "monitoring",
    {
      metadata: {
        name: "monitoring",
      },
    },
    { provider: kubeProvider, dependsOn: [cluster] }
  );

  const promOperator = new k8s.helm.v3.Release("prom-operator", {
    name: "kube-prometheus-stack",
    chart: "kube-prometheus-stack",
    namespace: monitoringNs.metadata.name,
    repositoryOpts: {
      repo: "https://prometheus-community.github.io/helm-charts",
    },
    values: {
      prometheus: {
        prometheusSpec: {
          serviceMonitorSelectorNilUsesHelmValues: false,
          retention: "30d", // Retain metrics for 30 days
          storageSpec: {
            volumeClaimTemplate: {
              spec: {
                storageClassName: "gp3",
                accessModes: ["ReadWriteOnce"],
                resources: {
                  requests: {
                    storage: "50Gi",
                  },
                },
              },
            },
          },
          resources: {
            requests: {
              memory: "2Gi",
              cpu: "1000m",
            },
            limits: {
              memory: "4Gi",
              cpu: "2000m",
            },
          },
        },
      },
      grafana: {
        enabled: true,
        persistence: {
          enabled: true,
          size: "10Gi",
          storageClassName: "gp3",
        },
        adminPassword: config.requireSecret("grafanaAdminPassword"),
        resources: {
          requests: {
            memory: "256Mi",
            cpu: "100m",
          },
          limits: {
            memory: "512Mi",
            cpu: "200m",
          },
        },
      },
      alertmanager: {
        enabled: true,
        alertmanagerSpec: {
          storage: {
            volumeClaimTemplate: {
              spec: {
                storageClassName: "gp3",
                accessModes: ["ReadWriteOnce"],
                resources: {
                  requests: {
                    storage: "10Gi",
                  },
                },
              },
            },
          },
        },
      },
      // Enable node exporter for node metrics
      nodeExporter: {
        enabled: true,
      },
      // Enable kube-state-metrics
      kubeStateMetrics: {
        enabled: true,
      },
    },
  }, { provider: kubeProvider, dependsOn: [monitoringNs] });
}

if (config.getBoolean("useFlux")) {
  const fluxns = new k8s.core.v1.Namespace(
    "flux-system",
    { metadata: { name: "flux-system" } },
    { provider: kubeProvider, dependsOn: [cluster] }
  );

  const flux = new k8s.helm.v4.Chart(
    "flux",
    {
      namespace: fluxns.metadata.name,
      chart: "oci://ghcr.io/fluxcd-community/charts/flux2",
    },
    { provider: kubeProvider, dependsOn: [cluster, fluxns] }
  );
}

if (config.getBoolean("useArgoCD")) {
  const argoChartVersion = config.get("argoChartVersion") || "7.7.12";

  const argocd = new k8s.helm.v4.Chart(
    "argocd",
    {
      namespace: ns.metadata.name,
      chart: "argo-cd",
      repositoryOpts: {
        repo: "https://argoproj.github.io/argo-helm",
      },
      version: argoChartVersion,
      values: {
        fullNameOverride: "",
        installCRDs: true,
        createClusterRoles: true,
        createAggregateRoles: true,
        createNamespace: true,
        server: {
          service: {
            type: "NodePort",
          },
        },
      },
    },
    { provider: kubeProvider }
  );

  const appOfapps = new k8s.apiextensions.CustomResource("argocd-application", {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: {
      name: "my-argocd-application",
      namespace: "argocd",
    },
    spec: {
      project: "default",
      source: {
        repoURL: "https://github.com/your-repo/your-app.git",
        targetRevision: "HEAD",
        path: "path/to/your/app",
      },
      destination: {
        server: "https://kubernetes.default.svc",
        namespace: "your-app-namespace",
      },
      syncPolicy: {
        automated: {
          prune: true,
          selfHeal: true,
        },
      },
    },
  }, { provider: kubeProvider, dependsOn: [argocd] });
}

if (config.getBoolean("usePKO")) {
  const pkons = new k8s.core.v1.Namespace(
    "pulumi-kubernetes-operator",
    { metadata: { name: "pulumi-kubernetes-operator" } },
    { provider: kubeProvider, dependsOn: [cluster] }
  );

  const pko = new k8s.kustomize.Directory(
    "pulumi-kubernetes-operator",
    {
      directory: `https://github.com/pulumi/pulumi-kubernetes-operator//operator/config/default/?ref=${pkoVersion}`,
    },
    { provider: kubeProvider }
  );

  // const pko = new k8s.helm.v4.Chart("pulumi-kubernetes-operator", {
  //   namespace: pkons.metadata.name,
  //   chart: "oci://ghcr.io/pulumi/helm-charts/pulumi-kubernetes-operator",
  //   version: "2.0.0-beta.3"
  // }, { provider: kubeProvider});
}

// Deploy a Helm release into the namespace with proper replica counts for robustness
const externalSecrets = new k8s.helm.v4.Chart(
  "external-secrets",
  {
    chart: "external-secrets",
    version: externalSecretsVersion, // Specify the version of the chart
    namespace: ns.metadata.name,
    repositoryOpts: {
      repo: "https://charts.external-secrets.io",
    },
    values: {
      // Ensure minimum replica counts for high availability
      replicaCount: 2,
      webhook: {
        replicaCount: 2,
      },
      certController: {
        replicaCount: 2,
      },
      // Add resource limits and requests for stability
      resources: {
        limits: {
          cpu: "200m",
          memory: "256Mi",
        },
        requests: {
          cpu: "100m",
          memory: "128Mi",
        },
      },
      // Enable pod disruption budgets
      podDisruptionBudget: {
        enabled: true,
        minAvailable: 1,
      },
      // Add anti-affinity for better distribution
      affinity: {
        podAntiAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [
            {
              weight: 100,
              podAffinityTerm: {
                labelSelector: {
                  matchExpressions: [
                    {
                      key: "app.kubernetes.io/name",
                      operator: "In",
                      values: ["external-secrets"],
                    },
                  ],
                },
                topologyKey: "kubernetes.io/hostname",
              },
            },
          ],
        },
      },
    },
  },
  { provider: kubeProvider, dependsOn: [cluster] }
);

// Deploy a secret into the namespace
const accessTokenSecret = new k8s.core.v1.Secret(
  "pulumi-access-token",
  {
    metadata: {
      namespace: ns.metadata.name,
      name: "pulumi-access-token",
    },
    stringData: {
      PULUMI_ACCESS_TOKEN: config.require("pulumiAccessToken"),
    },
    type: "Opaque",
  },
  { provider: kubeProvider, dependsOn: [cluster] }
);

const crd = new k8s.apiextensions.CustomResource(
  "cluster-secret-store",
  {
    apiVersion: "external-secrets.io/v1beta1",
    kind: "ClusterSecretStore",
    metadata: {
      name: "secret-store",
    },
    spec: {
      provider: {
        pulumi: {
          organization: pulumi.runtime.getOrganization(),
          project: secretStoreEnvironment.split("/")[0],
          environment: secretStoreEnvironment.split("/")[1],
          accessToken: {
            secretRef: {
              namespace: accessTokenSecret.metadata.namespace,
              name: accessTokenSecret.metadata.name,
              key: "PULUMI_ACCESS_TOKEN",
            },
          },
        },
      },
    },
  },
  { provider: kubeProvider, dependsOn: [externalSecrets, cluster] }
);

// Deploy Cluster Autoscaler for automatic node scaling
if (!useFargate) {
  // Create service account for cluster autoscaler
  const clusterAutoscalerSA = new k8s.core.v1.ServiceAccount(
    "cluster-autoscaler-sa",
    {
      metadata: {
        name: "cluster-autoscaler",
        namespace: "kube-system",
      },
    },
    { provider: kubeProvider, dependsOn: [cluster] }
  );

  // Deploy cluster autoscaler
  const clusterAutoscaler = new k8s.apps.v1.Deployment(
    "cluster-autoscaler",
    {
      metadata: {
        name: "cluster-autoscaler",
        namespace: "kube-system",
        labels: {
          app: "cluster-autoscaler",
        },
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: "cluster-autoscaler",
          },
        },
        template: {
          metadata: {
            labels: {
              app: "cluster-autoscaler",
            },
            annotations: {
              "prometheus.io/scrape": "true",
              "prometheus.io/port": "8085",
            },
          },
          spec: {
            serviceAccountName: clusterAutoscalerSA.metadata.name,
            containers: [
              {
                image: "registry.k8s.io/autoscaling/cluster-autoscaler:v1.31.0",
                name: "cluster-autoscaler",
                resources: {
                  limits: {
                    cpu: "100m",
                    memory: "600Mi",
                  },
                  requests: {
                    cpu: "100m",
                    memory: "600Mi",
                  },
                },
                command: [
                  "./cluster-autoscaler",
                  "--v=4",
                  "--stderrthreshold=info",
                  "--cloud-provider=aws",
                  `--node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/${name}`,
                  "--logtostderr=true",
                  "--scale-down-enabled=true",
                  "--scale-down-delay-after-add=10m",
                  "--scale-down-unneeded-time=10m",
                  "--scale-down-utilization-threshold=0.5",
                  "--skip-nodes-with-local-storage=false",
                  "--expander=random",
                ],
                volumeMounts: [
                  {
                    name: "ssl-certs",
                    mountPath: "/etc/ssl/certs/ca-certificates.crt",
                    readOnly: true,
                  },
                ],
                imagePullPolicy: "Always",
              },
            ],
            volumes: [
              {
                name: "ssl-certs",
                hostPath: {
                  path: "/etc/ssl/certs/ca-bundle.crt",
                },
              },
            ],
          },
        },
      },
    },
    { provider: kubeProvider, dependsOn: [clusterAutoscalerSA, cluster] }
  );
}

// Deploy Velero for backup and disaster recovery
if (config.getBoolean("useVelero") ?? true) {
  // Create Velero namespace
  const veleroNs = new k8s.core.v1.Namespace(
    "velero",
    {
      metadata: {
        name: "velero",
      },
    },
    { provider: kubeProvider, dependsOn: [cluster] }
  );

  // Deploy Velero using Helm
  const velero = new k8s.helm.v3.Release("velero", {
    name: "velero",
    chart: "velero",
    namespace: veleroNs.metadata.name,
    repositoryOpts: {
      repo: "https://vmware-tanzu.github.io/helm-charts",
    },
    values: {
      configuration: {
        backupStorageLocation: [
          {
            name: "default",
            provider: "aws",
            bucket: config.get("veleroBackupBucket") ?? `${name}-velero-backups`,
            config: {
              region: region,
            },
          },
        ],
        volumeSnapshotLocation: [
          {
            name: "default",
            provider: "aws",
            config: {
              region: region,
            },
          },
        ],
      },
      initContainers: [
        {
          name: "velero-plugin-for-aws",
          image: "velero/velero-plugin-for-aws:v1.10.0",
          imagePullPolicy: "IfNotPresent",
          volumeMounts: [
            {
              mountPath: "/target",
              name: "plugins",
            },
          ],
        },
      ],
      serviceAccount: {
        server: {
          create: true,
          annotations: {
            "eks.amazonaws.com/role-arn": cluster.core.oidcProvider?.arn.apply(arn => 
              `arn:aws:iam::${aws.getCallerIdentity().accountId}:role/velero-role`
            ),
          },
        },
      },
      schedules: {
        daily: {
          disabled: false,
          schedule: "0 2 * * *", // Daily at 2 AM
          template: {
            ttl: "720h", // 30 days retention
            includedNamespaces: ["*"],
            excludedNamespaces: ["kube-system", "kube-public", "kube-node-lease"],
          },
        },
        weekly: {
          disabled: false,
          schedule: "0 3 * * 0", // Weekly on Sunday at 3 AM
          template: {
            ttl: "2160h", // 90 days retention
            includedNamespaces: ["*"],
            excludedNamespaces: ["kube-system", "kube-public", "kube-node-lease"],
          },
        },
      },
    },
  }, { provider: kubeProvider, dependsOn: [veleroNs, cluster] });
}

// Deploy AWS Load Balancer Controller for better ingress management
if (!useFargate) {
  const awsLbControllerNs = new k8s.core.v1.Namespace(
    "aws-load-balancer-controller",
    {
      metadata: {
        name: "aws-load-balancer-controller",
      },
    },
    { provider: kubeProvider, dependsOn: [cluster] }
  );

  const awsLbController = new k8s.helm.v3.Release("aws-load-balancer-controller", {
    name: "aws-load-balancer-controller",
    chart: "aws-load-balancer-controller",
    namespace: awsLbControllerNs.metadata.name,
    repositoryOpts: {
      repo: "https://aws.github.io/eks-charts",
    },
    values: {
      clusterName: cluster.eksCluster.name,
      serviceAccount: {
        create: true,
        annotations: {
          "eks.amazonaws.com/role-arn": cluster.core.oidcProvider?.arn.apply(arn => 
            `arn:aws:iam::${aws.getCallerIdentity().accountId}:role/aws-load-balancer-controller-role`
          ),
        },
      },
      region: region,
      vpcId: vpcId,
      replicaCount: 2,
      resources: {
        limits: {
          cpu: "200m",
          memory: "500Mi",
        },
        requests: {
          cpu: "100m",
          memory: "200Mi",
        },
      },
    },
  }, { provider: kubeProvider, dependsOn: [awsLbControllerNs, cluster] });
}

// Deploy Calico for network policies (if not using Fargate)
if (!useFargate && config.getBoolean("useNetworkPolicies") ?? true) {
  const calico = new k8s.helm.v3.Release("calico", {
    name: "calico",
    chart: "tigera-operator",
    namespace: "tigera-operator",
    createNamespace: true,
    repositoryOpts: {
      repo: "https://docs.tigera.io/calico/charts",
    },
    values: {
      installation: {
        kubernetesProvider: "EKS",
      },
    },
  }, { provider: kubeProvider, dependsOn: [cluster] });

  // Create default network policies for enhanced security
  const defaultDenyAll = new k8s.networking.v1.NetworkPolicy(
    "default-deny-all",
    {
      metadata: {
        name: "default-deny-all",
        namespace: "default",
      },
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
      },
    },
    { provider: kubeProvider, dependsOn: [calico] }
  );

  // Allow DNS resolution
  const allowDns = new k8s.networking.v1.NetworkPolicy(
    "allow-dns",
    {
      metadata: {
        name: "allow-dns",
        namespace: "default",
      },
      spec: {
        podSelector: {},
        policyTypes: ["Egress"],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: {
                    name: "kube-system",
                  },
                },
              },
            ],
            ports: [
              {
                protocol: "UDP",
                port: 53,
              },
              {
                protocol: "TCP",
                port: 53,
              },
            ],
          },
        ],
      },
    },
    { provider: kubeProvider, dependsOn: [calico] }
  );
}

// Create Pod Security Standards
const podSecurityPolicy = new k8s.core.v1.Namespace(
  "secure-namespace",
  {
    metadata: {
      name: "secure-workloads",
      labels: {
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/audit": "restricted",
        "pod-security.kubernetes.io/warn": "restricted",
      },
    },
  },
  { provider: kubeProvider, dependsOn: [cluster] }
);

// Create a security context constraints for workloads
const securityContextConstraints = new k8s.core.v1.LimitRange(
  "security-limits",
  {
    metadata: {
      name: "security-limits",
      namespace: podSecurityPolicy.metadata.name,
    },
    spec: {
      limits: [
        {
          type: "Container",
          default: {
            cpu: "100m",
            memory: "128Mi",
          },
          defaultRequest: {
            cpu: "50m",
            memory: "64Mi",
          },
          max: {
            cpu: "1000m",
            memory: "1Gi",
          },
        },
      ],
    },
  },
  { provider: kubeProvider, dependsOn: [podSecurityPolicy] }
);

export const kubeconfig = cluster.kubeconfigJson;
export const clusterOidcProvider = cluster.core.oidcProvider?.url;
export const clusterOidcProviderArn = cluster.core.oidcProvider?.arn;
export const clusterIdentifier = cluster.eksCluster.id;
export const clusterName = cluster.eksCluster.name;
export const clusterSecretStoreRef = { kind: crd.kind, metadata: { name: crd.metadata.name, namespace: crd.metadata.namespace }};