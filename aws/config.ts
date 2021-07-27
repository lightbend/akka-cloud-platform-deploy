import * as eks from "@pulumi/eks";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as pulumi from "@pulumi/pulumi";
import { ChartOpts } from "@pulumi/kubernetes/helm/v3";

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
  // Kubernetes 1.20 is the current latest for EKS. For up to date information
  // see https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html
  static readonly KubernetesVersion: string = "1.20";

  // See the latest version for Akka Platform Operator here:
  // https://github.com/lightbend/akka-platform-operator/releases
  static readonly AkkaPlatformOperatorVersion = "1.1.22";

  // See the list of supported Kafka versions here:
  // https://docs.aws.amazon.com/msk/latest/developerguide/supported-kafka-versions.html
  static readonly KafkaVersion: string = "2.8.0";

  // See the latest version for Lightbend Telemetry (Cinnamon) here:
  // https://developer.lightbend.com/docs/telemetry/current/project/release-notes.html
  static readonly Cinnamon: string = "2.16.1";
}

export class Eks {
  static readonly Defaults = {
    NumberOfAvailabilityZones: 2,
    Node: {
      DesiredCapacity: 3,
      MinSize: 1,
      MaxSize: 4,
    },
  };

  static readonly VpcArgs: awsx.ec2.VpcArgs = {
    numberOfAvailabilityZones:
      config.getNumber("vpc.numberOfAvailabilityZones") || Eks.Defaults.NumberOfAvailabilityZones,
  };

  static readonly ClusterOptions: eks.ClusterOptions = {
    version: config.get<string>("eks.kubernetes.version") || Versions.KubernetesVersion,
  };

  static readonly ClusterNodeGroupOptions: eks.ClusterNodeGroupOptions = {
    desiredCapacity: config.getNumber("eks.kubernetes.node.desiredCapacity") || Eks.Defaults.Node.DesiredCapacity,
    minSize: config.getNumber("eks.kubernetes.node.minSize") || Eks.Defaults.Node.MinSize,
    maxSize: config.getNumber("eks.kubernetes.node.maxSize") || Eks.Defaults.Node.MaxSize,
  };
}

export class Mks {
  static readonly Defaults = {
    NumberOfBrokerNodes: 2,
    BrokerNodeGroupInfo: {
      // See the list of supported instance types here:
      // https://docs.aws.amazon.com/msk/latest/developerguide/msk-create-cluster.html#broker-instance-types
      InstanceType: "kafka.m5.large",
      EbsVolumeSize: 1000,
    },
    EncryptionInfo: {
      // Possible values are described here:
      // https://www.pulumi.com/docs/reference/pkg/aws/msk/cluster/#clusterencryptioninfoencryptionintransit
      EncryptionInTransit: "TLS_PLAINTEXT",
    },
  };

  static readonly DeployKafkaCluster = getBooleanOrDefault("mks.createCluster", true);

  static clusterArgs(vpc: awsx.ec2.Vpc, securityGroup: aws.ec2.SecurityGroup, kms: aws.kms.Key): aws.msk.ClusterArgs {
    return {
      kafkaVersion: config.get<string>("msk.kafka.version") || Versions.KafkaVersion,
      numberOfBrokerNodes: config.getNumber("msk.kafka.numberOfBrokerNodes") || Mks.Defaults.NumberOfBrokerNodes,
      brokerNodeGroupInfo: {
        instanceType:
          config.get<string>("msk.kafka.brokerNodeGroupInfo.instanceType") ||
          Mks.Defaults.BrokerNodeGroupInfo.InstanceType,
        ebsVolumeSize:
          config.getNumber("msk.kafka.brokerNodeGroupInfo.ebsVolumeSize") ||
          Mks.Defaults.BrokerNodeGroupInfo.EbsVolumeSize,
        clientSubnets: vpc.publicSubnetIds,
        securityGroups: [securityGroup.id],
      },
      encryptionInfo: {
        encryptionAtRestKmsKeyArn: kms.arn,
        encryptionInTransit: {
          clientBroker:
            config.get<string>("msk.kafka.encryptionInfo.encryptionInTransit") ||
            Mks.Defaults.EncryptionInfo.EncryptionInTransit,
        },
      },
    };
  }
}

export class AkkaOperator {
  static readonly CharOpts: ChartOpts = {
    chart: "akka-operator",
    version: config.get<string>("akka.operator.version") || Versions.AkkaPlatformOperatorVersion,
    fetchOpts: {
      repo: "https://lightbend.github.io/akka-operator-helm/",
    },
  };

  static readonly Namespace = config.get<string>("akka.operator.namespace") || Namespaces.LightbendNamespace;
}

export class Rds {
  static readonly CreateCluster = getBooleanOrDefault("rds.createCluster", true);
}

export class Telemetry {
  static readonly InstallBackends = getBooleanOrDefault("akka.operator.installTelemetryBackends", true);
  static readonly Version = Versions.Cinnamon;
}

export class OpenTelemetry {
  static readonly Collector = {
    InstallAwsOTelCollector: getBooleanOrDefault("otel.collector.install", false),
    Namespace: config.get<string>("otel.collector.namespace") || Namespaces.AwsOTelCollectorNamespace,
    // enables debug loglevel for the AWS OTel collector
    Debug: getBooleanOrDefault("otel.collector.debug", false),
  };

  static readonly XrayKeys = {
    AccessKeyId: "xray.access-key-id",
    SecretAccessKey: "xray.secret-access-key",
  };

  static readonly Xray = {
    Region: config.get<string>("xray.region") || new pulumi.Config("aws").get<string>("region"),
    AccessKeyId: config.get<string>(OpenTelemetry.XrayKeys.AccessKeyId),
    SecretAccessKey: config.get<string>(OpenTelemetry.XrayKeys.SecretAccessKey),
  };

  static initializationCheck(): void {
    if (OpenTelemetry.Collector.InstallAwsOTelCollector) {
      pulumi.log.info(`AWS X-Ray region: ${OpenTelemetry.Xray.Region}`);
      config.require(OpenTelemetry.XrayKeys.AccessKeyId);
      config.requireSecret(OpenTelemetry.XrayKeys.SecretAccessKey);
    }
  }
}

OpenTelemetry.initializationCheck();
