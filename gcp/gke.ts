import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as gcp from "@pulumi/gcp";

import * as config from "./config";
import * as util from "./utils";

export class GcpKubernetesCluster {
  cluster: gcp.container.Cluster;
  kubeconfig: pulumi.Output<any>;
  name: pulumi.Output<any>;
  k8sProvider: k8s.Provider;

  constructor(cluster: gcp.container.Cluster, kubeconfig: pulumi.Output<any>, provider: k8s.Provider) {
    this.cluster = cluster;
    this.kubeconfig = kubeconfig;
    this.name = cluster.id;
    this.k8sProvider = provider;
  }
}

class CloudSQLDatabaseInstance {
  name: pulumi.Output<any>;
  connectionName: pulumi.Output<any>;
  endpoint: pulumi.Output<any>;

  constructor(dbInstance: gcp.sql.DatabaseInstance) {
    this.name = dbInstance.name;
    this.connectionName = dbInstance.connectionName;
    this.endpoint = dbInstance.privateIpAddress;
  }
}

export class GcpCloud {
  /**
   * Creates a GCP cluster.
   */
  createKubernetesCluster(): GcpKubernetesCluster {
    const createdAt = new Date();
    // Create a GKE cluster
    const engineVersion = gcp.container.getEngineVersions().then((v) => v.latestMasterVersion);
    const cluster = new gcp.container.Cluster(util.name("gke"), {
      location: gcp.config.zone,
      minMasterVersion: engineVersion,
      nodeVersion: engineVersion,
      releaseChannel: {
        // See available channels here:
        // https://cloud.google.com/kubernetes-engine/docs/concepts/release-channels
        // Regular:
        //    Access GKE and Kubernetes features reasonably soon after they debut, but on a version that
        //    has been qualified over a longer period of time. Offers a balance of feature availability
        //    and release stability, and is what we recommend for most users.
        channel: "REGULAR",
      },
      resourceLabels: {
        "pulumi-stack": pulumi.getStack(),
        "pulumi-project": pulumi.getProject(),
        // Not using `getTime` to avoid updating the resource too often
        "pulumi-created-at": `${createdAt.getUTCFullYear()}-${createdAt.getUTCMonth()}-${createdAt.getUTCDate()}`,
      },
      networkingMode: "VPC_NATIVE",
      // needed for VPC native cluster
      // keeping the cidr blocks empty means GKE will automatically set them up
      ipAllocationPolicy: { clusterIpv4CidrBlock: "", servicesIpv4CidrBlock: "" },
      // We can't create a cluster with no node pool defined, but we want to only use
      // separately managed node pools. So we create the smallest possible default
      // node pool and immediately delete it.
      initialNodeCount: 1,
      removeDefaultNodePool: true,
    });

    // separate node pool
    const nodePool = new gcp.container.NodePool(
      // There is a short limit for the node pool name on GCP, and `util.name` appends
      // multiple information to it, so better to keep the "base name" short.
      util.name("primary"),
      {
        ...config.Gke.nodePoolArgs(cluster.name, gcp.config.zone),
        version: engineVersion,
        management: {
          autoRepair: true,
          autoUpgrade: true, // MUST be true if the releaseChannel is "REGULAR"
        },
      },
      {
        dependsOn: [cluster],
      },
    );

    // Manufacture a GKE-style kubeconfig. Note that this is slightly "different"
    // because of the way GKE requires gcloud to be in the picture for cluster
    // authentication (rather than using the client cert/key directly).
    const kubeconfig = pulumi
      .all([cluster.name, cluster.endpoint, cluster.masterAuth])
      .apply(([name, endpoint, masterAuth]) => {
        const context = `${gcp.config.project}_${gcp.config.zone}_${name}`;
        return `apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: ${masterAuth.clusterCaCertificate}
    server: https://${endpoint}
  name: ${context}
contexts:
- context:
    cluster: ${context}
    user: ${context}
  name: ${context}
current-context: ${context}
kind: Config
preferences: {}
users:
- name: ${context}
  user:
    auth-provider:
      config:
        cmd-args: config config-helper --format=json
        cmd-path: gcloud
        expiry-key: '{.credential.token_expiry}'
        token-key: '{.credential.access_token}'
      name: gcp
`;
      });

    // Create a Kubernetes provider instance that uses our cluster from above.
    const clusterProvider = new k8s.Provider(
      util.name("gcp-k8s"),
      {
        kubeconfig: kubeconfig,
        namespace: config.AkkaOperator.Namespace,
      },
      {
        dependsOn: [nodePool],
      },
    );

    return new GcpKubernetesCluster(cluster, kubeconfig, clusterProvider);
  }

  operatorServiceAccount(
    kubernetesCluster: GcpKubernetesCluster,
    serviceAccountName: string,
    namespace: k8s.core.v1.Namespace,
  ): k8s.core.v1.ServiceAccount {
    // Create a Service Account with the IAM role annotated to use with the Pod.
    return new k8s.core.v1.ServiceAccount(
      serviceAccountName,
      {
        metadata: {
          namespace: namespace.metadata.name,
          name: serviceAccountName,
        },
      },
      { provider: kubernetesCluster.k8sProvider },
    );
  }

  // Direct connectivity between GKE and Cloud SQL via a private IP is only possible
  // if using a Native VPC cluster otherwise the Cloud SQL proxy is required.
  createCloudSQLInstance(): CloudSQLDatabaseInstance {
    const networkId = `projects/${gcp.config.project}/global/networks/default`;
    const privateIpAddress = new gcp.compute.GlobalAddress(util.name("akka-private-ip-address"), {
      purpose: "VPC_PEERING",
      addressType: "INTERNAL",
      prefixLength: 16,
      network: networkId,
    });

    const privateVpcConnection = new gcp.servicenetworking.Connection(util.name("akka-private-vpc-connection"), {
      network: networkId,
      service: "servicenetworking.googleapis.com",
      reservedPeeringRanges: [privateIpAddress.name],
    });

    const instance = new gcp.sql.DatabaseInstance(
      util.name("instance"),
      config.CloudSql.databaseInstanceArgs(gcp.config.project, networkId),
      { dependsOn: [privateVpcConnection] },
    );
    return new CloudSQLDatabaseInstance(instance);
  }
}
