import { ChartOpts } from "@pulumi/kubernetes/helm/v3";
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

function getBooleanOrDefault(key: string, def: boolean): boolean {
  const ret = config.getBoolean(key);
  return ret == undefined ? def : ret;
}

// license-file-path has to be set using cli
// `pulumi config set akka-cloud-platform-gcp-deploy:license-file-path <value>`
export const licenseFile = config.require("license-file-path");

export const LightbendNamespace = "lightbend";

export const operatorNamespace = config.get<string>("akka.operator.namespace") || LightbendNamespace;
export const installTelemetryServices = getBooleanOrDefault("akka.operator.installTelemetryBackends", true);

export const akkaOperatorChartOpts: ChartOpts = {
  chart: "akka-operator",
  version: config.get<string>("akka.operator.version") || "1.1.19",
  fetchOpts: {
    repo: "https://lightbend.github.io/akka-operator-helm/",
  },
};

export function gkeNodePoolArgs(
  clusterName: pulumi.Output<string>,
  zone: string | undefined,
): gcp.container.NodePoolArgs {
  return {
    cluster: clusterName,
    location: zone,
    initialNodeCount: config.getNumber("gke.nodePool.initialNodeCount") || 3,
    autoscaling: {
      maxNodeCount: config.getNumber("gke.nodePool.autoscaling.maxNodeCount") || 7,
      minNodeCount: config.getNumber("gke.nodePool.autoscaling.minNodeCount") || 1,
    },
    nodeConfig: {
      preemptible: true,
      machineType: config.get<string>("gke.nodePool.nodeConfig.machineType") || "n1-standard-4",
      oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
    },
  };
}

export function databaseInstanceArgs(project: string | undefined, networkId: string): gcp.sql.DatabaseInstanceArgs {
  return {
    databaseVersion: config.get<string>("clouSql.databaseVersion") || "POSTGRES_13",
    project: project,
    settings: {
      tier: config.get<string>("clouSql.settings.tier") || "db-f1-micro",
      ipConfiguration: {
        ipv4Enabled: true,
        privateNetwork: networkId,
      },
    },
    deletionProtection: false,
  };
}
