/**
 * CloudCluster abstracts away Cloud-specific K8s cluster types
 */
export interface CloudCluster {
  kubeconfig: pulumi.Output<any>;
  name: pulumi.Output<any>;
  // Required to define define dependency order of the following resources of resources after cluster provisioned
  k8sProvider: k8s.Provider;
}

export interface KafkaCluster {
  zookeeperConnectString: pulumi.Output<any>;
  bootstrapBrokersTls: pulumi.Output<any>;
  bootstrapBrokers: pulumi.Output<any>;
}
