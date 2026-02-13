import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";

export interface ArgoCDArgs {

  /**
   * Namespace to deploy ArgoCD to (default: argocd)
   */
  namespace?: string;

  /**
   * Helm chart version (default: 7.7.12)
   */
  chartVersion?: string;

  /**
   * NodePort for HTTP (default: 30081)
   */
  nodePortHttp?: number;

  /**
   * NodePort for HTTPS (default: 30444)
   */
  nodePortHttps?: number;

  /**
   * App-of-apps repository URL
   */
  appOfAppsRepoUrl?: string;

  /**
   * App-of-apps target revision (default: HEAD)
   */
  appOfAppsRevision?: string;

  /**
   * App-of-apps path in repository (default: apps)
   */
  appOfAppsPath?: string;

  /**
   * Enable app-of-apps Application CR (default: true)
   */
  enableAppOfApps?: boolean;
}

/**
 * ArgoCD is a component resource that encapsulates the ArgoCD deployment
 * including namespace, Redis secret, Helm chart, and optional app-of-apps pattern.
 */
export class ArgoCD extends pulumi.ComponentResource {
  public readonly namespace: k8s.core.v1.Namespace;
  public readonly redisSecret: k8s.core.v1.Secret;
  public readonly chart: k8s.helm.v4.Chart;
  public readonly appOfApps?: k8s.apiextensions.CustomResource;

  constructor(
    name: string,
    args: ArgoCDArgs,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("custom:k8s:ArgoCD", name, {}, opts);

    const namespace = args.namespace ?? "argocd";
    const chartVersion = args.chartVersion ?? "7.7.12";
    const nodePortHttp = args.nodePortHttp ?? 30081;
    const nodePortHttps = args.nodePortHttps ?? 30444;
    const enableAppOfApps = args.enableAppOfApps ?? true;
    const appOfAppsRepoUrl = args.appOfAppsRepoUrl ?? "https://github.com/pulumi-initech/pulumi-argocd-apps.git";
    const appOfAppsRevision = args.appOfAppsRevision ?? "HEAD";
    const appOfAppsPath = args.appOfAppsPath ?? "apps";

    // Create namespace
    this.namespace = new k8s.core.v1.Namespace(
      `${name}-namespace`,
      {
        metadata: { name: namespace }
      },
      { parent: this }
    );

    // Create Redis password and secret
    const redisPasswordResource = new random.RandomPassword(
      `${name}-redis-password`,
      { length: 16 },
      { parent: this }
    );

    this.redisSecret = new k8s.core.v1.Secret(
      `${name}-redis-secret`,
      {
        metadata: {
          name: "argocd-redis",
          namespace: this.namespace.metadata.name,
        },
        type: "Opaque",
        stringData: {
          auth: redisPasswordResource.result,
        },
      },
      { parent: this, dependsOn: [this.namespace] }
    );

    // Deploy ArgoCD Helm chart
    this.chart = new k8s.helm.v4.Chart(
      `${name}-chart`,
      {
        namespace: this.namespace.metadata.name,
        chart: "argo-cd",
        repositoryOpts: {
          repo: "https://argoproj.github.io/argo-helm",
        },
        version: chartVersion,
        values: {
          fullNameOverride: "",
          installCRDs: true,
          createClusterRoles: true,
          createAggregateRoles: true,
          createNamespace: false,
          server: {
            service: {
              type: "NodePort",
              nodePortHttp: nodePortHttp,
              nodePortHttps: nodePortHttps,
            },
          },
        },
      },
      { parent: this, dependsOn: [this.namespace] }
    );

    // Optionally create app-of-apps Application CR
    if (enableAppOfApps) {
      this.appOfApps = new k8s.apiextensions.CustomResource(
        `${name}-application`,
        {
          apiVersion: "argoproj.io/v1alpha1",
          kind: "Application",
          metadata: {
            name: "pulumi-argocd-apps",
            namespace: namespace,
          },
          spec: {
            project: "default",
            source: {
              repoURL: appOfAppsRepoUrl,
              targetRevision: appOfAppsRevision,
              path: appOfAppsPath,
            },
            destination: {
              server: "https://kubernetes.default.svc",
              namespace: namespace,
            },
            syncPolicy: {
              automated: {
                prune: true,
                selfHeal: true,
              },
            },
          },
        },
        { parent: this, dependsOn: [this.chart] }
      );
    }

    this.registerOutputs({
      namespaceName: this.namespace.metadata.name,
    });
  }
}
