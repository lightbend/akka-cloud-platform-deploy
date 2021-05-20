import * as pulumi from "@pulumi/pulumi";
import * as utils from "./utils";

let config = new pulumi.Config();
// license-file-path has to be set using cli 
// `pulumi config set akka-cloud-platform-gcp-deploy:license-file-path <value>`
let licenseFilePath = config.require("license-file-path");

export const GcpCloud = "gcp";
export const LightbendNamespace = "lightbend";
export const licenseFile = licenseFilePath;

export const cloud = config.get<string>("cloud") || GcpCloud;
export const zone = config.get<string>("gcp:zone") || "europe-west1-b";
export const region = config.get<string>("gcp:region") || "europe-west1";
export const operatorNamespace = config.get<string>("operator-namespace") || LightbendNamespace;
export const operatorVersion = config.get<string>("operator-version") || "1.1.19";
export const clusterName = config.get<string>("cluster-name") || utils.name("gke");

export const initialNodeCountInCluster = config.getNumber("initial-node-count") || 3;
export const autoscalingMinNodeCount = config.getNumber("autoscaling-min-node-count") || 1;
export const autoscalingMaxNodeCount = config.getNumber("autoscaling-max-node-count") || 7;