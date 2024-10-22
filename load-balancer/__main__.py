"""An AWS Python Pulumi program"""

import pulumi
import pulumi_aws as aws
import json
import pulumi_kubernetes as k8s
import roles

def remove_status(obj, opts):
    foo()
    if obj["kind"] == "CustomResourceDefinition" and "status" in obj:
        del obj["status"]


stack = pulumi.get_stack()
cluster = pulumi.StackReference(f"team-ce/eks-workshop-argocd/{stack}")

oidc_arn = cluster.get_output('clusterOidcProviderArn')
oidc_url = cluster.get_output('clusterOidcProvider')

ns = "aws-lb-controller"
service_account_name = f"system:serviceaccount:{ns}:aws-lb-controller-serviceaccount"

iam_role = aws.iam.Role(
    "aws-loadbalancer-controller-role",
    assume_role_policy=pulumi.Output.all(oidc_arn, oidc_url).apply(
        lambda args: json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Principal": {
                            "Federated": args[0],
                        },
                        "Action": "sts:AssumeRoleWithWebIdentity",
                        "Condition": {
                            "StringEquals": {f"{args[1]}:sub": service_account_name},
                        },
                    }
                ],
            }
        )
    ),
)

with open("files/iam_policy.json") as policy_file:
    policy_doc = policy_file.read()

    iam_policy = aws.iam.Policy(
        "aws-loadbalancer-controller-policy",
        policy=policy_doc,
        opts=pulumi.ResourceOptions(parent=iam_role),
)

aws.iam.PolicyAttachment(
    "aws-loadbalancer-controller-attachment",
    policy_arn=iam_policy.arn,
    roles=[iam_role.name],
    opts=pulumi.ResourceOptions(parent=iam_role),
)


kubeconfig = cluster.get_output("kubeconfig")
cluster_name = cluster.get_output("clusterName")
vpc_id = cluster.get_output("vpcId")

provider = k8s.Provider("provider", kubeconfig=kubeconfig)

namespace = k8s.core.v1.Namespace(
    f"{ns}-ns",
    metadata={
        "name": ns,
        "labels": {
            "app.kubernetes.io/name": "aws-load-balancer-controller",
        }
    },
    opts=pulumi.ResourceOptions(
        provider=provider,
        parent=provider,
    )
)

service_account = k8s.core.v1.ServiceAccount(
    "aws-lb-controller-sa",
    metadata={
        "name": "aws-lb-controller-serviceaccount",
        "namespace": namespace.metadata["name"],
        "annotations": {
            "eks.amazonaws.com/role-arn": iam_role.arn.apply(lambda arn: arn)
        }
    }
)

k8s.helm.v3.Chart(
    "lb", k8s.helm.v3.ChartOpts(
        chart="aws-load-balancer-controller",
        fetch_opts=k8s.helm.v3.FetchOpts(
            repo="https://aws.github.io/eks-charts"
        ),
        namespace=namespace.metadata["name"],
        values={
            "region": "us-west-1",
            "serviceAccount": {
                "name": "aws-lb-controller-serviceaccount",
                "create": False,
            },
            "vpcId": vpc_id,
            "clusterName": cluster_name,
            "podLabels": {
                "stack": stack,
                "app": "aws-lb-controller"
            }
        },
        transformations=[remove_status]
    ), pulumi.ResourceOptions(
        provider=provider, parent=namespace
    )
)