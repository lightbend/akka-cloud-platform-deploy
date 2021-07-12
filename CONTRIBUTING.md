# Welcome! Thank you for contributing to Akka!

We follow the standard GitHub [fork & pull](https://help.github.com/articles/using-pull-requests/#fork--pull) approach to pull requests. Just fork the official repo, develop in a branch, and submit a PR!

You're always welcome to submit your PR straight away and start the discussion (without reading the rest of this wonderful doc, or the README.md). The goal of these notes is to make your experience contributing to Akka as smooth and pleasant as possible. We're happy to guide you through the process once you've submitted your PR.

# The Akka Community

In case of questions about the contribution process or for discussion of specific issues please visit the [akka/dev gitter chat](https://gitter.im/akka/dev).

You may also check out these [other resources](https://akka.io/get-involved/).

# Reconcile state

In most cases you can make a change to the playbook and run `pulumi up` to reconcile with the target.
If you made manual changes in your target you can attempt to reconcile the target state with local state by calling `pulumi refresh`.
This is useful during development so you can test changes. If your changes create an incorrect or broken state you can manually clean up the cluster and then reconcile state without reprovisioning everything.

# Update Dependencies

Use `npm-check-updates`.

```bash
npm i -g npm-check-updates
```

Update `package.json`:

```bash
ncu -u
npm install
```

# Auto-format TypeScript

In order to auto-format TypeScript sources.

First install npm dependencies with:

```bash
npm install
```

And then use the `format` command:

```bash
npm run format
```

> Note that this command has to be run from the root folder of the project.
