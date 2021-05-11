import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";

import * as model from "./model";
import * as util from "./util";

class EksKubernetesCluster implements model.KubernetesCluster {
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
    this.k8sProvider = new k8s.Provider("eks-k8s", {
      kubeconfig: this.kubeconfig.apply(JSON.stringify)
    });
  }
}

class MskKafkaCluster implements model.KafkaCluster {
  zookeeperConnectString: pulumi.Output<any>;
  bootstrapBrokersTls: pulumi.Output<any>;
  bootstrapBrokers: pulumi.Output<any>;

  constructor(cluster: aws.msk.Cluster) {
    this.zookeeperConnectString = cluster.zookeeperConnectString;
    this.bootstrapBrokersTls = cluster.bootstrapBrokersTls;
    this.bootstrapBrokers = cluster.bootstrapBrokers;
  }
}

class AuroraRdsDatabase implements model.JdbcDatabase {
  rdsCluster: aws.rds.Cluster;
  clusterId: pulumi.Output<any>;
  username: pulumi.Output<any>;
  password: pulumi.Output<any>;
  dbName: pulumi.Output<any>;
  endpoint: pulumi.Output<any>;
  readerEndpoint: pulumi.Output<any>;

  constructor(db: aws.rds.Cluster) {
    this.rdsCluster = db;
    this.clusterId = db.clusterResourceId;
    this.username = db.masterUsername;
    this.password = db.masterPassword;
    this.dbName = db.databaseName;
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
  "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
];

/**
 * IAM Policy to enable billing from the operator in AWS.
 */
const meterUsagePolicy: string = JSON.stringify({
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "aws-marketplace:MeterUsage"
      ],
      "Resource": "*"
    }
  ]
});

/**
 * MSK firehose role to write logs to S3 bucket
 */
const mskFireHoseRole: string = JSON.stringify({
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "firehose.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
});

export class AwsCloud implements model.Cloud {


  /**
   * Creates a role and attaches the EKS worker node IAM managed policies.
   */
  createNodeGroupRole(name: string): aws.iam.Role {
    let role = new aws.iam.Role(name, {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ec2.amazonaws.com",
      }),
    });

    let counter = 0;
    for (const policy of managedPolicyArns) {
      // Create RolePolicyAttachment without returning it.
      const rpa = new aws.iam.RolePolicyAttachment(`${name}-policy-${counter++}`,
        { policyArn: policy, role: role },
      );
    }

    return role;
  }

  /**
   * Creates an EKS cluster and its nodegroup.
   */
  createKubernetesCluster(): model.KubernetesCluster {
    // fixme: add number of az's to configuration, tie to MSK and RDS config for azs?
    // Create a VPC for our cluster.
    let vpc = new awsx.ec2.Vpc(util.name("vpc"), { numberOfAvailabilityZones: 2 });

    // Now create the roles and instance profiles for the two worker groups.
    let workersRole = this.createNodeGroupRole(util.name("workers-role"));
    let workersInstanceProfile = new aws.iam.InstanceProfile(util.name("workers-instprof"), {role: workersRole});

    // create the EKS cluster
    // https://www.pulumi.com/docs/reference/pkg/aws/eks/cluster/
    let cluster = new eks.Cluster(util.name("eks"), {
      skipDefaultNodeGroup: true,
      createOidcProvider: true,
      instanceRoles: [ workersRole ],
      vpcId: vpc.id,
      subnetIds: vpc.publicSubnetIds,
      // fixme: add to configuration
      version: "1.17",
    });

    let nodeGroup = cluster.createNodeGroup(util.name("workers-ng"), {
      // fixme: use configuration
      desiredCapacity: 3,
      minSize: 1,
      maxSize: 4,
      labels: {"ondemand": "true"},
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
    kubernetesCluster: model.KubernetesCluster, 
    serviceAccountName: string, 
    namespace: k8s.core.v1.Namespace) {

    if (!(kubernetesCluster instanceof EksKubernetesCluster)) {
      throw new Error("Invalid KubernetesCluster provided")
    }

    let eksCluster = (kubernetesCluster as EksKubernetesCluster).cluster;

    if (!eksCluster?.core?.oidcProvider) {
      throw new Error("Invalid cluster OIDC provider URL");
    }

    let saAssumeRolePolicy = pulumi
      .all([eksCluster.core.oidcProvider.url, eksCluster.core.oidcProvider.arn, namespace.metadata])
      .apply(([url, arn, ns]) => aws.iam.getPolicyDocument({
        statements: [{
          actions: ["sts:AssumeRoleWithWebIdentity"],
          conditions: [{
            test: "StringEquals",
            values: [`system:serviceaccount:${ns.name}:${serviceAccountName}`],
            variable: `${url.replace("https://", "")}:sub`,
          }],
          effect: "Allow",
          principals: [{
            identifiers: [arn],
            type: "Federated",
          }],
        }],
      })
    );

    let saRole = new aws.iam.Role(util.name("sa-role"), {assumeRolePolicy: saAssumeRolePolicy.json});
    let meterUsageRolePolicy = new aws.iam.Policy(util.name("billing-rp"), {policy: meterUsagePolicy});

    // Attach the IAM role to the MeterUsage policy
    let saMeterUsageRpa = new aws.iam.RolePolicyAttachment(util.name("sa-rpa"), {
      policyArn: meterUsageRolePolicy.arn,
      role: saRole,
    });

    // Create a Service Account with the IAM role annotated to use with the Pod.
    let sa = new k8s.core.v1.ServiceAccount(
      serviceAccountName,
      {
        metadata: {
          namespace: namespace.metadata.name,
          name: serviceAccountName,
          annotations: {
            'eks.amazonaws.com/role-arn': saRole.arn
          },
        },
      }, { provider: kubernetesCluster.k8sProvider});

    return sa;
  }

  /**
   * Create AWS MSK Kafka cluster
   */
  createKafkaCluster(kubernetesCluster: model.KubernetesCluster) {
    if (!(kubernetesCluster instanceof EksKubernetesCluster)) {
      throw new Error("Invalid KubernetesCluster provided")
    }

    let eksKubernetesCluster = kubernetesCluster as EksKubernetesCluster;
    let mskName = util.name("msk");

    // give all the K8s nodegroup securitygroups full ingress access to MSK securitygroup for brokers
    let nodeSecurityGroups = eksKubernetesCluster.nodeGroups.map(ng => ng.nodeSecurityGroup.id);
    let sg = new aws.ec2.SecurityGroup(util.name("msk-sg"), {
      vpcId: eksKubernetesCluster.vpc.id,
      ingress: [{
        description: "EKS NodeGroups ingress",
        fromPort: 0,
        toPort: 0,
        protocol: "-1",
        securityGroups: nodeSecurityGroups
      }]
    });
    let kms = new aws.kms.Key(util.name("kms"), {description: mskName});
    let logGroup = new aws.cloudwatch.LogGroup(util.name("msk-lg"), {});
    let logBucket = new aws.s3.Bucket(util.name("msk-bucket"), {
      acl: "private",
      forceDestroy: true // note: delete bucket on pulumi destroy even if it's populated
    });
    let firehoseRole = new aws.iam.Role(util.name("msk-firehose-role"), {assumeRolePolicy: mskFireHoseRole});
    let mskStream = new aws.kinesis.FirehoseDeliveryStream(util.name("msk-stream"), {
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
    let kafkaCluster = new aws.msk.Cluster(mskName, {
      // fixme: add to configuration
      kafkaVersion: "2.8.0",
      // fixme: add to configuration
      // must be multiple of number of subnets. default VPC has 2
      numberOfBrokerNodes: 2,
      brokerNodeGroupInfo: {
        // fixme: add to configuration
        instanceType: "kafka.m5.large",
        // fixme: add to configuration
        ebsVolumeSize: 1000,
        clientSubnets: eksKubernetesCluster.vpc.publicSubnetIds,
        securityGroups: [sg.id],
      },
      encryptionInfo: {
        encryptionAtRestKmsKeyArn: kms.arn,
        encryptionInTransit: {
          // fixme: add to configuration
          // enable TLS and PLAINTEXT client connections
          // https://www.pulumi.com/docs/reference/pkg/aws/msk/cluster/#clusterencryptioninfoencryptionintransit
          clientBroker: "TLS_PLAINTEXT"
        }
      },
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

  createJdbcCluster(kubernetesCluster: model.KubernetesCluster) {
    if (!(kubernetesCluster instanceof EksKubernetesCluster)) {
      throw new Error("Invalid KubernetesCluster provided")
    }

    let eksKubernetesCluster = kubernetesCluster as EksKubernetesCluster;
    let rdsName = util.name("rds");

    let vpc = eksKubernetesCluster.vpc;

    let password = new random.RandomPassword("password", {
      length: 16,
      special: true,
      overrideSpecial: `!#$%&*()-_=+[]{}<>:?`, // Only printable ASCII characters besides '/', '@', '"', ' ' may be used.
    });

    // give all the K8s nodegroup securitygroups full ingress access to RDS securitygroup for brokers
    let nodeSecurityGroups = eksKubernetesCluster.nodeGroups.map(ng => ng.nodeSecurityGroup.id);

    // defining a db subnet group is a pre-requisite for creating an RDS db in an existing VPC
    let subnetGroup = new aws.rds.SubnetGroup(util.name('rds-subnet-group'), {
      subnetIds: vpc.privateSubnetIds
    });

    let auroraEngine = aws.rds.EngineType.AuroraPostgresql;

    // https://www.pulumi.com/docs/reference/pkg/aws/rds/cluster/
    let auroraCluster = new aws.rds.Cluster(rdsName, {
      backupRetentionPeriod: 5,
      clusterIdentifier: rdsName,
      databaseName: "public",
      engine: auroraEngine,
      masterUsername: "acpadmin",
      masterPassword: password.result,
      preferredBackupWindow: "07:00-09:00",
      dbSubnetGroupName: subnetGroup.id,
      skipFinalSnapshot: true, // note: skips backup "snapshot" of db when pulumi stack is destroyed
      vpcSecurityGroupIds: nodeSecurityGroups
    });

    let clusterInstances: aws.rds.ClusterInstance[] = [];
    let rdsInstanceName = util.name("rds-inst");

    for (const range = {value: 0}; range.value < 2; range.value++) {
      clusterInstances.push(new aws.rds.ClusterInstance(`${rdsInstanceName}-${range.value}`, {
        identifier: `${rdsInstanceName}-${range.value}`,
        clusterIdentifier: auroraCluster.id,
        instanceClass: "db.r4.large",
        engine: auroraEngine,
        engineVersion: auroraCluster.engineVersion,
      }));
    }    

    return new AuroraRdsDatabase(auroraCluster);
  }
}