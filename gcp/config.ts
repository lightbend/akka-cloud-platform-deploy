import { ChartOpts } from "@pulumi/kubernetes/helm/v3";
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import * as utils from "./utils";

const config = new pulumi.Config();

// license-file-path has to be set using cli
// `pulumi config set akka-cloud-platform-gcp-deploy:license-file-path <value>`
const licenseFilePath = config.require("license-file-path");

export const LightbendNamespace = "lightbend";
export const licenseFile = licenseFilePath;

export const operatorNamespace = config.get<string>("operator-namespace") || LightbendNamespace;
export const clusterName = config.get<string>("cluster-name") || utils.name("gke");

export const akkaOperatorChartOpts: ChartOpts = {
  chart: "akka-operator",
  version: config.get<string>("operator-version") || "1.1.19",
  fetchOpts: {
    repo: "https://lightbend.github.io/akka-operator-helm/",
  },
};

export function gkeNodePoolArgs(
  clusterName: string,
  zone: string | undefined
): gcp.container.NodePoolArgs {
  return {
    cluster: clusterName,
    location: zone,
    initialNodeCount: config.getNumber("initial-node-count") || 3,
    autoscaling: {
      maxNodeCount: config.getNumber("autoscaling-max-node-count") || 7,
      minNodeCount: config.getNumber("autoscaling-min-node-count") || 1,
    },
    nodeConfig: {
      preemptible: true,
      machineType: config.get<string>("node-machine-type") || "n1-standard-4",
      oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
    },
  };
}

export function databaseInstanceArgs(
  project: string | undefined,
  networkId: string
): gcp.sql.DatabaseInstanceArgs {
  return {
    databaseVersion: config.get<string>("db-version") || "POSTGRES_13",
    project: project,
    settings: {
      tier: config.get<string>("db-instance-tier") || "db-f1-micro",
      ipConfiguration: {
        ipv4Enabled: true,
        privateNetwork: networkId,
      },
    },
    deletionProtection: false,
  };
}
