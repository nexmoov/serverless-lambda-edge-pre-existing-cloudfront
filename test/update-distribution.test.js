'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { GetDistributionCommand, UpdateDistributionCommand } = require('@aws-sdk/client-cloudfront')
const { ListVersionsByFunctionCommand } = require('@aws-sdk/client-lambda')
const Plugin = require('../dist/index.js').default

const FUNCTION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:edge-prod:2'
const OLD_FUNCTION_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:edge-prod:1'

function event(distributionId, pathPattern) {
  return {
    preExistingCloudFront: {
      distributionId,
      eventType: 'viewer-response',
      pathPattern,
      includeBody: false
    }
  }
}

function cacheBehavior(pathPattern, functionArn) {
  return {
    PathPattern: pathPattern,
    LambdaFunctionAssociations: {
      Quantity: 1,
      Items: [{ LambdaFunctionARN: functionArn, IncludeBody: false, EventType: 'viewer-response' }]
    }
  }
}

function createPlugin(events, distributions) {
  const serverless = {
    configSchemaHandler: { defineCustomProperties() {}, defineFunctionEvent() {} },
    getProvider: () => ({ getStage: () => 'prod' }),
    service: {
      provider: { region: 'us-east-1', stage: 'prod' },
      custom: {},
      getAllFunctions: () => ['edge'],
      getFunction: () => ({ name: 'edge-prod', events })
    }
  }
  const plugin = new Plugin(serverless, {}, { log: { notice() {}, error() {} } })

  plugin.lambdaClient.send = async (command) => {
    assert.ok(command instanceof ListVersionsByFunctionCommand)
    return { Versions: [{ FunctionArn: FUNCTION_ARN }] }
  }
  const updates = []
  plugin.cloudfrontClient.send = async (command) => {
    if (command instanceof GetDistributionCommand) {
      const cacheBehaviors = distributions[command.input.Id]
      return {
        ETag: 'etag',
        Distribution: {
          DistributionConfig: {
            CacheBehaviors: {
              Quantity: cacheBehaviors.length,
              Items: structuredClone(cacheBehaviors)
            }
          }
        }
      }
    }
    assert.ok(command instanceof UpdateDistributionCommand)
    updates.push(command.input)
    return {}
  }
  return { plugin, updates }
}

test('skips the update when every association already points at the latest version', async () => {
  const { plugin, updates } = createPlugin([event('DIST1', '/v1*'), event('DIST1', '/v2*')], {
    DIST1: [cacheBehavior('/v1*', FUNCTION_ARN), cacheBehavior('/v2*', FUNCTION_ARN)]
  })

  await plugin.setupLambdaEdgePreExistingCloudFront()

  assert.deepEqual(updates, [])
})

test('sends one update per distribution with all of its associations', async () => {
  const { plugin, updates } = createPlugin(
    [event('DIST1', '/v1*'), event('DIST1', '/v2*'), event('DIST2', '/v3*')],
    {
      DIST1: [cacheBehavior('/v1*', OLD_FUNCTION_ARN), cacheBehavior('/v2*', OLD_FUNCTION_ARN)],
      DIST2: [cacheBehavior('/v3*', OLD_FUNCTION_ARN)]
    }
  )

  await plugin.setupLambdaEdgePreExistingCloudFront()

  assert.deepEqual(
    updates.map((update) => ({
      Id: update.Id,
      arns: update.DistributionConfig.CacheBehaviors.Items.map(
        (behavior) => behavior.LambdaFunctionAssociations.Items[0].LambdaFunctionARN
      )
    })),
    [
      { Id: 'DIST1', arns: [FUNCTION_ARN, FUNCTION_ARN] },
      { Id: 'DIST2', arns: [FUNCTION_ARN] }
    ]
  )
})

test('updates when only includeBody changed', async () => {
  const { plugin, updates } = createPlugin(
    [
      {
        preExistingCloudFront: {
          ...event('DIST1', '/v1*').preExistingCloudFront,
          includeBody: true
        }
      }
    ],
    { DIST1: [cacheBehavior('/v1*', FUNCTION_ARN)] }
  )

  await plugin.setupLambdaEdgePreExistingCloudFront()

  assert.deepEqual(
    updates[0].DistributionConfig.CacheBehaviors.Items[0].LambdaFunctionAssociations.Items,
    [{ LambdaFunctionARN: FUNCTION_ARN, IncludeBody: true, EventType: 'viewer-response' }]
  )
})

test('retries CloudFront throttling with adaptive backoff', async () => {
  const { plugin } = createPlugin([], {})

  assert.equal(await plugin.cloudfrontClient.config.maxAttempts(), 10)
  assert.equal(await plugin.cloudfrontClient.config.retryStrategy().then((s) => s.mode), 'adaptive')
})
