import * as pulumi from "@pulumi/pulumi";

let config = new pulumi.Config();

// couldn't get generics working here with `config.get<T>(key)`
function getStringOrDefault(key: string, def: string): string {
  let ret = config.get<string>(key);
  if (ret == undefined) {
    ret = def;
  }
  return ret;
}

function getBooleanOrDefault(key: string, def: boolean): boolean {
  let ret = config.getBoolean(key);
  if (ret == undefined) {
    ret = def;
  }
  return ret; 
}

export const AwsCloud = "aws";
export const LightbendNamespace = "lightbend";

export const cloud = getStringOrDefault("cloud", AwsCloud);
export const operatorNamespace = getStringOrDefault("operator-namespace", LightbendNamespace);
export const installMetricsServer = getBooleanOrDefault("install-metrics-server", true);
export const deployKafkaCluster = getBooleanOrDefault("deploy-kafka-cluster", true);
export const deployJdbcDatabase = getBooleanOrDefault("deploy-jdbc-database", true);
