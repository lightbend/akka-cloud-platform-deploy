import { ChartOpts } from "@pulumi/kubernetes/helm/v3";
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();

function getBooleanOrDefault(key: string, def: boolean): boolean {
  const ret = config.getBoolean(key);
  return ret == undefined ? def : ret;
}

class Namespaces {
  static readonly LightbendNamespace: string = "lightbend";
  static readonly AwsOTelCollectorNamespace: string = "aws-otel-collector";
}

class Versions {
  // See the latest version for Akka Platform Operator here:
  // https://github.com/lightbend/akka-platform-operator/releases
  static readonly AkkaPlatformOperatorVersion = "1.1.22";

  // See the latest version for Lightbend Telemetry (Cinnamon) here:
  // https://developer.lightbend.com/docs/telemetry/current/project/release-notes.html
  static readonly Cinnamon: string = "2.16.1";
}

export class AkkaOperator {
  static readonly ChartOpts: ChartOpts = {
    chart: "akka-operator",
    version: config.get<string>("akka.operator.version") || Versions.AkkaPlatformOperatorVersion,
    fetchOpts: {
      repo: "https://lightbend.github.io/akka-operator-helm/",
    },
  };

  static readonly Namespace = config.get<string>("akka.operator.namespace") || Namespaces.LightbendNamespace;

  // license-file-path has to be set using cli
  // `pulumi config set akka-cloud-platform-gcp-deploy:license-file-path <value>`
  static readonly LicenseFile = config.require("license-file-path");
}

export class Telemetry {
  static readonly InstallBackends = getBooleanOrDefault("akka.operator.installTelemetryBackends", true);
  static readonly Version = Versions.Cinnamon;
}

export class Gke {
  static readonly Defaults = {
    NodePool: {
      InitialCount: 3,
      Autoscaling: {
        MinNodeCount: 1,
        MaxNodeCount: 7,
      },
      NodeConfig: {
        MachineType: "n1-standard-4",
      },
    },
  };

  static nodePoolArgs(clusterName: pulumi.Output<string>, zone: string | undefined): gcp.container.NodePoolArgs {
    return {
      cluster: clusterName,
      location: zone,
      initialNodeCount: config.getNumber("gke.nodePool.initialNodeCount") || Gke.Defaults.NodePool.InitialCount,
      autoscaling: {
        minNodeCount:
          config.getNumber("gke.nodePool.autoscaling.minNodeCount") || Gke.Defaults.NodePool.Autoscaling.MinNodeCount,
        maxNodeCount:
          config.getNumber("gke.nodePool.autoscaling.maxNodeCount") || Gke.Defaults.NodePool.Autoscaling.MaxNodeCount,
      },
      nodeConfig: {
        preemptible: true,
        machineType:
          config.get<string>("gke.nodePool.nodeConfig.machineType") || Gke.Defaults.NodePool.NodeConfig.MachineType,
        oauthScopes: ["https://www.googleapis.com/auth/cloud-platform"],
      },
    };
  }
}

export class CloudSql {
  static readonly Defaults = {
    DatabaseVersion: "POSTGRES_13",
    Settings: {
      Tier: "db-f1-micro",
    },
  };
  static databaseInstanceArgs(project: string | undefined, networkId: string): gcp.sql.DatabaseInstanceArgs {
    return {
      databaseVersion: config.get<string>("cloudSql.databaseVersion") || CloudSql.Defaults.DatabaseVersion,
      project: project,
      settings: {
        tier: config.get<string>("cloudSql.settings.tier") || CloudSql.Defaults.Settings.Tier,
        ipConfiguration: {
          ipv4Enabled: true,
          privateNetwork: networkId,
        },
      },
      deletionProtection: false,
    };
  }
}
