import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

import * as config from "./config";
import * as eks from "./eks";
import * as model from "./model";
import * as util from "./util";

let cloud: model.Cloud;

if (config.cloud == config.AwsCloud)
  cloud = new eks.AwsCloud();
else
  throw new Error(`invalid cloud configuration: ${config.cloud}`);

let cluster: model.KubernetesCluster = cloud.createKubernetesCluster();

// K8s namespace for operator
let namespaceName = config.operatorNamespace;

// Output the cluster's kubeconfig and name
export const kubeconfig = cluster.kubeconfig;
export const clusterName = cluster.name;

// fixme use tag, or copy yaml locally to control the version
// fixme add tag to configuration
// Install k8s metrics-server
if (config.installMetricsServer) {
  const metricsServer = new k8s.yaml.ConfigGroup("metrics-server",
    { files: "https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml" },
    { provider: cluster.k8sProvider },
  );
}

// Create a k8s namespace for operator
let namespace = new k8s.core.v1.Namespace(namespaceName, {
  metadata: {
    // fixme: add to configuration, if DNE let pulumi generate random suffix?
    // otherwise pulumi will append a random suffix to the namespace.. might be useful for integration testing to do that
    name: namespaceName 
  }
}, {provider: cluster.k8sProvider});

// Operator namespace name
export const operatorNamespace = namespace.metadata.name;

let serviceAccountName = util.name("sa");

let serviceAccount = cloud.operatorServiceAccount(cluster, serviceAccountName, namespace);

// Install Akka Cloud Platform Helm Chart
let akkaPlatformOperatorChart = new k8s.helm.v3.Chart("akka-operator", {
  chart: "akka-operator",
  namespace: namespace.metadata.name,
  version: "1.1.19", // # fixme: add to configuration, omit `version` field to get latest
  fetchOpts: {
    repo: "https://lightbend.github.io/akka-operator-helm/"
  },
  // chart values don't support shorthand value assignment syntax i.e. `serviceAccount.name: "foo"`
  values: { // fixme merge in chart value config from pulumi config
    serviceAccount: {
      name: serviceAccountName
    }
  }
}, { provider: cluster.k8sProvider});


let bootstrapServersSecretName: string | null = null;
let kafkaCluster: model.KafkaCluster | null = null;

if (config.deployKafkaCluster) {

  kafkaCluster = cloud.createKafkaCluster(cluster);

  // K8s secret with bootstrap.servers connection string
  bootstrapServersSecretName = util.name("kafka-secret");
  let bootstrapServersSecret = new k8s.core.v1.Secret(bootstrapServersSecretName, {
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
let jdbc: model.JdbcDatabase | null = null;

if (config.deployJdbcDatabase) {
  jdbc = cloud.createJdbcCluster(cluster);

  jdbcSecretName = util.name("jdbc-secret");
  let jdbcSecretResource = new k8s.core.v1.Secret(jdbcSecretName, {
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
