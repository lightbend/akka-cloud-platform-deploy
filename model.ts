import * as k8s from "@pulumi/kubernetes";

export interface KubernetesCluster {
  kubeconfig: pulumi.Output<any>;
  name: pulumi.Output<any>;
  k8sProvider: k8s.Provider;
}

export interface KafkaCluster {
  zookeeperConnectString: pulumi.Output<any>;
  bootstrapBrokersTls: pulumi.Output<any>;
  bootstrapBrokers: pulumi.Output<any>;
}

export interface JdbcDatabase {
  clusterId: pulumi.Output<any>;
  username: pulumi.Output<any>;
  password: pulumi.Output<any>;
  dbName: pulumi.Output<any>;
  endpoint: pulumi.Output<any>;
  readerEndpoint: pulumi.Output<any>;
}

export interface Cloud {
  createKubernetesCluster(): KubernetesCluster;
  operatorServiceAccount(
    kubernetesCluster: KubernetesCluster, 
    serviceAccountName: string, 
    namespace: k8s.core.v1.Namespace): k8s.core.v1.ServiceAccount;
  createKafkaCluster(kubernetesCluster: KubernetesCluster): KafkaCluster;
  createJdbcCluster(kubernetesCluster: KubernetesCluster): JdbcDatabase;
}
