# Some issues faced with Pulumi and GCP

* Problem in concurrency control where an operation fails with the following message. This is also documented in [pulumi troubleshooting section](https://www.pulumi.com/docs/troubleshooting/#conflict) 

> gcp:sql:DatabaseInstance (pg12instance):
  error: 1 error occurred:
  	* updating urn:pulumi:dev::akka-cloud-platform-gcp-deploy::gcp:sql/databaseInstance:DatabaseInstance::pg12instance: 1 error occurred:
  	* Error, failed to update instance settings for : googleapi: Error 409: Operation failed because another operation was already in progress., operationInProgress
 
 pulumi:pulumi:Stack (akka-cloud-platform-gcp-deploy-dev):
  error: update failed

Doing a `pulumi cancel` will cancel the running update. However in some cases the update might have gone ok despite the above message. In that case `pulumi cancel` gives the following message __The Update has already completed__.

> pulumi cancel

> This will irreversibly cancel the currently running update for 'dev'!
Please confirm that this is what you'd like to do by typing ("dev"): dev
error: [409] Conflict: The Update has already completed

* __Update fails in pulumi reporting containers with unready status:__ In gcp based deployment on gke, *ubbagent* is a sidecar container. On Pulumi Github there is an [open issue](https://github.com/pulumi/pulumi-kubernetes/issues/878) with sidecar containers. It doesn't check the exit status 0 of sidecar container and reports as unready. In such cases we get errors like the following though everything is fine on the cluster and re-running `pulumi up` reports a success.

> kubernetes:apps/v1:Deployment (lightbend/akka-operator):
> 
> error: 4 errors occurred:
>
> 	* resource lightbend/akka-operator was successfully created, but the Kubernetes API server reported that it failed to fully initialize or become live: 'akka-operator' timed out waiting to be Ready
>
>  	* [MinimumReplicasUnavailable] Deployment does not have minimum availability.
>
>  	* Minimum number of live Pods was not attained
>
>  	* [Pod lightbend/akka-operator-9b6f567cc-sgp7d]: containers with unready status: [akka-operator ubbagent]
> 
> pulumi:pulumi:Stack (akka-cloud-platform-gcp-deploy-dev):
  error: update failed