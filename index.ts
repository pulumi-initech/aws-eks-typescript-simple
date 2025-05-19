import * as pulumi from "@pulumi/pulumi";
import * as eks from "@pulumi/eks";
import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumiservice from "@pulumi/pulumiservice";

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
  maxSize: 6,
  desiredCapacity: 4,
  minSize: 4,
  authenticationMode: "API_AND_CONFIG_MAP",
  instanceType: "m3.medium",
  tags: {
    Owner: "jconnell@pulumi.com",
  },
};

if (!useFargate) {
  clusterOptions.instanceType = config.require("instanceType");
}
const cluster = new eks.Cluster(name, clusterOptions);

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
  const promOperator = new k8s.helm.v3.Release("prom-operator", {
    name: "kube-prometheus-stack",
    chart: "kube-prometheus-stack",
    repositoryOpts: {
      repo: "https://prometheus-community.github.io/helm-charts",
    },
    values: {
      prometheus: {
        prometheusSpec: {
          serviceMonitorSelectorNilUsesHelmValues: false,
        },
      },
    },
  });
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
  });
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

// // Deploy a Helm release into the namespace
const externalSecrets = new k8s.helm.v4.Chart(
  "external-secrets",
  {
    chart: "external-secrets",
    version: externalSecretsVersion, // Specify the version of the chart
    namespace: ns.metadata.name,
    repositoryOpts: {
      repo: "https://charts.external-secrets.io",
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

export const kubeconfig = cluster.kubeconfigJson;
export const clusterOidcProvider = cluster.core.oidcProvider?.url;
export const clusterOidcProviderArn = cluster.core.oidcProvider?.arn;
export const clusterIdentifier = cluster.eksCluster.id;
export const clusterName = cluster.eksCluster.name;
<<<<<<< HEAD
export const clusterSecretStoreRef = { kind: crd.kind, metadata: { name: crd.metadata.name, namespace: crd.metadata.namespace }};
=======
export const clusterSecretStoreRef = {
  kind: crd.kind,
  metadata: { name: crd.metadata.name, namespace: crd.metadata.namespace },
};

const settings = new StackSettings("settings", {
  stackOutputs: [
    "kubeconfig",
    "clusterName",
    "clusterIdentifier",
    "clusterOidcProvider",
    "clusterOidcProviderArn",
    "clusterSecretStoreRef",
  ],
});
>>>>>>> b465a18 (Updates)
