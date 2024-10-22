import * as pulumi from "@pulumi/pulumi";
import * as eks from "@pulumi/eks";
import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumiservice from "@pulumi/pulumiservice";
import { StackSettings } from "@pulumi-initech/stack-management";

const config = new pulumi.Config();

const name = config.require("clusterName");
const vpcId = config.require("VpcId");
const publicSubnetIds = config.requireObject<string[]>("PublicSubnetIds");
const privateSubnetIds = config.requireObject<string[]>("PrivateSubnetIds");
const useFargate = config.getBoolean("useFargate") ?? false;
const secretStoreEnvironment = config.require("secretStoreEnvironment");
const externalSecretsVersion = config.get("externalSecretsVersion") ?? "0.10.4";

const clusterOptions: eks.ClusterOptions = {
  vpcId: vpcId,
  privateSubnetIds: privateSubnetIds,
  publicSubnetIds: publicSubnetIds,
  createOidcProvider: true,
  fargate: useFargate,
  tags: {
    Owner: "jconnell@pulumi.com",
  },
};

if (!useFargate) {
  clusterOptions.instanceType = config.require("instanceType")
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
                      Service: "eks-fargate-pods.amazonaws.com"
                  },
                  Action: "sts:AssumeRole"
              }
          ],
      }),
  });

  // Attach the AmazonEKSFargatePodExecutionRolePolicy to the role
  const podExecutionRolePolicyAttachment = new aws.iam.RolePolicyAttachment("podExecutionRolePolicyAttachment", {
      role: podExecutionRole.name,
      policyArn: "arn:aws:iam::aws:policy/AmazonEKSFargatePodExecutionRolePolicy",
  });

  new aws.eks.FargateProfile("externalSecrets", {
    clusterName: cluster.eksCluster.name,
    podExecutionRoleArn: podExecutionRole.arn,
    subnetIds: cluster.core.privateSubnetIds,
    selectors: [{
      "namespace": "external-secrets"
    }]
  }, { dependsOn: [cluster]})
}

const kubeProvider = new k8s.Provider("kube", {
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

// // Deploy a Helm release into the namespace
const externalSecrets = new k8s.helm.v4.Chart("external-secrets", {
    chart: "external-secrets",
    version: externalSecretsVersion, // Specify the version of the chart
    namespace: ns.metadata.name,
    repositoryOpts: {
        repo: "https://charts.external-secrets.io",
    },
}, { provider: kubeProvider, dependsOn: [cluster] });

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

const crd = new k8s.apiextensions.CustomResource("cluster-secret-store", {
    apiVersion: "external-secrets.io/v1beta1",
    kind: "ClusterSecretStore",
    metadata: {
        name: "secret-store"
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
}, { provider: kubeProvider, dependsOn: [externalSecrets, cluster] });

const organization = pulumi.getOrganization();
const project = pulumi.getProject()
const stack = pulumi.getStack()
const stackName = `${project}/${stack}`;

export const kubeconfig = cluster.kubeconfigJson;
export const clusterOidcProvider = cluster.core.oidcProvider?.url;
export const clusterOidcProviderArn = cluster.core.oidcProvider?.arn;
export const clusterName = cluster.eksCluster.name;
export const clusterSecretStoreRef = { kind: crd.kind, metadata: { name: crd.metadata.name, namespace: crd.metadata.namespace }};


// new StackSettings("settings", {
//   driftManagement: "",
//   "stackOutputs": [
//     "kubeconfig",
//     "clusterOidcProvider",
//     "clusterOidcProviderArn",
//     "clusterSecretStoreRef"
//   ]
// });

// ESC environment to advertise outputs
const esc = new pulumiservice.Environment("stack-env", {
  name: `${stack}-outputs`,
  project: project,
  organization: organization,
  yaml: new pulumi.asset.StringAsset(`
values:
  stackRef:
    fn::open::pulumi-stacks:
      stacks:
        eks:
          stack: ${stackName}
  pulumiConfig:
    kubeConfig: \${stackRef.eks.kubeconfig}
    cluserOidcProvider: \${stackRef.eks.cluserOidcProvider}
    clusterOidcPrivderArn: \${stackRef.eks.clusterOidcPrivderArn}
    clusterSecretStoreRef: \${stackRef.eks.clusterSecretStoreRef}
  files:
    KUBECONFIG: \${stackRef.eks.kubeconfig}`),
  
});