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

// AWS Load Balancer Controller setup
const albControllerNamespace = "kube-system";
const albServiceAccountName = "aws-load-balancer-controller";

// IAM policy for AWS Load Balancer Controller
const albControllerPolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["iam:CreateServiceLinkedRole"],
      Resource: "*",
      Condition: {
        StringEquals: {
          "iam:AWSServiceName": "elasticloadbalancing.amazonaws.com"
        }
      }
    },
    {
      Effect: "Allow",
      Action: [
        "ec2:DescribeAccountAttributes",
        "ec2:DescribeAddresses",
        "ec2:DescribeAvailabilityZones",
        "ec2:DescribeInternetGateways",
        "ec2:DescribeVpcs",
        "ec2:DescribeVpcPeeringConnections",
        "ec2:DescribeSubnets",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeInstances",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DescribeTags",
        "ec2:GetCoipPoolUsage",
        "ec2:DescribeCoipPools",
        "elasticloadbalancing:DescribeLoadBalancers",
        "elasticloadbalancing:DescribeLoadBalancerAttributes",
        "elasticloadbalancing:DescribeListeners",
        "elasticloadbalancing:DescribeListenerCertificates",
        "elasticloadbalancing:DescribeSSLPolicies",
        "elasticloadbalancing:DescribeRules",
        "elasticloadbalancing:DescribeTargetGroups",
        "elasticloadbalancing:DescribeTargetGroupAttributes",
        "elasticloadbalancing:DescribeTargetHealth",
        "elasticloadbalancing:DescribeTags"
      ],
      Resource: "*"
    },
    {
      Effect: "Allow",
      Action: [
        "cognito-idp:DescribeUserPoolClient",
        "acm:ListCertificates",
        "acm:DescribeCertificate",
        "iam:ListServerCertificates",
        "iam:GetServerCertificate",
        "waf-regional:GetWebACL",
        "waf-regional:GetWebACLForResource",
        "waf-regional:AssociateWebACL",
        "waf-regional:DisassociateWebACL",
        "wafv2:GetWebACL",
        "wafv2:GetWebACLForResource",
        "wafv2:AssociateWebACL",
        "wafv2:DisassociateWebACL",
        "shield:GetSubscriptionState",
        "shield:DescribeProtection",
        "shield:CreateProtection",
        "shield:DeleteProtection"
      ],
      Resource: "*"
    },
    {
      Effect: "Allow",
      Action: [
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupIngress"
      ],
      Resource: "*"
    },
    {
      Effect: "Allow",
      Action: ["ec2:CreateSecurityGroup"],
      Resource: "*"
    },
    {
      Effect: "Allow",
      Action: ["ec2:CreateTags"],
      Resource: "arn:aws:ec2:*:*:security-group/*",
      Condition: {
        StringEquals: {
          "ec2:CreateAction": "CreateSecurityGroup"
        },
        Null: {
          "aws:RequestTag/elbv2.k8s.aws/cluster": "false"
        }
      }
    },
    {
      Effect: "Allow",
      Action: ["ec2:CreateTags", "ec2:DeleteTags"],
      Resource: "arn:aws:ec2:*:*:security-group/*",
      Condition: {
        Null: {
          "aws:RequestTag/elbv2.k8s.aws/cluster": "true",
          "aws:ResourceTag/elbv2.k8s.aws/cluster": "false"
        }
      }
    },
    {
      Effect: "Allow",
      Action: [
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:DeleteSecurityGroup"
      ],
      Resource: "*",
      Condition: {
        Null: {
          "aws:ResourceTag/elbv2.k8s.aws/cluster": "false"
        }
      }
    },
    {
      Effect: "Allow",
      Action: [
        "elasticloadbalancing:CreateLoadBalancer",
        "elasticloadbalancing:CreateTargetGroup"
      ],
      Resource: "*",
      Condition: {
        Null: {
          "aws:RequestTag/elbv2.k8s.aws/cluster": "false"
        }
      }
    },
    {
      Effect: "Allow",
      Action: [
        "elasticloadbalancing:CreateListener",
        "elasticloadbalancing:DeleteListener",
        "elasticloadbalancing:CreateRule",
        "elasticloadbalancing:DeleteRule"
      ],
      Resource: "*"
    },
    {
      Effect: "Allow",
      Action: [
        "elasticloadbalancing:AddTags",
        "elasticloadbalancing:RemoveTags"
      ],
      Resource: [
        "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
        "arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*",
        "arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*"
      ],
      Condition: {
        Null: {
          "aws:RequestTag/elbv2.k8s.aws/cluster": "true",
          "aws:ResourceTag/elbv2.k8s.aws/cluster": "false"
        }
      }
    },
    {
      Effect: "Allow",
      Action: [
        "elasticloadbalancing:AddTags",
        "elasticloadbalancing:RemoveTags"
      ],
      Resource: [
        "arn:aws:elasticloadbalancing:*:*:listener/net/*/*/*",
        "arn:aws:elasticloadbalancing:*:*:listener/app/*/*/*",
        "arn:aws:elasticloadbalancing:*:*:listener-rule/net/*/*/*",
        "arn:aws:elasticloadbalancing:*:*:listener-rule/app/*/*/*"
      ]
    },
    {
      Effect: "Allow",
      Action: [
        "elasticloadbalancing:ModifyLoadBalancerAttributes",
        "elasticloadbalancing:SetIpAddressType",
        "elasticloadbalancing:SetSecurityGroups",
        "elasticloadbalancing:SetSubnets",
        "elasticloadbalancing:DeleteLoadBalancer",
        "elasticloadbalancing:ModifyTargetGroup",
        "elasticloadbalancing:ModifyTargetGroupAttributes",
        "elasticloadbalancing:DeleteTargetGroup"
      ],
      Resource: "*",
      Condition: {
        Null: {
          "aws:ResourceTag/elbv2.k8s.aws/cluster": "false"
        }
      }
    },
    {
      Effect: "Allow",
      Action: [
        "elasticloadbalancing:AddTags"
      ],
      Resource: [
        "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
        "arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*",
        "arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*"
      ],
      Condition: {
        StringEquals: {
          "elasticloadbalancing:CreateAction": [
            "CreateTargetGroup",
            "CreateLoadBalancer"
          ]
        },
        Null: {
          "aws:RequestTag/elbv2.k8s.aws/cluster": "false"
        }
      }
    },
    {
      Effect: "Allow",
      Action: [
        "elasticloadbalancing:RegisterTargets",
        "elasticloadbalancing:DeregisterTargets"
      ],
      Resource: "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*"
    },
    {
      Effect: "Allow",
      Action: [
        "elasticloadbalancing:SetWebAcl",
        "elasticloadbalancing:ModifyListener",
        "elasticloadbalancing:AddListenerCertificates",
        "elasticloadbalancing:RemoveListenerCertificates",
        "elasticloadbalancing:ModifyRule"
      ],
      Resource: "*"
    }
  ]
};

// Create IAM policy for AWS Load Balancer Controller
const albControllerPolicy = new aws.iam.Policy("aws-load-balancer-controller-policy", {
  policy: JSON.stringify(albControllerPolicyDocument),
  description: "IAM policy for AWS Load Balancer Controller",
});

// Create IAM role for AWS Load Balancer Controller with OIDC trust policy
const albControllerRole = new aws.iam.Role("aws-load-balancer-controller-role", {
  assumeRolePolicy: pulumi.all([
    cluster.core.oidcProvider?.arn,
    cluster.core.oidcProvider?.url
  ]).apply(([oidcArn, oidcUrl]) => JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: {
          Federated: oidcArn
        },
        Action: "sts:AssumeRoleWithWebIdentity",
        Condition: {
          StringEquals: {
            [`${oidcUrl?.replace("https://", "")}:sub`]: `system:serviceaccount:${albControllerNamespace}:${albServiceAccountName}`,
            [`${oidcUrl?.replace("https://", "")}:aud`]: "sts.amazonaws.com"
          }
        }
      }
    ]
  })),
  description: "IAM role for AWS Load Balancer Controller",
});

// Attach policy to role
const albControllerRolePolicyAttachment = new aws.iam.RolePolicyAttachment("aws-load-balancer-controller-policy-attachment", {
  role: albControllerRole.name,
  policyArn: albControllerPolicy.arn,
});

// Create service account for AWS Load Balancer Controller
const albControllerServiceAccount = new k8s.core.v1.ServiceAccount("aws-load-balancer-controller-sa", {
  metadata: {
    name: albServiceAccountName,
    namespace: albControllerNamespace,
    annotations: {
      "eks.amazonaws.com/role-arn": albControllerRole.arn,
    },
  },
}, { provider: kubeProvider, dependsOn: [cluster] });

// Deploy AWS Load Balancer Controller using Helm
const albController = new k8s.helm.v4.Chart("aws-load-balancer-controller", {
  chart: "aws-load-balancer-controller",
  version: "1.11.0", // Latest stable version
  namespace: albControllerNamespace,
  repositoryOpts: {
    repo: "https://aws.github.io/eks-charts",
  },
  values: {
    clusterName: cluster.eksCluster.name,
    serviceAccount: {
      create: false,
      name: albServiceAccountName,
    },
    region: region,
    vpcId: cluster.core.vpcId,
    podLabels: {
      app: "aws-load-balancer-controller",
      cluster: name,
    },
  },
}, { 
  provider: kubeProvider, 
  dependsOn: [cluster, albControllerServiceAccount, albControllerRolePolicyAttachment] 
});

export const kubeconfig = cluster.kubeconfigJson;
export const clusterOidcProvider = cluster.core.oidcProvider?.url;
export const clusterOidcProviderArn = cluster.core.oidcProvider?.arn;
export const clusterIdentifier = cluster.eksCluster.id;
export const clusterName = cluster.eksCluster.name;
export const clusterSecretStoreRef = { kind: crd.kind, metadata: { name: crd.metadata.name, namespace: crd.metadata.namespace }};
export const albControllerRoleArn = albControllerRole.arn;