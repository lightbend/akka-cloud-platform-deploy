import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";

import * as model from "./model";
import * as util from "./util";

class EksCloudCluster implements model.CloudCluster {
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

class AwsMskKafkaCluster implements model.KafkaCluster {
  zookeeperConnectString: pulumi.Output<any>;
  bootstrapBrokersTls: pulumi.Output<any>;
  bootstrapBrokers: pulumi.Output<any>;

  constructor(cluster: aws.msk.Cluster) {
    this.zookeeperConnectString = cluster.zookeeperConnectString;
    this.bootstrapBrokersTls = cluster.bootstrapBrokersTls;
    this.bootstrapBrokers = cluster.bootstrapBrokers;
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

/**
 * Creates a role and attaches the EKS worker node IAM managed policies.
 */
function createNodeGroupRole(name: string): aws.iam.Role {
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
export function createCluster(): model.CloudCluster {
  // fixme: add number of az's to configuration, tie to MSK and RDS config for azs?
  // Create a VPC for our cluster.
  let vpc = new awsx.ec2.Vpc(util.name("vpc"), { numberOfAvailabilityZones: 2 });

  // Now create the roles and instance profiles for the two worker groups.
  let workersRole = createNodeGroupRole(util.name("workers-role"));
  let workersInstanceProfile = new aws.iam.InstanceProfile(util.name("workers-instprof"), {role: workersRole});

  // Create the EKS cluster itself and a deployment of the Kubernetes dashboard.
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

  return new EksCloudCluster(vpc, cluster, [nodeGroup]);
}

/**
 * Setup EKS pre-requisitite IAM configuration for service account used by operator.
 * This enables the operator to call the AWS Marketplace MeterUsage API to bill customers.
 *
 * Based on example: https://github.com/pulumi/pulumi-eks/blob/v0.30.0/examples/oidc-iam-sa/index.ts
 */
export function operatorServiceAccount(
  cloudCluster: model.CloudCluster, 
  serviceAccountName: string, 
  namespace: k8s.core.v1.Namespace): k8s.core.v1.ServiceAccount {

  if (!(cloudCluster instanceof EksCloudCluster)) {
    throw new Error("Invalid CloudCluster provided")
  }

  let eksCluster = (cloudCluster as EksCloudCluster).cluster;

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
    }, { provider: cloudCluster.k8sProvider});

  return sa;
}

/**
 * Create AWS MSK Kafka cluster
 */
export function createKafkaCluster(cloudCluster: model.CloudCluster): model.KafkaCluster {
  if (!(cloudCluster instanceof EksCloudCluster)) {
    throw new Error("Invalid CloudCluster provided")
  }

  let eksCloudCluster = cloudCluster as EksCloudCluster;
  let mskName = util.name("msk");

  // give all the K8s nodegroup securitygroups full ingress access to MSK securitygroup for brokers
  let nodeSecurityGroups = eksCloudCluster.nodeGroups.map(ng => ng.nodeSecurityGroup.id);
  let sg = new aws.ec2.SecurityGroup(util.name("msk-sg"), {
    vpcId: eksCloudCluster.vpc.id,
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
  let logBucket = new aws.s3.Bucket(util.name("msk-bucket"), {acl: "private"});
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
      clientSubnets: eksCloudCluster.vpc.publicSubnetIds,
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

  return new AwsMskKafkaCluster(kafkaCluster);
}

export function createRdsCluster(cloudCluster: model.CloudCluster): pulumi.Output<aws.rds.Cluster> {
  if (!(cloudCluster instanceof EksCloudCluster)) {
    throw new Error("Invalid CloudCluster provided")
  }

  let eksCloudCluster = cloudCluster as EksCloudCluster;
  let rdsName = util.name("rds");

  let vpc = eksCloudCluster.vpc;

  // try to get azs from vpc (from each subnet), but need to map over output and promise before can get result
  // let availabilityZones = pulumi
  //   .all([vpc.publicSubnetIds, vpc.privateSubnetIds, vpc.isolatedSubnetIds])
  //   .apply(([pub, priv, iso]) => {
      
  //     pub.forEach(sub => pulumi.log.info(`keys: ${sub} ${Object.keys(sub)}`));
  //     // let azs2 = pub.concat(priv).concat(iso)
  //     //  .map(subnetx => subnetx.subnet.availabilityZone);

  //     // pulumi.log.info(`type: ${azs2.constructor.name}`);
  //     // azs2.forEach(sub => sub.apply(sb => pulumi.log.info(`type: ${sb}`)));
  //     let azs = ["foo"];
  //     return Array.from((new Set<string>(azs)).values());
  //   });

  let availabilityZones = aws.getAvailabilityZones({state: "available"});

  let rds = availabilityZones.then(azsResult => {
    // get 3 or less azs
    let azs = azsResult.names;
    if (azs.length >= 3) {
      azs = azs.slice(0, 3);
    }

    azs.forEach(az => pulumi.log.info(`az: ${az}`));
    let postgresqlRds = new aws.rds.Cluster(rdsName, {
      availabilityZones: azs,
      backupRetentionPeriod: 5,
      clusterIdentifier: rdsName,
      databaseName: "mydb",
      engine: "aurora-postgresql",
      masterPassword: "bar",
      masterUsername: "foo",
      preferredBackupWindow: "07:00-09:00",
    });

    return postgresqlRds;
  });

  // todo: create relational db model type
  // convert Promise to Output
  return pulumi.output(rds);
}