import * as pulumi from "@pulumi/pulumi";
import * as eks from "@pulumi/eks";
import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as awsLoadBalancerController from "@pulumi-initech/aws-load-balancer-controller";
import { ArgoCD } from "./components/argocd";
import { PulumiDeploymentRunner } from "./components/pulumiDeploymentRunner"
import { Region } from "@pulumi/aws";

const config = new pulumi.Config();

const name = config.require("clusterName");
const vpcId = config.require("VpcId");

const awsConfig = new pulumi.Config("aws");
const region = awsConfig.require<Region>("region");
const defaultTags = awsConfig.requireObject<any>("defaultTags");

const publicSubnetIds = config.requireObject<string[]>("PublicSubnetIds");
const privateSubnetIds = config.requireObject<string[]>("PrivateSubnetIds");
const useFargate = config.getBoolean("useFargate") ?? false;
const secretStoreEnvironment = config.require("secretStoreEnvironment");
const externalSecretsVersion = config.get("externalSecretsVersion") ?? "0.10.4";
const pkoVersion = config.get("pkoVersion") ?? "v2.2.0";
const clusterVersion = config.get("clusterVersion") ?? "1.33";

const awsProvider = new aws.Provider("aws", { region: "us-west-2", defaultTags: defaultTags })

const clusterOptions: eks.ClusterOptions = {
  vpcId: vpcId,
  version: clusterVersion,
  privateSubnetIds: privateSubnetIds,
  publicSubnetIds: publicSubnetIds,
  createOidcProvider: true,
  fargate: useFargate,
  corednsAddonOptions: { enabled: true }, 
  autoMode: {
    enabled: config.require("useAutoMode") === "true",
    createNodeRole: true,
  },
  maxSize: 6,
  desiredCapacity: 2,
  minSize: 2,
  authenticationMode: "API_AND_CONFIG_MAP",
  instanceType: "m3.medium",
  tags: {
    Owner: "jconnell@pulumi.com",
  },
};

if (!useFargate) {
  clusterOptions.instanceType = config.require("instanceType");
}
const cluster = new eks.Cluster(name, clusterOptions, { providers: { aws: awsProvider }});


// Create access entries for IAM principals
const accessEntryArns = config.getObject<string[]>("accessEntryArns") ?? [];
const accessEntries = accessEntryArns.map((arn, index) => {
  const accessEntry = new aws.eks.AccessEntry(`access-entry-${index}`, {
    clusterName: cluster.eksCluster.name,
    principalArn: arn,
    type: "STANDARD",
    tags: defaultTags.tags,
  }, { dependsOn: [cluster], provider: awsProvider });

  new aws.eks.AccessPolicyAssociation(`access-policy-${index}`, {
    clusterName: cluster.eksCluster.name,
    principalArn: arn,
    policyArn: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy",
    accessScope: {
      type: "cluster",
    },
  }, { dependsOn: [accessEntry], provider: awsProvider });

  return accessEntry;
});

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
  }, { provider: awsProvider });

  // Attach the AmazonEKSFargatePodExecutionRolePolicy to the role
  const podExecutionRolePolicyAttachment = new aws.iam.RolePolicyAttachment(
    "podExecutionRolePolicyAttachment",
    {
      role: podExecutionRole.name,
      policyArn:
        "arn:aws:iam::aws:policy/AmazonEKSFargatePodExecutionRolePolicy",
    }, { provider: awsProvider }
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
    { dependsOn: [cluster], provider: awsProvider }
  );
}

const kubeProvider = new k8s.Provider("kube", {
  clusterIdentifier: cluster.eksCluster.id,
  kubeconfig: cluster.kubeconfig,
});



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
  }, { provider: kubeProvider });
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
  new ArgoCD("argocd", {
    chartVersion: argoChartVersion,
    enableAppOfApps: config.getBoolean("enableAppOfApps")
  }, { providers: { kubernetes: kubeProvider }, dependsOn: [cluster] });
}

if (config.getBoolean("usePKO")) {
  const pko = new k8s.helm.v3.Release("pulumi-kubernetes-operator", {
    chart: "oci://ghcr.io/pulumi/helm-charts/pulumi-kubernetes-operator",
    version: "2.4.1",
    createNamespace: true,
  }, { provider: kubeProvider, dependsOn: [cluster] });
}

if (config.getBoolean("useDeploymentRunner")) {
  const deploymentRunner = new PulumiDeploymentRunner("deployment-runner", {
    namespace: "pulumi-deployments",
    poolName: config.get("deploymentRunnerPool") || "default",
    imageName: "pulumi/customer-managed-workflow-agent:latest-amd64",
    imagePullPolicy: "IfNotPresent",
    replicas: 1,
    agentMemQuantity: 2,
    accessToken: config.requireSecret("pulumiDeploymentToken"),
    serviceUrl: "https://api.pulumi.com",
    enableServiceMonitor: false,
  }, { providers: { kubernetes: kubeProvider }, dependsOn: [cluster] });
}

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
      namespace: 'default',
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
              namespace: 'default',
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

if(config.require("useAutoMode") === "true") {

  // EKS Auto Mode includes AWS Load Balancer Controller by default
  // For EKS 1.33+, we only need to create an IngressClass resource
  // The controller is managed by AWS and will handle the ingress resources

  const ingressClass = new k8s.networking.v1.IngressClass("alb-ingress-class", {
    metadata: {
      name: "alb",
      annotations: {
        "ingressclass.kubernetes.io/is-default-class": "true",
      },
    },
    spec: {
      controller: "eks.amazonaws.com/alb",
    },
  }, { provider: kubeProvider, dependsOn: [cluster] });

} else {
  // // AWS Load Balancer Controller setup
  const albController = new awsLoadBalancerController.AwsLoadBalancerController("load-balancer-controller", {
    clusterName: cluster.eksCluster.name,
    clusterOidcProviderArn: cluster.core.oidcProvider!.arn,
    clusterOidcProviderUrl: cluster.core.oidcProvider!.url,
    clusterVpcId: cluster.eksCluster.vpcConfig.vpcId,
    region: region,
  }, { providers: { kubernetes: kubeProvider }, dependsOn: [cluster]});
}

export const kubeconfig = cluster.kubeconfigJson;
export const clusterOidcProvider = cluster.core.oidcProvider?.url;
export const clusterOidcProviderArn = cluster.core.oidcProvider?.arn;
export const clusterIdentifier = cluster.eksCluster.id;
export const clusterName = cluster.eksCluster.name;
export const clusterSecretStoreRef = { kind: crd.kind, metadata: { name: crd.metadata.name, namespace: crd.metadata.namespace }};