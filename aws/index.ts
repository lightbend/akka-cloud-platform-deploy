import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

import * as config from "./config";
import * as awsOTelConfig from "./otelconfig";
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
new k8s.yaml.ConfigGroup(
  "metrics-server",
  { files: "https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.4.4/components.yaml" },
  { provider: cluster.k8sProvider },
);

// Create a k8s namespace for operator
const namespace = new k8s.core.v1.Namespace(
  namespaceName,
  {
    metadata: {
      // fixme: add to configuration, if DNE let pulumi generate random suffix?
      // otherwise pulumi will append a random suffix to the namespace.. might be useful for integration testing to do that
      name: namespaceName,
    },
  },
  { provider: cluster.k8sProvider },
);

const serviceAccountName = util.name("sa");
cloud.operatorServiceAccount(cluster, serviceAccountName, namespace);

// Install Akka Cloud Platform Helm Chart
new k8s.helm.v3.Chart(
  "akka-operator",
  {
    ...config.akkaOperatorChartOpts,
    namespace: namespace.metadata.name,
    // chart values don't support shorthand value assignment syntax i.e. `serviceAccount.name: "foo"`
    values: {
      // fixme merge in chart value config from pulumi config
      serviceAccount: {
        name: serviceAccountName,
      },
    },
  },
  { provider: cluster.k8sProvider },
);

if (config.installTelemetryServices) {
  // Install Prometheus Helm Chart
  // https://prometheus-community.github.io/helm-charts/
  new k8s.helm.v3.Chart(
    "prometheus",
    {
      chart: "prometheus",
      fetchOpts: {
        repo: "https://prometheus-community.github.io/helm-charts",
      },
      // Prometheus defaults are good enough for Lightbend Telemetry, so we don't need to customize values here.
      // If you need to change something, you can check the available chart values by running:
      // $ helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
      // $ helm show values prometheus-community/prometheus
    },
    { provider: cluster.k8sProvider },
  );

  // Install Grafana Helm Chart
  // https://grafana.github.io/helm-charts
  new k8s.helm.v3.Chart(
    "grafana",
    {
      chart: "grafana",
      fetchOpts: {
        repo: "https://grafana.github.io/helm-charts",
      },
      values: {
        datasources: {
          "datasources.yaml": {
            datasources: [
              {
                name: "Cinnamon Prometheus",
                type: "prometheus",
                access: "proxy",
                url: "http://prometheus-server.default.svc.cluster.local",
                editable: true,
              },
            ],
          },
        },
      },
    },
    { provider: cluster.k8sProvider },
  );
}

let bootstrapServersSecretName: string | null = null;
let kafkaCluster: eks.MskKafkaCluster | null = null;

if (config.deployKafkaCluster) {
  kafkaCluster = cloud.createKafkaCluster(cluster);

  // K8s secret with bootstrap.servers connection string
  bootstrapServersSecretName = util.name("kafka-secret");

  new k8s.core.v1.Secret(
    bootstrapServersSecretName,
    {
      metadata: {
        name: bootstrapServersSecretName,
        namespace: namespace.metadata.name,
      },
      stringData: {
        bootstrapServers: kafkaCluster.bootstrapBrokers,
      },
    },
    { provider: cluster.k8sProvider },
  );
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
  new k8s.core.v1.Secret(
    jdbcSecretName,
    {
      metadata: {
        name: jdbcSecretName,
        namespace: namespace.metadata.name,
      },
      stringData: {
        username: jdbc.username,
        password: jdbc.password,
        connectionUrl: pulumi.interpolate`jdbc:postgresql://${jdbc.endpoint}:5432/`,
      },
    },
    { provider: cluster.k8sProvider },
  );
}

export const jdbcClusterId = jdbc?.clusterId;
export const jdbcUsername = jdbc?.username;
export const jdbcPassword = jdbc?.password;
export const jdbcEndpoint = jdbc?.endpoint;
export const jdbcReaderEndpoint = jdbc?.readerEndpoint;
export const jdbcSecret = jdbcSecretName;

export let awsOTelCollectorServiceEndpoint: string | null = null;

// AWS OTel Collector
if (config.installAwsOTelCollector) {
  // Create an AWS OTel Collector namespace
  const namespaceName = config.awsOTelCollectorNamespace;
  new k8s.core.v1.Namespace(
    namespaceName,
    {
      metadata: {
        name: namespaceName,
      },
    },
    { provider: cluster.k8sProvider },
  );

  const awsOTelCollector = "aws-otel-collector";
  const awsOTelCollectorLabels = { app: awsOTelCollector };

  // AWS OTel Collector Configuration
  const podConfig = "config.yaml";
  const podMountFolder = "/etc/otel-agent-config";
  const podMountPath = podMountFolder + "/" + podConfig;
  const awsOTelConfigMap = new k8s.core.v1.ConfigMap(
    awsOTelCollector,
    {
      metadata: {
        namespace: namespaceName,
        labels: awsOTelCollectorLabels,
        name: "aws-otel-config.yaml",
      },
      data: { [podConfig]: awsOTelConfig.readAwsOTelCollectorConfig() },
    },
    { provider: cluster.k8sProvider },
  );
  const awsOTelConfigMapName = awsOTelConfigMap.metadata.name;

  const configVolumeName = "config";
  const awsOTelCollectorConfig = awsOTelConfig.getAwsOTelCollectorConfig();
  const zipkinPort = awsOTelCollectorConfig.zipkinPort;
  pulumi.log.debug(`Zipkin port: ${zipkinPort}`);
  const healthCheckPort = awsOTelCollectorConfig.healthCheckPort;
  pulumi.log.debug(`Health check port: ${healthCheckPort}`);

  const collectorArgs = ["--config=" + podMountPath];
  if (config.awsOTelCollectorDebug) {
    collectorArgs.push("--log-level=DEBUG");
  }

  // Create an AWS OTel Collector deployment
  new k8s.apps.v1.Deployment(
    awsOTelCollector,
    {
      metadata: {
        namespace: namespaceName,
        name: awsOTelCollector,
        labels: awsOTelCollectorLabels,
      },
      spec: {
        minReadySeconds: 5,
        progressDeadlineSeconds: 120,
        replicas: 1,
        selector: { matchLabels: awsOTelCollectorLabels },
        template: {
          metadata: { labels: awsOTelCollectorLabels },
          spec: {
            containers: [
              {
                name: awsOTelCollector,
                image: "amazon/aws-otel-collector:latest",
                command: ["/awscollector"],
                args: collectorArgs,
                volumeMounts: [{ name: configVolumeName, mountPath: podMountFolder }],
                resources: {
                  limits: {
                    cpu: "256m",
                    memory: "512Mi",
                  },
                  requests: {
                    cpu: "32m",
                    memory: "24Mi",
                  },
                },
                ports: [{ containerPort: zipkinPort }],
                livenessProbe: { httpGet: { path: "/", port: healthCheckPort } },
                readinessProbe: { httpGet: { path: "/", port: healthCheckPort } },
                env: [
                  // AWS region and credentials to connect to XRay
                  { name: "AWS_REGION", value: config.awsXRayRegion },
                  { name: "AWS_ACCESS_KEY_ID", value: config.awsXRayAccessKeyID },
                  { name: "AWS_SECRET_ACCESS_KEY", value: config.awsXRaySecretAccessKey },
                ],
              },
            ],
            volumes: [
              {
                name: configVolumeName,
                configMap: { name: awsOTelConfigMapName },
              },
            ],
          },
        },
      },
    },
    { provider: cluster.k8sProvider },
  );

  // Create an AWS OTel Collector service
  const serviceName = `${awsOTelCollector}-svc`;

  new k8s.core.v1.Service(
    serviceName,
    {
      metadata: {
        labels: awsOTelCollectorLabels,
        name: serviceName,
        namespace: namespaceName,
      },
      spec: {
        type: k8s.core.v1.ServiceSpecType.ClusterIP,
        ports: [{ port: zipkinPort }],
        selector: awsOTelCollectorLabels,
      },
    },
    { provider: cluster.k8sProvider },
  );

  awsOTelCollectorServiceEndpoint = `${serviceName}.${namespaceName}.svc.cluster.local`;
}
