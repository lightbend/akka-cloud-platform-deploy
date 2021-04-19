# Akka Cloud Platform Deployment Template

This playbook will deploy a fully working Cloud Kubernetes cluster with the Akka Cloud Platform and additional stateful cloud services installed.
Implemented with [Pulumi](https://www.pulumi.com/).

## Setup 

For user facing instructions on running this playbook see the [Installation on Amazon Elastic Kubernetes Service (EKS) Quick Start](https://developer.lightbend.com/docs/akka-platform-guide/deployment/aws-install-quickstart.html) documentation in the Akka Platform Guide.

1. Install the required Node.js packages:

```bash
npm install
```

2. Create a new stack, which is an isolated deployment target for this example:

```bash
pulumi stack init
```

3. Set the required configuration variables for this program:

```bash
pulumi config set aws:region eu-central-1
```

4. Setup `KUBECONFIG`

  * Merge the `kubeconfig` output variable into your current `~/.kube/config` or override the default config in your terminal.

  
  ```
  pulumi stack output kubeconfig > kubeconfig.yml
  export KUBECONFIG=./kubeconfig.yml 
  ```
  
  * Or, if you have the `aws` command locally you can use `aws eks update-kubeconfig` to update your `~/.kube/config`.
  
  ```
  aws eks update-kubeconfig --region $(pulumi config get "aws:region") --name $(pulumi stack output clusterName)
  ```

## Run

Set any configuration using `pulumi config set`

Run Pulumi up[date]:

```bash
pulumi up
```

## Delete Cluster

```bash
pulumi destroy
```

## Contributing

See the [CONTRIBUTING.md](CONTRIBUTING.md) file for more details.
