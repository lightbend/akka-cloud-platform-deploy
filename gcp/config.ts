import * as pulumi from "@pulumi/pulumi";
import * as utils from "./utils";

const config = new pulumi.Config();
// license-file-path has to be set using cli 
// `pulumi config set akka-cloud-platform-gcp-deploy:license-file-path <value>`
const licenseFilePath = config.require("license-file-path");

export const GcpCloud = "gcp";
export const LightbendNamespace = "lightbend";
export const licenseFile = licenseFilePath;

export const cloud = config.get<string>("cloud") || GcpCloud;

// operatorVersion needs to be set
const operatorVersionV = config.require("operator-version");

export const operatorNamespace = config.get<string>("operator-namespace") || LightbendNamespace;
export const operatorVersion = operatorVersionV;
export const clusterName = config.get<string>("cluster-name") || utils.name("gke");
export const nodeMachineType = config.get<string>("node-machine-type") || "n1-standard-4";
export const dbInstanceTier = config.get<string>("db-instance-tier") || "db-f1-micro";
export const dbVersion = config.get<string>("db-version") || "POSTGRES_13";
export const initialNodeCountInCluster = config.getNumber("initial-node-count") || 3;
export const autoscalingMinNodeCount = config.getNumber("autoscaling-min-node-count") || 1;
export const autoscalingMaxNodeCount = config.getNumber("autoscaling-max-node-count") || 7;