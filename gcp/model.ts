import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";

export interface KubernetesCluster {
  kubeconfig: pulumi.Output<any>;
  name: pulumi.Output<any>;
  k8sProvider: k8s.Provider;
}

export interface Cloud {
  createKubernetesCluster(): KubernetesCluster;
  operatorServiceAccount(
    kubernetesCluster: KubernetesCluster, 
    serviceAccountName: string, 
    namespace: k8s.core.v1.Namespace): k8s.core.v1.ServiceAccount;
  createCloudSQLInstance(): gcp.sql.DatabaseInstance;
}