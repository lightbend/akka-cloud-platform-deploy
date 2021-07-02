import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

import * as config from "./config";
import * as eks from "./eks";
import * as util from "./util";

const cloud = new eks.AwsCloud();
const cluster: eks.EksKubernetesCluster = cloud.createKubernetesCluster();

// K8s namespace for operator
const namespaceName = config.operatorNamespace;

// Output the cluster's kubeconfig and name
export const kubeconfig = cluster.kubeconfig;
export const clusterName = cluster.name;

// Install k8s metrics-server
if (config.installMetricsServer) {
  new k8s.yaml.ConfigGroup("metrics-server",
    { files: "https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.4.4/components.yaml" },
    { provider: cluster.k8sProvider },
  );
}

// Create a k8s namespace for operator
const namespace = new k8s.core.v1.Namespace(namespaceName, {
  metadata: {
    // fixme: add to configuration, if DNE let pulumi generate random suffix?
    // otherwise pulumi will append a random suffix to the namespace.. might be useful for integration testing to do that
    name: namespaceName 
  }
}, {provider: cluster.k8sProvider});

// Operator namespace name
export const operatorNamespace = namespace.metadata.name;

const serviceAccountName = util.name("sa");
cloud.operatorServiceAccount(cluster, serviceAccountName, namespace);

// Install Akka Cloud Platform Helm Chart
new k8s.helm.v3.Chart("akka-operator", {
  ...config.akkaOperatorChartOpts,
  namespace: namespace.metadata.name,
  // chart values don't support shorthand value assignment syntax i.e. `serviceAccount.name: "foo"`
  values: { // fixme merge in chart value config from pulumi config
    serviceAccount: {
      name: serviceAccountName
    }
  }
}, { provider: cluster.k8sProvider});


let bootstrapServersSecretName: string | null = null;
let kafkaCluster: eks.MskKafkaCluster | null = null;

if (config.deployKafkaCluster) {

  kafkaCluster = cloud.createKafkaCluster(cluster);

  // K8s secret with bootstrap.servers connection string
  bootstrapServersSecretName = util.name("kafka-secret");
  new k8s.core.v1.Secret(bootstrapServersSecretName, {
    metadata: {
      name: bootstrapServersSecretName,
      namespace: namespace.metadata.name
    },
    stringData: {
      bootstrapServers: kafkaCluster.bootstrapBrokers
    }
  }, {provider: cluster.k8sProvider});
}

export const kafkaZookeeperConnectString = kafkaCluster?.zookeeperConnectString;
export const kafkaBootstrapBrokersTls = kafkaCluster?.bootstrapBrokersTls;
export const kafkaBootstrapBrokers = kafkaCluster?.bootstrapBrokers;
export const kafkaBootstrapServerSecret = bootstrapServersSecretName;

let jdbcSecretName: string | null = null;
let jdbc: eks.AuroraRdsDatabase | null = null;

if (config.deployJdbcDatabase) {
  jdbc = cloud.createJdbcCluster(cluster);

  jdbcSecretName = util.name("jdbc-secret");
  new k8s.core.v1.Secret(jdbcSecretName, {
    metadata: {
      name: jdbcSecretName,
      namespace: namespace.metadata.name
    },
    stringData: {
      username: jdbc.username,
      password: jdbc.password,
      connectionUrl: pulumi.interpolate `jdbc:postgresql://${jdbc.endpoint}:5432/`
    }
  }, {provider: cluster.k8sProvider});
}

export const jdbcClusterId = jdbc?.clusterId;
export const jdbcUsername = jdbc?.username;
export const jdbcPassword = jdbc?.password;
export const jdbcEndpoint = jdbc?.endpoint;
export const jdbcReaderEndpoint = jdbc?.readerEndpoint;
export const jdbcSecret = jdbcSecretName;
