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

export const LightbendNamespace = "lightbend";
export const AwsOTelCollectorNamespace = "aws-otel-collector";

export const eksVpcArgs: awsx.ec2.VpcArgs = {
  numberOfAvailabilityZones: config.getNumber("vpc-numberOfAvailabilityZones") || 2,
};

export const eksClusterOptions: eks.ClusterOptions = {
  // Kubernetes 1.20 is the current latest for EKS. For up to date information
  // see https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html
  version: config.get<string>("eks-kubernetes-version") || "1.20",
};

export const eksClusterNodeGroupOptions: eks.ClusterNodeGroupOptions = {
  desiredCapacity: config.getNumber("eks-kubernetes-node-desiredCapacity") || 3,
  minSize: config.getNumber("eks-kubernetes-node-minSize") || 1,
  maxSize: config.getNumber("eks-kubernetes-node-maxSize") || 4,
};

export function mksClusterArgs(
  vpc: awsx.ec2.Vpc,
  securityGroup: aws.ec2.SecurityGroup,
  kms: aws.kms.Key,
): aws.msk.ClusterArgs {
  return {
    // See the list of supported Kafka versions here:
    // https://docs.aws.amazon.com/msk/latest/developerguide/supported-kafka-versions.html
    kafkaVersion: config.get<string>("msk-kafka-version") || "2.8.0",
    numberOfBrokerNodes: config.getNumber("msk-kafka-numberOfBrokerNodes") || 2,
    brokerNodeGroupInfo: {
      // See the list of supported instance types here:
      // https://docs.aws.amazon.com/msk/latest/developerguide/msk-create-cluster.html#broker-instance-types
      instanceType: config.get<string>("msk-kafka-brokerNodeGroupInfo-instanceType") || "kafka.m5.large",
      ebsVolumeSize: config.getNumber("msk-kafka-brokerNodeGroupInfo-ebsVolumeSize") || 1000,
      clientSubnets: vpc.publicSubnetIds,
      securityGroups: [securityGroup.id],
    },
    encryptionInfo: {
      encryptionAtRestKmsKeyArn: kms.arn,
      encryptionInTransit: {
        // Possible values are described here:
        // https://www.pulumi.com/docs/reference/pkg/aws/msk/cluster/#clusterencryptioninfoencryptionintransit
        clientBroker: config.get<string>("msk-kafka-encryptionInfo-encryptionInTransit") || "TLS_PLAINTEXT",
      },
    },
  };
}

export const akkaOperatorChartOpts: ChartOpts = {
  chart: "akka-operator",
  version: config.get<string>("operator-version") || "1.1.19",
  fetchOpts: {
    repo: "https://lightbend.github.io/akka-operator-helm/",
  },
};

export const operatorNamespace = config.get<string>("operator-namespace") || LightbendNamespace;

export const installMetricsServer = getBooleanOrDefault("install-metrics-server", true);
export const installAkkaOperator = getBooleanOrDefault("install-akka-operator", true);
export const deployKafkaCluster = getBooleanOrDefault("deploy-kafka-cluster", true);
export const deployJdbcDatabase = getBooleanOrDefault("deploy-jdbc-database", true);

export const installAwsOTelCollector = getBooleanOrDefault("install-aws-otel-collector", true);
export const awsOTelCollectorNamespace = config.get<string>("aws-otel-collector-namespace") || AwsOTelCollectorNamespace;