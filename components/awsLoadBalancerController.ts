import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";

export interface AwsLoadBalancerControllerArgs {
  /**
   * The EKS cluster instance
   */
  cluster: {
    eksCluster: {
      name: pulumi.Output<string>;
    };
    core: {
      oidcProvider?: {
        arn: pulumi.Output<string>;
        url: pulumi.Output<string>;
      };
      vpcId: pulumi.Output<string>;
    };
  };


  /**
   * AWS region
   */
  region: string;

  /**
   * Namespace to deploy the controller to (default: kube-system)
   */
  namespace?: string;

  /**
   * Service account name (default: aws-load-balancer-controller)
   */
  serviceAccountName?: string;

  /**
   * Helm chart version (default: 1.11.0)
   */
  chartVersion?: string;

}

/**
 * AwsLoadBalancerController is a component resource that encapsulates
 * the AWS Load Balancer Controller setup including IAM role, policy,
 * service account, and Helm chart deployment.
 */
export class AwsLoadBalancerController extends pulumi.ComponentResource {
  public readonly policy: aws.iam.Policy;
  public readonly role: aws.iam.Role;
  public readonly serviceAccount: k8s.core.v1.ServiceAccount;
  public readonly chart: k8s.helm.v4.Chart;
  public readonly roleArn: pulumi.Output<string>;

  constructor(
    name: string,
    args: AwsLoadBalancerControllerArgs,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("custom:eks:AwsLoadBalancerController", name, {}, opts);

    const namespace = args.namespace ?? "kube-system";
    const serviceAccountName = args.serviceAccountName ?? "aws-load-balancer-controller";
    const chartVersion = args.chartVersion ?? "1.11.0";

    // IAM policy document for AWS Load Balancer Controller
    const policyDocument = {
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
            "elasticloadbalancing:Describe*"
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

    // Create IAM policy
    this.policy = new aws.iam.Policy(
      `${name}-policy`,
      {
        policy: JSON.stringify(policyDocument),
        description: "IAM policy for AWS Load Balancer Controller",
      },
      { parent: this }
    );

    // Create IAM role with OIDC trust policy
    this.role = new aws.iam.Role(
      `${name}-role`,
      {
        assumeRolePolicy: pulumi.all([
          args.cluster.core.oidcProvider?.arn,
          args.cluster.core.oidcProvider?.url
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
                  [`${oidcUrl?.replace("https://", "")}:sub`]: `system:serviceaccount:${namespace}:${serviceAccountName}`,
                  [`${oidcUrl?.replace("https://", "")}:aud`]: "sts.amazonaws.com"
                }
              }
            }
          ]
        })),
        description: "IAM role for AWS Load Balancer Controller",
      },
      { parent: this }
    );

    // Attach policy to role
    const rolePolicyAttachment = new aws.iam.RolePolicyAttachment(
      `${name}-policy-attachment`,
      {
        role: this.role.name,
        policyArn: this.policy.arn,
      },
      { parent: this }
    );

    // Create Kubernetes service account
    this.serviceAccount = new k8s.core.v1.ServiceAccount(
      `${name}-sa`,
      {
        metadata: {
          name: serviceAccountName,
          namespace: namespace,
          annotations: {
            "eks.amazonaws.com/role-arn": this.role.arn,
          },
        },
      },
      { parent: this }
    );

    // Deploy AWS Load Balancer Controller using Helm
    this.chart = new k8s.helm.v4.Chart(
      `${name}-chart`,
      {
        chart: "aws-load-balancer-controller",
        version: chartVersion,
        namespace: namespace,
        repositoryOpts: {
          repo: "https://aws.github.io/eks-charts",
        },
        values: {
          clusterName: args.cluster.eksCluster.name,
          serviceAccount: {
            create: false,
            name: serviceAccountName,
          },
          region: args.region,
          vpcId: args.cluster.core.vpcId,
          podLabels: {
            app: "aws-load-balancer-controller",
            cluster: args.cluster.eksCluster.name,
          },
        },
      },
      {
        parent: this,
        dependsOn: [this.serviceAccount, rolePolicyAttachment]
      }
    );

    this.roleArn = this.role.arn;

    this.registerOutputs({
      policyArn: this.policy.arn,
      roleArn: this.role.arn,
      serviceAccountName: this.serviceAccount.metadata.name,
    });
  }
}
