# Serverless Lambda Edge PreExisting CloudFront

A Serverless Framework plugin which associates Lambda@Edge against pre-existing CloudFront
distributions.

## Install

You can install this plugin from npm registry.

```shell
$ npm install --save-dev @locallogic/serverless-lambda-edge-pre-existing-cloudfront
```

## How it works

Configure serverless.yml

```yaml
functions:
  viewerRequest:
    handler: lambdaEdge/viewerRequest.handler
    events:
      - preExistingCloudFront:
          # ---- Mandatory Properties -----
          distributionId: xxxxxxx # CloudFront distribution ID you want to associate
          # Supported values: viewer-request, origin-request, origin-response, viewer-response
          eventType: viewer-request
          pathPattern: '*' # Specifying the CloudFront behavior
          includeBody: false # Whether including body or not within request
          # ---- Optional Property -----
          # Stage at which this CloudFront distribution is updated
          stage: dev

plugins:
  - '@locallogic/serverless-lambda-edge-pre-existing-cloudfront'
```

Run deploy

```
$ serverless deploy
```

You can specify additional configurations in a `lambdaEdgePreExistingCloudFront` value in the
custom section of your `serverless.yml` file.
A `validStages` value allows you to specify valid stage names for deploy Lambda@Edge.

```yaml
lambdaEdgePreExistingCloudFront:
  validStages:
    - staging
    - production
```

### How `validStages` and `stage` properties work

This plugin first checks for a `validStages` property in the `custom` section. When it is set,
`preExistingCloudFront` events are only updated at those stages. Otherwise, events can be updated
at any stage.

At valid stages, the plugin checks whether the provider stage matches the optional `stage` property
on each `preExistingCloudFront` event. The event is updated when they match.

Without an event-level `stage`, the event is updated at every `validStages` entry, or at every stage
when `validStages` is not configured.
