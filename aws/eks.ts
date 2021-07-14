import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";

import * as util from "./util";
import * as config from "./config";
import { clusterName } from ".";

export class EksKubernetesCluster {
  vpc: awsx.ec2.Vpc;
  cluster: eks.Cluster;
  nodeGroups: eks.NodeGroup[];
  kubeconfig: pulumi.Output<any>;
  name: pulumi.Output<any>;
  k8sProvider: k8s.Provider;

  constructor(vpc: awsx.ec2.Vpc, cluster: eks.Cluster, nodeGroups: eks.NodeGroup[]) {
    this.vpc = vpc;
    this.cluster = cluster;
    this.kubeconfig = cluster.kubeconfig;
    this.name = cluster.eksCluster.id;
    this.nodeGroups = nodeGroups;
    this.k8sProvider = new k8s.Provider(util.name("eks-k8s"), {
      kubeconfig: this.kubeconfig.apply(JSON.stringify),
    });
  }
}

export class MskKafkaCluster {
  zookeeperConnectString: pulumi.Output<any>;
  bootstrapBrokersTls: pulumi.Output<any>;
  bootstrapBrokers: pulumi.Output<any>;

  constructor(cluster: aws.msk.Cluster) {
    this.zookeeperConnectString = cluster.zookeeperConnectString;
    this.bootstrapBrokersTls = cluster.bootstrapBrokersTls;
    this.bootstrapBrokers = cluster.bootstrapBrokers;
  }
}

export class AuroraRdsDatabase {
  rdsCluster: aws.rds.Cluster;
  clusterId: pulumi.Output<any>;
  username: pulumi.Output<any>;
  password: pulumi.Output<any>;
  endpoint: pulumi.Output<any>;
  readerEndpoint: pulumi.Output<any>;

  constructor(db: aws.rds.Cluster) {
    this.rdsCluster = db;
    this.clusterId = db.clusterResourceId;
    this.username = db.masterUsername;
    this.password = db.masterPassword;
    this.endpoint = db.endpoint;
    this.readerEndpoint = db.readerEndpoint;
  }
}

/**
 * Per NodeGroup IAM: each NodeGroup will bring its own, specific instance role and profile.
 */
const managedPolicyArns: string[] = [
  "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
  "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
  "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
];

/**
 * IAM Policy to enable billing from the operator in AWS.
 */
const meterUsagePolicy: string = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["aws-marketplace:MeterUsage"],
      Resource: "*",
    },
  ],
});

/**
 * MSK firehose role to write logs to S3 bucket
 */
const mskFireHoseRole: string = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Action: "sts:AssumeRole",
      Principal: {
        Service: "firehose.amazonaws.com",
      },
      Effect: "Allow",
      Sid: "",
    },
  ],
});

export class AwsCloud {
  /**
   * Creates a role and attaches the EKS worker node IAM managed policies.
   */
  createNodeGroupRole(name: string): aws.iam.Role {
    const role = new aws.iam.Role(name, {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ec2.amazonaws.com",
      }),
    });

    managedPolicyArns.forEach((policy, counter) => {
      new aws.iam.RolePolicyAttachment(`${name}-policy-${counter++}`, { policyArn: policy, role: role });
    });

    return role;
  }

  /**
   * Creates an EKS cluster and its nodegroup.
   */
  createKubernetesCluster(): EksKubernetesCluster {
    // Create a VPC for our cluster.
    const vpcName = util.name("vpc");
    const vpc = new awsx.ec2.Vpc(vpcName, {
      ...config.eksVpcArgs,
      tags: {
        // Tags help to later identify the VPC using AWS CLI or UI.
        Name: vpcName,
        "Pulumi:Stack": pulumi.getStack(),
        "Pulumi:Project": pulumi.getProject(),
      },
    });

    // Now create the roles and instance profiles for the two worker groups.
    const workersRole = this.createNodeGroupRole(util.name("workers-role"));
    const workersInstanceProfile = new aws.iam.InstanceProfile(util.name("workers-instprof"), { role: workersRole });

    // create the EKS cluster
    // https://www.pulumi.com/docs/reference/pkg/aws/eks/cluster/
    const cluster = new eks.Cluster(util.name("eks"), {
      ...config.eksClusterOptions,
      skipDefaultNodeGroup: true,
      createOidcProvider: true,
      instanceRoles: [workersRole],
      vpcId: vpc.id,
      subnetIds: vpc.publicSubnetIds,
    });

    const nodeGroup = cluster.createNodeGroup(util.name("workers-ng"), {
      ...config.eksClusterNodeGroupOptions,
      labels: { ondemand: "true" },
      instanceProfile: workersInstanceProfile,
    });

    return new EksKubernetesCluster(vpc, cluster, [nodeGroup]);
  }

  /**
   * Setup EKS pre-requisitite IAM configuration for service account used by operator.
   * This enables the operator to call the AWS Marketplace MeterUsage API to bill customers.
   *
   * Based on example: https://github.com/pulumi/pulumi-eks/blob/v0.30.0/examples/oidc-iam-sa/index.ts
   */
  operatorServiceAccount(
    kubernetesCluster: EksKubernetesCluster,
    serviceAccountName: string,
    namespace: k8s.core.v1.Namespace,
  ): k8s.core.v1.ServiceAccount {
    const eksCluster = kubernetesCluster.cluster;

    if (!eksCluster?.core?.oidcProvider) {
      throw new Error("Invalid cluster OIDC provider URL");
    }

    const saAssumeRolePolicy = pulumi
      .all([eksCluster.core.oidcProvider.url, eksCluster.core.oidcProvider.arn, namespace.metadata])
      .apply(([url, arn, ns]) =>
        aws.iam.getPolicyDocument({
          statements: [
            {
              actions: ["sts:AssumeRoleWithWebIdentity"],
              conditions: [
                {
                  test: "StringEquals",
                  values: [`system:serviceaccount:${ns.name}:${serviceAccountName}`],
                  variable: `${url.replace("https://", "")}:sub`,
                },
              ],
              effect: "Allow",
              principals: [
                {
                  identifiers: [arn],
                  type: "Federated",
                },
              ],
            },
          ],
        }),
      );

    const saRole = new aws.iam.Role(util.name("sa-role"), { assumeRolePolicy: saAssumeRolePolicy.json });
    const meterUsageRolePolicy = new aws.iam.Policy(util.name("billing-rp"), { policy: meterUsagePolicy });

    // Attach the IAM role to the MeterUsage policy
    new aws.iam.RolePolicyAttachment(util.name("sa-rpa"), {
      policyArn: meterUsageRolePolicy.arn,
      role: saRole,
    });

    // Create a Service Account with the IAM role annotated to use with the Pod.
    return new k8s.core.v1.ServiceAccount(
      serviceAccountName,
      {
        metadata: {
          namespace: namespace.metadata.name,
          name: serviceAccountName,
          annotations: {
            "eks.amazonaws.com/role-arn": saRole.arn,
          },
        },
      },
      { provider: kubernetesCluster.k8sProvider },
    );
  }

  /**
   * Create AWS MSK Kafka cluster
   */
  createKafkaCluster(kubernetesCluster: EksKubernetesCluster): MskKafkaCluster {
    const mskName = util.name("msk");

    // give all the K8s nodegroup securitygroups full ingress access to MSK securitygroup for brokers
    const nodeSecurityGroups = kubernetesCluster.nodeGroups.map((ng) => ng.nodeSecurityGroup.id);
    const securityGroup = new aws.ec2.SecurityGroup(util.name("msk-sg"), {
      vpcId: kubernetesCluster.vpc.id,
      ingress: [
        {
          description: "EKS NodeGroups ingress",
          fromPort: 0,
          toPort: 0,
          protocol: "-1",
          securityGroups: nodeSecurityGroups,
        },
      ],
    });
    const kms = new aws.kms.Key(util.name("kms"), { description: mskName });
    const logGroup = new aws.cloudwatch.LogGroup(util.name("msk-lg"), {});
    const logBucket = new aws.s3.Bucket(util.name("msk-bucket"), {
      acl: "private",
      forceDestroy: true, // note: delete bucket on pulumi destroy even if it's populated
    });
    const firehoseRole = new aws.iam.Role(util.name("msk-firehose-role"), { assumeRolePolicy: mskFireHoseRole });
    const mskStream = new aws.kinesis.FirehoseDeliveryStream(util.name("msk-stream"), {
      destination: "s3",
      s3Configuration: {
        roleArn: firehoseRole.arn,
        bucketArn: logBucket.arn,
      },
      tags: {
        LogDeliveryEnabled: "placeholder",
      },
    });
    // https://www.pulumi.com/docs/reference/pkg/aws/msk/cluster/#cluster
    const kafkaCluster = new aws.msk.Cluster(mskName, {
      ...config.mksClusterArgs(kubernetesCluster.vpc, securityGroup, kms),
      openMonitoring: {
        prometheus: {
          jmxExporter: {
            enabledInBroker: true,
          },
          nodeExporter: {
            enabledInBroker: true,
          },
        },
      },
      loggingInfo: {
        brokerLogs: {
          cloudwatchLogs: {
            enabled: true,
            logGroup: logGroup.name,
          },
          firehose: {
            enabled: true,
            deliveryStream: mskStream.name,
          },
          s3: {
            enabled: true,
            bucket: logBucket.id,
            prefix: "logs/msk-",
          },
        },
      },
      tags: {
        // foo: "bar",
      },
    });

    return new MskKafkaCluster(kafkaCluster);
  }

  createJdbcCluster(kubernetesCluster: EksKubernetesCluster): AuroraRdsDatabase {
    const rdsName = util.name("rds");

    const vpc = kubernetesCluster.vpc;

    const password = new random.RandomPassword("password", {
      length: 16,
      special: true,
      overrideSpecial: `!#$%&*()-_=+[]{}<>:?`, // Only printable ASCII characters besides '/', '@', '"', ' ' may be used.
    });

    // give all the K8s nodegroup securitygroups full ingress access to RDS securitygroup for brokers
    const nodeSecurityGroups = kubernetesCluster.nodeGroups.map((ng) => ng.nodeSecurityGroup.id);

    // defining a db subnet group is a pre-requisite for creating an RDS db in an existing VPC
    const subnetGroup = new aws.rds.SubnetGroup(util.name("rds-subnet-group"), {
      subnetIds: vpc.privateSubnetIds,
    });

    const auroraEngine = aws.rds.EngineType.AuroraPostgresql;

    // https://www.pulumi.com/docs/reference/pkg/aws/rds/cluster/
    const auroraCluster = new aws.rds.Cluster(
      rdsName,
      {
        backupRetentionPeriod: 5,
        clusterIdentifier: rdsName,
        engine: auroraEngine,
        masterUsername: "postgres",
        masterPassword: password.result,
        preferredBackupWindow: "07:00-09:00",
        dbSubnetGroupName: subnetGroup.id,
        skipFinalSnapshot: true, // note: skips backup "snapshot" of db when pulumi stack is destroyed
        vpcSecurityGroupIds: nodeSecurityGroups,
      },
      {
        dependsOn: [vpc],
      },
    );

    const rdsInstanceName = util.name("rds-inst");

    for (let index = 0; index < 2; index++) {
      new aws.rds.ClusterInstance(
        `${rdsInstanceName}-${index}`,
        {
          identifier: `${rdsInstanceName}-${index}`,
          clusterIdentifier: auroraCluster.id,
          instanceClass: "db.r4.large",
          engine: auroraEngine,
          engineVersion: auroraCluster.engineVersion,
          dbSubnetGroupName: subnetGroup.id,
        },
        {
          dependsOn: [auroraCluster],
        },
      );
    }

    return new AuroraRdsDatabase(auroraCluster);
  }
}
