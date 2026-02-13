# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Pulumi infrastructure-as-code project that provisions an AWS EKS (Elastic Kubernetes Service) cluster with various optional add-ons. The project uses TypeScript and deploys Kubernetes workloads including External Secrets Operator, ArgoCD, Flux, Prometheus, Pulumi Kubernetes Operator (PKO), and AWS Load Balancer Controller.

## Commands

### Pulumi Operations

- **Preview changes**: `pulumi preview --stack <stack-name>`
- **Deploy infrastructure**: `pulumi up --stack <stack-name>`
- **Destroy infrastructure**: `pulumi destroy --stack <stack-name>`
- **View stack outputs**: `pulumi stack output --stack <stack-name>`
- **Select stack**: `pulumi stack select <stack-name>`

Available stacks: `dev`, `prod`, `spinnaker`

### TypeScript

- **Compile TypeScript**: `tsc`
- **TypeScript compiler configuration**: `tsconfig.json` outputs to `bin/` directory

### Package Management

- **Install dependencies**: `npm install` (or `pnpm install` - pnpm lockfile is present)

## Architecture

### Main Infrastructure (`index.ts`)

The main entry point creates an EKS cluster with the following structure:

1. **EKS Cluster Setup** (lines 7-48)
   - Configurable cluster name, VPC, and subnets via Pulumi config
   - Supports both EC2 and Fargate deployment modes (`useFargate` config)
   - EKS Auto Mode enabled with node autoscaling (min: 4, desired: 4, max: 6)
   - OIDC provider enabled for IAM service account integration
   - Authentication mode: `API_AND_CONFIG_MAP`

2. **Optional Fargate Configuration** (lines 50-97)
   - Creates pod execution role and Fargate profile for External Secrets namespace when `useFargate` is true
   - Requires proper IAM role setup for EKS Fargate pods

3. **Kubernetes Provider Setup** (lines 99-113)
   - Custom Kubernetes provider using cluster kubeconfig
   - External Secrets namespace created

4. **Conditional Add-ons** (controlled by Pulumi config):
   - **Prometheus** (`usePrometheus`): kube-prometheus-stack Helm chart with ServiceMonitor support (lines 115-130)
   - **Flux** (`useFlux`): Flux v2 Helm chart in flux-system namespace (lines 132-147)
   - **ArgoCD** (`useArgoCD`): Argo CD Helm chart with Redis secret, NodePort service, and app-of-apps pattern pointing to `github.com/pulumi-initech/pulumi-argocd-apps` (lines 149-223)
   - **PKO** (`usePKO`): Pulumi Kubernetes Operator via Kustomize from GitHub (lines 225-245)

5. **External Secrets Operator** (lines 248-303)
   - Always deployed via Helm chart
   - Configured with Pulumi ESC (Environment, Secrets, Config) integration
   - ClusterSecretStore references Pulumi access token stored in Kubernetes secret
   - Organization, project, and environment pulled from config (`secretStoreEnvironment`)

6. **AWS Load Balancer Controller** (lines 305-607)
   - IAM policy with comprehensive ELB permissions (lines 310-532)
   - IAM role with OIDC trust relationship for service account
   - Kubernetes ServiceAccount with IAM role annotation
   - Helm chart deployment configured with cluster name, VPC ID, and region

### Configuration Pattern

Configuration is managed through Pulumi stack files (`Pulumi.<stack>.yaml`):
- Required: `clusterName`, `VpcId`, `PublicSubnetIds`, `PrivateSubnetIds`, `secretStoreEnvironment`, `pulumiAccessToken`, `instanceType` (if not Fargate)
- Optional: `useFargate`, `usePrometheus`, `useFlux`, `useArgoCD`, `usePKO`, `externalSecretsVersion`, `pkoVersion`, `clusterVersion`, `argoChartVersion`
- AWS region configured via `aws:region`
- Pulumi ESC environments linked via `environment` key

### Load Balancer Component (`load-balancer/`)

Separate Python-based Pulumi component for load balancer configuration:
- Located in `load-balancer/` subdirectory
- Independent Pulumi project with its own stack files
- Uses Python (`__main__.py`, `roles.py`) with Poetry for dependencies (`pyproject.toml`, `poetry.lock`)

## Key Integration Points

### OIDC and IAM Roles for Service Accounts (IRSA)

The cluster OIDC provider is used for AWS Load Balancer Controller authentication. The pattern (lines 542-564):
- Federated principal references the OIDC provider ARN
- Condition matches service account namespace and name
- Role ARN annotated on Kubernetes ServiceAccount

### External Secrets with Pulumi ESC

The ClusterSecretStore (lines 277-303) connects to Pulumi ESC:
- Retrieves secrets from specified Pulumi ESC project/environment
- Requires Pulumi access token stored in `default` namespace
- Pattern: `secretStoreEnvironment` format is `project/environment`

### ArgoCD App-of-Apps

When ArgoCD is enabled, an Application CRD is created (lines 197-222) that:
- Points to `github.com/pulumi-initech/pulumi-argocd-apps` repository
- Uses `apps` directory path
- Auto-syncs with prune and self-heal enabled
- Deploys to argocd namespace

## Component Resources

This project uses custom Pulumi ComponentResources to encapsulate complex infrastructure patterns. Component resources follow these best practices:

### Creating Component Resources

**Provider Inheritance Pattern:**
- Component resource arguments should NOT include explicit provider parameters (e.g., `kubeProvider`)
- Child resources within the component should use `{ parent: this }` in their resource options
- The provider is passed when instantiating the component using the `providers` map in `ComponentResourceOptions`

**Example:**
```typescript
// Component definition (argocd.ts)
export interface ArgoCDArgs {
  namespace?: string;
  chartVersion?: string;
  // NO kubeProvider parameter
}

export class ArgoCD extends pulumi.ComponentResource {
  constructor(name: string, args: ArgoCDArgs, opts?: pulumi.ComponentResourceOptions) {
    super("custom:k8s:ArgoCD", name, {}, opts);

    // Child resources use parent for provider inheritance
    this.namespace = new k8s.core.v1.Namespace(
      `${name}-namespace`,
      { metadata: { name: namespace } },
      { parent: this }  // Provider inherited from component
    );
  }
}

// Usage in index.ts
new ArgoCD("argocd", {
  chartVersion: "7.7.12",
}, {
  providers: { kubernetes: kubeProvider },  // Provider passed here
  dependsOn: [cluster]
});
```

**Benefits:**
- Reduces coupling between components and provider instances
- Follows Pulumi's idiomatic pattern for component resources
- Enables automatic provider inheritance to all child resources
- Makes components more reusable across different contexts

### Existing Component Resources

**AwsLoadBalancerController** (`awsLoadBalancerController.ts`):
- Encapsulates IAM policy, role, service account, and Helm chart
- Handles OIDC trust relationship for IRSA pattern
- Exports `roleArn` for stack outputs

**ArgoCD** (`argocd.ts`):
- Manages namespace, Redis secret, Helm chart, and app-of-apps Application CR
- Configurable NodePorts and repository settings
- Optional app-of-apps pattern enabled by default

## Exports

Key outputs exported for consumption by other stacks or CLI:
- `kubeconfig`: JSON-formatted kubeconfig for cluster access
- `clusterOidcProvider`: OIDC provider URL
- `clusterOidcProviderArn`: OIDC provider ARN
- `clusterIdentifier`: EKS cluster ID
- `clusterName`: EKS cluster name
- `clusterSecretStoreRef`: Reference to ClusterSecretStore CRD
- `albControllerRoleArn`: IAM role ARN for AWS Load Balancer Controller
