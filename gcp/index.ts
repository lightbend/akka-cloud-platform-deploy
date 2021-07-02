import * as k8s from "@pulumi/kubernetes";

import * as config from "./config";
import * as model from "./model";
import * as gke from "./gke";
import * as utils from "./utils";

let cloud: model.Cloud;

if (config.cloud == config.GcpCloud)
  cloud = new gke.GcpCloud();
else
  throw new Error(`invalid cloud configuration: ${config.cloud}`);

const cluster: model.KubernetesCluster = cloud.createKubernetesCluster();

// K8s namespace for operator
const namespaceName = config.operatorNamespace;

// Output the cluster's kubeconfig and name
export const kubeconfig = cluster.kubeconfig;
export const clusterName = cluster.name;

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

const serviceAccountName = utils.name("sa");
cloud.operatorServiceAccount(
  cluster, 
  serviceAccountName, 
  namespace
);

// Install the license key into the namespace
new k8s.yaml.ConfigGroup("license-secret",
  { files: config.licenseFile },
  { provider: cluster.k8sProvider },
);

// Install the GCP Marketplace applications CRD in the cluster
new k8s.yaml.ConfigGroup("app-crd",
  { files: "https://raw.githubusercontent.com/GoogleCloudPlatform/marketplace-k8s-app-tools/master/crd/app-crd.yaml" },
  { provider: cluster.k8sProvider },
);

// Install Akka Cloud Platform Helm Chart
// From the Platform Guide: https://developer.lightbend.com/docs/akka-platform-guide/deployment/gcp-install.html
new k8s.helm.v3.Chart("akka-operator", {
  chart: "akka-operator",
  namespace: namespace.metadata.name,
  version: config.operatorVersion, 
  fetchOpts: {
    repo: "https://lightbend.github.io/akka-operator-helm/"
  },
  // chart values don't support shorthand value assignment syntax i.e. `serviceAccount.name: "foo"`
  values: { // fixme merge in chart value config from pulumi config
    serviceAccount: {
      name: serviceAccountName
    },
    provider: {
      name: "gcp"
    },
    reportingSecret: "akka-cloud-platform-1-license"
  }
}, { 
  provider: cluster.k8sProvider, 
  customTimeouts: { create: "30m", update: "30m", delete: "30m" }
});

const instance = cloud.createCloudSQLInstance();

export const postgreSQLInstanceConnectionName = instance.connectionName
export const postgreSQLInstanceName = instance.name
export const postgreSQLEndpoint = instance.endpoint