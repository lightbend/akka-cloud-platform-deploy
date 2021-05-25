import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as gcp from "@pulumi/gcp";

import * as model from "./model";
import * as config from "./config";

class GcpKubernetesCluster implements model.KubernetesCluster {
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

export class GcpCloud implements model.Cloud {
  /**
   * Creates a GCP cluster.
   */
   createKubernetesCluster(): model.KubernetesCluster {
     // Create a GKE cluster
     const engineVersion = gcp.container.getEngineVersions().then(v => v.latestMasterVersion);
     const cluster = new gcp.container.Cluster(config.clusterName, {
       location: config.zone,
       initialNodeCount: 1,
       minMasterVersion: engineVersion,
       nodeVersion: engineVersion,
       removeDefaultNodePool: true,
       // needed for VPC native cluster
       // keeping the cidr blocks empty means GKE will automatically set them up
       ipAllocationPolicy: { clusterIpv4CidrBlock: "", servicesIpv4CidrBlock: "" }
     });

     // separate node pool
     const primaryPreemptibleNodes = new gcp.container.NodePool("primarynodes", {
       location: config.zone,
       cluster: cluster.name,
       initialNodeCount: config.initialNodeCountInCluster,
       autoscaling: {
         maxNodeCount: config.autoscalingMaxNodeCount,
         minNodeCount: config.autoscalingMinNodeCount
       },
       nodeConfig: {
         preemptible: true,
         machineType: "n1-standard-4",
         oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
       },
     });

     const kubeconfig = pulumi.
         all([ cluster.name, cluster.endpoint, cluster.masterAuth ]).
         apply(([ name, endpoint, masterAuth ]) => {
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
     const clusterProvider = new k8s.Provider("gcp-k8s", {
         kubeconfig: kubeconfig,
         namespace: config.operatorNamespace
     });

     return new GcpKubernetesCluster(cluster, kubeconfig, clusterProvider);
   }

   operatorServiceAccount(
    kubernetesCluster: model.KubernetesCluster, 
    serviceAccountName: string, 
    namespace: k8s.core.v1.Namespace) {

    if (!(kubernetesCluster instanceof GcpKubernetesCluster)) {
      throw new Error("Invalid KubernetesCluster provided")
    }

    let gkeCluster = (kubernetesCluster as GcpKubernetesCluster).cluster;

    // Create a Service Account with the IAM role annotated to use with the Pod.
    let sa = new k8s.core.v1.ServiceAccount(
      serviceAccountName,
      {
        metadata: {
          namespace: namespace.metadata.name,
          name: serviceAccountName
        },
      }, { provider: kubernetesCluster.k8sProvider});

    return sa;
  }

  // Direct connectivity between GKE and Cloud SQL via a private IP is only possible 
  // if using a Native VPC cluster otherwise the Cloud SQL proxy is required.
  createCloudSQLInstance(): gcp.sql.DatabaseInstance {
    const networkId = `projects/${ gcp.config.project }/global/networks/default`; 
    const privateIpAddress = new gcp.compute.GlobalAddress("akka-private-ip-address", {
      purpose: "VPC_PEERING",
      addressType: "INTERNAL",
      prefixLength: 16,
      network: networkId
    }, {});
    
    const privateVpcConnection = new gcp.servicenetworking.Connection("akka-private-vpc-connection", {
      network: networkId,
      service: "servicenetworking.googleapis.com",
      reservedPeeringRanges: [privateIpAddress.name],
    }, {});

    const instance = new gcp.sql.DatabaseInstance("instance", {
      databaseVersion: "POSTGRES_12",
      region: config.region,
      project: gcp.config.project,
      settings: {
          tier: "db-f1-micro",
          ipConfiguration: {
              ipv4Enabled: true,
              privateNetwork: networkId,
          },
      },
      deletionProtection: false,
    }, {
      dependsOn: [privateVpcConnection],
    });
    return instance;
  }

}
