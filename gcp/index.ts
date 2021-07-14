import * as k8s from "@pulumi/kubernetes";

import * as config from "./config";
import * as gke from "./gke";
import * as utils from "./utils";

const cloud = new gke.GcpCloud();
const cluster: gke.GcpKubernetesCluster = cloud.createKubernetesCluster();

// K8s namespace for operator
const namespaceName = config.operatorNamespace;

// Output the cluster's kubeconfig and name
export const kubeconfig = cluster.kubeconfig;
export const clusterName = cluster.name;

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

// Operator namespace name
export const operatorNamespace = namespace.metadata.name;

const serviceAccountName = utils.name("sa");
cloud.operatorServiceAccount(cluster, serviceAccountName, namespace);

// Install the license key into the namespace
new k8s.yaml.ConfigGroup("license-secret", { files: config.licenseFile }, { provider: cluster.k8sProvider });

// Install the GCP Marketplace applications CRD in the cluster
new k8s.yaml.ConfigGroup(
  "app-crd",
  { files: "https://raw.githubusercontent.com/GoogleCloudPlatform/marketplace-k8s-app-tools/master/crd/app-crd.yaml" },
  { provider: cluster.k8sProvider },
);

// Install Akka Cloud Platform Helm Chart
// From the Platform Guide: https://developer.lightbend.com/docs/akka-platform-guide/deployment/gcp-install.html
new k8s.helm.v3.Chart(
  "akka-operator",
  {
    ...config.akkaOperatorChartOpts,
    // chart values don't support shorthand value assignment syntax i.e. `serviceAccount.name: "foo"`
    values: {
      // fixme merge in chart value config from pulumi config
      serviceAccount: {
        name: serviceAccountName,
      },
      provider: {
        name: "gcp",
      },
      reportingSecret: "akka-cloud-platform-1-license",
    },
  },
  {
    provider: cluster.k8sProvider,
    customTimeouts: { create: "30m", update: "30m", delete: "30m" },
    dependsOn: [cluster.cluster],
  },
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
    {
      provider: cluster.k8sProvider,
      customTimeouts: { create: "30m", update: "30m", delete: "30m" },
      dependsOn: [cluster.cluster],
    },
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
    {
      provider: cluster.k8sProvider,
      customTimeouts: { create: "30m", update: "30m", delete: "30m" },
      dependsOn: [cluster.cluster],
    },
  );
}

const instance = cloud.createCloudSQLInstance();

export const postgreSQLInstanceConnectionName = instance.connectionName;
export const postgreSQLInstanceName = instance.name;
export const postgreSQLEndpoint = instance.endpoint;
