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

export interface RelationalDatabase {
  clusterId: pulumi.Output<any>;
  username: pulumi.Output<any>;
  password: pulumi.Output<any>;
  dbName: pulumi.Output<any>;
  endpoint: pulumi.Output<any>;
  readerEndpoint: pulumi.Output<any>;
}
