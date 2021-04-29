import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as eks from "@pulumi/eks";
import * as k8s from "@pulumi/kubernetes";

import * as cloudcluster from "./cloudcluster";
import * as util from "./util";

class EksCloudCluster implements cloudcluster.CloudCluster {
  cluster: eks.Cluster;
  kubeconfig: pulumi.Output<any>;
  name: pulumi.Output<any>;
  k8sProvider: k8s.Provider;

  constructor(cluster: eks.Cluster) {
    this.cluster = cluster;
    this.kubeconfig = cluster.kubeconfig;
    this.name = cluster.eksCluster.id;
    this.k8sProvider = new k8s.Provider("eks-k8s", {
      kubeconfig: this.kubeconfig.apply(JSON.stringify)
    });
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
export function createCluster(): cloudcluster.CloudCluster {
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

  return new EksCloudCluster(cluster);
}

/**
 * Setup EKS pre-requisitite IAM configuration for service account used by operator.
 * This enables the operator to call the AWS Marketplace MeterUsage API to bill customers.
 *
 * Based on example: https://github.com/pulumi/pulumi-eks/blob/v0.30.0/examples/oidc-iam-sa/index.ts
 */
export function operatorServiceAccount(
  cloudCluster: cloudcluster.CloudCluster, 
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

  let saRole = new aws.iam.Role(util.name("sa-role"), {
    assumeRolePolicy: saAssumeRolePolicy.json,
  });

  let meterUsageRolePolicy = new aws.iam.Policy(util.name("billing-rp"), {
    policy: meterUsagePolicy
  });

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
