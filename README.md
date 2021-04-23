# Akka Cloud Platform Deployment Template

Implemented with [Pulumi](https://www.pulumi.com/).

## Setup 

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
  aws eks update-kubeconfig --region $(pulumi config get "aws:region") --name $(pulumi stack output clusterId)
  ```

## Run

Set any configuration using `pulumi config set`

Run Pulumi up[date]:

```bash
pulumi up

```

# #Delete Cluster

```bash
pulumi destroy
```

### Synchronizing Cluster State

If you make changes to your provisioned cluster outside of Pulumi's workflow then you can reconcile the cluster state with Pulumi state.
This is useful during development so you can test changes. If your changes create an incorrect or broken state you can manually clean up the cluster and then reconciliate state without reprovisioning everything.


```bash
pulumi refresh
```

## Development

### Update Dependencies

Use `npm-check-updates`.

```bash
npm i -g npm-check-updates
```

Update `package.json`:

```bash
ncu -u
npm install
```
